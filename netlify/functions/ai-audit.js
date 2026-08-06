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

    const items = [];

    // Title
    const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || "";

    if (title.length > 30) {
      items.push({
        status: "pass",
        label: "Title Tag",
        detail: title,
        tag: "Good"
      });
    } else {
      items.push({
        status: "warn",
        label: "Title Tag",
        detail: "Title is short or missing.",
        tag: "Improve"
      });
    }

    // Meta Description
    const desc = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/i
    )?.[1];

    if (desc) {
      items.push({
        status: "pass",
        label: "Meta Description",
        detail: desc,
        tag: "Found"
      });
    } else {
      items.push({
        status: "fail",
        label: "Meta Description",
        detail: "No meta description found.",
        tag: "Missing"
      });
    }

    // Open Graph
    if (/property=["']og:title["']/i.test(html)) {
      items.push({
        status: "pass",
        label: "Open Graph Tags",
        detail: "Facebook/OpenGraph tags detected.",
        tag: "Present"
      });
    } else {
      items.push({
        status: "warn",
        label: "Open Graph Tags",
        detail: "OpenGraph tags missing.",
        tag: "Missing"
      });
    }

    // Twitter Cards
    if (/name=["']twitter:card["']/i.test(html)) {
      items.push({
        status: "pass",
        label: "Twitter Cards",
        detail: "Twitter Card detected.",
        tag: "Present"
      });
    } else {
      items.push({
        status: "warn",
        label: "Twitter Cards",
        detail: "Twitter Card missing.",
        tag: "Missing"
      });
    }

    // Schema
    if (/application\/ld\+json/i.test(html)) {
      items.push({
        status: "pass",
        label: "Schema Markup",
        detail: "Structured data detected.",
        tag: "Good"
      });
    } else {
      items.push({
        status: "warn",
        label: "Schema Markup",
        detail: "No schema markup found.",
        tag: "Missing"
      });
    }

    // AI Crawlability
    if (/robots/i.test(html)) {
      items.push({
        status: "pass",
        label: "AI Crawlability",
        detail: "Robots directives detected.",
        tag: "Good"
      });
    } else {
      items.push({
        status: "warn",
        label: "AI Crawlability",
        detail: "No robots directives found.",
        tag: "Review"
      });
    }

    const passed = items.filter(i => i.status === "pass").length;

    const pct = Math.round((passed / items.length) * 100);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        pct,
        items
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: e.message
      })
    };
  }
};
