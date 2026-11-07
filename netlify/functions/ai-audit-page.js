// netlify/functions/ai-audit-page.js
//
// STEP 2 of the whole-website AI audit.
// Analyzes ONE page (called once per page by the browser, so each call stays well inside
// Netlify's time limit).
//
// Request:  { url, lastmod? }   (lastmod = the page's <lastmod> date from the sitemap, if any)
// Response: { url, ok: true, results: { key: { status } }, meta: { lang, hreflang: [...] } }
//           { url, ok: false } when the page could not be fetched
// status is one of: 'pass' | 'warn' | 'fail' | 'na'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let target, lastmod;
  try {
    const body = JSON.parse(event.body || '{}');
    target = new URL(body.url);
    lastmod = typeof body.lastmod === 'string' ? body.lastmod.slice(0, 40) : '';
    if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) throw new Error('bad url');
  } catch (e) {
    return json(400, { error: 'Invalid or missing URL' });
  }

  const r = await fetchRaw(target.href, 8000);
  if (!r.ok || !r.text) return json(200, { url: target.href, ok: false, status: r.status });

  try {
    const analysis = analyzeHtml(r.text, r.hdr, target.pathname, lastmod);
    return json(200, { url: target.href, ok: true, results: analysis.results, meta: analysis.meta });
  } catch (e) {
    return json(200, { url: target.href, ok: false, status: 0 });
  }
};

// ---------------------------------------------------------------- analysis

function analyzeHtml(html, hdr, pathname, sitemapLastmod) {
  const results = {};
  const now = Date.now();

  const metas = parseTags(html, 'meta');
  const links = parseTags(html, 'link');
  const metaBy = (attr, val) => metas.filter(m => (m[attr] || '').toLowerCase() === val);

  // ---- JSON-LD (parsed properly, including @graph and nested objects)
  const ld = extractJsonLd(html);
  const types = new Set();
  ld.nodes.forEach(n => typesOf(n).forEach(t => types.add(t)));

  // Business entity schema
  const hasEntity = Array.from(types).some(isEntityType);
  if (hasEntity) results.entity = { status: 'pass' };
  else if (ld.nodes.length > 0) results.entity = { status: 'warn' };
  else results.entity = { status: 'fail' };

  // FAQ (FAQPage / QAPage schema, or question-style headings)
  const headingTexts = [];
  const hRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm;
  while ((hm = hRe.exec(html))) headingTexts.push({ level: +hm[1], text: hm[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  const questionHeadings = headingTexts.filter(h => h.level >= 2 && h.text.includes('?')).length;
  if (types.has('faqpage') || types.has('qapage')) results.faq = { status: 'pass' };
  else if (questionHeadings >= 2) results.faq = { status: 'warn' };
  else results.faq = { status: 'fail' };

  // Heading structure
  const h1 = headingTexts.filter(h => h.level === 1).length;
  const h2 = (html.match(/<h2[\s>]/gi) || []).length;
  if (h1 === 1 && h2 > 0) results.headings = { status: 'pass' };
  else if (h1 >= 1) results.headings = { status: 'warn' };
  else results.headings = { status: 'fail' };

  // Business description (meta description)
  const descTag = metaBy('name', 'description')[0];
  const desc = descTag && descTag.content ? descTag.content.trim() : '';
  if (desc.length > 50) results.desc = { status: 'pass' };
  else if (desc.length > 0) results.desc = { status: 'warn' };
  else results.desc = { status: 'fail' };

  // Breadcrumb schema (not expected on the homepage)
  if (pathname === '/' || pathname === '') {
    results.breadcrumb = { status: 'na' };
  } else if (types.has('breadcrumblist') || /itemtype=["'][^"']*BreadcrumbList/i.test(html) || /typeof=["']BreadcrumbList/i.test(html)) {
    results.breadcrumb = { status: 'pass' };
  } else {
    results.breadcrumb = { status: 'fail' };
  }

  // Author / Person schema (only for article-type pages)
  const articleNodes = ld.nodes.filter(n => typesOf(n).some(t => ['article', 'blogposting', 'newsarticle', 'techarticle', 'scholarlyarticle'].includes(t)));
  if (!articleNodes.length) {
    results.author = { status: 'na' };
  } else if (articleNodes.some(n => hasAuthorName(n.author))) {
    results.author = { status: 'pass' };
  } else if (metaBy('name', 'author').length || links.some(l => /(^|\s)author(\s|$)/i.test(l.rel || ''))) {
    results.author = { status: 'warn' };
  } else {
    results.author = { status: 'fail' };
  }

  // Last-modified / date signals
  const dates = [];
  const pushDate = (v) => {
    const t = Date.parse(v);
    if (!isNaN(t) && t <= now + 86400000) dates.push(t);
  };
  ld.nodes.forEach(n => { if (n.dateModified) pushDate(String(n.dateModified)); if (n.datePublished) pushDate(String(n.datePublished)); });
  ['article:modified_time', 'og:updated_time', 'article:published_time'].forEach(p => metaBy('property', p).forEach(m => m.content && pushDate(m.content)));
  ['last-modified', 'date', 'revised'].forEach(n => metaBy('name', n).forEach(m => m.content && pushDate(m.content)));
  parseTags(html, 'time').forEach(t => t.datetime && pushDate(t.datetime));
  if (hdr && hdr['last-modified']) pushDate(hdr['last-modified']);
  if (sitemapLastmod) pushDate(sitemapLastmod);
  if (!dates.length) results.lastmod = { status: 'fail' };
  else if (now - Math.max.apply(null, dates) <= 365 * 86400000) results.lastmod = { status: 'pass' };
  else results.lastmod = { status: 'warn' };

  // Language declaration
  const htmlTag = (parseTags(html, 'html')[0]) || {};
  const lang = (htmlTag.lang || '').trim();
  results.lang = /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]+)*$/.test(lang) ? { status: 'pass' } : { status: 'fail' };

  // Image alt text
  const imgs = parseTags(html, 'img');
  if (!imgs.length) {
    results.alt = { status: 'na' };
  } else {
    const withAlt = imgs.filter(i => Object.prototype.hasOwnProperty.call(i, 'alt')).length;
    const cov = withAlt / imgs.length;
    results.alt = { status: cov === 1 ? 'pass' : cov >= 0.5 ? 'warn' : 'fail' };
  }

  // hreflang (only scored by the browser when the site is multi-language)
  const hreflang = links
    .filter(l => /(^|\s)alternate(\s|$)/i.test(l.rel || '') && l.hreflang)
    .map(l => l.hreflang.toLowerCase())
    .filter(h => h !== 'x-default');
  results.hreflang = { status: hreflang.length ? 'pass' : 'fail' };

  // ---- Informational signals (shown, not scored)
  results.canonical = { status: links.some(l => /(^|\s)canonical(\s|$)/i.test(l.rel || '') && l.href) ? 'pass' : 'fail' };
  const ogCount = ['og:title', 'og:description', 'og:image'].filter(p => metaBy('property', p).some(m => m.content)).length;
  results.og = { status: ogCount === 3 ? 'pass' : ogCount > 0 ? 'warn' : 'fail' };

  return { results, meta: { lang: lang.toLowerCase(), hreflang: Array.from(new Set(hreflang)) } };
}

// ---------------------------------------------------------------- helpers

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':') || h.startsWith('[')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return true;
  }
  if (!h.includes('.')) return true;
  return false;
}

async function fetchRaw(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const text = await res.text();
    const hdr = {};
    res.headers.forEach((v, k) => { hdr[k.toLowerCase()] = v; });
    return { ok: res.ok, status: res.status, hdr, text: text.slice(0, 2000000) };
  } catch (e) {
    return { ok: false, status: 0, hdr: {}, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

// Parses every <tag ...> into an object of lowercase attribute names
function parseTags(html, tag) {
  const out = [];
  const tagRe = new RegExp('<' + tag + '(\\s[^>]*)?>', 'gi');
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = tagRe.exec(html)) && out.length < 3000) {
    const attrs = {};
    const s = m[1] || '';
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(s))) {
      const name = a[1].toLowerCase();
      const val = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
      if (!(name in attrs)) attrs[name] = val;
    }
    out.push(attrs);
  }
  return out;
}

function extractJsonLd(html) {
  const nodes = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { collect(JSON.parse(m[1].trim()), nodes, 0); } catch (e) { /* invalid JSON-LD is ignored */ }
  }
  return { nodes };
}
function collect(x, out, depth) {
  if (!x || depth > 8 || out.length > 2000) return;
  if (Array.isArray(x)) { x.forEach(i => collect(i, out, depth + 1)); return; }
  if (typeof x === 'object') {
    out.push(x);
    Object.keys(x).forEach(k => { if (x[k] && typeof x[k] === 'object') collect(x[k], out, depth + 1); });
  }
}
function typesOf(node) {
  const t = node && node['@type'];
  const arr = Array.isArray(t) ? t : t ? [t] : [];
  return arr.filter(x => typeof x === 'string').map(x => x.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());
}
const ENTITY_SET = new Set(['organization', 'localbusiness', 'corporation', 'professionalservice', 'legalservice', 'financialservice', 'realestateagent', 'store', 'restaurant', 'dentist', 'physician', 'hospital', 'school', 'ngo', 'hotel']);
function isEntityType(t) { return ENTITY_SET.has(t) || /(organization|business)$/.test(t); }
function hasAuthorName(a) {
  if (!a) return false;
  if (typeof a === 'string') return a.trim().length > 0;
  if (Array.isArray(a)) return a.some(hasAuthorName);
  if (typeof a === 'object') return typeof a.name === 'string' && a.name.trim().length > 0;
  return false;
}

// exported for local testing only
exports._test = { analyzeHtml, parseTags };
