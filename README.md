# Availability Scheduler

A group availability tool in the style of When2Meet. An organizer creates an event and shares a 6-character code. Each person marks the times they're free, and everyone sees a live heatmap of where the group overlaps. The organizer can then confirm one or more final times.

Built with React + Vite + Tailwind v3 on the frontend, and Supabase (Postgres, anonymous auth, row-level security, realtime, pg_cron) on the backend. Time-zone math uses Luxon.

## Features

- **Events and codes.** Create or join with a 6-character code. Each event's config and responses are fully isolated. Links work too: `?e=CODE`.
- **Flexible dates.** Pick a contiguous date range (up to 62 days) or up to 31 hand-picked dates.
- **Slot sizes.** Presets from 15 min to a whole day, or a custom size (5–1440 min) with live validation that snaps to the nearest 5 when you leave the field.
- **Time zones.** Each event has one canonical IANA zone. Viewers can relabel every time into their own zone, and the labels stay correct across daylight-saving changes.
- **Your response.** Edit or withdraw it later without logging in (anonymous auth). Duplicate names get a suffix, e.g. "Alex (2)".
- **Organizer tools.** Edit the event after creation, remove any response, finalize multiple times (shown in a "Confirmed times" banner), and set an optional response deadline that the server enforces.
- **Privacy.** Anonymous mode removes names on the server for everyone but the organizer. CSV exports let you pick columns and are always anonymized for non-organizers.
- **Retention.** Events and their responses are deleted automatically 15 days after the end date.
- **Accessibility.** Built toward Section 508 / WCAG 2.1 AA: keyboard operation, touch drag, ARIA tabs/dialogs/live regions, labelled controls, visible focus, and information that never relies on color alone.

## Project structure

```
availability-app/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example          # copy to .env (git-ignored)
├── .gitignore
├── docs/
│   └── SUPABASE-BUILD-GUIDE.md
├── supabase/
│   └── schema.sql        # tables, RLS, triggers, RPC, realtime, retention job
└── src/
    ├── main.jsx
    ├── index.css
    ├── supabaseClient.js
    └── AvailabilityApp.jsx
```

## Setup

### 1. Supabase

1. Create a Supabase project.
2. Go to **Authentication → Sign In / Providers** and turn on **Allow anonymous sign-ins**.
3. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it. If the `pg_cron` line errors, enable **pg_cron** under **Database → Extensions** and run the file again. It is safe to re-run.
4. Copy the **Project URL** and **publishable key** (`sb_publishable_...`) from **Project Settings → API Keys**.

See `docs/SUPABASE-BUILD-GUIDE.md` for what each part of the schema does and why.

### 2. Run locally

Requires Node.js 18 or later.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# edit .env with your URL and publishable key
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

### 3. Push to GitHub

Get it running locally first, then:

```bash
git init
git status                # confirm .env does NOT appear in the list
git add .
git commit -m "Initial commit: availability scheduler"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

## Security notes

- **Keep keys out of the repo.** Only the publishable key goes in `.env`. It is public by design, because RLS does the enforcement. Secret keys (and the legacy service-role key) must never go into this repo or the frontend.
- **Keep `.env` out of git.** It is git-ignored, but check `git status` before your first commit anyway. The most common leak is a first commit made before `.gitignore` is in place.
- **Commit `supabase/schema.sql`.** This repo is frontend-only, and the tables, RLS, anonymity RPC, and retention job live in Supabase. Versioning the SQL is what lets anyone reproduce a properly secured backend.
- **Don't open `subs_select` to `using (true)`.** That single change re-opens the name leak on anonymous events.

## Deployment and compliance

`npm run build` produces static files in `dist/` that any static host can serve (GitHub Pages, Azure Static Web Apps, Netlify, an internal web server). Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as build-time environment variables on the host.

> **Organizational use:** respondent names can be PII. Before using this for agency business, get the hosting and Supabase (a third-party cloud service) approved through your organization's authorization, privacy, and records processes, e.g. an ATO or privacy review. You may need an approved or self-hosted Postgres/Supabase instance instead of Supabase Cloud.

## Version note

Package versions are pinned to known-good majors. Tailwind is held at v3 on purpose, because v4 changed configuration significantly. If a newer install breaks something, pin back to the versions in `package.json`.

## Testing

User acceptance testing documents (test-case tracker, defect log, sign-off sheet, and runbook) live in the separate `uat/` package. Start with `HOW-TO-RUN-UAT.md`.
