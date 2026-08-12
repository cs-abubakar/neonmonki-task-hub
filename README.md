# NEONMONKI Task Hub

NEONMONKI Task Hub is the shared operating workspace for the NEONMONKI client
and the Advertidea team. It combines task workflows, service-line chat, files,
notifications, deliverables, decisions, recurring work, and an optional
permission-aware Kimi AI layer.

Production: [neonmonki-hub.vercel.app](https://neonmonki-hub.vercel.app)

## What is included

- Client/team task lifecycle: request, accept, assign, update, review, revision,
  completion, due dates, history, and activity.
- Username/password accounts with client, team, and super-admin roles.
- Service channels with manual membership, unread state, notification sounds,
  mute controls, link filing, and message/channel-to-task creation.
- Files organized by channel and workstream. Task-linked and channel-linked
  files inherit those records' server-side visibility rules.
- Deliverables, Decisions & Rules, Recurring Work, team workload, and
  notifications.
- Optional Kimi AI: Ask AI, in-channel AI, task/channel summaries, daily brief,
  citations, audit, usage controls, and human-approved task/decision proposals.
- Super Admin controls for users, passwords, account state, channels,
  membership, global AI settings, and per-user AI capabilities.

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

The current suite contains 236 checks covering storage mappings, authentication,
role and visibility boundaries, task workflows, chat, admin, files, AI context
isolation, per-user AI policies, proposal modification, and error hygiene.

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

Seeded accounts:

| Username | Role | Scope |
|---|---|---|
| `abubakar` | Super Admin | All tasks, channels, files, admin, and AI controls |
| `adika` | Client | Client-visible tasks/channels/files and review transitions |
| `advertidea` | Team | Shared team account |
| `hafeez`, `areeb`, `taha`, `usama`, `sana`, `munsif`, `mateen`, `taimoor` | Team | Team tasks plus their channel memberships |

The production administrator should set strong initial values and change all
seeded user passwords before distributing access.

Task visibility:

- `shared`: visible to all signed-in users.
- `internal`: visible to team and super admin, never the client.
- `private`: visible to the creator, named private assignee, and super admin.

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

The Super Admin AI Control Center manages:

- Kimi API key entry, live completion test, model selection (including K3),
  Kimi Code/Moonshot product selection, and provider status. The saved key is
  encrypted at rest.
- Global enable/disable, Ask/Chat/Brief/Summary feature toggles, client
  access, and global daily limit.
- Per-user enable/disable, daily-limit override, and capability profile:
  read-only, read plus drafts, or full proposals.
- Provider/configuration status, usage, audit history, and action history.

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

## Fresh Supabase setup

Create an empty Supabase project, then run these files in order in the Supabase
SQL Editor:

1. `migrations/001_schema.sql`
2. `migrations/002_chat.sql`
3. `migrations/003_ai.sql`
4. `migrations/004_visibility_departments.sql`
5. `migrations/005_ai_permissions_actions.sql`

The migrations are ordered and idempotent where noted. Migration 005 adds
per-user AI access and proposal modification/execution provenance.

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
├── lib/
│   ├── ai.js                       Kimi client and structured tools
│   ├── bootstrap.js                default users/channels
│   ├── handler.js                  API, auth, validation, workflows
│   ├── permissions.js              centralized task/channel/file visibility
│   ├── store-json.js               local storage driver
│   └── store-supabase.js           production PostgREST driver
├── migrations/001...005            ordered Supabase schema
├── public/                          SPA
├── scripts/seed_supabase.js         idempotent production seed
├── scripts/tests/run_tests.js       zero-dependency test suite
├── .github/workflows/test.yml       GitHub Actions
├── vercel.json                      Vercel routing
└── .env.example                     safe configuration template
```
