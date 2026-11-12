#!/usr/bin/env node
// Daily job: pick today's most interesting articles out of github-rss-reader's
// feed data, matched against a static interest profile (interests.md) in this
// repo. That profile is refreshed by hand roughly monthly (via an interactive
// Claude Pro/Code session analyzing Hatena Bookmarks in depth — titles alone
// aren't enough signal for that), not regenerated on every run.

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const ARTICLES_URL =
  process.env.ARTICLES_URL || "https://takahashilabo.github.io/github-rss-reader/data/articles.json";
const READER_BASE_URL =
  process.env.READER_BASE_URL || "https://takahashilabo.github.io/github-rss-reader/";
const INTERESTS_PATH = process.env.INTERESTS_PATH || path.join(__dirname, "..", "interests.md");
const CANDIDATE_WINDOW_HOURS = parseInt(process.env.CANDIDATE_WINDOW_HOURS || "26", 10);
const MIN_SELECTED = 5;
const MAX_SELECTED = 15;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || GMAIL_USER;

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "rss-digest-mailer/1.0 (+https://github.com/; personal daily digest)";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
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

function loadInterestProfile() {
  try {
    return fs.readFileSync(INTERESTS_PATH, "utf8");
  } catch (err) {
    console.warn(`Could not read interest profile at ${INTERESTS_PATH}: ${err.message}`);
    return "";
  }
}

async function callGemini(candidates, interestProfile) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set; skipping AI selection, falling back to newest-first.");
    return null;
  }

  const candidateLines = candidates.map((a) => ({
    id: a.id,
    title: a.title,
    feed: a.feedTitle,
    snippet: (a.contentSnippet || "").slice(0, 200),
  }));

  const system =
    "あなたは個人向けの毎日のニュースダイジェストを作るキュレーターです。" +
    "ユーザーの興味関心プロファイルを参考に、候補記事の中から本当に興味を持ちそうなものだけのidを選んでください。" +
    "要約や説明文は不要で、idの選別だけ行ってください。" +
    `必ず ${MIN_SELECTED}〜${MAX_SELECTED} 件を選んでください（候補がそれより少ない場合は全件）。` +
    "idは与えられた候補のidをそのまま使い、絶対に新しいidを作らないでください。";

  const userContent =
    "## ユーザーの興味関心プロファイル\n" +
    (interestProfile || "(プロファイル未設定)") +
    "\n\n## 今日の候補記事\n" +
    JSON.stringify(candidateLines);

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          selected: {
            type: "ARRAY",
            items: { type: "STRING", description: "候補記事のid（そのまま）" },
          },
        },
        required: ["selected"],
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  console.log(`Gemini API responded in ${Date.now() - startedAt}ms`);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response had no content");

  return JSON.parse(text).selected || [];
}

function buildFallbackSelection(candidates) {
  return candidates.slice(0, MAX_SELECTED).map((a) => a.id);
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
  const interestProfile = loadInterestProfile();
  console.log(`Loaded interest profile (${interestProfile.length} chars) from ${INTERESTS_PATH}`);

  let rawSelection;
  try {
    rawSelection = await callGemini(candidates, interestProfile);
  } catch (err) {
    console.error(`Gemini selection failed, falling back to newest-first: ${err.message}`);
    rawSelection = null;
  }
  if (!rawSelection) rawSelection = buildFallbackSelection(candidates);

  const selectedArticles = rawSelection
    .map((id) => {
      const article = candidatesById.get(id);
      if (!article) return null;
      return {
        id: article.id,
        title: article.title,
        link: article.link,
        category: article.category,
        feedTitle: article.feedTitle,
        summary: article.contentSnippet || "",
      };
    })
    .filter(Boolean);

  const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const markAllUrl = buildMarkAllUrl(windowStart, windowEnd);
  console.log(`Mark-all URL: ${markAllUrl}`);

  const html = buildEmailHtml({ selectedArticles, candidateCount: candidates.length, markAllUrl, today });
  const text = buildEmailText({ selectedArticles, candidateCount: candidates.length, markAllUrl, today });
  const subject = `RSS Digest - ${today} (${selectedArticles.length}件)`;

  if (process.env.DRY_RUN === "true") {
    console.log(`DRY_RUN: would send "${subject}" to ${RECIPIENT_EMAIL}`);
    console.log(text);
    return;
  }

  await sendEmail({ subject, html, text });
  console.log(`Sent digest with ${selectedArticles.length} articles to ${RECIPIENT_EMAIL}`);
}

main().catch((err) => {
  console.error("digest.js failed:", err);
  process.exitCode = 1;
});
