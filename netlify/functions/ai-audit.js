exports.handler = async (event) => {

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: false,
        error: "Method not allowed"
      })
    };
  }

  try {

    const body = JSON.parse(event.body || "{}");
    const url = body.url;

    if (!url) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          success: false,
          error: "Missing URL"
        })
      };
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36"
      }
    });

    const html = await response.text();

    const parsedURL = new URL(url);
    const origin = parsedURL.origin;

    async function safeFetch(target) {
      try {
        const res = await fetch(target, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137 Safari/537.36"
          }
        });

        return await res.text();

      } catch {

        return "";

      }
    }
        const robotsContent = await safeFetch(origin + "/robots.txt");
    const sitemapContent = await safeFetch(origin + "/sitemap.xml");
    const llmsContent = await safeFetch(origin + "/llms.txt");

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
      (html.match(/<a[^>]+href=["']\/[^"']*["']/gi) || []).length;

    const externalLinks =
      (html.match(/<a[^>]+href=["']https?:\/\/[^"']*["']/gi) || []).length;

    const hasViewport =
      /<meta[^>]+name=["']viewport["']/i.test(html);

    const hasCharset =
      /<meta[^>]+charset=/i.test(html);

    const items = [];

    let passed = 0;
    let warnings = 0;
    let failed = 0;

    function addCheck(category, name, status, score, details = "") {
      items.push({
        category,
        name,
        status,
        score,
        details
      });

      if (status === "pass") passed++;
      else if (status === "warning") warnings++;
      else failed++;
    }
        addCheck(
      "Metadata",
      "Title Tag",
      title.length > 10 ? "pass" : "fail",
      title.length > 10 ? 10 : 0,
      title || "Missing title"
    );

    addCheck(
      "Metadata",
      "Meta Description",
      metaDescription.length > 50 ? "pass" : "warning",
      metaDescription.length > 50 ? 10 : 5,
      metaDescription || "Missing description"
    );

    addCheck(
      "Metadata",
      "Canonical URL",
      canonical ? "pass" : "warning",
      canonical ? 10 : 5,
      canonical || "Missing canonical"
    );

    addCheck(
      "Content",
      "H1 Heading",
      h1Count === 1 ? "pass" : "warning",
      h1Count === 1 ? 10 : 5,
      `${h1Count} H1 tags`
    );
        addCheck(
      "Content",
      "Word Count",
      wordCount > 300 ? "pass" : "warning",
      wordCount > 300 ? 10 : 5,
      `${wordCount} words`
    );

    addCheck(
      "Images",
      "Image Alt Tags",
      imagesWithoutAlt === 0 ? "pass" : "warning",
      imagesWithoutAlt === 0 ? 10 : 5,
      `${imagesWithoutAlt} images missing alt`
    );

    addCheck(
      "Links",
      "Internal Links",
      internalLinks >= 3 ? "pass" : "warning",
      internalLinks >= 3 ? 10 : 5,
      `${internalLinks} internal links`
    );

    addCheck(
      "Links",
      "External Links",
      externalLinks >= 1 ? "pass" : "warning",
      externalLinks >= 1 ? 10 : 5,
      `${externalLinks} external links`
    );

    addCheck(
      "Technical",
      "Viewport Meta",
      hasViewport ? "pass" : "fail",
      hasViewport ? 10 : 0,
      hasViewport ? "Present" : "Missing"
    );
        addCheck(
      "Technical",
      "Charset",
      hasCharset ? "pass" : "warning",
      hasCharset ? 10 : 5,
      hasCharset ? "Present" : "Missing"
    );

    addCheck(
      "Technical",
      "Robots.txt",
      robotsContent ? "pass" : "warning",
      robotsContent ? 10 : 5,
      robotsContent ? "Found" : "Missing"
    );

    addCheck(
      "Technical",
      "Sitemap.xml",
      sitemapContent ? "pass" : "warning",
      sitemapContent ? 10 : 5,
      sitemapContent ? "Found" : "Missing"
    );

    addCheck(
      "AI",
      "llms.txt",
      llmsContent ? "pass" : "warning",
      llmsContent ? 10 : 5,
      llmsContent ? "Found" : "Not Found"
    );

    const totalScore = items.reduce((sum, item) => sum + item.score, 0);
    const maxScore = items.length * 10;
    const pct = Math.round((totalScore / maxScore) * 100);

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

      if (item.status === "pass") {
        categories[item.category].passed++;
      }

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

    console.error("AI AUDIT ERROR:", e);

    return {

      statusCode: 500,

      body: JSON.stringify({
        success: false,
        error: e.message,
        stack: e.stack
      })

    };

  }

};
