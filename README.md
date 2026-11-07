# GatePass // Event Ops

Campus event pass registration and gate check-in desk. Vanilla HTML/CSS/JS + Supabase (PostgreSQL). No build step, no frameworks.

## Features

- **Student registration** with validation, unique 8-char pass codes (`PASS-XXXX`), and a Wallet-style digital pass with copy button.
- **Gate verification desk** with live metrics, instant search (name / USN / pass code), status filters, one-click admit, and a Quick Check bar (type a code, press Enter).
- **Database-enforced integrity**: one registration per Student ID and per email per event, capacity limit, server-side `admitted_at` timestamp, race-safe admits (two desks can't double-admit).
- Admin table auto-refreshes every 8 seconds so multiple gate desks stay in sync.

## Project structure

```
index.html   Markup + Supabase CDN
style.css    Dark theme UI
app.js       All logic (config at the top)
schema.sql   Supabase migration (tables, constraints, triggers, RLS, seed event)
```

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the contents of `schema.sql`, and run it. This creates the tables, policies, and seeds one event (edit the `insert` at the bottom to change title/date/capacity).
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. Paste them into the top of `app.js`:
   ```js
   const SUPABASE_URL = 'https://xxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJ...';
   ```
5. Serve the folder and open it:
   ```bash
   python3 -m http.server 8000   # then visit http://localhost:8000
   ```
   Or deploy the folder as-is to GitHub Pages, Netlify, or Vercel (static).

## Schema

| Table | Key columns |
|---|---|
| `events` | `id` (uuid), `title`, `event_date`, `capacity` |
| `attendees` | `id`, `event_id`, `full_name`, `email`, `student_id`, `pass_code` (unique), `is_admitted`, `admitted_at`, `created_at` |

Constraints: `unique (event_id, student_id)`, unique `(event_id, lower(email))`, unique `pass_code`, format checks on email and pass code.

## Notes

- Pass codes use `PASS-` plus 4 characters from an unambiguous alphabet (no `0/O/1/I`), generated with `crypto.getRandomValues`. Collisions are retried automatically.
- The app uses the first upcoming event in the `events` table.
- **Security:** the schema grants public (anon) read/insert/update so the app works with just the anon key. That means the admin tab is not access-controlled and anyone with the page can view or admit attendees. Fine for a demo or a trusted internal network. Before real use, put the admin tab behind Supabase Auth and restrict the `select`/`update` policies on `attendees` to authenticated staff.

## License

MIT
