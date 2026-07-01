/**
 * News Simplifier — Node/Express backend (Gemini API version).
 *
 *  - Holds the Gemini API key server-side (read from .env, never sent to the browser).
 *  - Caches "today's top stories" per category in memory (60 min TTL),
 *    plus an hourly interval that proactively refreshes all 5 categories.
 *  - Caches individual article summaries by URL in memory (24 hour TTL).
 *  - Serves cached results instantly; only calls Gemini on a cache miss/expiry.
 *
 * NOTE: this in-memory cache lives only as long as the Node process runs.
 * If you restart the server, the cache starts empty again (it will just
 * refill itself on the next requests / next cron tick).
 *
 * Endpoints:
 *  POST /api/article   { url: string }                          -> { markdown, cached }
 *  POST /api/category  { category: string, forceRefresh?: bool } -> { data, cached, fetchedAt }
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "../frontend")));

const PORT = process.env.PORT || 3000;
const MODEL = "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in your .env file. Add it and restart the server.");
  process.exit(1);
}

const ARTICLE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CATEGORY_TTL_MS = 60 * 60 * 1000; // 60 minutes

const ARTICLE_SYSTEM_PROMPT = `You are a News Simplifier AI.
Your task is to find and analyze the content of a webpage at the URL the user gives you, then create a concise, easy-to-understand summary.

Instructions:
1. Use web search / fetching to read the actual page content at the given URL.
2. Identify the main topic, key facts, important events, and conclusions.
3. Remove: advertisements, promotional content, repeated information, unnecessary details, clickbait language.
4. Rewrite the content using simple English suitable for a 12-year-old reader. Use short sentences and common words.
5. Maintain factual accuracy. Do not add opinions or information not present in the article.
6. If the article contains technical terms, explain them in simple language.
7. If the page is not a news article or blog post, explain what type of content it is and give a brief plain-English summary instead, but still follow the output format below as closely as makes sense.

Output ONLY markdown in exactly this format, nothing else before or after it:

# Headline
(short, clear headline)

# Summary
(3-5 simple sentences, max 20 words)

# Key Points
- Point 1
- Point 2
- Point 3
- Point 4
- Point 5

# Why It Matters
(1-2 sentences)

# One-Line Version
(the whole article in one simple sentence)`;

const CATEGORIES = {
  global: { label: "Top Global News", topic: "world / international news" },
  tamilnadu: { label: "Top Tamil Nadu News", topic: "Tamil Nadu, India state and local news" },
  sports: { label: "Sports News", topic: "sports news (cricket, football, and other major sports)" },
  economy: { label: "Economic News", topic: "economic news (markets, inflation, policy, jobs)" },
  business: { label: "Business News", topic: "business and company news" },
};

// ---------------- In-memory caches ----------------

// articleCache: Map<normalizedUrl, { markdown, expiresAt }>
const articleCache = new Map();

// categoryCache: Map<categoryKey, { items, fetchedAt, expiresAt }>
const categoryCache = new Map();

function now() {
  return Date.now();
}

// ---------------- Shared Gemini call ----------------

async function callGemini({ system, userMessage }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      tools: [{ googleSearch: {} }],
     generationConfig: {
  maxOutputTokens: 2000
},
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    throw new Error("Gemini returned no usable content. It may have been blocked or hit a safety filter.");
  }

  return candidate.content.parts
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

// ---------------- Article logic ----------------

function normalizeUrl(rawUrl) {
  let normalized = rawUrl.trim();
  try {
    const u = new URL(normalized);
    u.hash = "";
    normalized = u.toString();
  } catch {
    // fall back to raw trimmed string
  }
  return normalized.toLowerCase();
}

async function fetchArticleFromGemini(articleUrl) {
  const text = await callGemini({
    system: ARTICLE_SYSTEM_PROMPT,
    userMessage: `Please simplify this article: ${articleUrl}`,
  });
  if (!text) throw new Error("No summary came back from Gemini.");
  return text.replace(/```markdown|```/g, "").trim();
}

app.post("/api/article", async (req, res) => {
  try {
    const articleUrl = (req.body.url || "").trim();
    if (!articleUrl) return res.status(400).json({ error: "Missing url" });
    try {
      new URL(articleUrl);
    } catch {
      return res.status(400).json({ error: "Invalid url" });
    }

    const key = normalizeUrl(articleUrl);
    const cached = articleCache.get(key);
    if (cached && cached.expiresAt > now()) {
      return res.json({ markdown: cached.markdown, cached: true });
    }

    const markdown = await fetchArticleFromGemini(articleUrl);
    articleCache.set(key, { markdown, expiresAt: now() + ARTICLE_TTL_MS });
    res.json({ markdown, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------------- Category logic ----------------

async function fetchCategoryFromGemini(catKey) {
  const meta = CATEGORIES[catKey];

  const todayLong = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const system = `
Today's date is ${todayLong}.

Use Google Search to find the top 5 REAL and CURRENT news stories for:

${meta.topic}

Return ONLY this format:

Headline: ...
Summary: ...

Headline: ...
Summary: ...

Headline: ...
Summary: ...

Headline: ...
Summary: ...

Headline: ...
Summary: ...

No markdown.
No JSON.
No explanations.
No citations.
`;

  const text = await callGemini({
    system,
    userMessage: "Find today's top 5 stories."
  });

  console.log(text);

  const items = [];

  const regex = /Headline:\s*(.*?)\s*Summary:\s*([\s\S]*?)(?=\n\s*Headline:|$)/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    items.push({
      headline: match[1].trim(),
      summary: match[2].trim()
    });
  }

  if (!items.length) {
    throw new Error("Gemini returned an unexpected format.");
  }

  return items.slice(0, 5);
}

async function refreshCategory(catKey) {
  const items = await fetchCategoryFromGemini(catKey);
  const fetchedAt = now();
  categoryCache.set(catKey, { items, fetchedAt, expiresAt: fetchedAt + CATEGORY_TTL_MS });
  return { items, fetchedAt };
}

app.post("/api/category", async (req, res) => {
  try {
    const catKey = req.body.category;
    const forceRefresh = !!req.body.forceRefresh;

    if (!catKey || !CATEGORIES[catKey]) {
      return res.status(400).json({ error: "Unknown category" });
    }

    if (!forceRefresh) {
      const cached = categoryCache.get(catKey);
      if (cached && cached.expiresAt > now()) {
        return res.json({ data: cached.items, cached: true, fetchedAt: cached.fetchedAt });
      }
    }

    const { items, fetchedAt } = await refreshCategory(catKey);
    res.json({ data: items, cached: false, fetchedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------------- Hourly proactive refresh ----------------
// Keeps the cache warm so users essentially never hit a cold category.
setInterval(() => {
  Object.keys(CATEGORIES).forEach((catKey) => {
    refreshCategory(catKey).catch((err) =>
      console.error(`Hourly refresh failed for ${catKey}:`, err.message)
    );
  });
}, CATEGORY_TTL_MS);

// ---------------- Start server ----------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/news_simplifier.html"));
});
app.listen(PORT, () => {
  console.log(`News Simplifier backend running on http://localhost:${PORT}`);
});