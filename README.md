# Kbail — Kingsley Brief Mail

Kbail is an Express + MySQL email briefing web app that connects to Gmail (via Google OAuth 2.0) or a built-in Sample Mailbox, extracts dates/deadlines, and summarizes messages into concise bullet points using Groq (`openai/gpt-oss-20b`) with Gemini fallback.

## Prerequisites

- Node.js 18+ (tested with Node 22)
- MySQL 8+ (or compatible MariaDB)
- Google Cloud OAuth 2.0 credentials (for Gmail login)
- Groq API key and/or Gemini API key (for AI summarization)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Initialize the MySQL database**

   ```bash
   mysql -u root -p < schema.sql
   ```

   This creates the `kbail` database (`utf8mb4`) and two tables:
   - `raw_emails`: stores fetched/sample emails (`user_email`, `message_id`, `subject`, `sender`, `body`, `received_at`, `extracted_dates`), keyed uniquely on `(user_email, message_id)`.
   - `email_summaries`: stores generated bullet-point summaries (`raw_email_id`, `user_email`, `sender`, `subject`, `time_label`, `summary_points`), referencing `raw_emails(id)` with `ON DELETE CASCADE`.

3. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   | Key | Description |
   | --- | --- |
   | `PORT` | HTTP server port (default: `8080`) |
   | `HOST` | Bind host (default: `127.0.0.1`) |
   | `SESSION_SECRET` | Secret for `express-session` cookies |
   | `DB_HOST` | MySQL host (default: `127.0.0.1`) |
   | `DB_PORT` | MySQL port (default: `3306`) |
   | `DB_USER` | MySQL username |
   | `DB_PASSWORD` | MySQL password |
   | `DB_NAME` | MySQL database name (`kbail`) |
   | `GEMINI_API_KEY` | Google Gemini API key (fallback summarizer) |
   | `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
   | `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
   | `GOOGLE_REDIRECT_URI` | OAuth callback URL (e.g. `http://localhost:8080/auth/google/callback`) |
   | `GROQ_API_KEY` | Groq API key (primary summarizer) |

## Running Locally

```bash
npm start
```

Open `http://localhost:8080` or `http://127.0.0.1:8080` in your browser.

- Click **Sample Mailbox** (`/auth/sample`) to try the app with `sample_emails.json` without Google OAuth.
- Click **Continue with Google** (`/auth/google`) to sign in with Gmail read-only access (`gmail.readonly` + `userinfo.email`).

## Architecture

- **Frontend (`UIUX/`)**: Static `landing.html` and `home_page.html` served by Express with `httpOnly`, `sameSite: "lax"` session cookies.
- **Email Ingestion**:
  - **Gmail API v1**: Fetches up to 10 recent messages (`users/me/messages`), decodes URL-safe base64 `multipart/alternative`, `text/plain`, and HTML-to-text fallback bodies.
  - **Date Extraction**: `extractEmailDates` detects dates and deadlines in subject/body before summarization.
- **AI Summarization**:
  - Primary: Groq Chat Completions (`openai/gpt-oss-20b`) with JSON output.
  - Fallback: Gemini `generateContent` when `GROQ_API_KEY` is unset or Groq fails.
  - Responses strip markdown fences and validate `summary_points` arrays with a safe fallback.
- **Endpoints**:
  - `GET /api/health` — Database connectivity check
  - `GET /api/me` — Current authenticated session (`401` if unauthenticated)
  - `GET /api/emails` & `POST /api/sync` — Sync and return summarized emails
  - `GET /api/emails/:id/full` — Return full email body (`404` if not found)
  - `GET /auth/sample`, `GET /auth/google`, `GET /auth/google/callback`, `GET /auth/logout`
