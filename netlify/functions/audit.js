// netlify/functions/audit.js
// Search-engine SEO audit. Zero external dependencies (Node 18+ global fetch).
// Returns backward-compatible shape: { pct, items:[{status,label,detail,tag}], ... }
// plus category + weight on each item, a categories[] summary, and a site{} snapshot.

// NOTE: Page speed lives in its own function (pagespeed.js) so the main audit
// returns instantly and the slow PageSpeed call gets the full time budget.

const UA = 'SEOZAR-Audit/1.0 (+https://seozar.co)';

/* ---------------- helpers ---------------- */

async function fetchWithTimeout(url, { timeout = 8000, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      signal: ctrl.signal,
    });
    const body = method === 'HEAD' ? '' : await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { ok: res.ok, status: res.status, finalUrl: res.url, redirected: res.redirected, headers, body };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const pass = (o) => ({ status: 'pass', ...o });
const warn = (o) => ({ status: 'warn', ...o });
const fail = (o) => ({ status: 'fail', ...o });
const skip = (o) => ({ status: 'skip', ...o }); // excluded from scoring ("couldn't check")

function firstMatch(re, s) { const m = re.exec(s); return m ? m[1] : null; }

function getMeta(html, name) {
  // matches name="..." or property="..." in any attribute order
  const re = new RegExp(
    `<meta[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']` +
    `|<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`,
    'i'
  );
  const m = re.exec(html);
  return m ? (m[1] || m[2] || '').trim() : null;
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonLd(html) {
  const types = new Set();
  const blocks = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  let broken = false, org = null;
  for (const b of blocks) {
    const json = b.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        const t = n['@type'];
        (Array.isArray(t) ? t : [t]).forEach(x => x && types.add(String(x)));
        if (/organization|localbusiness/i.test(JSON.stringify(t))) org = n;
      }
    } catch { broken = true; }
  }
  return { types: [...types], broken, org };
}

function scorePct(items) {
  let got = 0, max = 0;
  for (const it of items) {
    if (it.status === 'skip') continue;
    const w = it.weight || 1;
    max += w;
    got += it.status === 'pass' ? w : it.status === 'warn' ? w * 0.5 : 0;
  }
  return max ? Math.round((got / max) * 100) : 0;
}

/* ---------------- main audit ---------------- */

async function audit(rawUrl) {
  const target = new URL(rawUrl);
  const origin = `${target.protocol}//${target.host}`;

  // fire everything in parallel so total time ≈ the slowest single call
  const [pageR, robotsR, sitemapR, httpR] = await Promise.all([
    fetchWithTimeout(target.href, { timeout: 8000 }),
    fetchWithTimeout(origin + '/robots.txt', { timeout: 4000 }),
    fetchWithTimeout(origin + '/sitemap.xml', { timeout: 4000 }),
    target.protocol === 'https:' ? fetchWithTimeout('http://' + target.host, { timeout: 4000, method: 'HEAD' }) : Promise.resolve({ ok: false }),
  ]);

  if (!pageR.ok || !pageR.body) {
    const err = new Error('fetch-failed');
    err.friendly = 'We could not load that page. It may be blocking automated checks or be temporarily down.';
    throw err;
  }
  const html = pageR.body;
  const headers = pageR.headers || {};
  const items = [];

  /* --- TECHNICAL --- */
  const isHttps = target.protocol === 'https:' || (pageR.finalUrl || '').startsWith('https:');
  items.push(isHttps
    ? pass({ category: 'technical', label: 'HTTPS enabled', detail: 'Your site loads securely — good for trust and rankings.', tag: 'Secure', weight: 3 })
    : fail({ category: 'technical', label: 'No HTTPS', detail: 'Your site is not served over HTTPS. Install an SSL certificate.', tag: 'Insecure', weight: 3 }));

  const metaRobots = (getMeta(html, 'robots') || '').toLowerCase();
  const xRobots = (headers['x-robots-tag'] || '').toLowerCase();
  const noindex = /noindex/.test(metaRobots) || /noindex/.test(xRobots);
  items.push(noindex
    ? fail({ category: 'technical', label: 'Page set to noindex', detail: 'A noindex directive tells Google to hide this page from search entirely. Remove it if this page should rank.', tag: 'Noindex', weight: 5 })
    : pass({ category: 'technical', label: 'Page is indexable', detail: 'Nothing is blocking search engines from indexing this page.', tag: 'Indexable', weight: 5 }));

  const canonical = firstMatch(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i, html)
    || firstMatch(/<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i, html);
  items.push(canonical
    ? pass({ category: 'technical', label: 'Canonical tag present', detail: 'Tells Google the primary version of this page.', tag: 'Set', weight: 3 })
    : warn({ category: 'technical', label: 'No canonical tag', detail: 'Add a self-referential canonical tag to avoid duplicate-content confusion.', tag: 'Missing', weight: 3 }));

  const viewport = /<meta[^>]*name\s*=\s*["']viewport["']/i.test(html);
  items.push(viewport
    ? pass({ category: 'technical', label: 'Mobile viewport tag', detail: 'The page is set up to render correctly on phones.', tag: 'Present', weight: 3 })
    : fail({ category: 'technical', label: 'No mobile viewport tag', detail: "This usually means the page isn't properly optimised for mobile phones.", tag: 'Missing', weight: 3 }));

  if (isHttps) {
    const mixed = (html.match(/(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi) || []).length;
    items.push(mixed === 0
      ? pass({ category: 'technical', label: 'No mixed content', detail: 'All resources load securely over https.', tag: 'Clean', weight: 3 })
      : warn({ category: 'technical', label: `${mixed} insecure resource(s)`, detail: 'Your secure page loads some http:// resources — switch them to https:// to avoid warnings.', tag: `${mixed} http`, weight: 3 }));
  }

  if (httpR && httpR.ok !== undefined && target.protocol === 'https:') {
    // HEAD to http:// — if it reached https finalUrl or returned a redirect, treat as ok
    const redirected = httpR.redirected || (httpR.finalUrl || '').startsWith('https:');
    items.push(redirected
      ? pass({ category: 'technical', label: 'http → https redirect', detail: 'The insecure version redirects to https.', tag: 'Redirects', weight: 2 })
      : warn({ category: 'technical', label: 'No http → https redirect', detail: 'Add a 301 redirect from http:// to https:// to avoid duplicate URLs.', tag: 'Check', weight: 2 }));
  }

  /* --- ON-PAGE --- */
  const title = (firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html) || '').trim();
  if (!title) items.push(fail({ category: 'onpage', label: 'Missing title tag', detail: 'Every page needs a unique, descriptive title.', tag: 'Missing', weight: 3 }));
  else if (title.length > 60) items.push(warn({ category: 'onpage', label: 'Title may be truncated', detail: `"${title}" (${title.length} chars) — over ~60 chars can get cut off in results.`, tag: `${title.length} chars`, weight: 3 }));
  else if (title.length < 15) items.push(warn({ category: 'onpage', label: 'Title is short', detail: `"${title}" (${title.length} chars) — consider a more descriptive title.`, tag: `${title.length} chars`, weight: 3 }));
  else items.push(pass({ category: 'onpage', label: 'Title tag looks good', detail: `"${title}"`, tag: `${title.length} chars`, weight: 3 }));

  const desc = getMeta(html, 'description');
  if (!desc) items.push(fail({ category: 'onpage', label: 'Missing meta description', detail: 'Add a 120–160 char description — it becomes your search snippet.', tag: 'Missing', weight: 3 }));
  else if (desc.length > 160) items.push(warn({ category: 'onpage', label: 'Meta description long', detail: `${desc.length} chars — over ~160 may be truncated.`, tag: `${desc.length} chars`, weight: 3 }));
  else if (desc.length < 70) items.push(warn({ category: 'onpage', label: 'Meta description short', detail: `${desc.length} chars — consider expanding toward 120–160.`, tag: `${desc.length} chars`, weight: 3 }));
  else items.push(pass({ category: 'onpage', label: 'Meta description looks good', detail: `"${desc.slice(0, 120)}${desc.length > 120 ? '…' : ''}"`, tag: `${desc.length} chars`, weight: 3 }));

  const h1s = html.match(/<h1[\s>]/gi) || [];
  const h1text = (firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html) || '').replace(/<[^>]+>/g, '').trim();
  if (h1s.length === 0) items.push(fail({ category: 'onpage', label: 'No H1 heading', detail: 'Add a single H1 that states the page topic.', tag: 'Missing', weight: 2 }));
  else if (h1s.length === 1) items.push(pass({ category: 'onpage', label: 'Single H1 heading', detail: h1text ? `"${h1text.slice(0, 80)}"` : 'One clear main heading.', tag: '1 H1', weight: 2 }));
  else items.push(warn({ category: 'onpage', label: `${h1s.length} H1 tags found`, detail: 'More than one main heading can confuse search engines about the page topic.', tag: `${h1s.length} H1s`, weight: 2 }));

  const og = ['og:title', 'og:description', 'og:image'].filter(p => getMeta(html, p));
  items.push(og.length === 3
    ? pass({ category: 'onpage', label: 'Open Graph tags set', detail: 'Your page previews correctly when shared.', tag: 'Complete', weight: 2 })
    : warn({ category: 'onpage', label: 'Open Graph incomplete', detail: `Found ${og.length}/3 (og:title, og:description, og:image). Add the rest for better share previews.`, tag: `${og.length}/3`, weight: 2 }));

  /* --- CONTENT --- */
  const text = visibleText(html);
  const words = text ? text.split(/\s+/).length : 0;
  if (words >= 600) items.push(pass({ category: 'content', label: `${words} words on this page`, detail: 'Solid content depth for Google to work with.', tag: `${words} words`, weight: 2 }));
  else if (words >= 300) items.push(warn({ category: 'content', label: `${words} words on this page`, detail: 'A bit thin — more depth usually helps rankings.', tag: `${words} words`, weight: 2 }));
  else items.push(fail({ category: 'content', label: `Only ${words} words`, detail: 'Very thin content. Add more useful text for search engines.', tag: `${words} words`, weight: 2 }));

  const imgs = html.match(/<img[\s>][^>]*>/gi) || [];
  const missingAlt = imgs.filter(t => !/\balt\s*=\s*["'][^"']*["']/i.test(t)).length;
  if (imgs.length === 0) items.push(skip({ category: 'content', label: 'Images', detail: 'No images detected.', tag: 'None', weight: 2 }));
  else if (missingAlt === 0) items.push(pass({ category: 'content', label: 'All images have alt text', detail: 'Good for SEO and accessibility.', tag: `${imgs.length} imgs`, weight: 2 }));
  else items.push(fail({ category: 'content', label: `${missingAlt} of ${imgs.length} images missing alt text`, detail: 'Alt text helps both SEO and visually impaired visitors.', tag: `${missingAlt} missing`, weight: 2 }));

  const h2s = (html.match(/<h2[\s>]/gi) || []).length;
  items.push(h2s >= 2 && h1s.length >= 1
    ? pass({ category: 'content', label: 'Clear heading structure', detail: `Organised subheadings help Google parse sections.`, tag: `${h1s.length} H1 · ${h2s} H2`, weight: 1 })
    : warn({ category: 'content', label: 'Heading structure could improve', detail: 'Use one H1 and several H2s to organise the page.', tag: `${h1s.length} H1 · ${h2s} H2`, weight: 1 }));

  /* --- STRUCTURED DATA --- */
  const ld = extractJsonLd(html);
  if (ld.broken) items.push(warn({ category: 'schema', label: 'Broken structured data', detail: 'Some schema failed to parse. Validate your JSON-LD.', tag: 'Invalid', weight: 2 }));
  else if (ld.types.length) items.push(pass({ category: 'schema', label: 'Structured data detected', detail: `Types found: ${ld.types.slice(0, 6).join(', ')}. Helps Google unlock rich results.`, tag: `${ld.types.length} type(s)`, weight: 2 }));
  else items.push(warn({ category: 'schema', label: 'No structured data', detail: 'Add schema (Organization, Product, FAQ…) to earn richer search listings.', tag: 'None', weight: 2 }));

  /* --- CRAWLABILITY (sitemap) --- */
  let sitemapOk = sitemapR.ok && /<urlset|<sitemapindex/i.test(sitemapR.body || '');
  const robotsHasSitemap = robotsR.ok && /^sitemap:/im.test(robotsR.body || '');
  if (sitemapOk) {
    const count = (sitemapR.body.match(/<loc>/gi) || []).length;
    items.push(pass({ category: 'technical', label: 'Sitemap found', detail: 'Helps Google discover all your pages.', tag: count ? `${count} URLs` : 'Found', weight: 2 }));
  } else if (robotsHasSitemap) {
    items.push(pass({ category: 'technical', label: 'Sitemap referenced', detail: 'A sitemap is linked in robots.txt.', tag: 'Linked', weight: 2 }));
  } else {
    items.push(warn({ category: 'technical', label: 'No sitemap found', detail: 'Add /sitemap.xml so Google can discover all your pages.', tag: 'Missing', weight: 2 }));
  }

  /* ---------------- assemble ---------------- */
  const scored = items.filter(i => !i.informational);
  const cats = [
    ['technical', 'Technical'],
    ['onpage', 'On-Page'],
    ['content', 'Content'],
    ['schema', 'Structured Data'],
  ];
  const categories = cats.map(([key, label]) => {
    const catItems = scored.filter(i => i.category === key);
    return { key, label, pct: catItems.length ? scorePct(catItems) : null, count: catItems.length };
  }).filter(c => c.count > 0);

  return {
    pct: scorePct(scored),
    categories,
    items,
    site: { url: target.href, title: title || null, description: desc || null, h1: h1text || null, schemaTypes: ld.types },
    meta: { fetchedAt: new Date().toISOString() },
  };
}

/* ---------------- handler ---------------- */

exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing url' }) };
    const result = await audit(url);
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
  } catch (e) {
    // Return a non-2xx status so the front-end's `if (!res.ok)` error path triggers
    // (matches the original function's behaviour).
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.friendly || 'Could not fetch or analyze this site. It may be blocking automated requests.' }) };
  }
};
