# The Batch — stateful weekly saved-items feed

A phone-friendly static feed of your starred Gmail and X Bookmarks, refreshed every Saturday by a GitHub Actions cron. Items carry persistent state (`new|seen|sparred|acted|dismissed`) and spar/act threads that compound week over week.

## Gmail OAuth walkthrough

1. Google Cloud Console → new project → enable Gmail API.
2. OAuth consent screen → External → add your email as a test user.
3. Credentials → OAuth client ID → Desktop app → note Client ID + Secret.
4. OAuth 2.0 Playground → gear → "Use your own OAuth credentials" → paste ID+secret.
5. Authorize scope `https://www.googleapis.com/auth/gmail.readonly` → allow → exchange for tokens → copy refresh token.
6. Repo → Settings → Secrets and variables → Actions → add GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
7. Repo → Settings → Pages → deploy from main / root. Open the URL on your phone, add to home screen.

## Architecture

One **context store** (repo JSON) is the single source of truth. Two clients read/write it: a **phone-friendly static feed** (GitHub Pages) and **Dia on Mac** (via a write-back file). Item **state** and **spar/act threads** live in the store, never only in a client. Each Saturday the cron reads prior item state before writing the new batch, so the memory compounds week over week.

### File tree

```
batch/
├─ index.html
├─ updates.json                 # write-back channel; starts as []
├─ batches/
│   ├─ index.json
│   └─ 2026-08-01.json
├─ scripts/
│   ├─ gather-gmail.mjs
│   └─ lib.mjs
├─ .github/workflows/batch.yml
├─ package.json
└─ README.md
```

## Known limitation (by design, not a stopgap)

The static feed cannot write to the store server-side. Phone marks (seen/dismissed) and Dia spar/act updates are queued into `updates.json`, which the Saturday cron folds into the store on its next run. Write-back is therefore **asynchronous**.

The feed queues marks in `localStorage` and surfaces a **"Copy updates.json"** button so you can manually paste the pending marks into `updates.json` in the repo (or commit them via the GitHub UI) until the next cron fold.

When a persistent server-side store is added later, the write path becomes synchronous with no change to the store schema.

## Usage

```bash
npm install
# With secrets set:
node scripts/gather-gmail.mjs
# Without secrets (safe, exits 0):
node scripts/gather-gmail.mjs
```

The workflow runs every Saturday at 13:00 UTC and can be triggered manually via `workflow_dispatch`.