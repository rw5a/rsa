# Supabase Build Guide: Availability Scheduler (Production)

This guide walks through the production backend step by step and explains the design decisions behind it. The SQL for Steps 2–5 is in `supabase/schema.sql`. Run that file once; the sections below explain what each part does.

---

## Architecture at a glance

| Concern | Prototype (sandbox) | Production (this build) |
|---|---|---|
| Storage | Key-value store | Postgres tables `events` + `submissions` |
| Identity | Per-browser storage | Supabase **anonymous auth**: a real `auth.uid()` per browser, no sign-up |
| "Only edit your own" | Trusted the browser | **RLS** enforced by Postgres |
| Organizer powers | Trusted the browser | RLS + `owner_id = auth.uid()` |
| Name privacy | Hidden in UI | Stripped **server-side** by a `security definer` RPC |
| Deadline | UI lock | UI lock **plus** a `before insert/update` trigger |
| Live updates | 8-second polling | **Realtime** channels (polling only where RLS requires it) |
| Retention | Lazy delete on join | Lazy client check **plus** a daily `pg_cron` purge |
| Time zones | Native `Intl` | **Luxon** |

---

## Step 1: Project and auth

1. Create a Supabase project.
2. Go to **Authentication → Sign In / Providers** and enable **Allow anonymous sign-ins**.
3. Optional: add CAPTCHA (Auth → Attack Protection) to limit anonymous-account abuse.

Why anonymous auth: every browser gets a real `auth.uid()` without anyone creating an account. That one change is what makes the security model hold. RLS can enforce "you can only edit your own response" and "only the organizer can delete anyone's" instead of trusting the client.

---

## Step 2: Tables

### `events`

| Column | Type | Notes |
|---|---|---|
| `code` | text PK | 6 chars `A–Z0–9`. Client generator avoids look-alikes (0/O, 1/I/L). |
| `name` | text | 1–120 chars |
| `owner_id` | uuid | Defaults to `auth.uid()`; the organizer |
| `tz` | text | Canonical IANA zone (e.g. `America/New_York`) |
| `date_mode` | text | `'range'` or `'custom'` (default `'range'`) |
| `start_date`, `end_date` | date | Inclusive. In custom mode, the min/max of `dates` |
| `dates` | jsonb | Array of `YYYY-MM-DD`; used in custom mode |
| `start_hour`, `end_hour` | int | Daily window. Whole-day slots = `0..24` |
| `granularity` | int | Slot minutes, `check (granularity between 1 and 1440)` |
| `deadline` | timestamptz | Optional response deadline |
| `anonymous` | boolean | Hide names from non-organizers |
| `finalized` | jsonb | Confirmed slot keys `["YYYY-MM-DD\|HH:MM", ...]` |

Constraints:

- `end_date >= start_date`.
- **62-day cap** on ranges: `date_mode = 'custom' or end_date - start_date <= 61`.
- `end_hour > start_hour`.
- **Specific dates:** `jsonb_typeof(dates) = 'array' and jsonb_array_length(dates) <= 31`. The client caps at 31 for a friendly message; the database is the real enforcement.
- **Slot size:** `granularity between 1 and 1440`. The client validates 5–1440 and snaps to 5; the database is the backstop. This is the same belt-and-suspenders pattern.

### `submissions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `event_code` | text FK → events | `on delete cascade` (retention cleans these up) |
| `user_id` | uuid | Defaults to `auth.uid()` |
| `name` | text | Display name (deduplicated client-side) |
| `slots` | jsonb | Selected slot keys |

`unique (event_code, user_id)` gives one response per person per event, so the client can `upsert`.

**Slot keys** are wall-clock times in the event zone: `2026-11-04|09:30`. Each key maps to exactly one real instant, so aggregation is unambiguous no matter where responders are.

---

## Step 3: Row-level security

All traffic uses the `authenticated` role, because anonymous users are still authenticated. The bare `anon` role gets no table access.

| Policy | Rule |
|---|---|
| `events_select` | Any signed-in user (knowing the code is the access model) |
| `events_insert` | `owner_id = auth.uid()` |
| `events_update` / `events_delete` | Organizer only. Covers both **edit** and **finalize** |
| `subs_select` | Your row, **or** you organize the event, **or** the event is **not** anonymous |
| `subs_insert` / `subs_update` | `user_id = auth.uid()` |
| `subs_delete` | Your row **or** you own the parent event |

The critical piece is `subs_delete`. A delete succeeds only if the row is yours or you own the event, so even a direct API call that bypasses the UI can't remove someone else's response.

### Why anonymity needs an RPC

**Postgres RLS can't hide individual columns.** It is row-level, all-or-nothing. "Counts for everyone, names for the organizer only" can't be expressed as a policy alone. So:

1. `subs_select` stops non-organizers from reading other people's rows on anonymous events.
2. `get_event_submissions(p_code)` is a `security definer` function. It returns every row's slots but sets `name` to `NULL` when the caller is a non-organizer on an anonymous event.

A non-organizer therefore **cannot pull names off the wire**, and inspecting the network tab won't reveal them. The client reads the aggregate through this RPC in all modes, and hydrates *your own* name and selection with a direct own-row select, because the RPC nulls your name too on anonymous events.

---

## Step 4: Triggers and RPC

- **`submissions_guard`** (before insert/update):
  - Blocks writes after `deadline` with `Responses are closed`. **The organizer is exempt.**
  - Prevents changing `event_code` or `user_id` on update.
  - Maintains `updated_at`.
- **`events_guard`** (before update): `code` and `owner_id` are immutable. Maintains `updated_at`.
- **`get_event_submissions(p_code)`**: the read path described above. Execute is granted only to `authenticated`.

### Edit and finalize

Both use a plain organizer-only `events.update`.

- **Finalize** writes the `finalized` array, which can hold multiple slots.
- **Edit** writes the new config. The client prunes `finalized` to keys that still exist in the new grid. Responses outside a shrunken grid are kept in the database but no longer displayed, since RLS rightly prevents the organizer from rewriting other people's rows.

---

## Step 5: Realtime and retention

### Realtime

`events` and `submissions` are added to the `supabase_realtime` publication. The client subscribes per event:

- `events` UPDATE (filtered by code), for config edits and confirmed times.
- `submissions` INSERT/UPDATE (filtered by event code), but **only for non-anonymous events or the organizer.**
- `submissions` DELETE (unfiltered, because Supabase can't filter deletes). Only primary keys are sent, and the client simply re-reads the RPC.

**The honest tradeoff:** realtime respects RLS SELECT, so on anonymous events non-organizers can't receive pushes for others' rows. For exactly that case the client falls back to polling the RPC every 8 seconds. Everyone else gets genuine push.

### Retention (15 days after end date)

- `purge_expired_events()` deletes events where `end_date < current_date - 15`. FK cascade removes their submissions.
- `pg_cron` runs it daily at 03:15 UTC (`purge-expired-events`).
- The client also refuses to open an expired event ("This event has expired"), so nothing is shown between the expiry and the next purge.
- Manual run: `select public.purge_expired_events();`

---

## Step 6: Frontend

See the root `README.md`. In short: `npm install`, fill in `.env`, `npm run dev`. The client lives in `src/AvailabilityApp.jsx` and needs `src/supabaseClient.js`.

### Time-zone model

- The event has **one canonical zone**, chosen by the organizer. Slots are wall-clock times in that zone.
- Each viewer gets a **"Showing times in"** selector, defaulting to their browser zone, which **relabels** times. It does not rebuild the grid into the viewer's local days. That re-bucketing approach creates ragged grids and breaks on half-hour zones (India, +5:30) and on mid-range DST transitions.
- **The labels are DST-safe in all three places times appear:**
  - **Entry grid:** computed for the selected date's real instant.
  - **Heatmap row labels:** computed for *every* date and deduplicated. A range crossing a DST change shows both values, e.g. `6:00 AM / 7:00 AM`.
  - **Cell details:** computed exactly per cell, with a "(next day)" or "(previous day)" flag.

---

## Gotchas and known limitations

1. **Anonymous identity is per-browser.** RLS makes it *safe*, but clearing the browser or switching devices orphans the identity. The old response stays in the pool and can't be edited. For organizers who need durability, upgrade the anonymous user to a permanent one with `supabase.auth.linkIdentity()` (OAuth) or `updateUser({ email })`. For agency use, consider replacing anonymous auth with your SSO provider.
2. **Event configs are readable by any signed-in user.** `events_select` is `using (true)` so that join-by-code and realtime work. Codes aren't secret-grade (31^6 ≈ 887M combinations). For private events, route event reads through an RPC that requires the code and drop the open select policy.
3. **Duplicate-name detection runs client-side.** On anonymous events, non-organizers can't see others' names, so they can't detect collisions. That's harmless because names aren't shown to them. If you need guaranteed-unique names, move the insert into a `security definer` RPC that deduplicates server-side.
4. **Don't re-add an open `subs_select` policy.** That single change silently re-opens the name leak. Test as a second, non-organizer browser before shipping (UAT TC-33).
5. **Row labels may show two values** on a DST-straddling range even though only some columns use the second one. That's always truthful, just more information than strictly needed. The per-cell details are exact.
6. **`dates` entries aren't validated as dates by the database.** The client only writes `YYYY-MM-DD`. To be airtight against direct API abuse, move the event insert into an RPC that validates each entry.
7. **Retention uses UTC `current_date`** on the server and the event zone on the client. They can disagree by a few hours around the boundary, and the client check errs toward hiding.
8. **Withdrawals after the deadline** are allowed (delete isn't blocked by the trigger). If you want deletes locked too, add a `before delete` trigger that mirrors `submissions_guard`.

---

## Verifying the security model

Run these **below the UI**, using the SQL editor, `curl`, or the JS client in a browser console, as a non-organizer browser:

```js
// As a non-organizer on an ANONYMOUS event: names must be null
const { data } = await supabase.rpc('get_event_submissions', { p_code: 'ABC123' });
console.table(data);

// Direct read of others' rows: must return only your own row
await supabase.from('submissions').select('*').eq('event_code', 'ABC123');

// Edit someone else's row: must affect 0 rows / error
await supabase.from('submissions').update({ name: 'x' }).eq('id', '<someone-elses-id>');

// Edit the event as a non-organizer: must affect 0 rows
await supabase.from('events').update({ name: 'x' }).eq('code', 'ABC123');
```

These map to UAT TC-15, TC-33, TC-50, TC-51, and TC-52.
