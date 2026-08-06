exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const url = body.url;

    if (!url) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing URL" })
      };
    }

    const html = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36"
      }
    }).then(r => r.text());
// =======================================================
// AI AUDIT V2 - Website Data Collection
// =======================================================

const parsedURL = new URL(url);
const origin = parsedURL.origin;
    const robotsURL = origin + "/robots.txt";
const sitemapURL = origin + "/sitemap.xml";
const llmsURL = origin + "/llms.txt";

let robotsContent = "";
let sitemapContent = "";
let llmsContent = "";

async function fetchText(target) {
    try {
        const res = await fetch(target, {
            headers: {
                "User-Agent": "SEOzar AI Audit Bot/2.0"
            }
        });

        if (!res.ok) return "";
 return await res.text();

    } catch (e) {
        return "";
    }
}

robotsContent = await fetchText(robotsURL);
sitemapContent = await fetchText(sitemapURL);
llmsContent = await fetchText(llmsURL);

// =======================================================
// AI AUDIT V2 - Metadata Analysis
// =======================================================

const title =
  html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";

const metaDescription =
  html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"]*)["']/i
  )?.[1]?.trim() || "";

const canonical =
  html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"]+)["']/i
  )?.[1] || "";

const h1Count = (html.match(/<h1\b/gi) || []).length;

const wordCount = html
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .trim()
  .split(/\s+/).length;

const images = [...html.matchAll(/<img[^>]*>/gi)];

const imagesWithoutAlt = images.filter(
  img => !/alt\s*=/i.test(img[0])
).length;

const internalLinks =
  (html.match(/<a[^>]+href=["']\/[^"']*/gi) || []).length;

const externalLinks =
  (html.match(/<a[^>]+href=["']https?:\/\//gi) || []).length;

const hasViewport =
  /<meta[^>]+name=["']viewport["']/i.test(html);

const hasCharset =
  /<meta[^>]+charset=/i.test(html);

const hasOpenGraph =
  /property=["']og:/i.test(html);

const hasTwitterCards =
  /name=["']twitter:/i.test(html);

const hasSchema =
  /application\/ld\+json/i.test(html);

const hasFavicon =
  /rel=["']icon["']/i.test(html);

const language =
  html.match(/<html[^>]+lang=["']([^"]+)["']/i)?.[1] || "";

const titleLength = title.length;
const descriptionLength = metaDescription.length;

  // =======================================================
// AI AUDIT V2 - SEO Checks
// =======================================================

items.push({
  id: "title",
  category: "Technical SEO",
  status:
    titleLength >= 30 && titleLength <= 60 ? "pass" : "warning",
  label: "Title Tag",
  detail:
    title || "No title tag found.",
  recommendation:
    "Keep title between 30-60 characters.",
  score:
    titleLength >= 30 && titleLength <= 60 ? 5 : 2
});

items.push({
  id: "description",
  category: "Technical SEO",
  status:
    descriptionLength >= 120 &&
    descriptionLength <= 160
      ? "pass"
      : "warning",
  label: "Meta Description",
  detail:
    metaDescription || "Missing meta description.",
  recommendation:
    "Use a unique description of 120-160 characters.",
  score:
    descriptionLength >= 120 &&
    descriptionLength <= 160
      ? 5
      : 2
});

items.push({
  id: "canonical",
  category: "Technical SEO",
  status: canonical ? "pass" : "fail",
  label: "Canonical URL",
  detail:
    canonical || "Canonical tag missing.",
  recommendation:
    "Add a canonical URL.",
  score: canonical ? 5 : 0
});

items.push({
  id: "h1",
  category: "Content",
  status:
    h1Count === 1 ? "pass" : "warning",
  label: "H1 Heading",
  detail:
    `${h1Count} H1 tag(s) found.`,
  recommendation:
    "Use exactly one H1.",
  score:
    h1Count === 1 ? 5 : 2
});

items.push({
  id: "viewport",
  category: "Mobile",
  status:
    hasViewport ? "pass" : "fail",
  label: "Viewport Tag",
  detail:
    hasViewport
      ? "Viewport meta tag detected."
      : "Viewport tag missing.",
  recommendation:
    "Add viewport meta tag.",
  score:
    hasViewport ? 5 : 0
});

  // =======================================================
// AI AUDIT V2 - AI Visibility
// =======================================================

items.push({
  id: "robots",
  category: "AI Readiness",
  status: robotsContent ? "pass" : "fail",
  label: "robots.txt",
  detail: robotsContent
    ? "robots.txt detected."
    : "robots.txt not found.",
  recommendation:
    "Create a robots.txt file for search engines and AI crawlers.",
  score: robotsContent ? 5 : 0
});

items.push({
  id: "llms",
  category: "AI Readiness",
  status: llmsContent ? "pass" : "warning",
  label: "llms.txt",
  detail: llmsContent
    ? "llms.txt detected."
    : "llms.txt not found.",
  recommendation:
    "Publish llms.txt for ChatGPT, Claude and Gemini.",
  score: llmsContent ? 5 : 2
});

items.push({
  id: "sitemap",
  category: "AI Readiness",
  status: sitemapContent ? "pass" : "fail",
  label: "XML Sitemap",
  detail: sitemapContent
    ? "XML Sitemap detected."
    : "No sitemap.xml found.",
  recommendation:
    "Generate and submit an XML sitemap.",
  score: sitemapContent ? 5 : 0
});

items.push({
  id: "schema",
  category: "AI Readiness",
  status: hasSchema ? "pass" : "warning",
  label: "Structured Data",
  detail: hasSchema
    ? "Schema markup detected."
    : "No schema markup found.",
  recommendation:
    "Implement JSON-LD schema.",
  score: hasSchema ? 5 : 2
});

items.push({
  id: "opengraph",
  category: "AI Readiness",
  status: hasOpenGraph ? "pass" : "warning",
  label: "Open Graph",
  detail: hasOpenGraph
    ? "Open Graph tags detected."
    : "Open Graph tags missing.",
  recommendation:
    "Add Open Graph metadata.",
  score: hasOpenGraph ? 5 : 2
});

items.push({
  id: "twitter",
  category: "AI Readiness",
  status: hasTwitterCards ? "pass" : "warning",
  label: "Twitter Cards",
  detail: hasTwitterCards
    ? "Twitter Cards detected."
    : "Twitter Cards missing.",
  recommendation:
    "Implement Twitter Card metadata.",
  score: hasTwitterCards ? 5 : 2
});

  // =======================================================
// AI AUDIT V2 - Content Quality
// =======================================================

items.push({
  id: "wordcount",
  category: "Content",
  status: wordCount >= 600 ? "pass" : "warning",
  label: "Word Count",
  detail: `${wordCount} words detected.`,
  recommendation:
    "Aim for at least 600 words on important pages.",
  score: wordCount >= 600 ? 5 : 2
});

items.push({
  id: "images",
  category: "Content",
  status: images.length > 0 ? "pass" : "warning",
  label: "Images",
  detail: `${images.length} images found.`,
  recommendation:
    "Use optimized images throughout the page.",
  score: images.length > 0 ? 5 : 2
});

items.push({
  id: "alttext",
  category: "Accessibility",
  status:
    imagesWithoutAlt === 0 ? "pass" : "warning",
  label: "Image ALT Text",
  detail:
    `${imagesWithoutAlt} image(s) missing ALT text.`,
  recommendation:
    "Every image should have descriptive ALT text.",
  score:
    imagesWithoutAlt === 0 ? 5 : 2
});

items.push({
  id: "internal-links",
  category: "Links",
  status:
    internalLinks >= 5 ? "pass" : "warning",
  label: "Internal Links",
  detail:
    `${internalLinks} internal links detected.`,
  recommendation:
    "Add more internal links for crawlability.",
  score:
    internalLinks >= 5 ? 5 : 2
});

items.push({
  id: "external-links",
  category: "Links",
  status:
    externalLinks > 0 ? "pass" : "warning",
  label: "External Links",
  detail:
    `${externalLinks} external links detected.`,
  recommendation:
    "Link to authoritative external resources.",
  score:
    externalLinks > 0 ? 5 : 2
});

items.push({
  id: "language",
  category: "Accessibility",
  status:
    language ? "pass" : "warning",
  label: "HTML Language",
  detail:
    language || "Language attribute missing.",
  recommendation:
    "Specify the HTML language attribute.",
  score:
    language ? 5 : 2
});

items.push({
  id: "favicon",
  category: "Branding",
  status:
    hasFavicon ? "pass" : "warning",
  label: "Favicon",
  detail:
    hasFavicon
      ? "Favicon detected."
      : "Favicon missing.",
  recommendation:
    "Add a favicon for better branding.",
  score:
    hasFavicon ? 5 : 2
});

  // =======================================================
// AI AUDIT V2 - Score Calculation
// =======================================================

const totalScore = items.reduce((sum, item) => sum + item.score, 0);

const maxScore = items.length * 5;

const pct = Math.round((totalScore / maxScore) * 100);

const passed = items.filter(i => i.status === "pass").length;

const warnings = items.filter(i => i.status === "warning").length;

const failed = items.filter(i => i.status === "fail").length;

const categories = {};

for (const item of items) {
    if (!categories[item.category]) {
        categories[item.category] = {
            total: 0,
            passed: 0,
            score: 0
        };
    }

    categories[item.category].total++;

    if (item.status === "pass")
        categories[item.category].passed++;

    categories[item.category].score += item.score;
}

return {
    statusCode: 200,
    headers: {
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        success: true,

        score: pct,

        summary: {
            passed,
            warnings,
            failed,
            total: items.length
        },

        categories,

        robots: !!robotsContent,
        sitemap: !!sitemapContent,
        llms: !!llmsContent,

        title,
        metaDescription,

        items
    })
};

} catch (e) {

return {
    statusCode: 500,
    body: JSON.stringify({
        success: false,
        error: e.message
    })
};

}

};
