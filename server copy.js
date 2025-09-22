// server.js — Wizdom subtitles addon for Stremio
// v1.4 — validate direct links by filename + Hebrew encoding fix (Windows-1255/ISO-8859-8)

const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const cheerio = require('cheerio');
const { LRUCache } = require('lru-cache');
const AdmZip = require('adm-zip');
const srt2vtt = require('srt-to-vtt');
const { Readable } = require('stream');
const { URL } = require('url');
const iconv = require('iconv-lite');
const chardet = require('jschardet');

// ---------- Ports / Origins ----------
const ADDON_PORT = 7010;
const PROXY_PORT = 7001;
const PROXY_ORIGIN = `http://localhost:${PROXY_PORT}`;

// ---------- Search bases & overrides ----------
const SEARCH_BASES = [
  'https://wizdom.xyz',
  'http://wizdom.xyz',
  'https://www.wizdom.xyz',
  'http://www.wizdom.xyz'
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
  idPrefixes: ['tt']
};

// ---------- Cache ----------
const cache = new LRUCache({ max: 200, ttl: 1000 * 60 * 30 }); // 30m

// ---------- Utils ----------
function srtBufferToVtt(buf) {
  return new Promise((resolve, reject) => {
    const rs = Readable.from(buf);
    const chunks = [];
    rs.pipe(srt2vtt())
      .on('data', c => chunks.push(c))
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

// נרמול URL (כולל פירוק redirect של DuckDuckGo)
function normalizeUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
      const target = parsed.searchParams.get('uddg');
      if (target) return normalizeUrl(decodeURIComponent(target));
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

const isSubtitleFileUrl = (href) =>
  /\.srt(\?.*)?$/i.test(href) || /\.zip(\?.*)?$/i.test(href) || /\/api\/files\/sub\//i.test(href);

const HEADERS_HTML = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

// בדיקת התאמה של שם קובץ לשם כותר + SxxEyy
function seTag(season, episode) {
  if (!season || !episode) return null;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
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
  const hasTitle = titleNorm && name.includes(titleNorm);
  const hasSE = tag ? name.includes(tag.toLowerCase()) : true; // לסרטים אין SE
  return hasSE && (hasTitle || !titleNorm); // דורש S/E ולפחות כותר אם יש
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
      year: data?.meta?.year
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
  $('a').each((_, a) => {
    const href0 = ($(a).attr('href') || '').trim();
    const hrefAbs = href0.startsWith('http') ? href0 : new URL(href0, base).href;
    const href = normalizeUrl(hrefAbs);
    const text = ($(a).text() || '').trim();
    if (href && /wizdom\.xyz/i.test(href)) posts.push({ href, text });
  });
  return posts;
}

async function findWizdomPageCandidates(queries) {
  for (const base of SEARCH_BASES) {
    for (const q of queries) {
      const url = `${base}/?s=${encodeURIComponent(q)}`;
      console.log(`[Search] wizdom → ${url}`);
      try {
        const res = await fetch(url, { headers: HEADERS_HTML });
        if (!res.ok) { console.log(`[Search] status ${res.status}`); continue; }
        const html = await res.text();
        const posts = extractWizdomLinksFromHtml(html, base);
        if (posts.length) {
          console.log(`[Search] wizdom found ${posts.length} posts for "${q}"`);
          return posts;
        }
      } catch (e) {
        console.log(`[Search] wizdom fetch error: ${e.message}`);
      }
    }
  }

  // fallback: DuckDuckGo
  for (const q of queries) {
    const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent('site:wizdom.xyz ' + q)}`;
    console.log(`[Search] DDG → ${ddg}`);
    try {
      const res = await fetch(ddg, { headers: HEADERS_HTML });
      if (!res.ok) { console.log(`[Search] DDG status ${res.status}`); continue; }
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
  const direct = posts.find(p => isSubtitleFileUrl(p.href));
  if (direct) return direct.href;

  const tag = seTag(season, episode)?.toLowerCase();
  const tnorm = (title || '').toLowerCase();

  // עדיפות 1: קישור שמכיל גם SxxEyy וגם שם הכותר
  const byBoth = posts.find(p =>
    ((p.text || '').toLowerCase().includes(tnorm) || (p.href || '').toLowerCase().includes(tnorm)) &&
    tag && ((p.text || '').toLowerCase().includes(tag) || (p.href || '').toLowerCase().includes(tag))
  );
  if (byBoth) return byBoth.href;

  // עדיפות 2: רק SxxEyy
  if (tag) {
    const bySE = posts.find(p =>
      (p.text || '').toLowerCase().includes(tag) || (p.href || '').toLowerCase().includes(tag)
    );
    if (bySE) return bySE.href;
  }

  // עדיפות 3: לפי שם
  const byTitle = posts.find(p =>
    (p.text || '').toLowerCase().includes(tnorm) || (p.href || '').toLowerCase().includes(tnorm)
  );
  if (byTitle) return byTitle.href;

  return posts[0]?.href || null;
}

// חילוץ קישורי כתוביות מדף
async function extractSubtitleLinksFromPage(pageUrl) {
  const key = `page:${pageUrl}`;
  if (cache.has(key)) return cache.get(key);

  console.log(`[Extract] page: ${pageUrl}`);
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.log(`[Extract] status ${res.status}`); return []; }
  const html = await res.text();
  const $ = cheerio.load(html);

  const links = [];
  $('a').each((_, a) => {
    const href0 = ($(a).attr('href') || '').trim();
    const abs = href0.startsWith('http') ? href0 : new URL(href0, pageUrl).href;
    const href = normalizeUrl(abs);
    if (!href) return;
    const label = ($(a).text() || '').trim();
    if (isSubtitleFileUrl(href)) links.push({ href, label: label || 'Subtitle' });
  });

  console.log(`[Extract] found ${links.length} subtitle links`);
  cache.set(key, links);
  return links;
}

// אימות קישור ישיר (לפי שם קובץ)
async function validateDirectSubtitleUrl(urlStr, title, season, episode) {
  try {
    const head = await fetch(urlStr, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    // אם HEAD חסום, ננסה GET עם טווח 0 כדי לקבל רק כותרות
    let headers = head.headers;
    if (!head.ok || !headers || !headers.get('content-disposition')) {
      const r = await fetch(urlStr, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' } });
      headers = r.headers;
    }
    const fname = filenameFromUrlOrHeader(urlStr, headers) || '';
    const ok = looksLikeMatch(fname, title, season, episode);
    console.log(`[Validate] direct link filename="${fname}" → match=${ok}`);
    return ok;
  } catch (e) {
    console.log('[Validate] error:', e.message);
    return false;
  }
}

// ---------- Download/convert ----------
async function fetchAsVttBuffer(srcUrl) {
  const key = `vtt:${srcUrl}`;
  if (cache.has(key)) return cache.get(key);

  console.log(`[FetchVTT] get: ${srcUrl}`);
  const r = await fetch(srcUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`subtitle fetch ${r.status}`);
  const raw = Buffer.from(await r.arrayBuffer());

  let vtt;
  if (/\.zip(\?.*)?$/i.test(srcUrl)) {
    const zip = new AdmZip(raw);
    const srtEntry = zip.getEntries().find(e => /\.srt$/i.test(e.entryName));
    if (!srtEntry) throw new Error('No SRT inside ZIP');
    const srtBuf = toUtf8Buffer(srtEntry.getData()); // ← תקון קידוד
    vtt = await srtBufferToVtt(srtBuf);
  } else if (/\.srt(\?.*)?$/i.test(srcUrl) || /\/api\/files\/sub\//i.test(srcUrl)) {
    const srtBuf = toUtf8Buffer(raw); // ← תקון קידוד גם כשאין סיומת
    vtt = await srtBufferToVtt(srtBuf);
  } else {
    throw new Error('Unsupported subtitle format');
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
    if (m) { imdb = m[1]; season = Number(m[2]); episode = Number(m[3]); }
  }

  const { title, year } = await getTitleFromCinemeta(isMovie ? 'movie' : 'series', imdb);
  console.log(`[Addon] id=${args.id} → title="${title}" year=${year || '-'} s=${season||'-'} e=${episode||'-'}`);

  const queries = [];
  if (isMovie) {
    queries.push(`${title} ${year || ''}`.trim());
    queries.push(`${title}`);
    queries.push(`${title} 1080p`);
  } else {
    const tag = seTag(season, episode);
    queries.push(`${title} ${tag}`);
    queries.push(`${title} ${tag.slice(0,3)} ${tag.slice(3)}`);
    queries.push(`${title} ${tag} 1080p`);
    queries.push(`${title} ${tag} WEB`);
    queries.push(`${title} ${season} ${episode}`);
    queries.push(`${title}`);
  }

  const posts = await findWizdomPageCandidates(queries);
  if (!posts.length) {
    console.log('[Addon] No wizdom posts for queries:', queries);
    return { subtitles: [] };
  }

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
      console.log('[Addon] direct link failed validation, trying to parse page (if any)');
      // אם זה /api/files/sub שלא מתאים – אין דף; ננסה לוותר ולהחזיר ריק
      links = [];
    }
  } else {
    links = await extractSubtitleLinksFromPage(chosen);
    // סנן רק כאלה שמתאימים לפי שם קובץ
    const filtered = [];
    for (const l of links) {
      if (!isSubtitleFileUrl(l.href)) continue;
      const ok = await validateDirectSubtitleUrl(l.href, title, season, episode);
      if (ok) filtered.push(l);
    }
    links = filtered;
  }

  if (!links.length) {
    console.log('[Addon] No validated subtitle links');
    return { subtitles: [] };
  }

  const subs = links.map((lnk, i) => ({
    id: `wizdom-${i}`,
    lang: 'heb',
    name: `Wizdom • ${lnk.label}`,
    url: `${PROXY_ORIGIN}/proxy/vtt?src=${encodeURIComponent(lnk.href)}`
  }));

  console.log(`[Addon] ${subs.length} subtitles:`);
  subs.forEach(s => console.log(`   -> ${s.name} | ${s.url}`));

  return { subtitles: subs };
});

// ---------- Servers ----------
serveHTTP(addon.getInterface(), { port: ADDON_PORT }, () => {
  console.log(`HTTP addon accessible at: http://127.0.0.1:${ADDON_PORT}/manifest.json`);
  console.log(`TIP: install via → stremio://localhost:${ADDON_PORT}/manifest.json`);
});

const app = express();

app.get('/proxy/vtt', async (req, res) => {
  try {
    const src = req.query.src;
    console.log(`[Proxy] request: ${src}`);
    if (!src) return res.status(400).send('missing src');
    const vtt = await fetchAsVttBuffer(src);
    console.log(`[Proxy] served VTT (${vtt.length} bytes)`);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
  } catch (e) {
    console.error('[Proxy] error:', e.message);
    res.status(500).send('failed to fetch/convert subtitles');
  }
});

app.listen(PROXY_PORT, () => {
  console.log(`Subtitle proxy at: ${PROXY_ORIGIN}/proxy/vtt?src=ENCODED_URL`);
});
