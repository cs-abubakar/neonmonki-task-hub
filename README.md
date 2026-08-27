# NEONMONKI Task Hub

NEONMONKI Task Hub is the shared operating workspace for the NEONMONKI client
and the Advertidea team. It combines task workflows, service-line chat, files,
notifications, deliverables, decisions, recurring work, and an optional
permission-aware Monki assistant.

Production: [neonmonki-task-hub.vercel.app](https://neonmonki-task-hub.vercel.app)

## What is included

- Client/team task lifecycle with multiple owners and departments, whole-team
  assignment, subtasks, comments, mentions, review, revision, and completion.
- Drag-and-drop Kanban, dashboard-driven filters, task date/range filters, and
  a shared calendar with personal, overall-visible, and department views.
- Username/password accounts with client, team, and super-admin access types;
  team users may belong to multiple admin-managed departments.
- Service channels with manual membership, unread state, event-specific notification sounds,
  mute controls, link filing, and message/channel-to-task creation.
- Sharing links organized by task/subtask, channel, and workstream. Owners
  approve or reject deliverable links before delivery; clients then approve or request changes.
- Deliverables, Decisions & Rules, Recurring Work, team workload, and
  notifications.
- Smart Reporting: Hyros-backed marketing intelligence with KPI strip, trend
  chart, channel performance, attribution mix, campaign drill-down, activity
  feed, rule-based Monki insights, reporting-aware Monki chat, and
  period-over-period comparison. Owner-only (abubakar) in V1. The manual
  Results page (hand-logged metrics + Monki performance reports) remains a
  separate workspace-wide page — the two are deliberately not mixed.
- Optional Monki assistant: workspace chat, in-channel help, task/channel summaries, daily brief,
  citations, audit, usage controls, and human-approved task/decision proposals.
- Super Admin controls for users, access type, department membership,
  department colors/symbols, passwords, account state, channels, global AI
  settings, and per-user AI capabilities.

## Architecture

| Layer | Implementation |
|---|---|
| Browser | Hand-built vanilla JavaScript SPA in `public/`; hash routing |
| API | Zero-dependency Node.js handler shared by local Node and Vercel Functions |
| Production data | Supabase Postgres through server-side PostgREST calls |
| Local data | JSON file driver initialized from `data/seed.json` |
| Authentication | HMAC-signed, HttpOnly, SameSite=Lax session cookie; user role and active state rechecked on every request |
| AI | Server-side Kimi/Moonshot API with permission-filtered structured tools |
| Deployment | Vercel project `advertidea-s-projects/neonmonki-task-hub` |
| CI | GitHub Actions on pushes to `main` and pull requests, Node.js 22 |

Production uses the Supabase service-role key only inside the serverless API.
Every database table has Row Level Security enabled with no browser-facing
policies. The browser never receives the service key or Kimi key.

### Realtime decision

Chat, unread counts, notifications, and task updates use a five-second active
poll (30 seconds while the tab is hidden). Supabase Realtime was deliberately
not added in this phase: the app uses custom cookie auth and a server-side-only
service-role data path. Adding browser subscriptions cleanly would require a
publishable key plus a new Supabase Auth/RLS policy model. For this small team,
polling keeps one authorization path and avoids a destabilizing auth rewrite.

## Local development

Requirements: Node.js 22.

```bash
npm install
npm run dev
# http://localhost:4173
```

With no Supabase variables, the app uses `data/data.json`, creating it from
`data/seed.json` on first launch. The runtime file is gitignored.

To test:

```bash
npm test
```

The current suite contains 703 checks covering storage mappings, authentication,
role and visibility boundaries, task workflows, chat, admin, files, AI context
isolation, per-user AI policies, proposal modification, error hygiene, and
Smart Reporting (permissions, secrets hygiene, sync idempotency, webhook
deduplication, metric derivation, filters, Monki reporting-tool gating, and
the Hyros OAuth flow: discovery, PKCE, state validation, token rotation, and
the read-only MCP tool guard).

## Environment variables

Copy `.env.example` to `.env` for local Supabase/AI use. The example contains
placeholders only.

| Variable | Required in production | Purpose |
|---|---:|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database access |
| `SESSION_SECRET` | Yes | Long random session-signing secret |
| `ADMIN_PASSWORD` | Before first bootstrap | Initial `abubakar` password |
| `ADIKA_PASSWORD` | Before first bootstrap | Initial client password |
| `TEAM_PASSWORD` | Before first bootstrap | Initial shared-team password |
| `KIMI_API_KEY` | No | Optional hosting-level Kimi key fallback |
| `KIMI_BASE_URL` | No | Provider endpoint override |
| `HYROS_BASE_URL` | No | Hyros REST API override; defaults to `https://api.hyros.com/v1` |
| `HYROS_MCP_URL` | No | Hyros MCP override; defaults to `https://mcp.hyros.com/mcp` |
| `GOOGLE_OAUTH_CLIENT_ID` | Platform Reports | Google Cloud OAuth client for the GSC connector |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Platform Reports | Its client secret (redirect URI: `/api/platforms/gsc/oauth/callback`) |
| `CRON_SECRET` | Yes (cron) | Bearer guard for the daily `/api/cron/hyros-sync` reconciliation |
| `PORT` | Local only | Local server port; defaults to 4173 |

Bootstrap password variables are read only when an empty user table is first
initialized. Existing passwords are changed from Admin or the user's password
screen; changing an environment variable later does not rewrite an existing
database user.

AI is optional. The super admin can select Kimi Code Membership
(`api.kimi.com/coding/v1`) for keys created at `kimi.com/code/console`, Kimi
China (`api.moonshot.cn`) for China API developer billing, or Kimi Global
(`api.moonshot.ai`). Kimi Code uses model IDs such as `k3` and draws from the
membership quota; Moonshot API uses IDs such as `kimi-k3` and a separate API
balance. Their keys and endpoints are not interchangeable. The connection test
performs a lightweight completion, detects the matching official product, and
repairs both endpoint and model. A saved key is encrypted server-side with
`SESSION_SECRET`; `KIMI_API_KEY` remains an optional hosting-level fallback.
The key is write-only and is never returned to the browser. Rotating
`SESSION_SECRET` requires the saved key to be entered again. With no key, task,
chat, file, and admin features continue working while AI reports unconfigured.

## Users, roles, and permissions

This is a single-workspace product: NEONMONKI is the one client/project. There
is no multi-company registry — NEONMONKI client users (Adika, Andy, Dustin, …)
are simply accounts with the client role, managed from Control Panel → Users &
workspace.

Seeded accounts:

| Username | Role | Scope |
|---|---|---|
| `abubakar` | Super Admin | All tasks, channels, files, Control Panel, and AI controls |
| `adika` | Client | Client-visible tasks/channels/files and review transitions |
| `advertidea` | Team | Shared team account |
| `hafeez`, `areeb`, `taha`, `usama`, `sana`, `munsif`, `taimoor` | Team | Team tasks plus their channel memberships |
| `mateen` | External | Only tasks he owns or raised himself |

The production administrator should set strong initial values and change all
seeded user passwords before distributing access.

Task visibility:

- `shared`: visible to all signed-in users.
- `team`: visible to the internal team; a client creator can still follow their
  own request without seeing any other internal work.
- `department`: visible to members of the selected departments, named owners,
  the creator, and super admin.
- `private`: visible to the creator, named owners, and super admin.
- Legacy `internal` records retain their strict team-only meaning.

External partners (the `external` role) sit outside all of the above: they see
**only tasks they own or created** — never the rest of a department, never
shared/team work, never reporting. They can raise tasks (they land as New
Requests for the team to accept), assign them to internal people or
departments, and comment, post updates, share links and move status (except
Completed/Cancelled — closing work is a team call) on their visible tasks.
Their people directory is minimal: names and roles only, no profiles, no
client accounts. New external accounts start with AI off and reporting
disabled; both are granted per user from the Control Panel.

The initial department catalogue is SEO, Google Ads, Email Marketing, Research,
Social Media, Development, AI & Automation, and Project Management, plus
external partner departments (a department flagged "External partner team",
e.g. Development External Team). The super admin can create, edit, archive,
color, and assign additional departments.

Channel visibility is based on client allowance and membership. General is
protected and available to the whole workspace.

File visibility is centralized in `lib/permissions.js`:

- A task-linked file must pass the task visibility check.
- A channel-linked file must pass the channel access check.
- A file with both scopes must pass both checks.
- Broken scoped references fail closed except for super admin.
- Unscoped workspace files are shared.

The same rules protect `/api/state`, the Files page, file creation, AI
`search_files`, AI task summaries, and citations.

## AI controls and approval flow

All super-admin powers live in one place: the **Control Panel** (the single
admin nav entry). Its sections:

- **Users & workspace** — internal team + NEONMONKI client accounts (create,
  manage, reset passwords, activate/deactivate), departments, and channels.
- **External partners** — the external-user system: create/onboard partners,
  assign external departments, reset credentials, activate/deactivate, and see
  each partner's AI/reporting state.
- **Integrations** — the Hyros connection plus reporting refresh (below).
- **AI engine** — provider key, models, global toggles, per-user access,
  usage, and the proposal action trail.
- **AI history** — every user's AI questions and the exact user-visible
  answers, browsable by date (Asia/Karachi day boundaries) and user.

The AI engine section manages:

- Kimi API key entry, live completion test, model selection (including K3),
  Kimi Code/Moonshot product selection, and provider status. The saved key is
  encrypted at rest.
- Global enable/disable, Ask/Chat/Brief/Summary feature toggles, client
  access, and global daily limit.
- Per-user enable/disable, daily-limit override, and capability profile:
  read-only, read plus drafts, or full proposals.
- Provider/configuration status, usage, and action history.

AI history is recorded on every AI interaction (migration 013 adds the
`ai_audit.answer` column): who asked, when, the question, the exact answer
shown to the user, tools, model, tokens, and status — including blocked
attempts (the refusal the user saw is stored as the answer). History is kept
indefinitely (well beyond the required 30 days) and is readable only by the
super admin (`GET /api/ai/admin/history?date=YYYY-MM-DD&username=…`).

These controls are enforced by the API. Disallowed tools are removed from the
tool list sent to the provider.

Dashboard KPI cards are task filters for every role. Clicking Open, In
Progress, Waiting on Client, Ready for Review, Critical Open, or Completed
opens the Tasks page with the matching filter. The owner filter defaults to
`Everyone`; each role still receives only the tasks permitted by the server.

AI uses structured retrieval over current tasks, accessible chat, visible
files, decisions, and deliverables. It does not use embeddings, pgvector,
Hermes, autonomous employees, or a knowledge graph.

AI proposal execution is human-controlled:

1. Kimi proposes a task update or decision; no data changes.
2. The proposal is persisted as pending and shown with Approve, Modify, Reject.
3. Modify lets the reviewer change permitted fields before approval.
4. Execution rechecks the reviewer's normal task/role permissions.
5. The original proposal, modified payload, decider, outcome, and task history
   provenance are retained.

AI never receives additional privileges. For example, the client may approve
only the same review-handshake transitions allowed by a manual action.

## Smart Reporting (Hyros)

Smart Reporting turns the old Results page into a marketing intelligence center
backed by Hyros attribution data.

### Data flow

```text
Hyros (source of attribution truth)
  → MCP tools (OAuth, read-only hyros_get_* only)
  → sync (entity backfill + per-day aggregate series + webhooks)
  → Supabase reporting tables (source of truth for the UI)
  → /api/reporting/* aggregation endpoints
  → Smart Reporting UI and Monki reporting tools
```

The dashboard never calls Hyros live. All rendering reads our own stored facts;
the only live Hyros calls are connection tests and sync runs.

MCP semantics that matter (verified against the live server, Aug 2026):
every list tool takes its filters inside a `request` object
(`{ request: { fromDate, toDate, pageSize, pageId } }`) and flat arguments are
silently ignored (the server then returns its default unfiltered 50-row page).
Entity tools paginate with a real `nextPageId` cursor. Reporting tools:
`hyros_get_roas_report` returns a flat per-account/per-day object (the
authoritative spend/revenue/ROAS series); `hyros_get_attribution_report` with
`timeGroupingOption: DAY` returns daily tracked campaign rows including clicks
and impressions. `hyros_get_ad_account_report` with DAY grouping and
attribution + `isAdAccountId` + time grouping return no rows — do not use.

### Storage model (migrations 007–009)

- `integration_connections` — provider row; credentials encrypted with
  `SESSION_SECRET`, never returned to the browser.
- `hyros_sync_runs` — every backfill/incremental run with status and counts.
- `reporting_facts` — normalized, deduplicated events (sales, leads, calls,
  refunds) keyed by `(source_system, event_type, external_id)`. Facts are the
  truth for lead/sale counts, per-channel revenue and the activity feed.
- `reporting_daily` — day × scope aggregates: `account` rows (per-day ad
  account spend/revenue/sales from the ROAS report — the spend and ROAS
  truth), `campaign` rows (tracked spend/revenue/leads/clicks/impressions),
  `channel` rows (organic rollups computed from facts at sync time — never
  folded back into totals, they exist for filter discovery). Ratio metrics are
  always derived from summed totals, never summed.

All tables are RLS-enabled with service-role-only access; the browser never
queries them directly. Dates are compared in the Hyros account timezone
(Europe/Berlin), so day boundaries match Hyros's own reporting.

### Connecting Hyros

Admin → Integrations → **Connect with Hyros**. This runs the official Hyros
MCP sign-in (the same flow the Hyros docs describe for Claude): the app
discovers the OAuth 2.1 server from `https://mcp.hyros.com`, registers itself
dynamically (RFC 7591) as a confidential client, and redirects to Hyros where
you log in and approve. No API key is pasted anywhere.

Token lifecycle: access tokens live 15 minutes; because the app registers
with client credentials it also receives a 30-day **rotating refresh token**.
Every sync/cron run refreshes as needed and immediately persists the rotated
token (encrypted with `SESSION_SECRET`), so the connection stays alive without
re-signing-in. If the refresh token ever lapses, connecting again is one
click (Hyros passes an already-signed-in browser straight through).

An API-key connection remains available under "Advanced" as a fallback.

**Read-only guarantee:** the OAuth/MCP client in `lib/hyros-mcp.js` refuses
any tool that is not in its hard-coded `hyros_get_*` whitelist — before any
network call. Monki and the sync pipeline can only read Hyros data; creating,
updating, deleting or refunding anything in Hyros is impossible through this
app, regardless of which tokens are stored.

MCP tool argument shapes mirror the REST parameters (fromDate/toDate,
pageSize/pageId); the mapping layer is `MCP_TOOL_MAP` in `lib/hyros.js`, so
the normalizers and sync loops are identical for both transports.

### Sync architecture

- Connect from Control Panel → Integrations. Connecting runs a real
  `user-info` test first (REST) or a `hyros_get_user_info` MCP call (OAuth),
  then starts a 90-day backfill in cursor-paginated batches (`pageSize` 250,
  `pageId` cursors).
- Incremental syncs re-read a trailing window so late attribution changes land.
- **Reporting refresh is a Super Admin power only.** All integration mutations
  (connect, test, sync, resync, disconnect, OAuth) are gated on the
  `super_admin` role — a user with an advanced reporting tier can read the
  dashboards but can never trigger a refresh. Clients only consume the
  reporting data their tier allows.
- Reporting refreshes **automatically every day at 08:00 Asia/Karachi**
  (`0 3 * * *` UTC, the Vercel cron on `/api/cron/hyros-sync`), plus on demand
  via Control Panel → Integrations → **Refresh reporting data**.
- Webhooks: after connecting, the Integrations card shows a webhook URL and a
  bearer token. In Hyros (Settings → Integrations → Webhook) subscribe to
  sale/lead events with that URL and token. Events are deduplicated by Hyros
  event ID and `X-Hyros-Signature` (HMAC-SHA256 of the raw body) is verified
  when a webhook secret is configured. The scheduled cron reconciles anything
  webhooks miss; normal app usage never depends on it.

### Metric rules

Additive metrics (spend, revenue, leads, sales, calls, clicks, impressions)
sum. Derived metrics (ROAS, CPL, CPA, CPC, CTR, CVR, AOV) are always computed
from their underlying totals — never summed, never averaged — and return `null`
(shown as `—`) when a denominator is missing or zero. No fabricated zeros.

Channel/platform/source classification comes from a centralized mapping in
`lib/hyros.js` fed by observed Hyros `trafficSource` values; unmapped values
fall back to Other/Unknown instead of being guessed. Filters are built from
values actually present in the data, so empty dimensions never appear.

### Access model

Reporting access is tiered (`reportingAccess` in `lib/permissions.js`):

- **full** — the Smart Reporting dashboard + all `/api/reporting/*` endpoints.
  Default for super admins; grantable per user from the Control Panel ("Reporting
  access" → Full).
- **basic** — the calm, client-safe **Performance** page (`/api/reporting/basic`).
  Default for client and team roles. Basic payloads carry results only
  (revenue, leads, sales, spend, ROAS, trend, friendly channel/campaign names,
  calm highlights) — never sync diagnostics, never the word Hyros, never a raw
  connector enum, never lead-level PII.
- **none** — no reporting.

The same tier drives Monki: advanced/super users get the detailed reporting
digest and the reporting_* tools; basic users get a curated, client-calm
digest of the same numbers (so Monki and the dashboard always agree); none
get neither.

Tiers are: `none`, `basic` (Performance page — client/team default),
`advanced` (the Smart Reporting dashboard), `super` (adds the report
generator). Super admins default to super; every tier is grantable per user
from the Control Panel ("Reporting access"). Legacy stored `full` reads as
`advanced`.

### Report generator (super tier)

Smart Reporting → Generate Report builds a Word report (.docx, zero external
dependencies — a minimal ZIP/STORE writer in `lib/report-writer.js`) from the
synced reporting data plus Task Hub work context (completed work, departments,
decisions, deliverables). Two voices: Internal team (direct) and Client (calm,
no vendor/internal vocabulary). Kimi writes the narrative when configured; a
deterministic fallback composes the same structure from the data when the
provider is unavailable. "Open as Google Doc" copies the formatted report to
the clipboard and opens a new Google Doc — paste lands it there; there is no
Google API involved.

### Reports library (migration 011)

The old Results page is replaced by Reports: an organized library of delivered
reports — Weekly / Monthly / Annual & special — grouped by the month they
cover. Entries are a title, optional description, and one or more Google
Drive/Docs links. Everyone reads; team adds; super admin edits and deletes.

V1 route gates: `/api/reporting/*` requires full; `/api/reporting/basic`
requires basic-or-full; both return 401/403 server-side, never hidden-only.

### Platform Reports (migration 014)

A second reporting surface below Smart Reporting: per-platform data pulled
straight from the source platforms into our own store, refreshed by the same
daily 08:00 Asia/Karachi cron as Hyros. This is the owner-level surface — it
requires the advanced/super reporting tier (super admin by default; grant
access later from the Control Panel by raising a user's tier). Connect, sync
and disconnect are super-admin-only, server-enforced.

Six connectors:

- **Google Search Console** — Google sign-in (read-only `webmasters.readonly`
  scope). Auto-selects the NEONMONKI property. First sync backfills 90 days of
  daily totals, top queries and top pages; later syncs re-read a trailing
  7-day window (GSC data settles with ~3 days of lag).
- **Google Analytics 4** — the same Google sign-in (adds `analytics.readonly`).
  Auto-selects the NEONMONKI GA4 property. Sessions, users, conversions and
  new users per day, plus a channel breakdown.
- **Google Ads** — developer token + customer ID (stored encrypted), then the
  Google sign-in with the `adwords` scope. Spend (micros → currency), clicks,
  impressions, conversions and conversion value per day and per campaign.
- **Meta Ads** — a Marketing API token (`ads_read`) + the ad account ID.
  Spend, clicks, impressions and purchases per day and per campaign.
- **Microsoft Clarity** — the Data Export API token (validated live before
  storing; the token field is whitespace- and charset-safe). Each daily sync
  pulls the full useful spectrum — overall plus device, country, OS, browser,
  source and URL slices (7 of the API's 10 calls/day) — so the page offers
  per-dimension tables plus an explorer that charts any metric by any
  dimension over any stored period.

Retention: `platform_daily` keeps a rolling six months. Every platform sync
prunes rows older than 183 days, so the store accumulates history gradually
and never grows unboundedly — any report can be rebuilt for any day inside
the window.
- **Salesforce** — a connected app with client credentials (instance URL +
  consumer key + secret). Leads created, opportunities closing, pipeline and
  won value per day.

All credentials are entered from the Platform Reports page and stored encrypted
in the database — nothing needs to live in the hosting environment.
(`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` remain as env
fallbacks when no stored Google client exists.)

All rows live in `platform_daily` (upserted on
`(platform, day, slice_type, slice_value, metric)` — re-syncs are idempotent);
connection state reuses `integration_connections` (`meta` carries per-platform
extras like the selected property); run history rides `hyros_sync_runs` under
each platform's id. Derived values are computed, never summed: CTR = clicks ÷
impressions, average position is impression-weighted.

### Monki + reporting

Monki's structured tools query the same aggregated reporting layer, so its
answers match the UI. Asking from the Smart Reporting page attaches the active
date range and channel/platform/source/campaign filters automatically. Monki
can combine reporting trends with Task Hub context (tasks, deliverables,
decisions) and must label correlation vs causation; with no data it says so
instead of speculating. Rule-based insight cards (≥15% moves with enough
baseline volume) offer Investigate (opens Monki with that exact question) and
Create task (through the normal human-approved proposal flow).

### Precedence and future connectors

`source_system` on every fact keeps providers distinct. If a later connector
(e.g. Google Ads API) reports the same metric as Hyros, integrations data takes
precedence over hand-logged manual metrics for the same channel+metric, and
cross-provider precedence is decided in the reporting query layer rather than
by double-counting. New connectors should write normalized rows into
`reporting_facts` with their own `source_system` and keep raw payloads for
audit. See `docs/hyros-integration-spec.md` for the verified Hyros API shape.

## Fresh Supabase setup

Create an empty Supabase project, then run these files in order in the Supabase
SQL Editor:

1. `migrations/001_schema.sql`
2. `migrations/002_chat.sql`
3. `migrations/003_ai.sql`
4. `migrations/004_visibility_departments.sql`
5. `migrations/005_ai_permissions_actions.sql`
6. `migrations/006_reporting.sql`
7. `migrations/007_smart_reporting.sql`
8. `migrations/008_hyros_oauth.sql`
9. `migrations/009_reporting_daily_v2.sql` (rebuilds 007's reporting_daily
   with the scope model — run it even if 007 was already applied)
10. `migrations/010_ai_reporting_access.sql`
11. `migrations/011_report_library.sql`
12. `migrations/012_clients_external.sql`
13. `migrations/013_ai_audit_answer.sql`
14. `migrations/014_platform_reports.sql`

The migrations are ordered and idempotent where noted. Migration 005 adds
per-user AI access and proposal modification/execution provenance. Migration
006 adds the manual metrics tables. Migration 007 adds Smart Reporting:
integration connections, Hyros sync runs, normalized reporting facts, and
daily rollups. Migration 008 adds the Hyros OAuth (MCP) connection columns.
Migration 009 rebuilds `reporting_daily` as the scoped aggregate table
(account / campaign / channel) that carries spend, clicks and impressions.
Migration 010 adds the per-user reporting tiers. Migration 011 adds the
Reports library. Migration 012 adds the external partner role support and
per-user client scoping columns. Migration 013 adds the user-visible answer to
the AI audit log for the Control Panel's AI history. Migration 014 adds
Platform Reports: the generic `meta` column on integration connections and the
`platform_daily` store behind the GSC/Clarity connectors.

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then seed the source
records:

```bash
npm run seed:supabase
```

The seed command upserts tasks, deliverables, decisions, recurring work, team,
and links, then verifies table counts. Default users, their department
assignments, channels, and memberships bootstrap on the first application
request when the user table is empty.

Never put the service-role key in frontend code, GitHub, screenshots, or chat.

## GitHub and deployment

Repository: `cs-abubakar/neonmonki-task-hub`.

The CI-equivalent local sequence is:

```bash
npm ci
npm test
```

Pushing `main` runs `.github/workflows/test.yml`. If Vercel's Git integration
is connected, the same push can create the production deployment.

The existing Vercel project can also be deployed directly:

```bash
vercel link --project neonmonki-task-hub --scope advertidea-s-projects
vercel --prod
```

Configure the production environment variables in Vercel before deployment.
Do not set a build command or framework preset: `vercel.json` serves
`public/` and rewrites `/api/*` to the catch-all serverless function.

Production verification should cover all three roles, Dashboard, Tasks, Chat,
Files, notifications, task review transitions, internal/client separation, AI
degradation, hash deep links, and logout at desktop and mobile widths.

## Repository structure

```text
.
├── api/[...all].js                 Vercel API entry
├── data/seed.json                  checked-in source records
├── docs/hyros-integration-spec.md  verified Hyros API/MCP/webhook reference
├── lib/
│   ├── ai.js                       Kimi client and structured tools
│   ├── bootstrap.js                default users/channels
│   ├── handler.js                  API, auth, validation, workflows
│   ├── hyros.js                    Hyros connector (REST + MCP transports, sync, normalize)
│   ├── hyros-mcp.js                Hyros OAuth 2.1/PKCE/DCR + read-only MCP client
│   ├── permissions.js              centralized task/channel/file visibility
│   ├── reporting.js                reporting aggregation/query layer
│   ├── store-json.js               local storage driver
│   └── store-supabase.js           production PostgREST driver
├── migrations/001...011            ordered Supabase schema
├── public/                          SPA
├── scripts/seed_supabase.js         idempotent production seed
├── scripts/tests/run_tests.js       zero-dependency test suite
├── .github/workflows/test.yml       GitHub Actions
├── vercel.json                      Vercel routing
└── .env.example                     safe configuration template
```
