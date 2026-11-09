// netlify/functions/ai-audit-domain.js
//
// STEP 1 of the whole-website AI audit.
// Runs every check that applies to the WHOLE site (once), and discovers up to 10 pages
// for the browser to scan one-by-one using ai-audit-page.js.
//
// Returns: { items: [...], pages: [{url, lastmod}], multiLang: boolean }
// Each item: { key, status: 'pass'|'warn'|'fail'|'na'|'info', label, detail, tag }

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BOT_UAS = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexitybot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)'
};
const MAX_PAGES = 10;
const DEADLINE_MS = 8500; // Netlify's default function limit is 10s; stay safely under it
const SKIP_EXT = /\.(jpe?g|png|gif|svg|webp|avif|pdf|zip|xml|css|js|json|mp4|mp3|ico|woff2?|txt|docx?|xlsx?)$/i;
const LANG_CODES = new Set(['en','hi','fr','de','es','it','pt','nl','ru','ja','ko','zh','ar','tr','pl','sv','da','no','fi','id','th','vi','bn','ta','te','mr','gu','kn','ml','pa','ur','he','el','cs','ro','hu','uk']);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let target;
  try {
    const body = JSON.parse(event.body || '{}');
    target = new URL(body.url);
    if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) throw new Error('bad url');
  } catch (e) {
    return json(400, { error: 'Invalid or missing URL' });
  }

  const started = Date.now();
  const remaining = () => DEADLINE_MS - (Date.now() - started);
  const tmo = (max) => Math.max(800, Math.min(max, remaining()));
  const origin = target.origin;

  try {
    // ---------- Batch 1: everything we can fetch in parallel ----------
    const [robotsR, llmsR, llmsFullR, skillsR, pluginR, homeBrowser, homeGpt, homeClaude, homePerp, smA, smB, smC] = await Promise.all([
      fetchRaw(origin + '/robots.txt', { timeout: tmo(4000) }),
      fetchRaw(origin + '/llms.txt', { timeout: tmo(4000) }),
      fetchRaw(origin + '/llms-full.txt', { timeout: tmo(4000) }),
      fetchRaw(origin + '/skills.json', { timeout: tmo(4000) }),
      fetchRaw(origin + '/.well-known/ai-plugin.json', { timeout: tmo(4000) }),
      fetchRaw(origin + '/', { timeout: tmo(5000) }),
      fetchRaw(origin + '/', { timeout: tmo(5000), ua: BOT_UAS.gptbot }),
      fetchRaw(origin + '/', { timeout: tmo(5000), ua: BOT_UAS.claudebot }),
      fetchRaw(origin + '/', { timeout: tmo(5000), ua: BOT_UAS.perplexitybot }),
      fetchRaw(origin + '/sitemap.xml', { timeout: tmo(4000) }),
      fetchRaw(origin + '/sitemap_index.xml', { timeout: tmo(4000) }),
      fetchRaw(origin + '/wp-sitemap.xml', { timeout: tmo(4000) })
    ]);

    const items = [];

    // ---------- AI crawler access (robots.txt) ----------
    const robotsText = robotsR.ok ? robotsR.text : '';
    const groups = parseRobots(robotsText);
    const bots = [
      { key: 'gptbot', agent: 'gptbot', label: 'GPTBot (ChatGPT)' },
      { key: 'claudebot', agent: 'claudebot', label: 'ClaudeBot (Claude)' },
      { key: 'perplexitybot', agent: 'perplexitybot', label: 'PerplexityBot' },
      { key: 'google-extended', agent: 'google-extended', label: 'Google-Extended (AI Overviews)' }
    ];
    for (const bot of bots) {
      const st = checkBotAccess(groups, bot.agent);
      if (st === 'blocked') {
        items.push(item(bot.key, 'fail', `${bot.label} is blocked`, `Your robots.txt blocks ${bot.label} from your whole site, so it can't read any of your pages.`, 'Blocked'));
      } else if (st === 'partial') {
        items.push(item(bot.key, 'warn', `${bot.label} has partial restrictions`, `Some content sections of your site are off-limits to ${bot.label}.`, 'Partial'));
      } else {
        items.push(item(bot.key, 'pass', `${bot.label} can access your site`, `Nothing in your robots.txt stops ${bot.label} from reading your content.`, 'Allowed'));
      }
    }

    // ---------- llms.txt / llms-full.txt ----------
    const hasLlms = isPlainText(llmsR);
    const hasLlmsFull = isPlainText(llmsFullR);
    if (hasLlms) {
      items.push(item('llms', 'pass', 'llms.txt found', 'You have a dedicated file that summarizes your site for AI systems. It is still a new and uncommon standard.', 'Found'));
    } else {
      items.push(item('llms', 'warn', 'No llms.txt file', 'A new, still-emerging standard. Not urgent, but a short llms.txt helps AI tools understand your business quickly.', 'Not found'));
    }
    if (hasLlmsFull) {
      items.push(item('llmsfull', 'pass', 'llms-full.txt found', 'You also publish the extended version with fuller content for AI systems.', 'Found'));
    } else if (hasLlms) {
      items.push(item('llmsfull', 'warn', 'No llms-full.txt file', 'You have llms.txt but not the extended llms-full.txt, which gives AI tools your fuller content in one place.', 'Not found'));
    } else {
      items.push(item('llmsfull', 'na', 'llms-full.txt', 'Skipped because there is no llms.txt yet.', 'Skipped'));
    }

    // ---------- Sitemap ----------
    let sm = [smA, smB, smC].find(isSitemap);
    if (!sm && remaining() > 1500) {
      const declared = declaredSitemaps(robotsText).slice(0, 2);
      if (declared.length) {
        const rs = await Promise.all(declared.map(u => fetchRaw(u, { timeout: tmo(3000) })));
        sm = rs.find(isSitemap);
      }
    }
    let entries = [];
    let sitemapCount = null;
    let indexCount = null;
    if (sm) {
      if (/<sitemapindex/i.test(sm.text)) {
        const kids = locs(sm.text);
        indexCount = kids.length;
        const chosen = rankChildren(kids).filter(u => safeHttp(u)).slice(0, 4);
        if (chosen.length && remaining() > 1500) {
          const rs = await Promise.all(chosen.map(u => fetchRaw(u, { timeout: tmo(3500) })));
          rs.forEach(r => { if (isSitemap(r)) entries.push(...sitemapEntries(r.text)); });
        }
      } else {
        entries = sitemapEntries(sm.text);
        sitemapCount = entries.length;
      }
    }
    if (sm) {
      const detail = indexCount !== null
        ? `Found a sitemap index listing ${indexCount} sitemaps. AI crawlers use it to discover every page on your site.`
        : `Found, listing ${sitemapCount} page${sitemapCount === 1 ? '' : 's'}. AI crawlers use it to discover every page on your site.`;
      items.push(item('sitemap', 'pass', 'Sitemap found', detail, 'Found'));
    } else {
      items.push(item('sitemap', 'fail', 'No sitemap found', 'Without a sitemap, AI crawlers may only ever see your homepage and miss the rest of your site.', 'Not found'));
    }

    // ---------- Firewall / CDN bot-block test ----------
    items.push(firewallItem(homeBrowser, { gptbot: homeGpt, claudebot: homeClaude, perplexitybot: homePerp }));

    // ---------- AI layer files (informational, not scored) ----------
    const skillsOk = isJsonObject(skillsR);
    const pluginOk = isJsonObject(pluginR);
    if (skillsOk || pluginOk) {
      items.push(item('ailayer', 'info', 'AI layer files found', `Found ${[skillsOk ? '/skills.json' : null, pluginOk ? '/.well-known/ai-plugin.json' : null].filter(Boolean).join(' and ')}. These machine-readable files tell AI agents what your site or business can do. Very few sites have them yet.`, 'Found'));
    } else {
      items.push(item('ailayer', 'info', 'AI layer files (bonus)', 'No /skills.json or /.well-known/ai-plugin.json found. These are very new and almost no sites have them, so this is not counted in your score.', 'Not found'));
    }

    // ---------- Page discovery ----------
    const pages = pickPages(origin, entries, homeBrowser.ok ? homeBrowser.text : '');

    // ---------- Multi-language detection (for the hreflang check) ----------
    const prefixes = new Set();
    for (const e of entries) {
      try {
        const seg = new URL(e.url).pathname.split('/')[1];
        if (seg && LANG_CODES.has(seg.toLowerCase())) prefixes.add(seg.toLowerCase());
      } catch (e2) { /* ignore */ }
    }

    return json(200, { items, pages, multiLang: prefixes.size >= 2 });
  } catch (e) {
    return json(502, { error: 'Could not analyze this site.' });
  }
};

// ---------------------------------------------------------------- helpers

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function item(key, status, label, detail, tag) { return { key, status, label, detail, tag: tag || '' }; }

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':') || h.startsWith('[')) return true; // IPv6 literals
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return true;
  }
  if (!h.includes('.')) return true;
  return false;
}
function safeHttp(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !isBlockedHost(x.hostname); } catch (e) { return false; }
}

async function fetchRaw(url, opts) {
  const { ua = BROWSER_UA, timeout = 4500, maxChars = 1500000 } = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const text = await res.text();
    const hdr = {};
    res.headers.forEach((v, k) => { hdr[k.toLowerCase()] = v; });
    return { ok: res.ok, status: res.status, hdr, text: text.slice(0, maxChars) };
  } catch (e) {
    return { ok: false, status: 0, hdr: {}, text: '', error: true };
  } finally {
    clearTimeout(timer);
  }
}

function isPlainText(r) {
  return !!(r && r.ok && r.text.trim().length > 0 && !/^\s*<(!doctype|html)/i.test(r.text));
}
function isJsonObject(r) {
  if (!isPlainText(r)) return false;
  try { const v = JSON.parse(r.text); return v && typeof v === 'object'; } catch (e) { return false; }
}
function isSitemap(r) {
  return !!(r && r.ok && /<urlset|<sitemapindex/i.test(r.text));
}

// ---- robots.txt
function parseRobots(content) {
  const groups = [];
  let current = null;
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.started) {
        current = { agents: [], disallow: [], allow: [], started: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      current.started = true;
    } else if (key === 'allow' && current) {
      current.allow.push(value);
      current.started = true;
    }
  }
  return groups;
}
function declaredSitemaps(content) {
  const out = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m && safeHttp(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
// Paths that are normal to hide from everyone (admin, cart, login...). They don't count as "restricting AI".
const IGNORABLE = /^\/(wp-admin|wp-login\.php|wp-includes|wp-json|cgi-bin|admin|cart|checkout|my-account|account|login|signin|search|tmp|private|cdn-cgi)(\/|$|\?)/i;
function checkBotAccess(groups, bot) {
  let applicable = groups.filter(g => g.agents.includes(bot));
  if (!applicable.length) applicable = groups.filter(g => g.agents.includes('*'));
  if (!applicable.length) return 'allowed';
  const disallow = [].concat(...applicable.map(g => g.disallow)).map(d => d.trim()).filter(Boolean);
  const allow = [].concat(...applicable.map(g => g.allow)).map(a => a.trim()).filter(Boolean);
  if (disallow.includes('/')) return allow.some(a => a !== '/') ? 'partial' : (allow.includes('/') ? 'allowed' : 'blocked');
  const meaningful = disallow.filter(d => !IGNORABLE.test(d) && !/[?*]/.test(d));
  return meaningful.length ? 'partial' : 'allowed';
}

// ---- sitemap parsing
function decodeXml(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"); }
function locs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < 5000) out.push(decodeXml(m[1]));
  return out;
}
function sitemapEntries(xml) {
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < 5000) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/i) || [])[1];
    if (!loc) continue;
    const lm = (m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i) || [])[1];
    out.push({ url: decodeXml(loc), lastmod: lm || '' });
  }
  return out;
}
function rankChildren(kids) {
  // Content sitemaps first (blog/news, products, collections/services); plain "pages" sitemaps last.
  const score = (u) => {
    const l = u.toLowerCase();
    if (/(image|video|author|tag|taxonom|attachment)/.test(l)) return 9;
    if (/post|blog|article|news/.test(l)) return 0;
    if (/product/.test(l)) return 1;
    if (/collection|categor|service|solution/.test(l)) return 2;
    if (/page/.test(l)) return 3;
    return 4;
  };
  return kids.map((u, i) => ({ u, i, s: score(u) })).sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.u);
}

// ---- page discovery
function pickPages(origin, entries, homeHtml) {
  const baseHost = new URL(origin).hostname.replace(/^www\./, '').toLowerCase();
  const seen = new Set(['/']);
  const cand = [];
  const add = (href, lastmod) => {
    let u;
    try { u = new URL(href, origin + '/'); } catch (e) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (u.hostname.replace(/^www\./, '').toLowerCase() !== baseHost) return;
    if (SKIP_EXT.test(u.pathname)) return;
    const key = u.pathname.replace(/\/+$/, '') || '/';
    if (seen.has(key)) return;
    seen.add(key);
    cand.push({ url: origin + u.pathname, lastmod: lastmod || '', key });
  };
  entries.forEach(e => add(e.url, e.lastmod));

  // Fallback / top-up: internal links found on the homepage
  if (cand.length < MAX_PAGES - 1 && homeHtml) {
    const links = [];
    const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
    let m;
    while ((m = re.exec(homeHtml)) && links.length < 300) links.push(m[1]);
    const depth = (h) => { try { return new URL(h, origin + '/').pathname.split('/').filter(Boolean).length; } catch (e) { return 99; } };
    links.map((h, i) => ({ h, i, d: depth(h) })).sort((a, b) => a.d - b.d || a.i - b.i).forEach(x => add(x.h, ''));
  }

  // Prefer real content pages (FAQ, blog/news, product/service pages) over utility pages
  // such as contact, about, terms, shipping and returns. Utility pages are only used as filler.
  const segsOf = (c) => c.key.split('/').filter(Boolean);
  const CONTENT_SEG = /^(blog|blogs|news|article|articles|post|posts|insights?|guides?|resources?|learn|stories|magazine|knowledge-?base)$/i;
  const PRODUCT_SEG = /^(products?|collections?|shop|store|services?|solutions?|categor(y|ies)|items?|offerings?)$/i;
  const UTILITY = /(^|-)(contact|contact-us|about|about-us|terms|conditions|privacy|policy|policies|refund|refunds|return|returns|shipping|delivery|size-chart|track|tracking|track-order|cart|checkout|account|login|register|signin|wishlist|cookie|cookies|disclaimer|legal|careers|sitemap|thank-you|unsubscribe)(-|$)/i;
  const kindOf = (c) => {
    const segs = segsOf(c);
    if (segs.some(x => /faq/i.test(x))) return 'faq';
    if (segs.slice(0, -1).some(x => CONTENT_SEG.test(x)) || (segs.length === 1 && CONTENT_SEG.test(segs[0]))) return 'content';
    if (segs.slice(0, -1).some(x => PRODUCT_SEG.test(x)) || (segs.length === 1 && PRODUCT_SEG.test(segs[0]))) return 'product';
    const last = segs[segs.length - 1] || '';
    if (UTILITY.test(last)) return 'utility';
    return 'other';
  };
  const buckets = { faq: [], content: [], product: [], other: [], utility: [] };
  cand.forEach(c => buckets[kindOf(c)].push(c));

  // Inside a bucket: spread across sections (blogs/news vs blogs/guides, products vs collections),
  // newest pages first when the sitemap gives dates.
  const spread = (list) => {
    const groups = new Map();
    list.slice().sort((x, y) => (y.lastmod || '').localeCompare(x.lastmod || '')).forEach(c => {
      const segs = segsOf(c);
      const key = segs.slice(0, segs[0] === 'blogs' ? 2 : 1).join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });
    const lists = Array.from(groups.values()), out = [];
    for (let round = 0; ; round++) {
      let any = false;
      for (const l of lists) if (l[round]) { out.push(l[round]); any = true; }
      if (!any) break;
    }
    return out;
  };
  const queues = ['faq', 'content', 'product', 'other'].map(k => spread(buckets[k]));
  const picked = [];
  for (let round = 0; picked.length < MAX_PAGES - 1; round++) {
    let any = false;
    for (const q of queues) {
      if (q[round]) { picked.push(q[round]); any = true; if (picked.length >= MAX_PAGES - 1) break; }
    }
    if (!any) break;
  }
  // Utility pages (contact, about, terms...) only fill in for very small sites, so we still scan at least 4 pages.
  if (picked.length < 3) spread(buckets.utility).forEach(c => { if (picked.length < 3) picked.push(c); });
  return [{ url: origin + '/', lastmod: '' }].concat(picked.map(p => ({ url: p.url, lastmod: p.lastmod })));
}

// ---- firewall / CDN test
function detectCdn(hdr) {
  if (!hdr) return '';
  if (hdr['cf-ray'] || /cloudflare/i.test(hdr['server'] || '')) return 'Cloudflare';
  if (hdr['x-sucuri-id']) return 'Sucuri';
  if (hdr['x-amz-cf-id']) return 'Amazon CloudFront';
  if (/akamai/i.test(hdr['server'] || '') || hdr['x-akamai-transformed']) return 'Akamai';
  if (hdr['x-vercel-id']) return 'Vercel';
  return '';
}
function looksBlocked(r) {
  if (!r || r.error || r.status === 0) return true;
  if ([401, 403, 429, 451, 503].includes(r.status)) return true;
  if (r.status === 200 && r.text.length < 15000 && /just a moment|checking your browser|attention required|pardon our interruption|access denied|are you a robot/i.test(r.text)) return true;
  return false;
}
function firewallItem(browser, botRes) {
  const label = 'Firewall / CDN bot-block test';
  if (looksBlocked(browser)) {
    return item('firewall', 'na', label, 'We could not run this test because the site also refused our normal, browser-style request. It may be protected by a strict firewall.', 'Not tested');
  }
  const cdn = detectCdn(browser.hdr);
  const names = { gptbot: 'GPTBot', claudebot: 'ClaudeBot', perplexitybot: 'PerplexityBot' };
  const blockedBots = Object.keys(botRes).filter(k => looksBlocked(botRes[k])).map(k => names[k]);
  if (blockedBots.length === 0) {
    return item('firewall', 'pass', label, `${cdn ? cdn + ' detected, but it ' : 'Your firewall '}did not block AI bot requests in our test. (This checks user-agent blocking; some firewalls also verify bot IP addresses.)`, 'No block found');
  }
  if (blockedBots.length === 1) {
    return item('firewall', 'warn', label, `Your firewall${cdn ? ' (' + cdn + ')' : ''} appears to block ${blockedBots[0]} even though normal visitors get through. Check your bot-protection settings.`, 'Possible block');
  }
  return item('firewall', 'fail', label, `Your firewall${cdn ? ' (' + cdn + ')' : ''} appears to block ${blockedBots.join(', ')} even though normal visitors get through. Your robots.txt may say "welcome", but these bots are turned away before they read it.`, 'Possible block');
}

// exported for local testing only
exports._test = { parseRobots, checkBotAccess, isBlockedHost, pickPages, sitemapEntries, firewallItem, looksBlocked };
