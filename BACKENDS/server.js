const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_GMAIL_MAX_RESULTS = Number(process.env.GMAIL_MAX_RESULTS) || 100;
const MAX_SUMMARIZE_PER_SYNC = Number(process.env.MAX_SUMMARIZE_PER_SYNC) || 5;
const SUMMARY_FALLBACK = ["Summary unavailable for this message."];
const samplePath = path.join(__dirname, "sample_emails.json");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "kbail_user",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kbail",
  waitForConnections: true,
  connectionLimit: 10
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "kbail-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));
app.use("/UIUX", express.static(path.join(__dirname, "../UIUX")));
app.use("/assets", express.static(path.join(__dirname, "../assets")));

app.get("/", (req, res) => res.redirect("/UIUX/html/landing.html"));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: err.message });
  }
});

function extractEmailDates(text, receivedAt = null) {
  const s = String(text ?? "");
  const patterns = [
    /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*(?:,?\s+\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi,
    /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g,
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|today|tomorrow)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM))?\b/gi
  ];
  const found = new Set();
  for (const re of patterns) {
    for (const m of s.match(re) || []) found.add(m.replace(/\s+/g, " ").trim());
  }
  return { receivedAt, mentionedDates: [...found] };
}

function formatTimeLabel(dateInput) {
  const d = new Date(dateInput);
  return Number.isNaN(d.getTime())
    ? "Recent"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function toMysqlDatetime(dateInput) {
  const d = new Date(dateInput);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 19).replace("T", " ");
}

async function postAI(url, headers, body, label) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(body)
  });
  if (res.status === 429) {
    throw Object.assign(new Error(`${label} rate limit (429)`), { status: 429 });
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${label} error (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function parsePoints(raw) {
  if (Array.isArray(raw)) {
    const pts = raw.map((p) => String(p ?? "").trim()).filter(Boolean).slice(0, 4);
    return pts.length ? pts : SUMMARY_FALLBACK;
  }
  if (typeof raw !== "string") return SUMMARY_FALLBACK;
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!cleaned) return SUMMARY_FALLBACK;

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return SUMMARY_FALLBACK;
    try { parsed = JSON.parse(match[0]); } catch { return SUMMARY_FALLBACK; }
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.summary_points;
  if (!Array.isArray(list)) return SUMMARY_FALLBACK;
  const points = list.map((p) => String(p ?? "").trim()).filter(Boolean).slice(0, 4);
  return points.length ? points : SUMMARY_FALLBACK;
}

async function summarizeEmail(email) {
  const received = email.received_at instanceof Date
    ? email.received_at.toISOString()
    : String(email.received_at || "");
  const prompt = [
    "Summarize this email into 2 to 3 concise bullet points, including any dates or deadlines.",
    'Return strict JSON: {"summary_points": ["point 1", "point 2"]}',
    `Subject: ${email.subject || "(No subject)"}`,
    `Sender: ${email.sender || "Unknown sender"}`,
    `Received: ${received}`,
    `Detected Dates: ${JSON.stringify(email.extracted_dates || [])}`,
    `Body:\n${String(email.body || "").slice(0, 3500)}`
  ].join("\n\n");

  const callGroq = async () => {
    const data = await postAI(
      "https://api.groq.com/openai/v1/chat/completions",
      { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      {
        model: "openai/gpt-oss-20b",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You summarize emails into strict JSON." },
          { role: "user", content: prompt }
        ]
      },
      "Groq"
    );
    return data?.choices?.[0]?.message?.content || "{}";
  };

  const callGemini = async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not configured.");
    const data = await postAI(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      {},
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      },
      "Gemini"
    );
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  };

  let rawText;
  if (process.env.GROQ_API_KEY) {
    try {
      rawText = await callGroq();
    } catch (err) {
      if (!process.env.GEMINI_API_KEY) throw err;
      rawText = await callGemini();
    }
  } else {
    rawText = await callGemini();
  }
  return parsePoints(rawText);
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractPlainText(payload) {
  const findPart = (node, mime) => {
    if (!node) return "";
    if ((node.mimeType || "").toLowerCase().startsWith(mime) && node.body?.data) {
      return Buffer.from(node.body.data, "base64url").toString("utf8").trim();
    }
    for (const part of node.parts || []) {
      const hit = findPart(part, mime);
      if (hit) return hit;
    }
    return "";
  };
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(html);
  const mime = (payload?.mimeType || "").toLowerCase();
  if ((!mime || mime.startsWith("text/")) && payload?.body?.data) {
    return htmlToText(Buffer.from(payload.body.data, "base64url").toString("utf8"));
  }
  return "";
}

async function runBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function gmailJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    throw Object.assign(new Error("Google session expired. Please log in again."), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Gmail error (${res.status})`), { status: res.status === 403 ? 403 : 502 });
  }
  return res.json();
}

async function fetchGmailInbox(accessToken, maxResults = DEFAULT_GMAIL_MAX_RESULTS, existingIds = new Set(), inboxIdsOut = null) {
  if (!accessToken) {
    throw Object.assign(new Error("Google session expired. Please log in again."), { status: 401 });
  }
  const target = Math.max(1, Math.min(500, Number(maxResults) || DEFAULT_GMAIL_MAX_RESULTS));
  const collected = [];
  let pageToken = null;

  while (collected.length < target) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("labelIds", "INBOX");
    url.searchParams.set("maxResults", String(Math.min(100, target - collected.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await gmailJson(url.toString(), accessToken);
    if (!data.messages?.length) break;
    collected.push(...data.messages);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const pageSlice = collected.slice(0, target);
  if (inboxIdsOut instanceof Set) {
    for (const m of pageSlice) {
      if (m?.id) inboxIdsOut.add(m.id);
    }
  }
  const toFetch = pageSlice.filter((m) => m?.id && !existingIds.has(m.id));
  if (!toFetch.length) return [];

  const fetched = await runBatches(toFetch, 8, async (item) => {
    try {
      const msg = await gmailJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
        accessToken
      );
      const getHeader = (name) =>
        (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || "";
      const from = getHeader("from") || "Unknown sender";
      const rawDate = getHeader("date");
      const dateValue = rawDate && !Number.isNaN(new Date(rawDate).getTime())
        ? rawDate
        : Number(msg.internalDate || Date.now());
      return {
        message_id: msg.id,
        sender: from.replace(/<[^>]+>|"/g, "").trim() || from,
        subject: getHeader("subject") || "(No subject)",
        body: extractPlainText(msg.payload) || msg.snippet || "",
        received_at: toMysqlDatetime(dateValue),
        time_label: formatTimeLabel(dateValue)
      };
    } catch (err) {
      if (err.status === 401) throw err;
      return null;
    }
  });
  return fetched.filter(Boolean);
}

async function summarizeAndSave(row, userEmail) {
  const points = await summarizeEmail(row);
  await pool.query(
    `INSERT IGNORE INTO email_summaries
     (raw_email_id, user_email, sender, subject, time_label, summary_points)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      userEmail,
      String(row.sender || "Unknown sender").slice(0, 255),
      String(row.subject || "(No subject)").slice(0, 500),
      formatTimeLabel(row.received_at).slice(0, 64),
      JSON.stringify(points)
    ]
  );
  return points;
}

async function getCachedEmailsForUser(userEmail) {
  const [rows] = await pool.query(
    `SELECT r.id, r.sender, r.subject, r.received_at, s.time_label, s.summary_points AS points
     FROM raw_emails r
     LEFT JOIN email_summaries s ON s.raw_email_id = r.id
     WHERE r.user_email = ?
     ORDER BY r.received_at DESC`,
    [userEmail]
  );
  return rows.map((r) => ({
    id: r.id,
    sender: r.sender,
    subject: r.subject,
    time: r.time_label || formatTimeLabel(r.received_at),
    points: r.points ? parsePoints(r.points) : ["Summary not generated yet."],
    summarized: Boolean(r.points)
  }));
}

async function syncEmailsForUser(userEmail, rawList) {
  for (const mail of Array.isArray(rawList) ? rawList : []) {
    if (!mail?.message_id) continue;
    const subject = String(mail.subject || "(No subject)").slice(0, 500);
    const body = String(mail.body ?? "");
    const receivedAt = toMysqlDatetime(mail.received_at);
    await pool.query(
      `INSERT IGNORE INTO raw_emails
       (user_email, message_id, subject, sender, body, received_at, extracted_dates)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userEmail,
        String(mail.message_id).slice(0, 255),
        subject,
        String(mail.sender || "Unknown sender").slice(0, 255),
        body,
        receivedAt,
        JSON.stringify(extractEmailDates(`${subject}\n${body}`, receivedAt))
      ]
    );
  }

  const [unsummarized] = await pool.query(
    `SELECT r.* FROM raw_emails r
     LEFT JOIN email_summaries s ON s.raw_email_id = r.id
     WHERE r.user_email = ? AND s.id IS NULL
     ORDER BY r.received_at DESC LIMIT ?`,
    [userEmail, MAX_SUMMARIZE_PER_SYNC]
  );

  let rateLimited = false;
  await runBatches(unsummarized, 3, async (row) => {
    if (rateLimited) return;
    try {
      await summarizeAndSave(row, userEmail);
    } catch (err) {
      if (err.status === 429) rateLimited = true;
      console.warn(`Summary skipped for raw_email_id=${row.id}: ${err.message}`);
    }
  });

  return getCachedEmailsForUser(userEmail);
}

function requireAuth(req, res, next) {
  if (!req.session.userEmail) return res.status(401).json({ error: "Not authenticated" });
  if (req.session.mode === "google" && !req.session.accessToken) {
    return res.status(401).json({ error: "Google session expired. Please log in again." });
  }
  next();
}

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

app.get("/auth/sample", (req, res) => {
  req.session.mode = "sample";
  req.session.userEmail = "Sample Mailbox";
  delete req.session.accessToken;
  res.redirect("/UIUX/html/home_page.html");
});

app.get("/auth/google", (req, res) => {
  const { GOOGLE_CLIENT_ID: client_id, GOOGLE_REDIRECT_URI: redirect_uri } = process.env;
  if (!client_id || !redirect_uri) {
    return res.status(500).send("Google OAuth is not configured in .env yet.");
  }
  const params = new URLSearchParams({
    client_id,
    redirect_uri,
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
    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.error_description || "OAuth token exchange failed.");
    }
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

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ mode: req.session.mode, email: req.session.userEmail });
});

async function handleEmailFetch(req, res) {
  try {
    let rawList;
    if (req.session.mode === "sample") {
      rawList = JSON.parse(fs.readFileSync(samplePath, "utf8"));
    } else {
      const limit = Number(req.query.limit);
      const isPartial = Number.isInteger(limit) && limit > 0 && limit < DEFAULT_GMAIL_MAX_RESULTS;
      const maxResults = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : DEFAULT_GMAIL_MAX_RESULTS;
      const [rows] = await pool.query("SELECT message_id FROM raw_emails WHERE user_email = ?", [req.session.userEmail]);
      const inboxIds = new Set();
      rawList = await fetchGmailInbox(req.session.accessToken, maxResults, new Set(rows.map((r) => r.message_id)), inboxIds);
      if (!isPartial) {
        if (inboxIds.size) {
          const placeholders = [...inboxIds].map(() => "?").join(",");
          await pool.query(
            `DELETE FROM raw_emails WHERE user_email = ? AND message_id NOT IN (${placeholders})`,
            [req.session.userEmail, ...inboxIds]
          );
        } else {
          await pool.query("DELETE FROM raw_emails WHERE user_email = ?", [req.session.userEmail]);
        }
      }
    }
    res.json({ emails: await syncEmailsForUser(req.session.userEmail, rawList) });
  } catch (err) {
    if (err.status === 401) {
      delete req.session.accessToken;
      delete req.session.userEmail;
      delete req.session.mode;
    }
    res.status(err.status || 500).json({ error: err.message });
  }
}

app.get("/api/emails", requireAuth, async (req, res) => {
  try {
    const cached = await getCachedEmailsForUser(req.session.userEmail);
    if (cached.length) return res.json({ emails: cached });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return handleEmailFetch(req, res);
});

app.post("/api/sync", requireAuth, handleEmailFetch);

app.get("/api/emails/:id/full", requireAuth, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(404).json({ error: "Email not found." });
  try {
    const [rows] = await pool.query(
      "SELECT id, sender, subject, body, received_at FROM raw_emails WHERE id = ? AND user_email = ?",
      [id, req.session.userEmail]
    );
    if (!rows.length) return res.status(404).json({ error: "Email not found." });
    const row = rows[0];
    res.json({ id: row.id, sender: row.sender, subject: row.subject, time: formatTimeLabel(row.received_at), body: row.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/emails/:id/summarize", requireAuth, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(404).json({ error: "Email not found." });
  try {
    const [existing] = await pool.query(
      "SELECT summary_points FROM email_summaries WHERE raw_email_id = ? AND user_email = ?",
      [id, req.session.userEmail]
    );
    if (existing.length) {
      return res.json({ id, points: parsePoints(existing[0].summary_points), summarized: true });
    }
    const [rows] = await pool.query(
      "SELECT * FROM raw_emails WHERE id = ? AND user_email = ?",
      [id, req.session.userEmail]
    );
    if (!rows.length) return res.status(404).json({ error: "Email not found." });
    const points = await summarizeAndSave(rows[0], req.session.userEmail);
    res.json({ id, points, summarized: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`Kbail server listening on http://${HOST}:${PORT}`));
}

module.exports = {
  app,
  pool,
  fetchGmailInbox,
  handleEmailFetch,
  syncEmailsForUser,
  extractPlainText,
  extractEmailDates,
  summarizeEmail,
  DEFAULT_GMAIL_MAX_RESULTS,
  MAX_SUMMARIZE_PER_SYNC
};
