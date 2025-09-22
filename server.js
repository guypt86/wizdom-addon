// server.js — Wizdom subtitles addon for Stremio
// v1.4 — validate direct links by filename + Hebrew encoding fix (Windows-1255/ISO-8859-8)

const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));
const cheerio = require('cheerio');
const { LRUCache } = require('lru-cache');
const AdmZip = require('adm-zip');
const srt2vtt = require('srt-to-vtt');
const { Readable } = require('stream');
const { URL } = require('url');
const iconv = require('iconv-lite');
const chardet = require('jschardet');
const puppeteer = require('puppeteer');

// Test Puppeteer availability on startup
(async () => {
  try {
    const testPath =
      process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    console.log(`[Puppeteer] Testing executable path: ${testPath}`);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: testPath,
    });
    await browser.close();
    console.log(`[Puppeteer] ✅ Available and working`);
  } catch (e) {
    console.error(`[Puppeteer] ❌ Not available: ${e.message}`);
    console.log(`[Puppeteer] Will use fallback without browser automation`);
  }
})();

// ---------- Ports / Origins ----------
const ADDON_PORT = process.env.PORT || 7010;
const PROXY_PORT = process.env.PROXY_PORT || 7001;
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_ORIGIN = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}`
  : `http://127.0.0.1:${ADDON_PORT}`;

// ---------- Search bases & overrides ----------
const SEARCH_BASES = [
  'https://wizdom.xyz',
  'http://wizdom.xyz',
  'https://www.wizdom.xyz',
  'http://www.wizdom.xyz',
];

// אופציונלי: imdbId -> שם לחיפוש
const TITLE_OVERRIDE = {
  // 'tt28013708': 'Task',
};

// ---------- Manifest ----------
const manifest = {
  id: 'community.wizdom.subs',
  version: '1.4.0',
  name: 'Wizdom Subtitles (HEB)',
  description: 'Hebrew subtitles from wizdom.xyz (demo/educational use)',
  catalogs: [],
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  // הוספת תמיכה ב-Vidi
  behaviorHints: {
    adult: false,
    p2p: false,
    bingeable: false,
    configurable: true,
    configurationRequired: false,
  },
};

// ---------- Cache ----------
const cache = new LRUCache({ max: 200, ttl: 1000 * 60 * 30 }); // 30m

// ---------- Utils ----------
function srtBufferToVtt(buf) {
  return new Promise((resolve, reject) => {
    const rs = Readable.from(buf);
    const chunks = [];
    rs.pipe(srt2vtt())
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

// זיהוי קידוד -> החזרה תמיד UTF-8 Buffer
function toUtf8Buffer(rawBuf) {
  // נסה לזהות קידוד; אם בטחון נמוך ניפול ל-UTF-8
  const det = chardet.detect(rawBuf) || {};
  const enc = (det.encoding || 'UTF-8').toUpperCase();

  // מיפוי נפוצים לעברית
  const hebrewEnc = ['WINDOWS-1255', 'ISO-8859-8', 'ISO-8859-8-I', 'CP1255'];
  if (enc === 'UTF-8') return rawBuf;
  if (hebrewEnc.includes(enc)) {
    const text = iconv.decode(rawBuf, enc);
    return Buffer.from(text, 'utf8');
  }

  // ברירת מחדל: נסה בכל זאת לפענח לפי enc
  try {
    const text = iconv.decode(rawBuf, enc);
    return Buffer.from(text, 'utf8');
  } catch {
    return rawBuf; // fallback
  }
}

// זיהוי קידוד -> החזרה תמיד UTF-8 Buffer
function toUtf8Buffer(rawBuf) {
  // נסה לזהות קידוד; אם בטחון נמוך ניפול ל-UTF-8
  const det = chardet.detect(rawBuf) || {};
  const enc = (det.encoding || 'UTF-8').toUpperCase();

  // מיפוי נפוצים לעברית
  const hebrewEnc = ['WINDOWS-1255', 'ISO-8859-8', 'ISO-8859-8-I', 'CP1255'];
  if (enc === 'UTF-8') return rawBuf;
  if (hebrewEnc.includes(enc)) {
    const text = iconv.decode(rawBuf, enc);
    return Buffer.from(text, 'utf8');
  }

  // ברירת מחדל: נסה בכל זאת לפענח לפי enc
  try {
    const text = iconv.decode(rawBuf, enc);
    return Buffer.from(text, 'utf8');
  } catch {
    return rawBuf; // fallback
  }
}

// נרמול URL (כולל פירוק redirect של DuckDuckGo)
function normalizeUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u);
    if (
      parsed.hostname.includes('duckduckgo.com') &&
      parsed.pathname.startsWith('/l/')
    ) {
      const target = parsed.searchParams.get('uddg');
      if (target) return normalizeUrl(decodeURIComponent(target));
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

const isSubtitleFileUrl = (href) =>
  /\.srt(\?.*)?$/i.test(href) ||
  /\.zip(\?.*)?$/i.test(href) ||
  /\/api\/files\/sub\//i.test(href);

const HEADERS_HTML = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

// בדיקת התאמה של שם קובץ לשם כותר + SxxEyy
function seTag(season, episode) {
  if (!season || !episode) return null;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(
    2,
    '0'
  )}`;
}
function filenameFromUrlOrHeader(urlStr, headers) {
  // Content-Disposition: attachment; filename="Task.S01E01.1080p…srt"
  const cd = headers?.get ? headers.get('content-disposition') : null;
  if (cd) {
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(cd);
    if (m) return decodeURIComponent(m[1] || m[2] || '').trim();
  }
  try {
    const u = new URL(urlStr);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (base) return base;
  } catch {}
  return '';
}
function looksLikeMatch(filename, title, season, episode) {
  const name = filename.toLowerCase().replace(/[\s._-]+/g, ' ');
  const titleNorm = (title || '').toLowerCase().replace(/[\s._-]+/g, ' ');
  const tag = seTag(season, episode);

  // לסדרות - דורש התאמה מדויקת של SxxEyy
  if (season && episode) {
    const hasSE = tag ? name.includes(tag.toLowerCase()) : false;
    if (!hasSE) return false; // חייב SxxEyy לסדרות

    // אם יש כותר, הוא חייב להיות שם
    if (titleNorm && titleNorm.length > 2) {
      const hasTitle = name.includes(titleNorm);
      if (!hasTitle) return false;
    }
    return true;
  }

  // לסרטים - אם זה קישור API ישיר (רק מספרים), נקבל אותו
  if (/^\d+\.(zip|srt)$/i.test(filename)) {
    console.log(`[Validate] Accepting API direct link: ${filename}`);
    return true;
  }

  // לסדרות - אם זה קישור API ישיר, נצטרך לבדוק את התוכן
  if (season && episode && /^\d+\.(zip|srt)$/i.test(filename)) {
    console.log(
      `[Validate] API direct link for series, will check content: ${filename}`
    );
    return false; // נחזיר false כדי שהפונקציה הקוראת תבדוק את התוכן
  }

  // לסרטים - רק כותר
  if (titleNorm && titleNorm.length > 2) {
    return name.includes(titleNorm);
  }

  return false;
}

// ---------- Cinemeta ----------
async function getTitleFromCinemeta(type, imdbId) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`cinemeta ${r.status}`);
    const data = await r.json();
    return {
      title: TITLE_OVERRIDE[imdbId] || data?.meta?.name || imdbId,
      year: data?.meta?.year,
    };
  } catch (e) {
    console.log('[Cinemeta] fallback to imdb id:', e.message);
    return { title: TITLE_OVERRIDE[imdbId] || imdbId, year: undefined };
  }
}

// ---------- Search ----------
function extractWizdomLinksFromHtml(html, base) {
  const $ = cheerio.load(html);
  const posts = [];
  let totalLinks = 0;
  let wizdomLinks = 0;

  $('a').each((_, a) => {
    totalLinks++;
    const href0 = ($(a).attr('href') || '').trim();
    const hrefAbs = href0.startsWith('http')
      ? href0
      : new URL(href0, base).href;
    const href = normalizeUrl(hrefAbs);
    const text = ($(a).text() || '').trim();

    if (href && /wizdom\.xyz/i.test(href)) {
      wizdomLinks++;
      posts.push({ href, text });
    }
  });

  console.log(
    `[Extract] Found ${totalLinks} total links, ${wizdomLinks} wizdom links`
  );
  return posts;
}

async function findWizdomPageCandidates(queries, imdbId) {
  // ננסה קודם לגשת ישירות לעמוד הסרט/סדרה לפי IMDB ID
  if (imdbId) {
    const directUrls = [
      `https://wizdom.xyz/movie/${imdbId}`,
      `https://wizdom.xyz/series/${imdbId}`,
    ];

    for (const directUrl of directUrls) {
      console.log(`[Search] Trying direct IMDB URL: ${directUrl}`);

      try {
        const testRes = await fetch(directUrl, { method: 'HEAD' });
        if (testRes.ok) {
          console.log(`[Search] Direct IMDB URL exists!`);
          return [{ href: directUrl, text: 'Direct IMDB match' }];
        } else {
          console.log(
            `[Search] Direct IMDB URL not found (status: ${testRes.status})`
          );
        }
      } catch (e) {
        console.log(`[Search] Direct IMDB URL test failed: ${e.message}`);
      }
    }
  }

  // ננסה קודם עם Puppeteer
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    });
    const page = await browser.newPage();

    for (const q of queries) {
      const url = `https://wizdom.xyz/?s=${encodeURIComponent(q)}`;
      console.log(`[Search] wizdom (Puppeteer) → ${url}`);

      try {
        const discovered = new Set();
        const normalize = (u) => {
          try {
            return new URL(u, 'https://wizdom.xyz').toString();
          } catch {
            return null;
          }
        };
        const collectFromText = (txt) => {
          if (!txt) return;
          const re =
            /(https?:\/\/[^"'\s]+|\/api\/files\/sub\/\d+|\/[\w\-\/]+\.(?:srt|zip))(?:\?[^"'\s]*)?/gi;
          let m;
          while ((m = re.exec(txt)) !== null) {
            const u = normalize(m[0]);
            if (
              u &&
              (u.includes('/api/files/sub/') || /\.(srt|zip)(\?.*)?$/i.test(u))
            )
              discovered.add(u);
          }
        };

        page.removeAllListeners('response');
        page.on('response', async (resp) => {
          try {
            const u = resp.url();
            if (!/wizdom\.xyz\/api\//i.test(u)) return;
            const headers = resp.headers();
            const ct = (headers['content-type'] || '').toLowerCase();
            if (ct.includes('application/json')) {
              const json = await resp.json();
              collectFromText(JSON.stringify(json));
            } else {
              const text = await resp.text();
              collectFromText(text);
            }
          } catch {}
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const links = await page.evaluate(() => {
          const results = [];
          const anchors = document.querySelectorAll('a');
          anchors.forEach((a) => {
            const href = a.href;
            const text = a.textContent?.trim();
            if (href && text) results.push({ href, text });
          });
          return results;
        });

        const discoveredArr = Array.from(discovered).map((h) => ({
          href: h,
          text: 'discovered',
        }));
        const allLinks = [...links, ...discoveredArr];

        console.log(
          `[Search] Puppeteer found ${allLinks.length} total links for "${q}"`
        );

        // בואו נראה את כל הקישורים שנמצאו
        console.log('[DEBUG] All links found:');
        allLinks.forEach((link, i) => {
          console.log(`   ${i + 1}. "${link.text}" → ${link.href}`);
        });

        if (allLinks.length > 0) {
          // חפש קישורי כתוביות ישירות
          const directSubtitleLinks = allLinks.filter(
            (link) =>
              link.href.includes('wizdom.xyz') &&
              (link.href.includes('/api/files/sub/') ||
                /\.(srt|zip)(\?.*)?$/i.test(link.href))
          );

          if (directSubtitleLinks.length > 0) {
            console.log(
              `[Search] ${directSubtitleLinks.length} direct subtitle links found`
            );
            directSubtitleLinks.forEach((link, i) => {
              console.log(`   ${i + 1}. "${link.text}" → ${link.href}`);
            });
            await browser.close();
            return directSubtitleLinks;
          }

          // אם לא מצאנו קישורי כתוביות ישירות, חפש עמודי סרטים/סדרות
          const moviePageLinks = allLinks.filter(
            (link) =>
              link.href.includes('wizdom.xyz') &&
              (/\/movie\//.test(link.href) || /\/series\//.test(link.href))
          );

          console.log(
            `[Search] Found ${moviePageLinks.length} movie/series pages`
          );
          moviePageLinks.forEach((link, i) => {
            console.log(`   Movie ${i + 1}. "${link.text}" → ${link.href}`);
          });

          if (moviePageLinks.length > 0) {
            // נחפש התאמה טובה יותר
            const searchTerms = q.toLowerCase().split(' ');
            const scoredLinks = moviePageLinks.map((link) => {
              const linkText = link.text.toLowerCase();
              let score = 0;

              // נקודות על כל מילה שמתאימה
              searchTerms.forEach((term) => {
                if (linkText.includes(term)) score += 10;
              });

              // נקודות נוספות אם זה התאמה מדויקת
              if (linkText.includes(q.toLowerCase())) score += 50;

              return { link, score };
            });

            // מיין לפי ציון
            scoredLinks.sort((a, b) => b.score - a.score);

            console.log('[Search] Scored movie pages:');
            scoredLinks.forEach((item, i) => {
              console.log(
                `   ${i + 1}. Score: ${item.score} - "${item.link.text}"`
              );
            });

            const bestMatch = scoredLinks[0].link;
            console.log(
              `[Search] Checking movie page: "${bestMatch.text}" → ${bestMatch.href}`
            );
            await browser.close();
            return [bestMatch];
          }

          console.log('[DEBUG] No relevant links found. Found links:');
          allLinks.forEach((link, i) => {
            console.log(`   ${i + 1}. "${link.text}" → ${link.href}`);
          });
        }
      } catch (e) {
        console.log(`[Search] Puppeteer error for "${q}": ${e.message}`);
      }
    }

    await browser.close();
  } catch (e) {
    console.log(`[Search] Puppeteer launch error: ${e.message}`);
  }

  // fallback: DuckDuckGo
  for (const q of queries) {
    const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent(
      'site:wizdom.xyz ' + q
    )}`;
    console.log(`[Search] DDG → ${ddg}`);
    try {
      const res = await fetch(ddg, { headers: HEADERS_HTML });
      if (!res.ok) {
        console.log(`[Search] DDG status ${res.status}`);
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);
      const posts = [];
      $('a.result__a').each((_, a) => {
        const raw = ($(a).attr('href') || '').trim(); // לרוב redirect
        const href = normalizeUrl(raw);
        if (href && /wizdom\.xyz/i.test(href)) {
          posts.push({ href, text: ($(a).text() || '').trim() });
        }
      });
      if (posts.length) {
        console.log(`[Search] DDG found ${posts.length} posts for "${q}"`);
        return posts;
      }
    } catch (e) {
      console.log(`[Search] DDG error: ${e.message}`);
    }
  }
  return [];
}

function pickBestPost(posts, { title, season, episode }) {
  // עדיפות 0: אם זה כבר קובץ כתוביות ישיר – נאמת לפי שם קובץ בהמשך (לא כאן)
  const direct = posts.find((p) => isSubtitleFileUrl(p.href));
  if (direct) return direct.href;

  const tag = seTag(season, episode)?.toLowerCase();
  const tnorm = (title || '').toLowerCase();

  // עדיפות 1: קישור שמכיל גם SxxEyy וגם שם הכותר
  const byBoth = posts.find(
    (p) =>
      ((p.text || '').toLowerCase().includes(tnorm) ||
        (p.href || '').toLowerCase().includes(tnorm)) &&
      tag &&
      ((p.text || '').toLowerCase().includes(tag) ||
        (p.href || '').toLowerCase().includes(tag))
  );
  if (byBoth) return byBoth.href;

  // עדיפות 2: רק SxxEyy
  if (tag) {
    const bySE = posts.find(
      (p) =>
        (p.text || '').toLowerCase().includes(tag) ||
        (p.href || '').toLowerCase().includes(tag)
    );
    if (bySE) return bySE.href;
  }

  // עדיפות 3: לפי שם
  const byTitle = posts.find(
    (p) =>
      (p.text || '').toLowerCase().includes(tnorm) ||
      (p.href || '').toLowerCase().includes(tnorm)
  );
  if (byTitle) return byTitle.href;

  return posts[0]?.href || null;
}

// חילוץ קישורי כתוביות מדף
async function extractSubtitleLinksFromPage(pageUrl) {
  const key = `page:${pageUrl}`;
  if (cache.has(key)) return cache.get(key);

  console.log(`[Extract] page: ${pageUrl}`);

  // אם זה עמוד סרט/סדרה, נשתמש ב-Puppeteer כדי לטעון את התוכן הדינמי
  if (/\/(movie|series)\//.test(pageUrl)) {
    return await extractSubtitleLinksWithPuppeteer(pageUrl);
  }

  // עבור עמודים רגילים - נשתמש ב-fetch
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    console.log(`[Extract] status ${res.status}`);
    return [];
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const links = [];
  $('a').each((_, a) => {
    const href0 = ($(a).attr('href') || '').trim();
    const abs = href0.startsWith('http') ? href0 : new URL(href0, pageUrl).href;
    const href = normalizeUrl(abs);
    if (!href) return;
    const label = ($(a).text() || '').trim();
    if (isSubtitleFileUrl(href))
      links.push({ href, label: label || 'Subtitle' });
  });

  console.log(`[Extract] found ${links.length} subtitle links`);
  cache.set(key, links);
  return links;
}

// חילוץ קישורי כתוביות מעמוד סרט/סדרה עם Puppeteer
async function extractSubtitleLinksWithPuppeteer(pageUrl) {
  console.log(`[Extract] Using Puppeteer for page: ${pageUrl}`);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    });
    const page = await browser.newPage();

    const discovered = new Set();
    const normalize = (u) => {
      try {
        return new URL(u, 'https://wizdom.xyz').toString();
      } catch {
        return null;
      }
    };
    const collectFromText = (txt) => {
      if (!txt) return;
      const re =
        /(https?:\/\/[^"'\s]+|\/api\/files\/sub\/\d+|\/[\w\-\/]+\.(?:srt|zip))(?:\?[^"'\s]*)?/gi;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const u = normalize(m[0]);
        if (
          u &&
          (u.includes('/api/files/sub/') || /\.(srt|zip)(\?.*)?$/i.test(u))
        )
          discovered.add(u);
      }
    };

    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!/wizdom\.xyz\/api\//i.test(u)) return;
        const headers = resp.headers();
        const ct = (headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          const json = await resp.json();
          collectFromText(JSON.stringify(json));
        } else {
          const text = await resp.text();
          collectFromText(text);
        }
      } catch {}
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 15000 });

    // נחכה עוד קצת ונבדוק כמה פעמים
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // בדוק אם יש כתוביות כבר
      const currentLinks = await page.evaluate(() => {
        const results = [];
        const anchors = document.querySelectorAll('a');
        anchors.forEach((a) => {
          const href = a.href;
          const text = a.textContent?.trim();
          if (
            href &&
            text &&
            (href.includes('/api/files/sub/') ||
              /\.(srt|zip)(\?.*)?$/i.test(href))
          ) {
            results.push({ href, text });
          }
        });
        return results;
      });

      if (currentLinks.length > 0) {
        console.log(`[Extract] Found subtitles after ${(i + 1) * 2} seconds`);
        break;
      }

      console.log(
        `[Extract] No subtitles found yet, waiting... (attempt ${i + 1}/3)`
      );
    }

    // חפש קישורים בדף
    const links = await page.evaluate(() => {
      const results = [];
      const anchors = document.querySelectorAll('a');
      anchors.forEach((a) => {
        const href = a.href;
        const text = a.textContent?.trim();
        if (
          href &&
          text &&
          (href.includes('/api/files/sub/') ||
            /\.(srt|zip)(\?.*)?$/i.test(href))
        ) {
          results.push({ href, text });
        }
      });
      return results;
    });

    // נוסיף חיפוש נוסף לכל הקישורים בדף כדי לראות מה יש שם
    const allPageLinks = await page.evaluate(() => {
      const results = [];

      // חפש קישורים רגילים
      const anchors = document.querySelectorAll('a');
      anchors.forEach((a) => {
        const href = a.href;
        const text = a.textContent?.trim();
        if (href && text) {
          results.push({ href, text, type: 'link' });
        }
      });

      // חפש כפתורים וכלים אחרים
      const buttons = document.querySelectorAll(
        'button, div[role="button"], [data-url], [data-href], [onclick]'
      );
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim();
        const dataUrl =
          btn.getAttribute('data-url') || btn.getAttribute('data-href');
        const onclick = btn.getAttribute('onclick');
        if (text && (dataUrl || onclick)) {
          results.push({
            href: dataUrl || onclick || 'javascript',
            text: text,
            type: 'button',
          });
        }
      });

      // חפש אלמנטים שמכילים מילים קשורות לכתוביות
      const allElements = document.querySelectorAll('*');
      allElements.forEach((el) => {
        const text = el.textContent?.trim();
        if (
          text &&
          text.length < 100 &&
          (text.includes('srt') ||
            text.includes('zip') ||
            text.includes('subtitle') ||
            text.includes('כתוביות') ||
            text.includes('הורד') ||
            text.includes('download'))
        ) {
          const nearbyLink =
            el.querySelector('a') ||
            el.closest('a') ||
            el.nextElementSibling?.querySelector('a');
          if (nearbyLink && nearbyLink.href) {
            results.push({
              href: nearbyLink.href,
              text: text,
              type: 'subtitle-related',
            });
          }
        }
      });

      return results;
    });

    console.log(
      `[Extract] Found ${allPageLinks.length} total elements on movie page`
    );
    if (allPageLinks.length > 0) {
      console.log('[Extract] All elements on movie page:');
      allPageLinks.slice(0, 15).forEach((link, i) => {
        console.log(
          `   ${i + 1}. [${link.type}] "${link.text}" → ${link.href}`
        );
      });
      if (allPageLinks.length > 15) {
        console.log(`   ... and ${allPageLinks.length - 15} more`);
      }
    }

    const discoveredArr = Array.from(discovered).map((h) => ({
      href: h,
      text: 'discovered',
    }));

    // הוסף גם את הקישורים שנמצאו מ-allPageLinks
    const subtitleLinksFromPage = allPageLinks.filter(
      (link) =>
        link.href.includes('/api/files/sub/') ||
        /\.(srt|zip)(\?.*)?$/i.test(link.href)
    );

    // נסיר כפילויות ונשמור רק קישורים ייחודיים
    const allLinks = [...links, ...discoveredArr, ...subtitleLinksFromPage];
    const uniqueLinks = [];
    const seenUrls = new Set();

    for (const link of allLinks) {
      if (!seenUrls.has(link.href)) {
        seenUrls.add(link.href);
        uniqueLinks.push(link);
      }
    }

    console.log(
      `[Extract] After deduplication: ${uniqueLinks.length} unique links`
    );

    await browser.close();

    console.log(
      `[Extract] Found ${uniqueLinks.length} unique subtitle links via Puppeteer`
    );
    uniqueLinks.forEach((link, i) => {
      console.log(`   ${i + 1}. "${link.text}" → ${link.href}`);
    });

    return uniqueLinks;
  } catch (e) {
    console.error(`[Extract] Puppeteer error: ${e.message}`);
    console.log(`[Extract] Falling back to regular fetch for: ${pageUrl}`);

    // Fallback: try regular fetch without Puppeteer
    try {
      const response = await fetch(pageUrl);
      if (!response.ok) return [];

      const html = await response.text();
      const $ = cheerio.load(html);
      const links = [];

      $('a[href*="/api/files/sub/"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && href.includes('/api/files/sub/')) {
          const fullUrl = href.startsWith('http')
            ? href
            : `https://wizdom.xyz${href}`;
          links.push({ href: fullUrl, label: text || 'Download' });
        }
      });

      console.log(`[Extract] Fallback found ${links.length} subtitle links`);

      // If no links found with fetch, try direct API search as last resort
      if (links.length === 0) {
        console.log(`[Extract] No links found, trying direct API search...`);
        return await tryDirectApiSearch(pageUrl);
      }

      return links;
    } catch (fallbackError) {
      console.error(`[Extract] Fallback also failed: ${fallbackError.message}`);
      // Last resort: try API search
      try {
        return await tryDirectApiSearch(pageUrl);
      } catch (apiError) {
        console.error(`[Extract] API search also failed: ${apiError.message}`);
        return [];
      }
    }
  }
}

// Try direct API search when page scraping fails
async function tryDirectApiSearch(pageUrl) {
  console.log(`[API] Attempting direct search for: ${pageUrl}`);

  // Extract IMDB ID from URL
  const imdbMatch = pageUrl.match(/\/movie\/(tt\d+)/);
  if (!imdbMatch) {
    console.log(`[API] No IMDB ID found in URL`);
    return [];
  }

  const imdbId = imdbMatch[1];
  console.log(`[API] Searching for IMDB ID: ${imdbId}`);

  try {
    // Try to search for the movie/series on Wizdom's search
    const searchUrl = `https://wizdom.xyz/api/search?q=${imdbId}`;
    const response = await fetch(searchUrl);

    if (!response.ok) {
      console.log(`[API] Search failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    console.log(`[API] Search response:`, JSON.stringify(data, null, 2));

    const links = [];

    // Process search results to extract subtitle links
    if (data && Array.isArray(data.results)) {
      for (const result of data.results) {
        if (result.subtitles && Array.isArray(result.subtitles)) {
          for (const sub of result.subtitles) {
            if (sub.download_link) {
              const fullUrl = sub.download_link.startsWith('http')
                ? sub.download_link
                : `https://wizdom.xyz${sub.download_link}`;
              links.push({
                href: fullUrl,
                label: sub.release_name || 'Download',
              });
            }
          }
        }
      }
    }

    console.log(`[API] Found ${links.length} subtitle links via API`);
    return links;
  } catch (error) {
    console.error(`[API] Direct search failed: ${error.message}`);
    return [];
  }
}

// בדיקת תוכן כתוביות לאימות פרק ועונה
async function validateSubtitleContent(urlStr, title, season, episode) {
  try {
    console.log(
      `[ValidateContent] Checking content of ${urlStr} for S${season}E${episode}`
    );

    // נטען רק את החלק הראשון של הקובץ כדי לבדוק את התוכן
    const response = await fetch(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-2048' }, // רק 2KB ראשונים
    });

    if (!response.ok) {
      console.log(
        `[ValidateContent] Failed to fetch content: ${response.status}`
      );
      return false;
    }

    const raw = Buffer.from(await response.arrayBuffer());
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    const cdName = filenameFromUrlOrHeader(urlStr, response.headers) || '';

    // בדיקה אם זה ZIP
    const looksZipByHeader =
      /zip/.test(ct) || /\.zip$/i.test(cdName) || /\.zip(\?.*)?$/i.test(urlStr);
    const looksZipByMagic =
      raw.length >= 4 &&
      raw[0] === 0x50 &&
      raw[1] === 0x4b &&
      raw[2] === 0x03 &&
      raw[3] === 0x04;
    const isZip = looksZipByHeader || looksZipByMagic;

    let content = '';

    if (isZip) {
      try {
        const zip = new AdmZip(raw);
        const srtEntries = zip
          .getEntries()
          .filter((e) => /\.srt$/i.test(e.entryName));
        if (srtEntries.length > 0) {
          const firstEntry = srtEntries[0];
          const srtData = firstEntry.getData();
          content = toUtf8Buffer(srtData).toString('utf8');
          console.log(
            `[ValidateContent] Extracted content from ZIP entry: ${firstEntry.entryName}`
          );
        }
      } catch (e) {
        console.log(`[ValidateContent] Failed to read ZIP: ${e.message}`);
        return false;
      }
    } else {
      // אם זה לא ZIP, ננסה לקרוא ישירות
      content = toUtf8Buffer(raw).toString('utf8');
    }

    if (!content) {
      console.log(`[ValidateContent] No content found`);
      return false;
    }

    // נבדוק אם התוכן מכיל את הפרק והעונה הנכונים
    const tag = seTag(season, episode);
    const titleNorm = (title || '').toLowerCase().replace(/[\s._-]+/g, ' ');

    // חיפוש SxxEyy בתוכן
    const hasCorrectEpisode = tag
      ? content.toLowerCase().includes(tag.toLowerCase())
      : false;

    // חיפוש שם הסדרה בתוכן
    const hasTitle =
      titleNorm && titleNorm.length > 2
        ? content.toLowerCase().includes(titleNorm)
        : true;

    // חיפוש מספרי פרק ועונה
    const hasSeasonEpisode =
      content.includes(`S${season}`) && content.includes(`E${episode}`);

    console.log(
      `[ValidateContent] Content check: hasCorrectEpisode=${hasCorrectEpisode}, hasTitle=${hasTitle}, hasSeasonEpisode=${hasSeasonEpisode}`
    );
    console.log(`[ValidateContent] Looking for: "${tag}", "${titleNorm}"`);
    console.log(
      `[ValidateContent] Content preview: ${content.substring(0, 200)}...`
    );

    // אם יש התאמה של פרק ועונה, נקבל את זה
    return hasCorrectEpisode || hasSeasonEpisode;
  } catch (e) {
    console.log(`[ValidateContent] Error: ${e.message}`);
    return false;
  }
}

// אימות קישור ישיר (לפי שם קובץ ותוכן)
async function validateDirectSubtitleUrl(urlStr, title, season, episode) {
  try {
    const head = await fetch(urlStr, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    // אם HEAD חסום, ננסה GET עם טווח 0 כדי לקבל רק כותרות
    let headers = head.headers;
    if (!head.ok || !headers || !headers.get('content-disposition')) {
      const r = await fetch(urlStr, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-0' },
      });
      headers = r.headers;
    }
    const fname = filenameFromUrlOrHeader(urlStr, headers) || '';

    // בדיקה ראשונית לפי שם קובץ
    let ok = looksLikeMatch(fname, title, season, episode);

    // אם זה קישור API ישיר לעונה שלמה – נאפשר, והבחירה המדויקת תעשה בפרוקסי
    if (!ok && /\/api\/files\/sub\/\d+/.test(urlStr) && season && episode) {
      console.log(
        `[Validate] API link (series) accepted; will pick correct SxxEyy in proxy`
      );
      ok = true;
    }

    console.log(
      `[Validate] direct link filename="${fname}" title="${title}" s=${season} e=${episode} → match=${ok}`
    );
    return ok;
  } catch (e) {
    console.log('[Validate] error:', e.message);
    return false;
  }
}

// ---------- Download/convert ----------
async function fetchAsVttBuffer(srcUrl, opts = {}) {
  // מפתח קאש יכלול גם את בחירת העונה/פרק ושם כותר לצמצום התנגשות
  const seTagKey = (opts.seTag || '').toUpperCase();
  const titleKey = (opts.title || '')
    .toLowerCase()
    .replace(/[\s._-]+/g, ' ')
    .trim();
  const key = `vtt:${srcUrl}|${seTagKey}|${titleKey}`;
  if (cache.has(key)) return cache.get(key);

  console.log(`[FetchVTT] get: ${srcUrl}`);
  const seTagWanted = (opts.seTag || '').toUpperCase();
  const titleWanted = (opts.title || '')
    .toLowerCase()
    .replace(/[\s._-]+/g, ' ')
    .trim();
  const r = await fetch(srcUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`subtitle fetch ${r.status}`);
  const raw = Buffer.from(await r.arrayBuffer());

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const cdName = filenameFromUrlOrHeader(srcUrl, r.headers) || '';
  const looksZipByHeader =
    /zip/.test(ct) || /\.zip$/i.test(cdName) || /\.zip(\?.*)?$/i.test(srcUrl);
  const looksZipByMagic =
    raw.length >= 4 &&
    raw[0] === 0x50 &&
    raw[1] === 0x4b &&
    raw[2] === 0x03 &&
    raw[3] === 0x04;
  const isZip = looksZipByHeader || looksZipByMagic;
  const isSrtByName = /\.srt$/i.test(cdName) || /\.srt(\?.*)?$/i.test(srcUrl);

  console.log(
    `[Detect] content-type="${ct}" filename="${cdName}" zip=${isZip} srtByName=${isSrtByName}`
  );

  let vtt;
  if (isZip) {
    const zip = new AdmZip(raw);
    const srtEntries = zip
      .getEntries()
      .filter((e) => /\.srt$/i.test(e.entryName));
    if (!srtEntries.length) throw new Error('No SRT inside ZIP');
    // נסה לבחור לפי SxxEyy בשם הקובץ
    let chosen = null;
    if (seTagWanted) {
      const wantedLower = seTagWanted.toLowerCase();
      chosen = srtEntries.find((e) =>
        e.entryName.toLowerCase().includes(wantedLower)
      );
    }
    // אם יש כותר, עדיף שם קובץ שמכיל גם אותה
    if (!chosen && seTagWanted && titleWanted) {
      const wantedLower = seTagWanted.toLowerCase();
      chosen = srtEntries.find(
        (e) =>
          e.entryName.toLowerCase().includes(wantedLower) &&
          e.entryName
            .toLowerCase()
            .replace(/[\s._-]+/g, ' ')
            .includes(titleWanted)
      );
    }
    // fallback: חפש SxxEyy בתוכן של כל קובץ עד שמוצאים
    if (!chosen && seTagWanted) {
      for (const e of srtEntries) {
        try {
          const buf = toUtf8Buffer(e.getData());
          const txt = buf.toString('utf8').toLowerCase();
          if (txt.includes(seTagWanted.toLowerCase())) {
            chosen = e;
            break;
          }
        } catch {}
      }
    }
    // fallback אחרון: הכי גדול
    if (!chosen) {
      chosen = srtEntries.sort((a, b) => b.header.size - a.header.size)[0];
    }
    const srtRaw = chosen.getData();
    const srtBuf = toUtf8Buffer(srtRaw);
    console.log(
      `[Detect] picked SRT from ZIP: ${chosen.entryName} (${srtRaw.length} bytes)`
    );
    vtt = await srtBufferToVtt(srtBuf);
  } else if (
    isSrtByName ||
    /text\/(plain|srt|vtt)/.test(ct) ||
    /\/api\/files\/sub\//i.test(srcUrl)
  ) {
    const srtBuf = toUtf8Buffer(raw);
    vtt = await srtBufferToVtt(srtBuf);
  } else if (/webvtt|vtt/.test(ct)) {
    vtt = raw;
  } else {
    const asText = toUtf8Buffer(raw).toString('utf8');
    if (/-->/.test(asText)) {
      vtt = await srtBufferToVtt(Buffer.from(asText, 'utf8'));
    } else {
      throw new Error('Unsupported subtitle format');
    }
  }

  // אחרי שקיבלת את vtt (Buffer):
  const head = vtt.slice(0, 16).toString('utf8').toUpperCase();
  if (!head.includes('WEBVTT')) {
    // אם מסיבה כלשהי המרה לא הוסיפה כותרת — נוסיף ידנית
    const prefix = Buffer.from('WEBVTT\n\n', 'utf8');
    vtt = Buffer.concat([prefix, vtt]);
  }

  // נוודא שיש שורה ריקה אחרי WEBVTT
  const vttText = vtt.toString('utf8');
  if (!vttText.startsWith('WEBVTT\n\n')) {
    vtt = Buffer.from(
      'WEBVTT\n\n' + vttText.replace(/^WEBVTT\s*\n?/, ''),
      'utf8'
    );
  }

  console.log(`[FetchVTT] converted → ${vtt.length} bytes`);
  cache.set(key, vtt);
  return vtt;
}

// ---------- Addon ----------
const addon = new addonBuilder(manifest);

addon.defineSubtitlesHandler(async (args) => {
  const isMovie = args.type === 'movie';
  let imdb = args.id;
  let season, episode;

  if (!isMovie) {
    const m = args.id.match(/(tt\d+):(\d+):(\d+)/);
    if (m) {
      imdb = m[1];
      season = Number(m[2]);
      episode = Number(m[3]);
    }
  }

  const { title, year } = await getTitleFromCinemeta(
    isMovie ? 'movie' : 'series',
    imdb
  );
  console.log(
    `[Addon] id=${args.id} → title="${title}" year=${year || '-'} s=${
      season || '-'
    } e=${episode || '-'}`
  );

  const queries = [];
  if (isMovie) {
    queries.push(`${title} ${year || ''}`.trim());
    queries.push(`${title}`);
    queries.push(`${title} 1080p`);
  } else {
    const tag = seTag(season, episode);
    // חיפושים מדויקים יותר - עם סיומת SxxEyy
    queries.push(`${title} ${tag}`);
    queries.push(`${title} ${tag} 1080p`);
    queries.push(`${title} ${tag} WEB`);
    queries.push(`${title} ${tag} WEB-DL`);
    queries.push(`${title} ${tag} HDTV`);
    queries.push(`${title} ${tag} BluRay`);
    // חיפושים עם רווחים
    queries.push(`${title} ${tag.slice(0, 3)} ${tag.slice(3)}`);
    queries.push(`${title} ${season} ${episode}`);
    // חיפושים כלליים יותר (רק בסוף)
    queries.push(`${title}`);
  }

  const posts = await findWizdomPageCandidates(queries, imdb);
  if (!posts.length) {
    console.log('[Addon] No wizdom posts for queries:', queries);
    return { subtitles: [] };
  }

  console.log(`[Addon] Found ${posts.length} posts:`);
  posts.forEach((p, i) => console.log(`   ${i + 1}. "${p.text}" → ${p.href}`));

  let chosen = pickBestPost(posts, { title, season, episode });
  chosen = normalizeUrl(chosen);
  console.log(`[Addon] chosen: ${chosen}`);
  if (!chosen) return { subtitles: [] };

  let links = [];
  if (isSubtitleFileUrl(chosen)) {
    // אימות שם קובץ
    const ok = await validateDirectSubtitleUrl(chosen, title, season, episode);
    if (ok) links = [{ href: chosen, label: 'Direct' }];
    else {
      console.log(
        '[Addon] direct link failed validation, trying to parse page (if any)'
      );
      // אם זה /api/files/sub שלא מתאים – אין דף; ננסה לוותר ולהחזיר ריק
      links = [];
    }
  } else {
    links = await extractSubtitleLinksFromPage(chosen);
    // סנן רק כאלה שמתאימים לפי שם קובץ
    const filtered = [];
    for (const l of links) {
      if (!isSubtitleFileUrl(l.href)) continue;
      const ok = await validateDirectSubtitleUrl(
        l.href,
        title,
        season,
        episode
      );
      if (ok) filtered.push(l);
    }
    links = filtered;
  }

  if (!links.length) {
    console.log('[Addon] No validated subtitle links');
    return { subtitles: [] };
  }

  const useWizdomEpisodeProxy = !isMovie && /\/(movie|series)\//.test(chosen);
  const subs = links.map((lnk, i) => {
    // נסה לחלץ שם יותר ברור מהקישור
    let subtitleName = lnk.label || 'Subtitle';
    if (lnk.href.includes('/api/files/sub/')) {
      const subId = lnk.href.match(/\/sub\/(\d+)/)?.[1];
      if (subId) {
        subtitleName = `Hebrew Subtitle ${subId}`;
      }
    }

    const directMode = process.env.WIZDOM_DIRECT === '1';
    const se = !isMovie ? seTag(season, episode) : undefined;
    let url;
    if (!directMode && useWizdomEpisodeProxy) {
      const q = `post=${encodeURIComponent(chosen)}${
        se ? `&se=${encodeURIComponent(se)}` : ''
      }${title ? `&title=${encodeURIComponent(title)}` : ''}${
        lnk.href ? `&fallback=${encodeURIComponent(lnk.href)}` : ''
      }`;
      url = `${PROXY_ORIGIN}/proxy/vtt-wizdom?${q}`;
    } else {
      const query = `src=${encodeURIComponent(lnk.href)}${
        se ? `&se=${encodeURIComponent(se)}` : ''
      }${title ? `&title=${encodeURIComponent(title)}` : ''}`;
      url = directMode ? lnk.href : `${PROXY_ORIGIN}/proxy/vtt?${query}`;
    }
    return {
      id: `wizdom-${i}`,
      lang: 'he',
      name: `Wizdom • ${subtitleName}`,
      url,
      mimeType: 'text/vtt',
    };
  });

  console.log(`[Addon] ${subs.length} subtitles:`);
  subs.forEach((s) => console.log(`   -> ${s.name} | ${s.url}`));

  return { subtitles: subs };
});

// ---------- Express Server ----------
const app = express();

// Log ALL requests for debugging
app.use((req, res, next) => {
  console.log(`\n📥 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log(`📥 User-Agent: ${req.headers['user-agent'] || 'N/A'}`);
  next();
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Stremio addon endpoints
app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(addon.getInterface().manifest);
});

// Handler function for Stremio subtitles
const handleStremioSubtitles = async (req, res) => {
  try {
    // Handle both named params (:type/:id) and regex params (req.params[0], req.params[1])
    const type = req.params.type || req.params[0];
    let id = req.params.id || req.params[1];

    // Clean ID from Stremio parameters like: tt3402138/videoHash=...&videoSize=...
    if (id && id.includes('/')) {
      id = id.split('/')[0];
    }

    console.log(`\n🎬 [STREMIO] ===== REQUEST START =====`);
    console.log(`[Stremio] Request for ${type}/${id}`);
    console.log(`[Stremio] Original path:`, req.path);
    console.log(`[Stremio] Cleaned ID:`, id);
    console.log(`[Stremio] Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`[Stremio] Query:`, req.query);

    // Use the same logic as Vidi route
    const isMovie = type === 'movie';
    let imdb = id;
    let season, episode;

    if (!isMovie) {
      const m = id.match(/(tt\d+):(\d+):(\d+)/);
      if (m) {
        imdb = m[1];
        season = Number(m[2]);
        episode = Number(m[3]);
      }
    }

    const { title, year } = await getTitleFromCinemeta(
      isMovie ? 'movie' : 'series',
      imdb
    );

    const queries = [];
    if (isMovie) {
      queries.push(`${title} ${year || ''}`.trim());
      queries.push(`${title}`);
      queries.push(`${title} 1080p`);
    } else {
      const tag = seTag(season, episode);
      queries.push(`${title} ${tag}`);
      queries.push(`${title} ${tag} 1080p`);
      queries.push(`${title} ${tag} WEB`);
      queries.push(`${title} ${tag} WEB-DL`);
      queries.push(`${title} ${tag} HDTV`);
      queries.push(`${title} ${tag} BluRay`);
      queries.push(`${title} ${tag.slice(0, 3)} ${tag.slice(3)}`);
      queries.push(`${title} ${season} ${episode}`);
      queries.push(`${title}`);
    }

    const posts = await findWizdomPageCandidates(queries, imdb);
    if (!posts.length) {
      return res.json({ subtitles: [] });
    }

    let chosen = pickBestPost(posts, { title, season, episode });
    chosen = normalizeUrl(chosen);
    if (!chosen) return res.json({ subtitles: [] });

    let links = [];
    if (isSubtitleFileUrl(chosen)) {
      const ok = await validateDirectSubtitleUrl(
        chosen,
        title,
        season,
        episode
      );
      if (ok) links = [{ href: chosen, label: 'Direct' }];
      else links = [];
    } else {
      links = await extractSubtitleLinksFromPage(chosen);
      const filtered = [];
      for (const l of links) {
        if (!isSubtitleFileUrl(l.href)) continue;
        const ok = await validateDirectSubtitleUrl(
          l.href,
          title,
          season,
          episode
        );
        if (ok) filtered.push(l);
      }
      links = filtered;
    }

    if (!links.length) {
      return res.json({ subtitles: [] });
    }

    const useWizdomEpisodeProxy = !isMovie && /\/(movie|series)\//.test(chosen);
    const subs = links.map((lnk, i) => {
      let subtitleName = lnk.label || 'Subtitle';
      if (lnk.href.includes('/api/files/sub/')) {
        const subId = lnk.href.match(/\/sub\/(\d+)/)?.[1];
        if (subId) {
          subtitleName = `Hebrew Subtitle ${subId}`;
        }
      }

      const se = !isMovie ? seTag(season, episode) : undefined;
      let url;
      if (useWizdomEpisodeProxy) {
        const q = `post=${encodeURIComponent(chosen)}${
          se ? `&se=${encodeURIComponent(se)}` : ''
        }${title ? `&title=${encodeURIComponent(title)}` : ''}${
          lnk.href ? `&fallback=${encodeURIComponent(lnk.href)}` : ''
        }`;
        url = `${PROXY_ORIGIN}/proxy/vtt-wizdom?${q}`;
      } else {
        const query = `src=${encodeURIComponent(lnk.href)}${
          se ? `&se=${encodeURIComponent(se)}` : ''
        }${title ? `&title=${encodeURIComponent(title)}` : ''}`;
        url = `${PROXY_ORIGIN}/proxy/vtt?${query}`;
      }
      return {
        id: `wizdom-${i}`,
        lang: 'he',
        name: `Wizdom • ${subtitleName}`,
        url,
        mimeType: 'text/vtt',
      };
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    console.log(`[Stremio] Returning ${subs.length} subtitles`);
    console.log(`🎬 [STREMIO] ===== REQUEST END =====\n`);
    res.json({ subtitles: subs });
  } catch (e) {
    console.error('🎬 [STREMIO] ERROR:', e.message);
    console.log(`🎬 [STREMIO] ===== REQUEST END (ERROR) =====\n`);
    res.status(500).json({ error: 'Failed to fetch subtitles' });
  }
};

// Stremio endpoint - handle both formats: /subtitles/:type/:id and /subtitles/:type/:id/something.json
app.get('/subtitles/:type/:id', handleStremioSubtitles);
app.get(/^\/subtitles\/([^\/]+)\/([^\/]+)\/.*/, handleStremioSubtitles);

// Vidi-compatible endpoints
app.get('/vidi/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

app.get('/vidi/configure', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json({
    type: 'configure',
    args: [],
  });
});

// Vidi subtitles endpoint
app.get('/vidi/subtitles/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    console.log(`[Vidi] Request for ${type}/${id}`);

    // השתמש באותו לוגיקה כמו התוסף הרגיל
    const args = { type, id };
    const isMovie = args.type === 'movie';
    let imdb = args.id;
    let season, episode;

    if (!isMovie) {
      const m = args.id.match(/(tt\d+):(\d+):(\d+)/);
      if (m) {
        imdb = m[1];
        season = Number(m[2]);
        episode = Number(m[3]);
      }
    }

    const { title, year } = await getTitleFromCinemeta(
      isMovie ? 'movie' : 'series',
      imdb
    );

    const queries = [];
    if (isMovie) {
      queries.push(`${title} ${year || ''}`.trim());
      queries.push(`${title}`);
      queries.push(`${title} 1080p`);
    } else {
      const tag = seTag(season, episode);
      queries.push(`${title} ${tag}`);
      queries.push(`${title} ${tag} 1080p`);
      queries.push(`${title} ${tag} WEB`);
      queries.push(`${title} ${tag} WEB-DL`);
      queries.push(`${title} ${tag} HDTV`);
      queries.push(`${title} ${tag} BluRay`);
      queries.push(`${title} ${tag.slice(0, 3)} ${tag.slice(3)}`);
      queries.push(`${title} ${season} ${episode}`);
      queries.push(`${title}`);
    }

    const posts = await findWizdomPageCandidates(queries, imdb);
    if (!posts.length) {
      return res.json({ subtitles: [] });
    }

    let chosen = pickBestPost(posts, { title, season, episode });
    chosen = normalizeUrl(chosen);
    if (!chosen) return res.json({ subtitles: [] });

    let links = [];
    if (isSubtitleFileUrl(chosen)) {
      const ok = await validateDirectSubtitleUrl(
        chosen,
        title,
        season,
        episode
      );
      if (ok) links = [{ href: chosen, label: 'Direct' }];
      else links = [];
    } else {
      links = await extractSubtitleLinksFromPage(chosen);
      const filtered = [];
      for (const l of links) {
        if (!isSubtitleFileUrl(l.href)) continue;
        const ok = await validateDirectSubtitleUrl(
          l.href,
          title,
          season,
          episode
        );
        if (ok) filtered.push(l);
      }
      links = filtered;
    }

    if (!links.length) {
      return res.json({ subtitles: [] });
    }

    const useWizdomEpisodeProxy = !isMovie && /\/(movie|series)\//.test(chosen);
    const subs = links.map((lnk, i) => {
      let subtitleName = lnk.label || 'Subtitle';
      if (lnk.href.includes('/api/files/sub/')) {
        const subId = lnk.href.match(/\/sub\/(\d+)/)?.[1];
        if (subId) {
          subtitleName = `Hebrew Subtitle ${subId}`;
        }
      }

      const se = !isMovie ? seTag(season, episode) : undefined;
      let url;
      if (useWizdomEpisodeProxy) {
        const q = `post=${encodeURIComponent(chosen)}${
          se ? `&se=${encodeURIComponent(se)}` : ''
        }${title ? `&title=${encodeURIComponent(title)}` : ''}${
          lnk.href ? `&fallback=${encodeURIComponent(lnk.href)}` : ''
        }`;
        url = `${PROXY_ORIGIN}/proxy/vtt-wizdom?${q}`;
      } else {
        const query = `src=${encodeURIComponent(lnk.href)}${
          se ? `&se=${encodeURIComponent(se)}` : ''
        }${title ? `&title=${encodeURIComponent(title)}` : ''}`;
        url = `${PROXY_ORIGIN}/proxy/vtt?${query}`;
      }
      return {
        id: `wizdom-${i}`,
        lang: 'he',
        name: `Wizdom • ${subtitleName}`,
        url,
        mimeType: 'text/vtt',
      };
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json({ subtitles: subs });
  } catch (e) {
    console.error('[Vidi] Error:', e.message);
    res.status(500).json({ error: 'Failed to fetch subtitles' });
  }
});

// Ensure VTT header is valid and friendly for strict parsers
function normalizeVttBuffer(vttBuf) {
  try {
    let text = vttBuf.toString('utf8');
    // Replace non-standard header variants
    text = text.replace(/^\uFEFF?WEBVTT FILE\r?\n/, 'WEBVTT\n');
    // Guarantee header exists
    if (!/^WEBVTT\b/.test(text)) text = 'WEBVTT\n\n' + text;
    // Normalize newlines to \n
    text = text.replace(/\r?\n/g, '\n');
    return Buffer.from(text, 'utf8');
  } catch {
    return vttBuf;
  }
}

app.get('/proxy/vtt', async (req, res) => {
  try {
    const src = req.query.src;
    console.log(`[Proxy] request: ${src}`);
    if (!src) return res.status(400).send('missing src');
    const se = (req.query.se || '').toString();
    const title = (req.query.title || '').toString();
    let vtt = await fetchAsVttBuffer(src, { seTag: se, title });

    // הבטחה שהקובץ מתחיל ב-WEBVTT
    const head = vtt.slice(0, 16).toString('utf8').toUpperCase();
    if (!head.includes('WEBVTT')) {
      vtt = Buffer.concat([Buffer.from('WEBVTT\n\n', 'utf8'), vtt]);
    }

    // כותרות חשובות
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Accept-Ranges', 'bytes');

    res.send(vtt);
  } catch (e) {
    console.error('[Proxy] error:', e.message);
    return res.status(500).send('failed to fetch/convert subtitles');
  }
});

// פרוקסי חכם לעמוד סדרה של Wizdom: לוחץ את מספר הפרק ומוריד את ה-ZIP המתאים
app.get('/proxy/vtt-wizdom', async (req, res) => {
  const postUrl = String(req.query.post || '');
  const se = String(req.query.se || '');
  const title = String(req.query.title || '');
  const fallback = String(req.query.fallback || '');
  console.log(
    `[Proxy wizdom] start post="${postUrl}" se=${se} title="${title}"`
  );
  if (!postUrl || !/(movie|series)\//.test(postUrl) || !se) {
    // נפנה לנתיב הרגיל אם חסר משהו
    const src = fallback || postUrl;
    if (!src) return res.status(400).send('missing post/fallback');
    try {
      const vtt = await fetchAsVttBuffer(src, { seTag: se, title });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
      return res.end(vtt);
    } catch (e) {
      console.error('[Proxy wizdom] fallback error:', e.message);
      return res.status(500).send('failed');
    }
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    });
    const page = await browser.newPage();
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // ננסה ללחוץ על הכפתור/לינק של הפרק, לפי מספרו
    const clickResult = await page.evaluate(async (seTag) => {
      const m = /S(\d{2})E(\d{2})/i.exec(seTag || '');
      if (!m) return { clicked: false, reason: 'invalid seTag format' };
      const ep = m[2];
      const epNum = String(Number(ep)); // "01" -> "1"

      // חיפוש יותר ממוקד - חפש את מספר הפרק המדויק
      const allElements = Array.from(document.querySelectorAll('*'));

      // Log all potential episode buttons for debugging
      const buttonTexts = allElements
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t && /^\d+$/.test(t) && t.length <= 2)
        .slice(0, 20); // רק מספרים של 1-2 ספרות, עד 20 ראשונים

      // חפש אלמנט שהטקסט שלו הוא בדיוק מספר הפרק
      let target = null;

      // גישה 1: חפש אלמנט לחיץ שהטקסט שלו הוא בדיוק מספר הפרק
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        const isClickable =
          el.tagName === 'A' ||
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' ||
          el.onclick ||
          el.getAttribute('onclick') ||
          getComputedStyle(el).cursor === 'pointer';

        if (text === epNum && isClickable) {
          target = el;
          break;
        }
      }

      // גישה 2: אם לא מצאנו, חפש אלמנט שהטקסט שלו הוא רק מספר הפרק (ללא אלמנטים אחרים בתוכו)
      if (!target) {
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          const hasOnlyThisText =
            el.children.length === 0 ||
            Array.from(el.children).every(
              (child) => !child.textContent?.trim()
            );

          if (text === epNum && hasOnlyThisText) {
            // נבדק אם האלמנט הזה או ההורה שלו לחיץ
            let clickableParent = el;
            for (let i = 0; i < 3; i++) {
              if (!clickableParent) break;
              const isClickable =
                clickableParent.tagName === 'A' ||
                clickableParent.tagName === 'BUTTON' ||
                clickableParent.getAttribute('role') === 'button' ||
                clickableParent.onclick ||
                clickableParent.getAttribute('onclick') ||
                getComputedStyle(clickableParent).cursor === 'pointer';
              if (isClickable) {
                target = clickableParent;
                break;
              }
              clickableParent = clickableParent.parentElement;
            }
            if (target) break;
          }
        }
      }

      if (target) {
        target.click();
        return {
          clicked: true,
          buttonTexts,
          targetText: target.textContent?.trim(),
          targetTag: target.tagName,
        };
      }

      return {
        clicked: false,
        reason: 'no matching episode button found',
        buttonTexts,
        searchedFor: epNum,
      };
    }, se);

    console.log(`[Proxy wizdom] click result:`, clickResult);

    if (clickResult.clicked) {
      await page
        .waitForNetworkIdle({ idleTime: 800, timeout: 5000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }

    // אסוף קישורי כתוביות לאחר הלחיצה
    const links = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a').forEach((a) => {
        if (
          a.href &&
          (a.href.includes('/api/files/sub/') ||
            /\.(srt|zip)(\?.*)?$/i.test(a.href))
        ) {
          out.push(a.href);
        }
      });
      return out;
    });

    const unique = Array.from(new Set(links));
    const src =
      unique.find((u) => /\/api\/files\/sub\//.test(u)) ||
      unique[0] ||
      fallback;
    console.log(
      `[Proxy wizdom] found ${unique.length} candidates, picked: ${
        src || 'none'
      }`
    );
    if (!src) {
      await browser.close();
      return res.status(404).send('no subtitle link found');
    }

    // הורדה מתוך ההקשר של הדפדפן כדי לשמר cookies/referrer של בחירת הפרק
    const dl = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        const buf = new Uint8Array(await r.arrayBuffer());
        const headers = {};
        r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { body: Array.from(buf), headers, ok: r.ok, status: r.status };
      } catch (e) {
        return { error: e.message };
      }
    }, src);

    await browser.close();

    if (dl.error || !dl.ok) {
      console.log(
        `[Proxy wizdom] fetch failed: ${dl.error || `status ${dl.status}`}`
      );
      throw new Error(`Failed to fetch subtitle: ${dl.error || dl.status}`);
    }

    const raw = Buffer.from(dl.body);
    const headers = dl.headers || {};
    const ct = String(headers['content-type'] || '').toLowerCase();
    const cd = String(headers['content-disposition'] || '');
    const looksZipByHeader = /zip/.test(ct) || /\.zip$/i.test(cd);
    const looksZipByMagic =
      raw.length >= 4 &&
      raw[0] === 0x50 &&
      raw[1] === 0x4b &&
      raw[2] === 0x03 &&
      raw[3] === 0x04;
    const isZip = looksZipByHeader || looksZipByMagic;

    let vtt;
    if (isZip) {
      const zip = new AdmZip(raw);
      const srtEntries = zip
        .getEntries()
        .filter((e) => /\.srt$/i.test(e.entryName));
      if (!srtEntries.length) throw new Error('No SRT inside ZIP');
      let chosen = null;
      const seWanted = (se || '').toLowerCase();
      const titleWanted = (title || '')
        .toLowerCase()
        .replace(/[\s._-]+/g, ' ')
        .trim();
      if (seWanted) {
        chosen = srtEntries.find((e) =>
          e.entryName.toLowerCase().includes(seWanted)
        );
      }
      if (!chosen && seWanted && titleWanted) {
        chosen = srtEntries.find(
          (e) =>
            e.entryName.toLowerCase().includes(seWanted) &&
            e.entryName
              .toLowerCase()
              .replace(/[\s._-]+/g, ' ')
              .includes(titleWanted)
        );
      }
      if (!chosen && seWanted) {
        for (const e of srtEntries) {
          try {
            const txt = toUtf8Buffer(e.getData())
              .toString('utf8')
              .toLowerCase();
            if (txt.includes(seWanted)) {
              chosen = e;
              break;
            }
          } catch {}
        }
      }
      if (!chosen)
        chosen = srtEntries.sort((a, b) => b.header.size - a.header.size)[0];
      const srtBuf = toUtf8Buffer(chosen.getData());
      vtt = await srtBufferToVtt(srtBuf);
    } else {
      const srtBuf = toUtf8Buffer(raw);
      vtt = await srtBufferToVtt(srtBuf);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
    return res.end(vtt);
  } catch (e) {
    console.error('[Proxy wizdom] error:', e.message);
    try {
      if (fallback) {
        const vtt = await fetchAsVttBuffer(fallback, { seTag: se, title });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
        return res.end(vtt);
      }
    } catch {}
    return res.status(500).send('failed');
  }
});

// תמיכה ב-OPTIONS
app.options('/proxy/vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(200).end();
});

// תמיכה ב-HEAD
app.head('/proxy/vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.status(200).end();
});

// אליאס עם סיומת .vtt (יש לקוחות שזה מפשט להם את הזיהוי)
app.get('/proxy/vtt.vtt', async (req, res) => {
  try {
    const src = req.query.src;
    console.log(`[Proxy] request (.vtt): ${src}`);
    if (!src) return res.status(400).send('missing src');
    const se = (req.query.se || '').toString();
    const title = (req.query.title || '').toString();
    let vtt = await fetchAsVttBuffer(src, { seTag: se, title });

    // הבטחה שהקובץ מתחיל ב-WEBVTT
    const head = vtt.slice(0, 16).toString('utf8').toUpperCase();
    if (!head.includes('WEBVTT')) {
      vtt = Buffer.concat([Buffer.from('WEBVTT\n\n', 'utf8'), vtt]);
    }

    // כותרות חשובות
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Accept-Ranges', 'bytes');

    res.send(vtt);
  } catch (e) {
    console.error('[Proxy] error (.vtt):', e.message);
    res.status(500).send('failed to fetch/convert subtitles');
  }
});
app.options('/proxy/vtt.vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.status(200).end();
});

app.head('/proxy/vtt.vtt', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.status(200).end();
});

// HEAD handler for clients probing metadata
app.head('/proxy/vtt', async (req, res) => {
  try {
    const src = req.query.src;
    if (!src) return res.status(400).end();
    let vtt = await fetchAsVttBuffer(src);
    vtt = normalizeVttBuffer(vtt);
    const subIdMatch = /\/sub\/(\d+)/.exec(String(src));
    const fileName = `wizdom-${subIdMatch ? subIdMatch[1] : 'subtitle'}.vtt`;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(vtt.length));
    return res.status(200).end();
  } catch (e) {
    return res.status(500).end();
  }
});

// Alias with .vtt extension to please strict clients
app.get('/proxy/vtt.vtt', async (req, res) => {
  try {
    const src = req.query.src;
    console.log(`[Proxy] request (.vtt): ${src}`);
    if (!src) return res.status(400).send('missing src');
    let vtt = await fetchAsVttBuffer(src);
    vtt = normalizeVttBuffer(vtt);
    const subIdMatch = /\/sub\/(\d+)/.exec(String(src));
    const fileName = `wizdom-${subIdMatch ? subIdMatch[1] : 'subtitle'}.vtt`;
    const total = vtt.length;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      if (!m) return res.status(416).end();
      const start = parseInt(m[1], 10);
      const end = Math.min(total - 1, m[2] ? parseInt(m[2], 10) : total - 1);
      if (start >= total || end < start) return res.status(416).end();
      const chunk = vtt.subarray(start, end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(chunk.length));
      console.log(
        `[Proxy] served VTT (.vtt) range ${start}-${end} (${chunk.length} bytes)`
      );
      return res.end(chunk);
    }
    res.setHeader('Content-Length', String(total));
    console.log(`[Proxy] served VTT (.vtt) full (${total} bytes)`);
    return res.end(vtt);
  } catch (e) {
    console.error('[Proxy] error (.vtt):', e.message);
    return res.status(500).send('failed to fetch/convert subtitles');
  }
});

app.head('/proxy/vtt.vtt', async (req, res) => {
  try {
    const src = req.query.src;
    if (!src) return res.status(400).end();
    let vtt = await fetchAsVttBuffer(src);
    vtt = normalizeVttBuffer(vtt);
    const subIdMatch = /\/sub\/(\d+)/.exec(String(src));
    const fileName = `wizdom-${subIdMatch ? subIdMatch[1] : 'subtitle'}.vtt`;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(vtt.length));
    return res.status(200).end();
  } catch (e) {
    return res.status(500).end();
  }
});

app.listen(ADDON_PORT, HOST, () => {
  const baseUrl =
    process.env.RENDER_EXTERNAL_URL || `http://localhost:${ADDON_PORT}`;
  console.log(`🚀 Wizdom Addon Server running on: ${baseUrl}`);
  console.log(`📡 Stremio Manifest: ${baseUrl}/manifest.json`);
  console.log(`🎬 Vidi Manifest: ${baseUrl}/vidi/manifest.json`);
  console.log(`🔗 Subtitle Proxy: ${baseUrl}/proxy/vtt?src=ENCODED_URL`);
  console.log('\n=== INTEGRATION URLS ===');
  console.log(
    `Stremio: stremio://${baseUrl
      .replace('https://', '')
      .replace('http://', '')}/manifest.json`
  );
  console.log(`Direct: ${baseUrl}/manifest.json`);
  console.log('========================\n');
});
