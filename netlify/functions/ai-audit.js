// netlify/functions/ai-audit.js
//
// Checks how "readable" a website is to AI crawlers (ChatGPT, Claude, Perplexity, Google AI)
// — this is AI CRAWLABILITY, not a live test of whether AI actually recommends the business.
// Single homepage check for v1 (domain-level + page-level combined).

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let targetUrl;
  try {
    const body = JSON.parse(event.body || '{}');
    targetUrl = body.url;
    if (!targetUrl) throw new Error('missing url');
    new URL(targetUrl);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing URL' }) };
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const origin = parsedUrl.origin;
    const items = [];
    let score = 0;
    const maxScore = 9;

    // --- Domain-level: robots.txt ---
    const robotsContent = await safeFetchText(origin + '/robots.txt');
    const groups = robotsContent ? parseRobots(robotsContent) : [];

    const bots = [
      { key: 'gptbot', label: 'GPTBot (ChatGPT)' },
      { key: 'claudebot', label: 'ClaudeBot (Claude)' },
      { key: 'perplexitybot', label: 'PerplexityBot' },
      { key: 'google-extended', label: 'Google-Extended (AI Overviews)' }
    ];

    for (const bot of bots) {
      const status = checkBotAccess(groups, bot.key);
      if (status === 'blocked') {
        items.push(fail(`${bot.label} is blocked`, `Your robots.txt is blocking ${bot.label} — it can't read your site at all right now.`, 'Blocked'));
      } else if (status === 'partial') {
        items.push(warn(`${bot.label} has partial restrictions`, `Some parts of your site are off-limits to ${bot.label}.`, 'Partial'));
        score += 0.5;
      } else {
        items.push(pass(`${bot.label} can access your site`, `Nothing in your robots.txt is stopping ${bot.label} from reading your site.`, 'Allowed'));
        score++;
      }
    }

    // --- Domain-level: llms.txt ---
    const llmsContent = await safeFetchText(origin + '/llms.txt');
    if (llmsContent) {
      items.push(pass('llms.txt found', 'You have a dedicated file summarizing your site for AI systems — still a new, uncommon standard.', 'Found'));
      score++;
    } else {
      items.push(warn('No llms.txt file', 'This is a new, still-emerging standard — not urgent, but adding one can help AI tools quickly understand your business.', 'Not found'));
      score += 0.5;
    }

    // --- Page-level: homepage HTML ---
    const html = await fetchHtml(targetUrl);

    // Schema / structured data
    if (/<script[^>]+type=["']application\/ld\+json["']/i.test(html)) {
      items.push(pass('Structured data (schema) detected', 'Helps AI systems understand your business as a real entity, not just plain text.', 'Detected'));
      score++;
    } else {
      items.push(fail('No structured data detected', 'Adding schema markup (Organization, LocalBusiness) helps AI accurately describe your business.', 'Missing'));
    }

    // Heading structure
    const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
    const h2Count = (html.match(/<h2[^>]*>/gi) || []).length;
    if (h1Count === 1 && h2Count > 0) {
      items.push(pass('Clear heading structure', 'A single main heading with organized subheadings — easy for AI to extract sections from.', `1 H1, ${h2Count} H2s`));
      score++;
    } else if (h1Count >= 1) {
      items.push(warn('Heading structure could improve', 'AI tools extract answers more easily from clearly organized sections (H1 → H2 → H3).', h1Count === 1 ? 'No H2s found' : `${h1Count} H1 tags`));
      score += 0.5;
    } else {
      items.push(fail('No H1 heading found', 'Without a clear main heading, AI systems struggle to identify your page\'s core topic.', 'Missing'));
    }

    // FAQ-style content
    const hasFaqSchema = /FAQPage/i.test(html);
    const questionHeadings = (html.match(/<h[1-4][^>]*>[^<]*\?[^<]*<\/h[1-4]>/gi) || []).length;
    if (hasFaqSchema || questionHeadings >= 2) {
      items.push(pass('FAQ-style content detected', 'Question-and-answer style content is more likely to get pulled into AI-generated answers.', hasFaqSchema ? 'FAQ schema found' : `${questionHeadings} Q&A headings`));
      score++;
    } else {
      items.push(warn('No FAQ-style content found', 'Adding a clear Q&A section can improve how often AI tools reference your content.', 'Not found'));
      score += 0.5;
    }

    // Clear business description
    const desc = matchOne(html, /<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i)
      || matchOne(html, /<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?>/i);
    if (desc && desc.length > 50) {
      items.push(pass('Clear business description found', 'AI systems rely on direct, factual descriptions like this to summarize your business accurately.', `${desc.length} characters`));
      score++;
    } else {
      items.push(fail('No clear business description found', 'Without a direct "who/what/where" statement, AI tools may describe your business inaccurately or not at all.', 'Missing'));
    }

    const pct = Math.round((score / maxScore) * 100);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, pct })
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Could not fetch or analyze this site. It may be blocking automated requests.' })
    };
  }
};

function pass(label, detail, tag) { return { status: 'pass', label, detail, tag: tag || '' }; }
function warn(label, detail, tag) { return { status: 'warn', label, detail, tag: tag || '' }; }
function fail(label, detail, tag) { return { status: 'fail', label, detail, tag: tag || '' }; }

function matchOne(html, regex) {
  const m = html.match(regex);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function safeFetchText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOzarAuditBot/1.0)' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

function parseRobots(content) {
  const lines = content.split('\n');
  const groups = [];
  let current = null;

  for (let raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || current.started) {
        current = { agents: [], disallow: [], started: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      current.started = true;
    } else if (key === 'allow' && current) {
      current.started = true;
    }
  }
  return groups;
}

function checkBotAccess(groups, botName) {
  const exact = groups.find(g => g.agents.includes(botName));
  const wildcard = groups.find(g => g.agents.includes('*'));
  const g = exact || wildcard;
  if (!g) return 'allowed';
  if (g.disallow.some(d => d.trim() === '/')) return 'blocked';
  if (g.disallow.some(d => d.trim() !== '')) return 'partial';
  return 'allowed';
}

async function fetchHtml(url) {
  const maxAttempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('Fetch failed with status ' + res.status);
      return await res.text();
    } catch (e) {
      clearTimeout(timeout);
      lastError = e;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastError;
}
