// netlify/functions/pagespeed.js
// Dedicated page-speed check. Runs on its own so it gets the full function time
// budget (the main audit no longer waits on it). Called separately by the front-end
// AFTER the main report renders.
//
// Reads the key from Netlify env vars — set PAGESPEED_API_KEY in Site configuration.

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';

async function fetchWithTimeout(url, timeout = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function speedItems(data) {
  const lh = (data && data.lighthouseResult) || {};
  const score = lh.categories && lh.categories.performance ? lh.categories.performance.score : null; // 0..1
  const a = lh.audits || {};
  const lcp = a['largest-contentful-paint'] && a['largest-contentful-paint'].displayValue;
  const cls = a['cumulative-layout-shift'] && a['cumulative-layout-shift'].displayValue;
  const inp = (a['interaction-to-next-paint'] && a['interaction-to-next-paint'].displayValue)
    || (a['total-blocking-time'] && a['total-blocking-time'].displayValue);

  const items = [];
  if (score == null) return items;

  const pct = Math.round(score * 100);
  const s = score >= 0.9 ? 'pass' : score >= 0.5 ? 'warn' : 'fail';
  items.push({
    status: s, category: 'performance', label: 'Page speed (mobile)',
    detail: s === 'pass'
      ? 'Your page loads fast on mobile — good for rankings and visitors.'
      : 'Mobile performance needs work; slow pages lose rankings and visitors.',
    tag: `${pct}/100`,
  });

  const cwv = [lcp && `LCP ${lcp}`, cls && `CLS ${cls}`, inp && `INP ${inp}`].filter(Boolean).join(' · ');
  if (cwv) {
    items.push({
      status: 'pass', category: 'performance', label: 'Core Web Vitals',
      detail: "Google's real user-experience metrics (loading, stability, responsiveness).",
      tag: cwv,
    });
  }
  return items;
}

exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  let url;
  try {
    url = JSON.parse(event.body || '{}').url;
    if (!url) throw new Error('missing');
    new URL(url);
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid or missing URL' }) };
  }

  // No key configured → tell the front-end to just hide the speed row.
  if (!PAGESPEED_API_KEY) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ items: [], status: 'unconfigured' }) };
  }

  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed`
    + `?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${PAGESPEED_API_KEY}`;

  const res = await fetchWithTimeout(api, 9000);
  if (!res.ok || !res.body) {
    // Timed out or errored — front-end will hide the row rather than show a scary failure.
    return { statusCode: 200, headers: cors, body: JSON.stringify({ items: [], status: 'timeout' }) };
  }

  let data;
  try { data = JSON.parse(res.body); }
  catch { return { statusCode: 200, headers: cors, body: JSON.stringify({ items: [], status: 'error' }) }; }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ items: speedItems(data), status: 'ok' }) };
};
