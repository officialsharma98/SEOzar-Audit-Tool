# SEOzar — Free SEO Audit Tool

This is the single-page MVP: a visitor enters a website URL, the tool checks it,
and shows a plain-English report — capturing their email before revealing full results.

## What's in this folder

- `index.html` — the page visitors see (form, loading state, email gate, report)
- `netlify/functions/audit.js` — the server-side function that fetches and analyzes the website
- `netlify.toml` — Netlify configuration
- `google-sheet-webhook.gs` — code to paste into Google Apps Script, so leads land in a Google Sheet

## Setup Steps

### 1. Google PageSpeed Insights API Key
- Go to console.cloud.google.com
- Create a project (or use an existing one)
- Enable the "PageSpeed Insights API"
- Go to "Credentials" > "Create Credentials" > "API Key"
- Copy the key — you'll add it as an environment variable in Netlify (see Step 3)

### 2. Google Sheet for Leads
- Create a new Google Sheet
- In row 1, add headers: `Email | Website | Score | Date`
- Go to Extensions > Apps Script
- Paste in the contents of `google-sheet-webhook.gs`
- Click Deploy > New deployment > type "Web app" > Execute as "Me" > Access "Anyone"
- Copy the Web App URL it gives you

### 3. Deploy to Netlify
- Push this folder to a GitHub repository
- In Netlify: "Add new site" > "Import an existing project" > connect your GitHub repo
- Once deployed, go to Site settings > Environment variables, and add:
  - `PAGESPEED_API_KEY` = (the key from Step 1)
- Redeploy the site after adding the environment variable

### 4. Connect the Google Sheet URL
- Open `index.html`
- Find this line near the top of the `<script>` section:
  ```
  const SHEET_WEBHOOK_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_URL_HERE';
  ```
- Replace it with the Web App URL from Step 2
- Commit and push — Netlify will auto-redeploy

### 5. Test It
- Open your live Netlify URL
- Enter a real website and click "Check my site"
- Confirm the report shows up, and check your Google Sheet to see the lead logged

### 6. Connect to seozar.co/audit (once your main site is live)
Once your main WordPress site is live, we'll set up `seozar.co/audit` to point to this tool.
The exact method depends on your hosting — most commonly this is done with a reverse
proxy rule or an iframe embed on a WordPress page at that URL. Flag this to me when
your site is ready and I'll walk you through the exact steps for your host.

## Known Limitations (MVP / Level 1)

- Checks a single page only (whatever URL is entered) — not the whole site
- Some websites with heavy bot-protection (e.g., aggressive Cloudflare settings) may block the fetch
- Sites built entirely in JavaScript (e.g., some React/Vue apps) may show incomplete
  results, since the function reads raw HTML without running the page's JavaScript
- No AI-written summary yet — this is the checklist-style report (Level 2 adds the AI layer later)

## Costs

- Netlify: Free tier is enough for this scale (functions + hosting)
- Google PageSpeed API: Free, generous quota for a tool like this
- Google Sheets: Free
- No costs to run this MVP unless traffic gets very high
