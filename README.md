# Kbail — Kingsley Brief Mail

Privacy-first Gmail summarizer with 2–3 bullet summaries, highlighted dates, and on-demand full reading. No server database is used: `BACKENDS/server.js` acts as a stateless proxy, while inbox metadata and summaries stay in your browser's `localStorage` and are wiped on Logout.

## Structure
- `UIUX/` — HTML, CSS, and client JS (`html/`, `styles/`, `scripts/`)
- `BACKENDS/` — Node/Express API (`server.js`, `package.json`, `sample_emails.json`, local `.env`)
- `assets/` & `sketches/` — Background video (`clouds.mp4`) and wireframe sketches

## APIs
- **[Gmail API v1](https://developers.google.com/gmail/api)** (`labelIds=INBOX`)
- **[Groq API](https://console.groq.com/)** (primary) & **[Google Gemini API](https://ai.google.dev/)** (fallback)

## Local Setup
1. Run `cd BACKENDS && npm install`
2. Set `SESSION_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `BACKENDS/.env`
3. Run `cd BACKENDS && npm start` and open `http://localhost:8080`
