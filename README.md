# NEONMONKI Task Hub

The shared work operating system for **NEONMONKI (client)** and the **Advertidea team** —
tasks, chat channels, files, decisions, deliverables and an AI intelligence layer
(Kimi) behind all of it. Seeded from the two master Excel trackers
(`Tasks-sheet/NEONMONKI_Master_Task_System_*.xlsx`).

## NEONMONKI AI (the intelligence layer)

The app has an AI layer behind it — not a bolted-on chatbot. Provider: **Kimi
(Moonshot)**, `kimi-k2.6` by default, called server-side only.

**Setup:** run `migrations/003_ai.sql`, set `KIMI_API_KEY` (and optionally
`KIMI_BASE_URL`) in env, then open **AI Control** (super admin) → enable AI →
Test connection. Without a key the app works normally; AI routes answer 503.

### Architecture decisions (and why)

- **Structured retrieval over embeddings (NOW).** The corpus (tasks, chat,
  files, decisions) is small and relational. Every AI answer is built from
  deterministic DB queries + keyword search — accurate, free, and instantly
  consistent with reality (no stale vector index after edits/deletes/permission
  changes). pgvector/semantic search is the documented NEXT step once message
  volume makes keyword recall insufficient.
- **The database stays the source of truth.** AI artifacts live in separate
  tables (`ai_summaries`) and are labeled "AI-generated" in the UI. AI never
  writes to factual tables. Task creation by AI = a *draft* the human confirms
  (created under the human's own permissions).
- **One permission choke point.** AI tools read through the same
  `lib/permissions.js` rules as the UI. The client can never receive team-only
  channel content — enforced in the retrieval executors, and verified by a
  test that inspects the exact payload sent to the provider. In-channel @ai
  answers are additionally scoped to that channel.
- **Native Kimi tool calling** (OpenAI-compatible `tools` param) with a small
  tool registry: read tools (search_tasks, read_task, list_workload,
  search_chat, channel_history, search_files, list_decisions,
  list_deliverables) plus **proposal tools** (draft_task, propose_task_update,
  propose_decision) that never write — they render as approval cards and a
  human applies or dismisses them. Every call is audited (user, kind, tools,
  cited records, tokens, latency, status) — never chain-of-thought.
- **Secrets:** `KIMI_API_KEY` lives only in env vars. The DB stores settings,
  audit, and AI artifacts; the browser sees only "configured: yes/no".
- **Degradation:** AI off / no key / provider down → tasks/chat/files/admin
  keep working; AI UI hides or returns a clear error. Rate limit per user
  (default 60 calls/day) protects both UX and wallet.

### AI surfaces

| Surface | What it does |
|---------|--------------|
| Ask AI (nav) | Free-form questions, tool-grounded answers, clickable citations, task drafts, **approve/dismiss AI-proposed changes** |
| Dashboard | "AI daily brief" card — role-aware (client gets client-safe brief) |
| Task drawer | "AI summary" — history, blockers, related discussions & files, citations |
| Chat | `@ai <question>` in a channel (channel-scoped answer posted as NEONMONKI AI); ✨ summarize button per channel |
| AI Control (super admin) | enable/disable, per-feature toggles, client access, model, daily limit, connection test + balance, usage stats, audit log, AI action-request trail |

### Where Hermes fits (and where it doesn't — yet)

Hermes (the Nous agent runtime on the agency VPS) is **not required** for
anything in this phase; the app is fully functional without it. The designed
integration for LATER is **loose HTTP coupling**: Hermes cron-style agents
call scoped API endpoints (e.g. to post a weekly digest or run a scheduled AI
employee), while agent state/config stays in Supabase (`ai_agents`,
`ai_action_requests` tables already exist for this). That mirrors how Hermes
already talks to the agency's other systems.

### Roadmap baked into the schema

- **NOW:** structured retrieval, tool-calling Ask AI, summaries, brief,
  control center, audit, rate limits, permission-enforced context — and the
  **approval system**: AI proposes task updates / decisions as cards, a human
  approves or dismisses, execution runs under the human's own role rules
  (the client e.g. can only apply review-handshake transitions), and every
  outcome lands in `ai_action_requests` (visible in AI Control).
- **NEXT:** autonomous-agent wiring of that same approval queue (agents
  propose → queue → admin decides), pgvector hybrid search when the corpus
  outgrows keyword recall, scheduled briefs.
- **LATER:** AI employees defined in `ai_agents` (identity, instructions,
  scopes, tools, autonomy level, budgets), executed by Hermes over HTTP with
  approvals for anything that changes state.

## Run it locally (development)

```bash
cd clients/neonmonki/task-system
node server.js
# → http://localhost:4173
```

Requires only **Node.js 18+**. No npm install, no build step, no database, no
Supabase account — data persists to `data/data.json` (auto-created from
`data/seed.json` on first boot).

Local dev differs from production in exactly one way: **storage**. If
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set (env or a local `.env`
file), `node server.js` talks to Supabase instead of the JSON file — everything
else is identical. Leave them unset for zero-setup local work.

### Accounts

Accounts live in the database now — the **super admin** creates users (username +
password, no email) from the **Admin** page, and everyone can change their own
password (sidebar key icon). Seeded accounts:

| Username | Role | Default password |
|----------|------|------------------|
| `abubakar` | **Super Admin** | `NM-admin-2026` (env `ADMIN_PASSWORD`) |
| `adika` | Client | `neonmonki2026` (env `ADIKA_PASSWORD`) |
| `advertidea` | Team (shared) | `advertidea2026` (env `TEAM_PASSWORD`) |
| `hafeez`, `areeb`, `taha`, `usama`, `sana`, `munsif`, `mateen`, `taimoor` | Team | `NM-<username>-2026` |

> Change the defaults before sharing the link (Admin → Reset pw, or the env vars
> above at first bootstrap). Sessions are stateless HMAC cookies (14-day expiry)
> and survive restarts; roles/active flags are re-checked on every request, so
> disabling a user in Admin locks them out immediately.

## Chat, channels & notifications

Slack-style channels per service line. Seeded: **General** (everyone, incl. the
client), **Strategies & Planning** (client included), **Google Ads**, **SEO**,
**Email Marketing**, **Social Media**, **AI Automation**, **Research** (team-only,
manual membership). The super admin creates/deletes channels and manages members
from **Admin**. Highlights:

- **Message → task:** hover any message → "+ Task" (or the channel's "+ Task"
  button). The new task is posted back into the channel as a clickable card.
- **Links shared in chat** are filed automatically into the channel's folder on
  the **Files** page (channels + workstreams = the folder structure).
- **Notifications:** the bell shows task events for tasks you own/requested plus
  chat activity; unread badges per channel; a tone plays for new messages. Mute
  any channel (channel header → Mute) to silence its badges and tones.
- Realtime is polling-based (5s active / 30s background) — Vercel's free tier
  can't hold websockets, and at this team size polling is indistinguishable.

## Super admin powers

Admin page (nav → Admin, `super_admin` only):

- **Users:** create (username/password/role — no email signup), reset passwords,
  disable/enable, promote to super admin. Lockout guards: you can't disable or
  demote yourself, and the last super admin can't be removed.
- **Channels:** create (name, description, task department, client-allowed flag,
  members), delete (General is protected), add/remove members per channel.

Roles: `super_admin` (everything) · `team` (task powers + their channels) ·
`client` (assigns tasks, reviews work, chats in client-allowed channels).


## Deploy to production (Vercel + Supabase free tier)

Exact, ordered runbook. No prior dev experience needed — about 20 minutes.

### 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign in
   (GitHub login works).
2. **New project** → pick your organization, any name (e.g. `neonmonki-task-hub`),
   a database password (save it somewhere; the app never needs it), and the
   region closest to the users. Keep the **Free** plan.
3. Wait ~2 minutes for the project to finish provisioning.

> Free-tier note: Supabase pauses projects after ~7 days of no database
> activity. The app will show errors until you open the Supabase dashboard and
> unpause (one click). Any login/task activity counts as activity.

### 2. Create the database tables

1. In the Supabase dashboard, left sidebar → **SQL Editor** → **New query**.
2. Open `migrations/001_schema.sql` from this folder, paste its entire contents,
   click **Run**. Then repeat with `migrations/002_chat.sql` (users, channels,
   messages, notifications) and `migrations/003_ai.sql` (AI settings, audit,
   summaries, future agent/approval tables).
3. Expected result: "Success. No rows returned." Both scripts are idempotent —
   running them twice is harmless. Default users and channels bootstrap
   themselves on first app access.

### 3. Collect the two Supabase values

In the Supabase dashboard: **Project Settings** (gear icon, bottom left) →
**API Keys** (on older dashboards: **Settings → API**):

- `SUPABASE_URL` — labeled **Project URL**, looks like
  `https://abcdefghijklmnop.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY` — the **`service_role`** key (under *Legacy API
  keys*), a long JWT starting with `eyJ...`. A new-style **secret key**
  (`sb_secret_...`) works too — the app sends it identically in the `apikey`
  and `Authorization` headers, which both key formats accept.

> ⚠️ **Security:** the service-role / secret key bypasses Row Level Security and
> grants full database access. It must exist **only** as a server-side
> environment variable (Vercel) or in a local, never-committed `.env` file.
> Never put it in the frontend, in git, or in a chat/message. The database is
> additionally locked down: RLS is enabled on every table with no public
> policies, so the publishable/anon key can read or write nothing.

### 4. Seed the database

On any machine with Node.js 18+ and this folder:

```bash
cd clients/neonmonki/task-system
SUPABASE_URL=https://your-ref.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
node scripts/seed_supabase.js
```

(Or put both lines into a local `.env` file — see `.env.example` — and just run
`node scripts/seed_supabase.js`. `.env` is gitignored.)

Expected output: row counts per table (`tasks: 51 rows upserted`, …), then a
`verify` line per table and `Done.`. The script is idempotent (upserts by id) —
safe to re-run. If it says `Could not read table 'tasks'`, go back to step 2.

### 5. Deploy to Vercel

Either path works:

**A. Git (recommended — auto-deploys on every push):**
1. Push this folder to a GitHub/GitLab/Bitbucket repository (private is fine).
2. [vercel.com](https://vercel.com) → **Add New… → Project** → **Import** the repo.
3. Vercel reads `vercel.json` automatically — do **not** override the build
   settings (no build command, output directory `public`, no framework preset).

**B. Vercel CLI (no git host needed):**
```bash
cd clients/neonmonki/task-system
npx vercel login
npx vercel --prod
```

### 6. Set the 5 environment variables

Vercel → your project → **Settings → Environment Variables** → add each of
these, for **Production** (and Preview if you use preview deployments):

| Variable                    | Value                                              |
|-----------------------------|----------------------------------------------------|
| `SUPABASE_URL`              | from step 3                                        |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 3 — server-side only                     |
| `SESSION_SECRET`            | any long random string (e.g. `openssl rand -hex 32`) — signs the login cookie |
| `ADMIN_PASSWORD`            | **strong password for the super admin — set this now, not later**  |
| `ADIKA_PASSWORD`            | **strong password for the client login — set this now, not later** |
| `TEAM_PASSWORD`             | **strong password for the shared team login — set this now, not later** |
| `KIMI_API_KEY`              | Kimi/Moonshot key (platform.kimi.ai) — enables the AI layer        |
| `KIMI_BASE_URL`             | optional override (China platform / mocks); defaults to api.moonshot.ai |

Then **Deployments → ⋯ → Redeploy** so the variables take effect (env changes
never apply to an already-built deployment).

> This is also how you "change passwords" later: edit `ADIKA_PASSWORD` /
> `TEAM_PASSWORD` here and redeploy. Same procedure for rotating
> `SESSION_SECRET` (logs everyone out) or the Supabase key.

### 7. Open and verify

1. Open the deployment URL (`https://<project>.vercel.app`).
2. Log in as `advertidea` (team) → accept a request, post an update. Log in as
   `adika` (client) → set it to **Completed**. Check the dashboard activity feed.
3. Send Adika the URL and her username/password over a secure channel.

Traffic is HTTPS-only on Vercel; the session cookie is `HttpOnly` +
`SameSite=Lax`.

## How the two sides work together

```
Adika (client)                     Advertidea (team)
─────────────                      ─────────────────
Assigns task ────────►  NEW REQUEST
                                 Accepts & starts ──► IN PROGRESS
                                 Posts progress updates (1–3 lines)
                                 Sets READY FOR REVIEW when done
Sees it in "Needs your
attention", confirms ──► COMPLETED
or sends back ────────► REVISION REQUIRED
```

- **Client can:** assign tasks (with priority, department, due date), edit them while
  they're still untouched (New Request), comment on any task, **confirm completion or
  request revision** on work that's ready for review, hand a "Waiting on Client" task
  back to the team, and watch the dashboard/activity feed.
- **Team can:** accept new requests (picking an owner), own tasks, change any status,
  post progress updates, edit task details, log deliverables, record decisions, add
  document links.
- The role rules are **enforced server-side**, not just hidden in the UI: the client
  cannot cancel tasks, edit team-owned fields, or move statuses outside the review
  handshake — and every status change *and* field edit is written to the task's
  **history timeline** and the shared **activity feed**, with who did it.

## Screens

| Screen | Purpose |
|--------|---------|
| Dashboard | KPIs, "needs attention" (role-aware), workload by department, live activity |
| Chat | Slack-style channels with unread badges, mute, tones, message→task, link filing |
| Board | Kanban: New Requests → Planned → In Progress → Waiting → Ready for Review → Done |
| All Tasks | Full searchable/filterable register (status, department, priority, due date, text) |
| Deliverables | Everything delivered to the client, with links |
| Decisions & Rules | Binding decisions from calls/chat (DEC-001…) |
| Recurring Work | Weekly/monthly/ongoing commitments |
| Files | All documents organized into channel + workstream folders |
| Team | Who owns what on the agency side |
| Admin | Super admin: users (create/reset/disable), channels (create/delete/members) |

## Data

`data/seed.json` was generated from the Excel trackers:

```bash
# regenerate (from the repo root, needs openpyxl):
PYTHONPATH=.tools python3 clients/neonmonki/task-system/scripts/extract_seed.py
```

- `NEONMONKI_Master_Task_System_V2.xlsx` → all 51 tasks, 19 deliverables,
  11 decisions, 8 recurring items, 10 team members, document links.
- `..._May-Aug_2026.xlsx` → merged in additional document links (deduped).

- **Production:** data lives in Supabase Postgres; re-run
  `node scripts/seed_supabase.js` to reset it to the seed state (upserts by id).
- **Local dev:** to start over with fresh seed data, stop the server, delete
  `data/data.json`, restart. To back up, copy `data/data.json`.

## Structure

```
task-system/
├─ server.js               # local dev server: static public/ + /api/* → lib/handler.js
├─ api/
│  └─ [...all].js          # Vercel serverless function — catch-all for /api/* (same handler)
├─ lib/
│  ├─ handler.js           # all API logic: auth (HMAC cookie), routes, validation
│  ├─ store.js             # picks storage driver (Supabase if env set, else JSON)
│  ├─ store-supabase.js    # PostgREST driver (service key, server-side only)
│  ├─ store-json.js        # JSON-file driver (local dev)
│  ├─ bootstrap.js         # default users + channels (seeded on first boot)
│  ├─ ai.js                # Kimi provider client, permission-filtered tools, context
│  ├─ permissions.js       # single choke point: channel/role access rules
│  └─ env.js               # minimal .env loader (no-ops on Vercel)
├─ public/                 # hand-built vanilla-JS SPA (hash routing)
│  ├─ index.html
│  ├─ styles.css           # dark neon sidebar + light workspace
│  └─ app.js
├─ data/
│  ├─ seed.json            # generated from the Excel trackers (checked in)
│  └─ data.json            # local runtime state (auto-created, gitignored)
├─ migrations/
│  ├─ 001_schema.sql       # tasks/deliverables/decisions/links/activity (RLS on, service-key-only)
│  ├─ 002_chat.sql         # users, channels, members, messages, notifications
│  └─ 003_ai.sql           # AI settings, audit, summaries, agent/approval foundations
├─ scripts/
│  ├─ extract_seed.py      # Excel → seed.json generator
│  ├─ seed_supabase.js     # seeds Supabase from seed.json (idempotent upserts)
│  └─ tests/run_tests.js   # 163-assertion backend suite: node scripts/tests/run_tests.js
├─ vercel.json             # static public/ + api function + /api/* rewrite (no build step)
└─ .env.example            # every env var the code reads — copy to .env locally
```
