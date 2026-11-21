const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const session = require("express-session");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const GMAIL_MAX_RESULTS = Number(process.env.GMAIL_MAX_RESULTS) || 100;
const MAX_SUMMARIZE = Number(process.env.MAX_SUMMARIZE_PER_SYNC) || 5;
const SUMMARY_FALLBACK = ["Summary unavailable for this message."];
const samplePath = path.join(__dirname, "sample_emails.json");

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "kbail-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));
app.use("/UIUX", express.static(path.join(__dirname, "../UIUX")));
app.use("/assets", express.static(path.join(__dirname, "../assets")));

function makeError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendError(req, res, err) {
  if (err.status === 401) {
    delete req.session.accessToken;
    delete req.session.userEmail;
    delete req.session.mode;
  }
  res.status(err.status || 500).json({ error: err.message });
}

function requireAuth(req, res, next) {
  if (!req.session.userEmail) return res.status(401).json({ error: "Not authenticated" });
  if (req.session.mode === "google" && !req.session.accessToken) {
    return res.status(401).json({ error: "Google session expired. Please log in again." });
  }
  next();
}

function formatTimeLabel(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return "Recent";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
    .trim();
}

function findPart(node, mime) {
  if (!node) return "";
  const nodeMime = String(node.mimeType || "").toLowerCase();
  if (nodeMime.startsWith(mime) && node.body && node.body.data) {
    return Buffer.from(node.body.data, "base64url").toString("utf8").trim();
  }
  for (const part of node.parts || []) {
    const found = findPart(part, mime);
    if (found) return found;
  }
  return "";
}

function extractPlainText(payload) {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(html);
  const mime = String(payload.mimeType || "").toLowerCase();
  if ((!mime || mime.startsWith("text/")) && payload.body && payload.body.data) {
    return htmlToText(Buffer.from(payload.body.data, "base64url").toString("utf8"));
  }
  return "";
}

function parsePoints(rawText) {
  if (typeof rawText !== "string") return SUMMARY_FALLBACK;
  const cleaned = rawText.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  if (!cleaned) return SUMMARY_FALLBACK;

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return SUMMARY_FALLBACK;
    try { parsed = JSON.parse(match[0]); } catch { return SUMMARY_FALLBACK; }
  }

  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && Array.isArray(parsed.summary_points)) list = parsed.summary_points;
  if (!list) return SUMMARY_FALLBACK;

  const points = [];
  for (const item of list) {
    const text = String(item || "").trim();
    if (text) points.push(text);
    if (points.length === 4) break;
  }
  if (points.length === 0) return SUMMARY_FALLBACK;
  return points;
}

async function postJson(url, headers, body, label) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(body)
  });
  if (res.status === 429) throw makeError(`${label} rate limit (429)`, 429);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${label} error (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function summarizeEmail(email) {
  const prompt = [
    "Summarize this email into 2 to 3 concise bullet points, including any dates or deadlines.",
    'Return strict JSON: {"summary_points": ["point 1", "point 2"]}',
    `Subject: ${email.subject || "(No subject)"}`,
    `Sender: ${email.sender || "Unknown sender"}`,
    `Received: ${email.receivedAt || ""}`,
    `Body:\n${String(email.body || "").slice(0, 3500)}`
  ].join("\n\n");

  if (process.env.GROQ_API_KEY) {
    try {
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` };
      const body = {
        model: "openai/gpt-oss-20b",
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: "You summarize emails into strict JSON." }, { role: "user", content: prompt }]
      };
      const data = await postJson("https://api.groq.com/openai/v1/chat/completions", headers, body, "Groq");
      const choice = data.choices && data.choices[0];
      const content = (choice && choice.message && choice.message.content) || "{}";
      return parsePoints(content);
    } catch (err) {
      if (!process.env.GEMINI_API_KEY) throw err;
    }
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } };
  const data = await postJson(url, { "Content-Type": "application/json" }, body, "Gemini");
  const first = data.candidates && data.candidates[0];
  const parts = first && first.content && first.content.parts;
  const text = (parts && parts[0] && parts[0].text) || "{}";
  return parsePoints(text);
}

async function gmailGet(url, token) {
  if (!token) throw makeError("Google session expired. Please log in again.", 401);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw makeError("Google session expired. Please log in again.", 401);
  if (res.status === 404) throw makeError("Email not found.", 404);
  if (!res.ok) {
    let status = 502;
    if (res.status === 403) status = 403;
    throw makeError(`Gmail error (${res.status})`, status);
  }
  return res.json();
}

function parseGmailMessage(msg, includeBody) {
  const headers = (msg.payload && msg.payload.headers) || [];
  let from = "";
  let subject = "";
  let rawDate = "";
  for (const h of headers) {
    const name = String(h.name || "").toLowerCase();
    if (name === "from") from = h.value || "";
    else if (name === "subject") subject = h.value || "";
    else if (name === "date") rawDate = h.value || "";
  }

  let sender = from.replace(/<[^>]+>/g, "").replace(/"/g, "").trim();
  if (!sender) sender = from.trim() || "Unknown sender";

  let receivedAt = new Date().toISOString();
  if (rawDate && !Number.isNaN(new Date(rawDate).getTime())) receivedAt = new Date(rawDate).toISOString();
  else if (msg.internalDate) receivedAt = new Date(Number(msg.internalDate)).toISOString();

  const mail = { id: String(msg.id), sender, subject: subject || "(No subject)", receivedAt, time: formatTimeLabel(receivedAt) };
  if (includeBody) mail.body = extractPlainText(msg.payload) || msg.snippet || "";
  return mail;
}

async function fetchGmailMetadata(id, token) {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
    const msg = await gmailGet(url, token);
    return parseGmailMessage(msg, false);
  } catch (err) {
    if (err.status === 401) throw err;
    console.warn(`Gmail metadata skipped for id=${id}: ${err.message}`);
    return null;
  }
}

async function fetchGmailInbox(token, maxResults) {
  const target = Math.max(1, Math.min(500, Number(maxResults) || GMAIL_MAX_RESULTS));
  const items = [];
  let pageToken = "";

  while (items.length < target) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("labelIds", "INBOX");
    url.searchParams.set("maxResults", String(Math.min(100, target - items.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await gmailGet(url.toString(), token);
    if (!data.messages || data.messages.length === 0) break;
    for (const item of data.messages) {
      if (item && item.id) items.push(item);
      if (items.length >= target) break;
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const emails = [];
  for (let i = 0; i < items.length; i += 10) {
    const jobs = [];
    for (let j = i; j < i + 10 && j < items.length; j++) jobs.push(fetchGmailMetadata(items[j].id, token));
    const batch = await Promise.all(jobs);
    for (const mail of batch) {
      if (mail) emails.push(mail);
    }
  }
  emails.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return emails;
}

async function fetchGmailFullMessage(token, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
  const msg = await gmailGet(url, token);
  return parseGmailMessage(msg, true);
}

function loadSampleEmails() {
  const raw = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const list = [];
  for (const m of raw) {
    const receivedAt = new Date(m.received_at || Date.now()).toISOString();
    list.push({
      id: String(m.message_id),
      sender: m.sender || "Unknown sender",
      subject: m.subject || "(No subject)",
      receivedAt,
      time: m.time_label || formatTimeLabel(receivedAt),
      body: m.body || ""
    });
  }
  list.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return list;
}

async function loadSingleEmail(req) {
  const id = String(req.params.id || "").trim();
  if (!id) throw makeError("Email not found.", 404);
  if (req.session.mode === "sample") {
    for (const item of loadSampleEmails()) {
      if (item.id === id) return item;
    }
    throw makeError("Email not found.", 404);
  }
  return fetchGmailFullMessage(req.session.accessToken, id);
}

async function syncEmails(req, res) {
  try {
    const cachedIds = new Set();
    if (req.body && Array.isArray(req.body.cachedIds)) {
      for (const id of req.body.cachedIds) cachedIds.add(id);
    }

    let rawList;
    if (req.session.mode === "sample") {
      rawList = loadSampleEmails();
    } else {
      const limit = Number(req.query.limit);
      let maxResults = GMAIL_MAX_RESULTS;
      if (Number.isInteger(limit) && limit > 0) maxResults = Math.min(limit, 500);
      rawList = await fetchGmailInbox(req.session.accessToken, maxResults);
    }

    const emails = [];
    let summarizedCount = 0;
    let rateLimited = false;

    for (const mail of rawList) {
      let points = ["Summary not generated yet."];
      let summarized = false;
      if (!cachedIds.has(mail.id) && !rateLimited && summarizedCount < MAX_SUMMARIZE) {
        summarizedCount += 1;
        try {
          let fullMail = mail;
          if (mail.body === undefined) fullMail = await fetchGmailFullMessage(req.session.accessToken, mail.id);
          points = await summarizeEmail(fullMail);
          summarized = true;
        } catch (err) {
          if (err.status === 401) throw err;
          if (err.status === 429) rateLimited = true;
          console.warn(`Summary skipped for id=${mail.id}: ${err.message}`);
        }
      }
      emails.push({ id: mail.id, sender: mail.sender, subject: mail.subject, time: mail.time, receivedAt: mail.receivedAt, points, summarized });
    }
    res.json({ emails });
  } catch (err) {
    sendError(req, res, err);
  }
}

app.get("/", (_req, res) => res.redirect("/UIUX/html/landing.html"));
app.get("/api/health", (_req, res) => res.json({ status: "ok", storage: "browser-local" }));

app.get("/auth/sample", (req, res) => {
  req.session.mode = "sample";
  req.session.userEmail = "Sample Mailbox";
  delete req.session.accessToken;
  res.redirect("/UIUX/html/home_page.html");
});

app.get("/auth/google", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) return res.status(500).send("Google OAuth is not configured in .env yet.");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type: "online",
    prompt: "select_account"
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!req.query.code) return res.redirect("/UIUX/html/landing.html");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description || "OAuth token exchange failed.");
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!userRes.ok) throw new Error("Failed to fetch Google user profile.");
    const profile = await userRes.json();
    req.session.mode = "google";
    req.session.userEmail = profile.email || "Google Account";
    req.session.accessToken = tokens.access_token;
    res.redirect("/UIUX/html/home_page.html");
  } catch (err) {
    res.status(500).send(`Google login failed: ${err.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/UIUX/html/landing.html");
  });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ mode: req.session.mode, email: req.session.userEmail }));
app.get("/api/emails", requireAuth, syncEmails);
app.post("/api/sync", requireAuth, syncEmails);

app.get("/api/emails/:id/full", requireAuth, async (req, res) => {
  try {
    const mail = await loadSingleEmail(req);
    res.json({ id: mail.id, sender: mail.sender, subject: mail.subject, time: mail.time, body: mail.body });
  } catch (err) {
    sendError(req, res, err);
  }
});

app.post("/api/emails/:id/summarize", requireAuth, async (req, res) => {
  try {
    const mail = await loadSingleEmail(req);
    const points = await summarizeEmail(mail);
    res.json({ id: mail.id, points, summarized: true });
  } catch (err) {
    sendError(req, res, err);
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`Kbail server listening on http://${HOST}:${PORT}`));
}

module.exports = { app };
