// netlify/functions/audit.js
//
// This function runs on Netlify's server (not in the visitor's browser),
// so it can fetch any public website directly without CORS issues.
//
// Required environment variable (set in Netlify dashboard > Site settings > Environment variables):
//   PAGESPEED_API_KEY = your Google PageSpeed Insights API key

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let targetUrl;
  try {
    const body = JSON.parse(event.body || '{}');
    targetUrl = body.url;
    if (!targetUrl) throw new Error('missing url');
    new URL(targetUrl); // validate
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing URL' }) };
  }

  try {
    const html = await fetchHtml(targetUrl);
    const items = [];
    let score = 0;
    let maxScore = 8; // page speed adds a 9th if available

    const parsedUrl = new URL(targetUrl);

    // HTTPS
    if (parsedUrl.protocol === 'https:') {
      items.push(pass('HTTPS enabled', 'Your site loads securely — good for trust and rankings.'));
      score++;
    } else {
      items.push(fail('Not using HTTPS', 'Browsers mark HTTP sites as "not secure," which can turn visitors away.'));
    }

    // Title tag
    const title = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!title) {
      items.push(fail('Title tag missing', 'This is the headline Google shows in search results. An easy, high-impact fix.'));
    } else if (title.length < 30 || title.length > 60) {
      items.push(warn('Title tag length could improve', `"${title}" is ${title.length} characters — ideal is 30–60.`));
      score += 0.5;
    } else {
      items.push(pass('Title tag looks good', `"${title}" (${title.length} characters)`));
      score++;
    }

    // Meta description
    const desc = matchOne(html, /<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i)
      || matchOne(html, /<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?>/i);
    if (!desc) {
      items.push(fail('Meta description missing', 'Without this, Google writes its own snippet — usually a less compelling one.'));
    } else if (desc.length < 70 || desc.length > 160) {
      items.push(warn('Meta description length could improve', `Currently ${desc.length} characters — ideal is 70–160.`));
      score += 0.5;
    } else {
      items.push(pass('Meta description looks good', `${desc.length} characters`));
      score++;
    }

    // H1
    const h1Matches = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
    if (h1Matches.length === 0) {
      items.push(fail('No H1 heading found', 'Every page needs one clear main heading for both readers and Google.'));
    } else if (h1Matches.length > 1) {
      items.push(warn(`${h1Matches.length} H1 tags found`, 'Having more than one main heading can confuse search engines about your page\'s topic.'));
      score += 0.5;
    } else {
      const h1Text = h1Matches[0].replace(/<[^>]+>/g, '').trim();
      items.push(pass('Single H1 found', h1Text.slice(0, 70)));
      score++;
    }

    // Images / alt text
    const imgTags = html.match(/<img[^>]*>/gi) || [];
    const missingAlt = imgTags.filter(tag => !/alt\s*=\s*["'][^"']+["']/i.test(tag));
    if (imgTags.length === 0) {
      items.push(warn('No images found', 'Not necessarily a problem, but visuals often help engagement.'));
      score += 0.5;
    } else if (missingAlt.length > 0) {
      items.push(fail(`${missingAlt.length} of ${imgTags.length} images missing alt text`, 'Alt text helps both SEO and accessibility for visually impaired visitors.'));
    } else {
      items.push(pass('All images have alt text', `${imgTags.length} images checked.`));
      score++;
    }

    // Word count (rough, strips tags/scripts/styles)
    const bodyMatch = matchOne(html, /<body[^>]*>([\s\S]*?)<\/body>/i) || html;
    const textOnly = bodyMatch
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const wordCount = textOnly ? textOnly.split(' ').length : 0;
    if (wordCount < 300) {
      items.push(warn(`Only ${wordCount} words on this page`, 'Thin content can make it harder to rank for competitive search terms.'));
      score += 0.5;
    } else {
      items.push(pass(`${wordCount} words on this page`, 'Reasonable content depth for Google to work with.'));
      score++;
    }

    // Viewport / mobile
    if (/<meta\s+name=["']viewport["']/i.test(html)) {
      items.push(pass('Mobile viewport tag found', 'Good sign that your site is set up for mobile visitors.'));
      score++;
    } else {
      items.push(fail('No mobile viewport tag found', 'This usually means the page isn\'t properly optimized for mobile phones.'));
    }

    // Schema / structured data
    if (/<script[^>]+type=["']application\/ld\+json["']/i.test(html)) {
      items.push(pass('Structured data (schema) detected', 'Helps Google understand your content and can unlock richer search results.'));
      score++;
    } else {
      items.push(fail('No structured data detected', 'Adding schema markup can help your listing stand out on Google.'));
    }

    // Page speed (optional — only if API key is set)
    if (PAGESPEED_API_KEY) {
      try {
        const speed = await fetchPageSpeed(targetUrl);
        maxScore += 1;
        if (speed !== null) {
          if (speed >= 90) {
            items.push(pass(`Page speed score: ${speed}/100`, 'Your site loads quickly — great for both visitors and rankings.'));
            score++;
          } else if (speed >= 50) {
            items.push(warn(`Page speed score: ${speed}/100`, 'Room to improve — slow pages lose visitors before they even see your content.'));
            score += 0.5;
          } else {
            items.push(fail(`Page speed score: ${speed}/100`, 'Your site is loading slowly. Most visitors leave before a slow page even finishes loading.'));
          }
        }
      } catch (e) {
        // silently skip if PageSpeed API fails — don't break the whole report
      }
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

function pass(label, detail) { return { status: 'pass', label, detail }; }
function warn(label, detail) { return { status: 'warn', label, detail }; }
function fail(label, detail) { return { status: 'fail', label, detail }; }

function matchOne(html, regex) {
  const m = html.match(regex);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOzarAuditBot/1.0; +https://seozar.co)'
      }
    });
    if (!res.ok) throw new Error('Fetch failed with status ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageSpeed(url) {
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${PAGESPEED_API_KEY}&strategy=mobile`;
  const res = await fetch(endpoint);
  if (!res.ok) return null;
  const data = await res.json();
  const scoreRaw = data?.lighthouseResult?.categories?.performance?.score;
  if (typeof scoreRaw !== 'number') return null;
  return Math.round(scoreRaw * 100);
}
