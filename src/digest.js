#!/usr/bin/env node
// Daily job: pick today's most interesting articles out of github-rss-reader's
// feed data, using the user's recent Hatena Bookmarks as a live interest
// signal, and email the result. No Inoreader, no persistent interest profile —
// everything is recomputed fresh from public data each run.

const nodemailer = require("nodemailer");
const Parser = require("rss-parser");

const ARTICLES_URL =
  process.env.ARTICLES_URL || "https://takahashilabo.github.io/github-rss-reader/data/articles.json";
const READER_BASE_URL =
  process.env.READER_BASE_URL || "https://takahashilabo.github.io/github-rss-reader/";
const HATENA_USERNAME = process.env.HATENA_USERNAME || "hagemofu";
const HATENA_PAGES = parseInt(process.env.HATENA_PAGES || "2", 10);
const CANDIDATE_WINDOW_HOURS = parseInt(process.env.CANDIDATE_WINDOW_HOURS || "26", 10);
const MIN_SELECTED = 5;
const MAX_SELECTED = 15;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || GMAIL_USER;

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "rss-digest-mailer/1.0 (+https://github.com/; personal daily digest)";

const rssParser = new Parser();

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function loadCandidateArticles(windowStart, windowEnd) {
  const data = await fetchJson(ARTICLES_URL);
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const candidates = (data.articles || []).filter((a) => {
    if (!a.pubDate) return false;
    const t = new Date(a.pubDate).getTime();
    return t >= startMs && t <= endMs;
  });
  candidates.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return candidates;
}

async function loadRecentHatenaBookmarks() {
  const bookmarks = [];
  for (let page = 1; page <= HATENA_PAGES; page++) {
    const url = `https://b.hatena.ne.jp/${encodeURIComponent(HATENA_USERNAME)}/rss?page=${page}`;
    try {
      const xml = await fetchText(url);
      const feed = await rssParser.parseString(xml);
      for (const item of feed.items || []) {
        bookmarks.push({
          title: item.title || "",
          link: item.link || "",
          pubDate: item.isoDate || item.pubDate || null,
        });
      }
    } catch (err) {
      console.warn(`Failed to fetch Hatena bookmarks page ${page}: ${err.message}`);
    }
  }
  return bookmarks;
}

async function callGemini(candidates, bookmarks) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set; skipping AI selection, falling back to newest-first.");
    return null;
  }

  const candidateLines = candidates.map((a) => ({
    id: a.id,
    title: a.title,
    category: a.category,
    feed: a.feedTitle,
    pubDate: a.pubDate,
    snippet: (a.contentSnippet || "").slice(0, 200),
  }));

  const bookmarkLines = bookmarks.map((b) => ({ title: b.title, pubDate: b.pubDate }));

  const system =
    "あなたは個人向けの毎日のニュースダイジェストを作るキュレーターです。" +
    "ユーザーの直近のはてなブックマーク（興味の最新シグナル）を参考に、" +
    "候補記事の中から本当に興味を持ちそうなものだけを選び、各記事に日本語で短い要約と、" +
    "なぜ興味に合うと判断したかの短いコメントを付けてください。" +
    `必ず ${MIN_SELECTED}〜${MAX_SELECTED} 件を選んでください（候補がそれより少ない場合は全件）。` +
    "idは与えられた候補のidをそのまま使い、絶対に新しいidを作らないでください。";

  const userContent =
    "## 直近のはてなブックマーク（興味シグナル）\n" +
    JSON.stringify(bookmarkLines) +
    "\n\n## 今日の候補記事\n" +
    JSON.stringify(candidateLines);

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
      responseSchema: {
        type: "OBJECT",
        properties: {
          selected: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING", description: "候補記事のid（そのまま）" },
                summary: { type: "STRING", description: "記事の1-2文の要約（日本語）" },
                why: { type: "STRING", description: "興味に合う理由の短いコメント（日本語）" },
              },
              required: ["id", "summary", "why"],
            },
          },
        },
        required: ["selected"],
      },
    },
  };

  const startedAt = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(170_000),
    }
  );
  console.log(`Gemini API responded in ${Date.now() - startedAt}ms`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response had no content");

  const parsed = JSON.parse(text);
  return parsed.selected || [];
}

function buildFallbackSelection(candidates) {
  return candidates.slice(0, MAX_SELECTED).map((a) => ({
    id: a.id,
    summary: a.contentSnippet || "",
    why: "",
  }));
}

// Passes the same date range used to select candidates, rather than an
// explicit id list — keeps the URL short regardless of how many articles
// were in scope, and mark-all.html recomputes the id set itself from
// articles.json using this same window.
function buildMarkAllUrl(windowStart, windowEnd) {
  const url = new URL("mark-all.html", READER_BASE_URL);
  url.searchParams.set("from", windowStart);
  url.searchParams.set("to", windowEnd);
  return url.toString();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml({ selectedArticles, candidateCount, markAllUrl, today }) {
  const markAllButton = `<p><a href="${escapeHtml(markAllUrl)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;">このダイジェストを全て既読にする（${candidateCount}件）</a></p>`;

  const items = selectedArticles
    .map((a) => {
      return `
        <div style="border:1px solid #e2e5ea;border-radius:8px;padding:12px 14px;margin-bottom:10px;">
          <div style="font-size:12px;color:#6a7280;margin-bottom:4px;">
            <span style="background:#eaf0ff;color:#2563eb;border-radius:999px;padding:1px 8px;">${escapeHtml(a.category)}</span>
            <span style="margin-left:6px;">${escapeHtml(a.feedTitle)}</span>
          </div>
          <a href="${escapeHtml(a.link)}" style="font-weight:600;color:#1b1f23;text-decoration:none;font-size:15px;">${escapeHtml(a.title)}</a>
          ${a.summary ? `<p style="color:#444;font-size:13px;margin:6px 0 4px;">${escapeHtml(a.summary)}</p>` : ""}
          ${a.why ? `<p style="color:#2563eb;font-size:12px;margin:0;">${escapeHtml(a.why)}</p>` : ""}
        </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<body style="font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#1b1f23;">
  <h1 style="font-size:18px;">RSS Digest - ${escapeHtml(today)}</h1>
  <p style="color:#6a7280;font-size:13px;">${candidateCount}件の新着記事から${selectedArticles.length}件を選びました。</p>
  ${markAllButton}
  ${items}
  ${markAllButton}
</body>
</html>`;
}

function buildEmailText({ selectedArticles, candidateCount, markAllUrl, today }) {
  const lines = [`RSS Digest - ${today}`, `${candidateCount}件の新着記事から${selectedArticles.length}件を選びました。`, ""];
  lines.push(`全て既読にする: ${markAllUrl}`, "");
  for (const a of selectedArticles) {
    lines.push(`[${a.category}] ${a.title}`);
    lines.push(a.link);
    if (a.summary) lines.push(a.summary);
    if (a.why) lines.push(`→ ${a.why}`);
    lines.push("");
  }
  lines.push(`全て既読にする: ${markAllUrl}`);
  return lines.join("\n");
}

async function sendEmail({ subject, html, text }) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set to send the digest email.");
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: GMAIL_USER,
    to: RECIPIENT_EMAIL,
    subject,
    html,
    text,
  });
}

async function main() {
  const windowEnd = new Date().toISOString();
  const windowStart = new Date(Date.now() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const candidates = await loadCandidateArticles(windowStart, windowEnd);
  console.log(`Loaded ${candidates.length} candidate articles from the last ${CANDIDATE_WINDOW_HOURS}h`);

  if (candidates.length === 0) {
    console.log("No new articles in the window; skipping digest.");
    return;
  }

  const candidatesById = new Map(candidates.map((a) => [a.id, a]));
  const bookmarks = await loadRecentHatenaBookmarks();
  console.log(`Loaded ${bookmarks.length} recent Hatena bookmarks as the interest signal`);

  let rawSelection;
  try {
    rawSelection = await callGemini(candidates, bookmarks);
  } catch (err) {
    console.error(`Gemini selection failed, falling back to newest-first: ${err.message}`);
    rawSelection = null;
  }
  if (!rawSelection) rawSelection = buildFallbackSelection(candidates);

  const selectedArticles = rawSelection
    .map((s) => {
      const article = candidatesById.get(s.id);
      if (!article) return null;
      return {
        id: article.id,
        title: article.title,
        link: article.link,
        category: article.category,
        feedTitle: article.feedTitle,
        summary: s.summary || "",
        why: s.why || "",
      };
    })
    .filter(Boolean);

  const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const markAllUrl = buildMarkAllUrl(windowStart, windowEnd);
  console.log(`Mark-all URL: ${markAllUrl}`);

  const html = buildEmailHtml({ selectedArticles, candidateCount: candidates.length, markAllUrl, today });
  const text = buildEmailText({ selectedArticles, candidateCount: candidates.length, markAllUrl, today });

  await sendEmail({ subject: `RSS Digest - ${today} (${selectedArticles.length}件)`, html, text });
  console.log(`Sent digest with ${selectedArticles.length} articles to ${RECIPIENT_EMAIL}`);
}

main().catch((err) => {
  console.error("digest.js failed:", err);
  process.exitCode = 1;
});
