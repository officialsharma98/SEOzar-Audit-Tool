// netlify/functions/ai-audit-page.js
//
// STEP 2 of the whole-website AI audit.
// Analyzes ONE page (called once per page by the browser, so each call stays well inside
// Netlify's time limit).
//
// Request:  { url, lastmod? }   (lastmod = the page's <lastmod> date from the sitemap, if any)
// Response: { url, ok: true, results: { key: { status } }, meta: { lang, hreflang: [...] } }
//           { url, ok: false } when the page could not be fetched
// status is one of: 'pass' | 'warn' | 'fail' | 'na'   ('na' = this check does not apply to this page)

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
    const analysis = analyzeHtml(r.text, r.hdr, target.pathname, lastmod, target.hostname);
    return json(200, { url: target.href, ok: true, results: analysis.results, meta: analysis.meta });
  } catch (e) {
    return json(200, { url: target.href, ok: false, status: 0 });
  }
};

// ---------------------------------------------------------------- analysis

const ARTICLE_TYPES = ['article', 'blogposting', 'newsarticle', 'techarticle', 'scholarlyarticle', 'report'];
const GENERIC_AUTHOR = /^(admin|administrator|editor|staff|team|author|user|webmaster|guest|unknown)$/i;
const CONTENT_SEG = /^(blog|blogs|news|article|articles|post|posts|insights?|guides?|resources?|learn|stories|magazine|press|updates?)$/i;

function decodeEntities(t) {
  return String(t).replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
}
function textOf(frag) { return decodeEntities(String(frag).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').trim(); }
function hostKey(h) { return String(h || '').replace(/^www\./, '').toLowerCase(); }

function analyzeHtml(html, hdr, pathname, sitemapLastmod, hostname) {
  const results = {};
  const now = Date.now();
  const isHome = pathname === '/' || pathname === '';
  const host = hostKey(hostname);

  const metas = parseTags(html, 'meta');
  const links = parseTags(html, 'link');
  const metaBy = (attr, val) => metas.filter(m => (m[attr] || '').toLowerCase() === val);

  const cleaned = cleanHtml(html);
  const bodyText = textOf((cleaned.match(/<body[\s\S]*$/i) || [cleaned])[0]);
  const words = bodyText ? bodyText.split(/\s+/).filter(w => /[a-zA-Z0-9À-￿]/.test(w)).length : 0;
  const titleText = textOf((cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const visibleNorm = norm(titleText + ' ' + bodyText);

  // ---- JSON-LD (parsed properly, including @graph, nested objects and @id references)
  const ld = extractJsonLd(html);
  const types = new Set();
  ld.nodes.forEach(n => typesOf(n).forEach(t => types.add(t)));
  const byId = {};
  ld.nodes.forEach(n => { if (n && typeof n['@id'] === 'string' && Object.keys(n).length > 1) byId[n['@id']] = n; });
  const ref = (x) => (x && typeof x === 'object' && !Array.isArray(x) && typeof x['@id'] === 'string' && byId[x['@id']] && Object.keys(x).length === 1) ? byId[x['@id']] : x;
  const nameOf = (x) => { x = ref(x); if (typeof x === 'string') return x.trim(); if (Array.isArray(x)) { for (const i of x) { const n = nameOf(i); if (n) return n; } return ''; } return x && typeof x.name === 'string' ? x.name.trim() : ''; };
  const microdata = /itemscope/i.test(html);

  // ---- Business entity (valid, identifiable Organization / LocalBusiness / relevant entity markup)
  const entityNodes = ld.nodes.filter(n => typesOf(n).some(isEntityType));
  const entityNames = [];
  let entityValid = false, entityNameVisible = false;
  entityNodes.forEach(n => {
    const nm = nameOf(n);
    if (nm) entityNames.push(nm);
    const identifying = ['url', 'sameAs', 'logo', 'address', 'telephone', 'email', 'contactPoint', 'image'].some(k => n[k]);
    if (nm && identifying) {
      entityValid = true;
      if (visibleNorm.includes(norm(nm))) entityNameVisible = true;
    }
  });
  if (entityValid && entityNameVisible) results.entity = { status: 'pass' };
  else if (entityNodes.length) results.entity = { status: 'warn' };
  else results.entity = { status: 'fail' };

  // ---- Headings
  const seq = [];
  const hRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm;
  while ((hm = hRe.exec(cleaned)) && seq.length < 400) seq.push({ level: +hm[1], text: textOf(hm[2]) });
  const h1 = seq.filter(h => h.level === 1).length;
  const h2 = seq.filter(h => h.level === 2).length;
  let skips = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i].level > seq[i - 1].level + 1) skips++;
  if (h1 === 1 && h2 > 0 && skips === 0) results.headings = { status: 'pass' };
  else if (h1 >= 1) results.headings = { status: 'warn' };
  else results.headings = { status: 'fail' };

  // ---- FAQ content & FAQPage schema (only evaluated where FAQ content exists)
  const questionHeads = seq.filter(h => h.level >= 2 && h.text.includes('?')).length;
  const summaryQs = (cleaned.match(/<summary[^>]*>[^<]*\?[^<]*<\/summary>/gi) || []).length;
  const faqClass = /(class|id)=["'][^"']*\bfaq/i.test(html);
  const visibleFaq = questionHeads + summaryQs >= 2 || faqClass;
  const faqNodes = ld.nodes.filter(n => typesOf(n).some(t => t === 'faqpage' || t === 'qapage'));
  const faqSchemaValid = faqNodes.some(n => {
    const me = [].concat(n.mainEntity || []).map(ref);
    return me.some(q => q && nameOf(q) && ((q.acceptedAnswer && (ref(q.acceptedAnswer).text || ref(q.acceptedAnswer).name)) || q.suggestedAnswer));
  });
  if (!faqNodes.length && !visibleFaq) results.faq = { status: 'na' };
  else if (faqSchemaValid && visibleFaq) results.faq = { status: 'pass' };
  else results.faq = { status: 'warn' };

  // ---- Meta description (indexable pages only)
  const robotsMeta = (metaBy('name', 'robots')[0] || {}).content || '';
  const noindex = /noindex/i.test(robotsMeta) || /noindex/i.test((hdr && hdr['x-robots-tag']) || '');
  const descTag = metaBy('name', 'description')[0];
  const desc = descTag && descTag.content ? decodeEntities(descTag.content).trim() : '';
  if (noindex) results.desc = { status: 'na' };
  else if (desc.length >= 50 && norm(desc) !== norm(titleText)) results.desc = { status: 'pass' };
  else if (desc.length > 0) results.desc = { status: 'warn' };
  else results.desc = { status: 'fail' };

  // ---- Page type
  const segs = pathname.split('/').filter(Boolean);
  const ogType = ((metaBy('property', 'og:type')[0] || {}).content || '').toLowerCase();
  const articleNodes = ld.nodes.filter(n => typesOf(n).some(t => ARTICLE_TYPES.includes(t)));
  const isArticle = articleNodes.length > 0 || ogType === 'article' || metaBy('property', 'article:published_time').length > 0;
  const timeSensitive = isArticle || segs.slice(0, -1).some(x => CONTENT_SEG.test(x));

  // ---- Author / Person schema (editorial pages only)
  if (!isArticle) {
    results.author = { status: 'na' };
  } else {
    const authorOk = articleNodes.some(n => { const nm = nameOf(n.author); return nm && !GENERIC_AUTHOR.test(nm); });
    if (authorOk) results.author = { status: 'pass' };
    else if (articleNodes.some(n => nameOf(n.author)) || metaBy('name', 'author').length || links.some(l => /(^|\s)author(\s|$)/i.test(l.rel || ''))) results.author = { status: 'warn' };
    else results.author = { status: 'fail' };
  }

  // ---- Breadcrumb schema (inner pages; markup should match a visible trail)
  if (isHome) {
    results.breadcrumb = { status: 'na' };
  } else {
    const bcNodes = ld.nodes.filter(n => typesOf(n).includes('breadcrumblist'));
    const items = [];
    bcNodes.forEach(n => [].concat(n.itemListElement || []).forEach(i => { const nm = nameOf(i.item && typeof i.item === 'object' ? i.item : i) || nameOf(i); if (nm) items.push(nm); }));
    const microBc = /itemtype=["'][^"']*BreadcrumbList/i.test(html) || /typeof=["']BreadcrumbList/i.test(html);
    const schemaOk = (bcNodes.length > 0 && items.length >= 2) || microBc;
    const m = /<(nav|ol|ul|div)\b[^>]*(?:class|id|aria-label)=["'][^"']*breadcrumb[^"']*["'][^>]*>/i.exec(cleaned);
    const trail = m ? norm(textOf(cleaned.slice(m.index, m.index + 3000))) : '';
    const visible = !!m || microBc;
    let matches = true;
    if (items.length && trail) matches = items.filter(n => trail.includes(norm(n))).length >= Math.ceil(items.length / 2);
    if (schemaOk && visible && matches) results.breadcrumb = { status: 'pass' };
    else if (schemaOk || visible) results.breadcrumb = { status: 'warn' };
    else results.breadcrumb = { status: 'fail' };
  }

  // ---- Schema validity & consistency (only pages that have structured data)
  if (!ld.blocks && !microdata) {
    results.schema = { status: 'na' };
  } else {
    let fail = ld.invalid > 0, warn = ld.noContext > 0;
    ld.nodes.forEach(n => {
      const t = typesOf(n);
      if (!t.length) return;
      const has = (k) => !!(n[k] && (typeof n[k] !== 'string' || n[k].trim()));
      if (t.some(isEntityType) && !nameOf(n)) warn = true;
      if (t.includes('localbusiness') && !(has('address') || has('telephone'))) warn = true;
      if (t.some(x => ARTICLE_TYPES.includes(x)) && !(has('headline') || has('name'))) warn = true;
      if (t.some(x => ARTICLE_TYPES.includes(x)) && !(has('datePublished') || has('dateModified'))) warn = true;
      if (t.includes('product') && !nameOf(n)) warn = true;
      if (t.includes('person') && !nameOf(n)) warn = true;
      if (t.includes('faqpage') && !faqSchemaValid) warn = true;
      if (t.includes('breadcrumblist') && ![].concat(n.itemListElement || []).length) warn = true;
      if (t.some(x => ['organization', 'website', 'webpage'].includes(x)) && typeof n.url === 'string') {
        try { if (hostKey(new URL(n.url, 'https://' + hostname).hostname) !== host) warn = true; } catch (e) { /* ignore */ }
      }
      if (t.some(isEntityType) && nameOf(n) && !visibleNorm.includes(norm(nameOf(n)))) warn = true;
    });
    results.schema = { status: fail ? 'fail' : warn ? 'warn' : (ld.blocks ? 'pass' : 'warn') };
  }

  // ---- Freshness / date signals
  const explicit = [], weak = [];
  const pushDate = (arr, v) => {
    const t = Date.parse(v);
    if (!isNaN(t) && t <= now + 86400000 && t > Date.parse('1995-01-01')) arr.push(t);
  };
  ld.nodes.forEach(n => { if (n.dateModified) pushDate(explicit, String(n.dateModified)); if (n.datePublished) pushDate(explicit, String(n.datePublished)); });
  ['article:modified_time', 'og:updated_time', 'article:published_time'].forEach(p => metaBy('property', p).forEach(m => m.content && pushDate(explicit, m.content)));
  ['last-modified', 'date', 'revised'].forEach(n => metaBy('name', n).forEach(m => m.content && pushDate(explicit, m.content)));
  parseTags(html, 'time').forEach(t => t.datetime && pushDate(explicit, t.datetime));
  if (hdr && hdr['last-modified']) pushDate(weak, hdr['last-modified']);
  if (sitemapLastmod) pushDate(weak, sitemapLastmod);
  if (explicit.length) results.lastmod = { status: 'pass' };
  else if (timeSensitive) results.lastmod = { status: weak.length ? 'warn' : 'fail' };
  else results.lastmod = { status: 'na' };   // evergreen page with no dates: not penalised

  // ---- Language declaration
  const htmlTag = (parseTags(html, 'html')[0]) || {};
  const lang = (htmlTag.lang || '').trim();
  results.lang = /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]+)*$/.test(lang) ? { status: 'pass' } : { status: 'fail' };

  // ---- Image alt text (informative images; empty alt on decorative images is correct)
  const imgs = parseTags(cleaned, 'img');
  const informative = imgs.filter(i => {
    if ((i['aria-hidden'] || '').toLowerCase() === 'true' || /^(presentation|none)$/i.test(i.role || '')) return false;
    if ((+i.width <= 2 && i.width !== undefined && i.width !== '') || (+i.height <= 2 && i.height !== undefined && i.height !== '')) return false;
    if (Object.prototype.hasOwnProperty.call(i, 'alt') && i.alt.trim() === '') return false; // decorative
    return true;
  });
  if (!informative.length) {
    results.alt = { status: 'na' };
  } else {
    const meaningful = informative.filter(i => {
      const a = (i.alt || '').trim();
      return a.length >= 3 && !/\.(jpe?g|png|gif|webp|svg|avif)$/i.test(a) && !/^(image|img|photo|picture|logo|banner|icon|untitled|dsc|screenshot)[\s_-]*\d*$/i.test(a) && !/^\d+$/.test(a);
    }).length;
    const cov = meaningful / informative.length;
    results.alt = { status: cov >= 0.9 ? 'pass' : cov >= 0.5 ? 'warn' : 'fail' };
  }

  // ---- Page text extractability (is the important text in the raw HTML?)
  const shell = /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html) || (words < 40 && parseTags(html, 'script').length >= 3);
  if (shell && words < 40) results.extract = { status: 'fail' };
  else if (words >= 100) results.extract = { status: 'pass' };
  else if (words >= 40) results.extract = { status: 'warn' };
  else results.extract = { status: 'fail' };

  // ---- Internal linking (crawlable links in the body of the page)
  const internal = (frag) => {
    const out = new Set();
    const re = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(frag)) && out.size < 500) {
      const h = m[1].trim();
      if (/^(mailto:|tel:|javascript:|data:)/i.test(h)) continue;
      let u;
      try { u = new URL(h, 'https://' + hostname + pathname); } catch (e) { continue; }
      if (hostKey(u.hostname) !== host) continue;
      if (/\.(jpe?g|png|gif|svg|webp|pdf|zip|css|js)$/i.test(u.pathname)) continue;
      if (!textOf(m[2]) && !/<img/i.test(m[2]) && !/aria-label/i.test(m[0])) continue;
      const key = u.pathname.replace(/\/+$/, '') || '/';
      if (key === (pathname.replace(/\/+$/, '') || '/')) continue;
      out.add(key);
    }
    return out;
  };
  const bodyOnly = cleaned.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const bodyLinks = internal(bodyOnly).size, allLinks = internal(cleaned).size;
  if (bodyLinks >= 3) results.links = { status: 'pass' };
  else if (bodyLinks >= 1 || allLinks >= 5) results.links = { status: 'warn' };
  else results.links = { status: 'fail' };

  // ---- Business & service content clarity (signals the browser combines across all pages)
  const low = (bodyText + ' ' + seq.map(h => h.text).join(' ') + ' ' + pathname).toLowerCase();
  const schemaGeo = ld.nodes.some(n => n.areaServed || n.address || typesOf(n).includes('postaladdress') || typesOf(n).includes('place'));
  const clarity = {
    what: words >= 100 && h1 >= 1 && (desc.length >= 50 || /<p[^>]*>[^<]{60,}/i.test(cleaned)),
    services: ld.nodes.some(n => typesOf(n).some(t => ['service', 'product', 'offer', 'itemlist'].includes(t))) ||
      /\b(our services?|services?|products?|solutions?|what we (do|offer)|packages|pricing|plans|collections?|shop)\b/.test(seq.map(h => h.text).join(' ').toLowerCase() + ' ' + segs.join(' ')),
    audience: /\b(for|helps?|helping|serv(?:e|es|ing)|built for|designed for|trusted by)\s+(?:\w+\s+){0,3}(businesses|brands|companies|customers|clients|startups|teams|families|patients|students|owners|ecommerce|e-commerce|enterprises|professionals|shoppers|agencies|farmers|homes?)\b/.test(low),
    geo: schemaGeo || /\b(located in|based in|headquartered|serving|service area|we serve|pan[- ]india|worldwide|globally|visit us|our (?:office|store|showroom|clinic)|across india|near you)\b/.test(low),
    diff: /\b(why choose|why us|our approach|what makes us|years of experience|since (?:19|20)\d\d|award|certified|guarantee|trusted by|case stud|testimonials?|customer reviews?|our story|our mission)\b/.test(low)
  };

  // ---- Informational signals (shown, not scored)
  results.canonical = { status: links.some(l => /(^|\s)canonical(\s|$)/i.test(l.rel || '') && l.href) ? 'pass' : 'fail' };
  const ogCount = ['og:title', 'og:description', 'og:image'].filter(p => metaBy('property', p).some(m => m.content)).length;
  results.og = { status: ogCount === 3 ? 'pass' : ogCount > 0 ? 'warn' : 'fail' };
  const hreflang = links
    .filter(l => /(^|\s)alternate(\s|$)/i.test(l.rel || '') && l.hreflang)
    .map(l => l.hreflang.toLowerCase())
    .filter(h => h !== 'x-default');
  results.hreflang = { status: hreflang.length ? 'pass' : 'fail' };

  return {
    results,
    meta: {
      lang: lang.toLowerCase(), hreflang: Array.from(new Set(hreflang)), isHome, hasSchema: !!(ld.blocks || microdata),
      entityNames: entityNames.slice(0, 5), desc: norm(desc).slice(0, 200), words, clarity
    }
  };
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
  let blocks = 0, invalid = 0, noContext = 0;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    blocks++;
    try {
      const parsed = JSON.parse(m[1].trim());
      const tops = Array.isArray(parsed) ? parsed : [parsed];
      if (tops.some(t => t && typeof t === 'object' && !t['@context'])) noContext++;
      collect(parsed, nodes, 0);
    } catch (e) { invalid++; }
  }
  return { nodes, blocks, invalid, noContext };
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
exports._test = { analyzeHtml, parseTags, extractJsonLd };
