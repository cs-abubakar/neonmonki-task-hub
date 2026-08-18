# Hyros Integration Spec — Smart Reporting (NEONMONKI Task Hub)

Research date: 2026-08-18. Author: Hyros researcher role. Status: verified against official docs unless flagged `[UNVERIFIED]` (mark for live-account verification).

Primary sources (official):
- REST API reference (OpenAPI 3.1, version "1.40"): https://api-docs.hyros.com/ai-context/rest-api.txt
- Webhooks reference (version "1.1"): https://api-docs.hyros.com/ai-context/webhooks.txt
- MCP reference (version "1.0"): https://api-docs.hyros.com/ai-context/mcp.txt
- Docs hub: https://api-docs.hyros.com/ (tabs: REST API / Webhooks / MCP; llms.txt lists only the three ai-context files)
- Source-link glossary (tag vocabulary): https://docs.hyros.com/glossary/source-link/

---

## 1. REST API

### Base URL
- `https://api.hyros.com/v1` + path `/api/v1.0/<resource>` → e.g. `GET https://api.hyros.com/v1/api/v1.0/leads`.
- Evidence: the tracking-script example in the official spec points at `https://api.hyros.com/v1/lst/universal-script`, and the docs-site snippet reads "Send get request to https://api.hyros.com/v1/api/v1.0/leads". The published txt does NOT include an OpenAPI `servers:` block — `[UNVERIFIED]` confirm with one live `GET /api/v1.0/user-info` before wiring the connector.

### Authentication
- Header: `API-Key: <key>` — an apiKey-in-header scheme named exactly `API-Key` (NOT `Authorization: Bearer`). Wrong/missing key → `401`; valid key missing an endpoint role → `403` with `Missing role <ROLE>`.
- API key location in the Hyros app `[UNVERIFIED — official spec doesn't state it]`: third-party integration guides consistently say Hyros app → **Settings → Profile tab** (API key section) (https://help.bir.ch/en/articles/6700815-how-hyros-integration-works) or **Settings → API Keys** (https://skaler.app/blog/hyros-integration, https://community.funnelish.com/t/how-to-connect-hyros-to-funnelish/9887). Hyros-MCP GitHub repo says **Settings → Integrations → API** (https://github.com/HyrosOG/Hyros-MCP). Confirm exact location in the live NEONMONKI account.
- Agency access: optional `Accessible-Account-Id` header on any `/api/v1.0` request runs it against a connected client account (approved agency relation required; else `403`). Rate limits always apply to the caller. Relevant if Advertidea ever pulls via an agency key; V1 should use the client account's own key.
- Keys are per-account. No key rotation/scoping endpoints documented. Never send to browser (aligns with our no-secrets rule).

### Pagination (all list endpoints)
- Cursor style, NOT page/offset: `pageSize` (max 250 everywhere; ad-accounts defaults 50) + `pageId` from the previous response's `nextPageId`. Omit `pageId` for page 1. Last page: `nextPageId: null` (stated explicitly for ad-accounts; `[UNVERIFIED]` that null-vs-absent is uniform on other endpoints).
- An invalid/expired `pageId` → `400` (stated on subscriptions). "Any change to the other parameters resets pagination" (ad-accounts) — keep filter params identical across pages of one scan.
- Bulk-id filters: `ids`/`emails`/`leadIds` max 50 per call; `productTags` max 20.

### Endpoints (GET subset relevant to reporting)

| Endpoint | Filters | Response wrapper |
|---|---|---|
| `GET /api/v1.0/leads` | `ids`, `emails`, `fromDate`, `toDate` (join date), `pageSize`, `pageId` | `{result: Lead[], nextPageId, request_id}` |
| `GET /api/v1.0/leads/journey` | `ids` (required) | `{result: LeadJourney[], request_id}` — lead + sales + calls + carts + subscriptions + linkedLeads |
| `GET /api/v1.0/leads/clicks` | `leadId` or `email` (one required), `fromDate`, `toDate`, paging | `{result: Click[], nextPageId, request_id}` |
| `GET /api/v1.0/sales` | `ids`, `emails`, `leadIds`, `productTags`, `isRecurringSale` (RECURRING/NON_RECURRING/ALL), `saleRefundedState` (REFUNDED/NON_REFUNDED/ALL), `fromDate`, `toDate` (sale date), paging | `{result: Sale[], nextPageId, request_id}` |
| `GET /api/v1.0/calls` | `ids`, `emails`, `leadIds`, `productTags`, `fromDate`, `toDate`, `qualified` (bool), `qualificationStages` (≤50 names), paging | `{result: Call[], nextPageId, request_id}` |
| `GET /api/v1.0/subscriptions` | `ids`, `emails`, `leadIds`, `productTags`, `subscriptionStates`, `fromDate`, `toDate`, paging | `{result: Subscription[], nextPageId, request_id}` |
| `GET /api/v1.0/sources` | `adSourceIds`, `includeOrganic` (bool), `includeDisregarded` (bool), `integrationType` (enum), paging (pageSize 0–250) | `{result: Source[], nextPageId, request_id}` |
| `GET /api/v1.0/ads` | `integrationType`, `adSourceIds`, paging | `{result: [{name, adSource, source, creationDate}], nextPageId, request_id}` |
| `GET /api/v1.0/tags` / `GET /api/v1.0/tags/count` | — / `name`, paging | `{result: string[]}` / `{result: [{name, amount}]}` |
| `GET /api/v1.0/stages` | `name`, paging | `{result: [{name, amount}]}` |
| `GET /api/v1.0/ad-accounts` | `ids` (≤50), `fields` (name,type), paging | `{result: [{id, name, type}], nextPageId, request_id}` — use for onboarding/discovery |
| `GET /api/v1.0/user-info` | — | `{result: {userProfile{email, firstName, lastName, companyName, timezone, ...}, allowedAccounts[], accessibleAccounts[{accountId, ...}], trueTrackingData}}` — ideal smoke test / connection check |
| `GET /api/v1.0/attribution` | REQUIRED: `attributionModel` (last_click/scientific/first_click), `startDate`, `endDate`, `level`, `fields`, `ids`. Optional: `currency` (usd/user_currency), `dayOfAttribution` (click-date vs sale-date), `sourceConfiguration` (all_sources/only_organic/only_paid/prioritize_organic/prioritize_paid), `timeGroupingOption` (source_link/day/week/month/year), `ignoreRecurringSales`, `scientificDaysRange` (1–30), `windowAttributionDaysRange` (0–365), `newCustomerConfiguration`, `status` (active/paused, only with source_link grouping), `isAdAccountId`, paging | `{result: [{id, <requested fields...>}], request_id}` |
| `GET /api/v1.0/attribution/ad-account` | same minus `level`; `ids` = exactly 1 ad account id; `dateTimeGroupingOption` (ad_account/day/week/month/year) | `{result: [...], request_id}` |
| `GET /api/v1.0/attribution/roas` | REQUIRED: `id`, `level` (ad/source_link/campaign/account), `startDate`, `endDate`; optional `basis` (click_date/sale_date). Fixed `last_click` model | `{result: {id, roas, new_customers_roas, revenue, recurring_revenue, total_revenue, cost, unique_sales, unique_customers, reported_result, reported_vs_revenue}}` (absent when no row) |

Attribution `level` enum: `google_campaign, google_v2_adgroup, google_ad, google_v2_keyword, facebook_adset, facebook_campaign, facebook_ad, tiktok_adgroup, tiktok_ad, snapchat_adsquad, snapchat_ad, pinterest_adgroup, pinterest_ad, twitter_adgroup, bing_adgroup, bing_ad, linkedin_campaign`.
Attribution `fields` (metric list, partial): `sales, revenue, total_revenue, recurring_revenue, refund, unique_sales, leads, new_leads, calls, unique_calls, qualified_calls, unqualified_calls, canceled_calls, cost, profit, net_profit, roi, roas, cost_per_sale, cost_per_lead, cost_per_call, clicks, new_visits, ctr, cpm, cvr, impressions, cac, aov, 30/60/90_days_ltv (+forecasts), churn_rate, new_mrr, new_subscriptions, name, parent_name` (full list in spec).
Constraint gotchas on `/attribution`: `isAdAccountId=true` fails with time grouping day/week/month/year; `status=active|paused` fails unless `timeGroupingOption=source_link`; unknown ids → 400, not zeros.

### Strict-parameter behavior
Some endpoints (`GET products`, `GET carts`, `GET custom-costs`, `GET tags/count`, `GET attribution/roas`, `GET /api/v1.0/requests/{request_id}`) reject unknown/duplicated query params with `400 Unknown parameter: <name>`. All others SILENTLY IGNORE typos (e.g. `?email=` is not a filter on `emails`) — so validate param names client-side in lib/hyros.js.
Note: `GET /api/v1.0/requests/{request_id}` is referenced in that strictness list but has NO path definition in the published spec — presumably an async-write status lookup. `[UNVERIFIED]`

### Writes are asynchronous (matters for sync design)
`200` on POST/PUT/DELETE = accepted; creates visible in ~10s, updates/deletes ~5 min. GETs are synchronous/current. Our sync is read-only, so impact is limited to: a sale created seconds ago may not appear in the same incremental window — overlap windows (see §6).

---

## 2. Rate limits, timeouts, batch/backoff

- Limits (per Hyros account): **30 requests/second** and **1000 requests/minute**. Adjustable per account — "treat the response headers rather than these numbers as the source of truth".
- Headers on responses: `X-RateLimit-Limit` (`30;w=1, 1000;w=60`), `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix ts). On 429: `Retry-After` (seconds).
- Recommended client policy (our recommendation, not from docs): cap at ~10 rps sustained; on `429` sleep exactly `Retry-After`; on network/5xx use exponential backoff (1s, 2s, 4s, 8s) + jitter, max ~5 attempts; read timeout 30s, connect timeout 10s `[UNVERIFIED — docs state no server-side timeout]`.
- Backfill sizing: 90 days, pageSize 250 → even 100k sales = 400 requests ≈ well under limits. Sync cost is trivial; the real constraint is cursor hygiene.

---

## 3. Webhooks (outgoing)

Yes — first-class outgoing webhooks, manageable both in-app and via REST.

- In-app config: **Settings → Integrations → Hyros Webhook Subscription**.
- REST management (requires roles; all under `API-Key` auth):
  - `POST /api/v1.0/webhook-subscriptions` — body `{name, targetUrl, eventTypes[]}`; response includes `externalId` (`sub-...`) and `secretKey` (`ssk-...`). **`secretKey` is returned ONCE** — store it server-side at create time; also retrievable later only via the app UI. targetUrl must be public http(s); private/loopback/metadata hosts rejected.
  - `GET /api/v1.0/webhook-subscriptions` — list (no secretKey).
  - `DELETE /api/v1.0/webhook-subscriptions/{externalId}`.
- Event types (REST enum — superset of the webhook doc table): `sale.attributed`, `sale.refunded`, `call.attributed`, `lead.opted.in`, `lead.opted.in.first.time` `[UNDOCUMENTED payload — not in webhooks reference; likely LeadOptIn shape]`, `lead.origin.assigned`, `lead.stage.changed`, `lead.tag.added`, `lead.tag.removed`, `subscription.created`, `subscription.status.changed`.
- Envelope: `{subscriptionId, eventId, type, timestamp, body}`. `eventId` (`evt-...`) is the dedup key → maps 1:1 to our unique `source + external_id` idempotency rule (`hyros:event:<eventId>`, and entity-level `hyros:sale:<id>` etc. for REST backfill).
- Signature verification: header `X-Hyros-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secretKey, "${t}.${rawBody}")`. Compare constant-time; reject if `|now - t| > 300s`. Deprecated `X-Hyros-Hmac-Sha1` (HMAC-SHA1 of the raw `body` field only) still sent — ignore it, use v1. Reference Node implementation is in the webhooks doc (verified it matches this description).
- Failure/retry: on rising delivery errors Hyros notifies the account and eventually **auto-disables the subscription** (re-enable manually after fix). "Retried deliveries are re-signed, so each attempt carries a fresh timestamp." Exact retry count/schedule/backoff `[UNVERIFIED — not documented]` → our receiver must be idempotent and always 200-fast (enqueue + process async) to avoid auto-disable.

### Payload shapes (body per event)
- `sale.attributed`: `body{id (sle-...), type:"SALE", date, UTCDate, qualified, score, orderId, recurring, attribution: Attribution[], lead{email, joinDate, UTCJoinDate, firstName, lastName, ips[], tags[], phoneNumbers[]}, product{id (pdt-...), quantity, name, tag ($...), category{id (cat-...), name}, price{price, discount, hardCost, refunded, currency}, USDPrice{same}}}`
- `sale.refunded`: same + `refundedDate`; refunded amount in `product.price.refunded` / `product.USDPrice.refunded`.
- `call.attributed`: `body{id (cll-...), type:"CALL", date, UTCDate, qualified, score, tag, attribution[], lead}`.
- `lead.opted.in`: `body{id (opt-...), firstOptin, date, UTCDate, referrerUrl, lead, attribution[], firstSource, lastSource}`.
- `Attribution` object: `{sourceLinkId (slk-...), name, tag (@...), disregarded, organic, trafficSource{id, name}, goal{id, name}, category{id, name}, clickDate, UTCClickDate, adSource{adSourceId, adAccountId, platform}, sourceLinkAd{name, adSourceId}, gclId/gbraId/wbraId (Google only)}`.
- Gotcha: webhook sale/call bodies carry the full `attribution[]` array, NOT `firstSource`/`lastSource` (those appear on `lead.opted.in` and on REST Sale/Call/Subscription). Decide attribution convention (last entry of array vs explicit first/last from REST) — flag for builder.
- Dates come duplicated: local account-tz (`date`) and UTC (`UTCDate`) — store UTC.

---

## 4. MCP server — https://mcp.hyros.com/mcp

- Transport: **Streamable HTTP only** (no SSE); `/mcp` path required.
- Auth: **OAuth 2.1 authorization-code + PKCE (S256), dynamic client registration (RFC 7591), scope `mcp`**, token via `Authorization: Bearer` only. Access tokens live **15 minutes**; public clients get **no refresh token** (confidential clients: 30-day rotating refresh). No API keys, ever.
- **Per-account enablement by Hyros support — not self-serve.** Token binds to whichever account is signed in at consent; no account picker.
- Surface: 59 tools (29 read-only, 30 write; all `hyros_*`) mirroring the REST model (get_leads, get_sales, get_calls, get_subscriptions, get_sources, get_ads, get_keywords, get_attribution_report, get_roas_report, get_ad_account_report, get_ad_accounts, get_user_info, plus writes), 1 prompt (`hyros_diagnose_tracking`), agency `accessible_account_id` arg. Same rate limits (30/s, 1000/min); 429 body `{"error":"You have reached the MCP request limit..."}`. Writes async (~10s).
- **Verdict for Smart Reporting: NOT usable as the server-to-server sync channel.** Interactive browser OAuth + 15-min tokens + no service credential + manual per-account enablement = human-in-the-loop assistant sessions only. Use REST + `API-Key` for the Supabase sync pipeline. Optional future use: Monki could call MCP in an interactive admin session, but that contradicts our "dashboards never call Hyros live" rule for the reporting path — keep it out of V1.

---

## 5. Connector spec table

Base: `https://api.hyros.com/v1` · Auth: `API-Key: <key>` header · Paging: `pageSize`(≤250) + `pageId`←`nextPageId` · Dates: ISO 8601 with tz offset recommended.

| Entity | Endpoint | Key fields (REST) | Value fields | Attribution/source fields | Gotchas |
|---|---|---|---|---|---|
| Lead | `GET /api/v1.0/leads` | `id` (64-hex, unprefixed in examples), `email`, `creationDate` (ISO w/ offset), `firstName`, `lastName`, `phoneNumbers[]`, `ips[]`, `tags[]`, `provider{id, integration{name,type,id}}` | — | tags carry `@source`, `$product`, `!event` | `fromDate/toDate` filter on JOIN date. REST `creationDate` ≠ webhook `joinDate`. PII — never expose raw lead PII to client role beyond what reporting needs. |
| Sale | `GET /api/v1.0/sales` | `id`, `orderId`, `creationDate`, `lead{id,email,...}`, `provider` | `price{price, discount, hardCost, refunded, currency}`, `quantity`, `recurring`, `qualified`, `score` | `firstSource`, `lastSource` (Attribution objs), `product{name, tag, category}` | Refund sweep via `saleRefundedState=REFUNDED`. Ratio metrics: derive from totals. Multi-item orders → one Sale per item sharing `orderId` — group by `orderId` for order-level revenue `[UNVERIFIED — inferred from orders model]`. |
| Call | `GET /api/v1.0/calls` | `id`, `externalId`, `creationDate`, `lead`, `name`, `tag` | `qualified` (bool, legacy), `state` (QUALIFIED/UNQUALIFIED/CANCELLED/NO_SHOW), `qualification{name, oldName}`, `score` | `firstSource`, `lastSource` | `qualified` is deprecated in favor of `state` on writes; GET still returns both `[UNVERIFIED how they interact on read]`. |
| Source | `GET /api/v1.0/sources` | `name`, `tag` (@...), `creationDate` (INTEGER — epoch `[UNVERIFIED unit]`) | — | `organic` (bool), `disregarded` (bool), `trafficSource{id,name}`, `goal{id,name}`, `category{id,name}`, `adSource{adSourceId, adAccountId, platform}` | Pass `includeOrganic=true` (and `includeDisregarded` as needed) or organics may be excluded. `platform` enum: FACEBOOK, GOOGLE, TIKTOK, SNAPCHAT, LINKEDIN, TWITTER, PINTEREST, BING. |
| (bonus) Attribution report | `GET /api/v1.0/attribution` + `/ad-account` + `/roas` | `id`, `name`, `parent_name` | `sales, revenue, total_revenue, cost, roas, roi, leads, calls, clicks, ...` (caller-selected) | level + ids pin the entity; `sourceConfiguration` filters organic/paid | This is HYROS-computed aggregation — use for cost/ROAS dashboards (we cannot pull ad spend from entity endpoints). Validate constraint matrix before coding queries. |

### Hyros channel/source vocabulary (for our normalization layer)
- **Tags are prefixed by type**: `@tag` = source link (traffic source), `$tag` = product/sale, `!tag` = lead event/action. Confirmed by spec examples (`@sl1`, `$product1`, `!clicked`) and the glossary: "@source tags basically represent the SOURCE that a person came from: Paid Ad traffic or Organic traffic" (https://docs.hyros.com/glossary/source-link/).
- **Organic vs paid is a boolean, not a string**: `Attribution.organic` / `Source.organic` (`true`/`false`), plus `disregarded` (bool) for ignored sources. Report-level filter: `sourceConfiguration = all_sources | only_organic | only_paid | prioritize_organic | prioritize_paid`.
- **`trafficSource.name`** is the coarse channel bucket — observed values in official examples: `facebook`, `automatic`. `[UNVERIFIED full vocabulary]` — expect lowercase platform/organic bucket names; enumerate from live `/sources` + sale attributions at first sync and build the mapping table from real data.
- **`adSource.platform`** enum (paid only): `FACEBOOK, GOOGLE, TIKTOK, SNAPCHAT, LINKEDIN, TWITTER, PINTEREST, BING` — note webhooks doc omits BING from its enum while REST includes it `[doc discrepancy]`.
- Suggested normalization: `channel = organic ? "organic" : platform.toLowerCase()`; keep `trafficSource.name`, `sourceLink name/tag`, `category.name`, `goal.name` as raw dimensions in `reporting_facts` for drill-down.

---

## 6. Implications for our sync design (matches architecture rules)

1. **Backfill (90d default)**: paginate `/sales`, `/calls`, `/leads`, `/subscriptions` with `fromDate = now-90d`, `pageSize=250`, follow `nextPageId`. `/sources` + `/ad-accounts` as dimension tables (full refresh each run — cheap).
2. **Incremental**: advance a `last_synced_at` cursor per entity into `fromDate`, with a **~10–15 min overlap** (writes async; late-arriving attributions) — idempotent upsert on `(source='hyros', external_id)` makes re-reads safe.
3. **Refunds**: webhook `sale.refunded` + periodic `saleRefundedState=REFUNDED` sweep; update the stored fact's `refunded` amount, don't delete the row.
4. **Webhooks**: subscribe to `sale.attributed`, `sale.refunded`, `call.attributed`, `lead.opted.in`, `subscription.created`, `subscription.status.changed`. Verify `X-Hyros-Signature` (v1 only), dedup on `eventId`, 200-fast + async processing. Poll-based incremental stays as the safety net since retry/disable behavior is under-documented.
5. **Ad spend / ROAS**: only available via `/attribution*` endpoints (Hyros-computed) — schedule these (e.g. hourly for yesterday/today, daily for the trailing 90d) rather than real-time; store rows keyed by `(level, id, date, attributionModel)`. Never sum `roas`/`roi` across rows — recompute from summed `revenue`/`cost` (our ratio-from-totals rule).
6. **Ratios**: `roas = total_revenue / cost` etc., always computed from summed base metrics at read time.
7. **Access gate**: unchanged — reporting APIs stay behind super_admin `abubakar` + per-user `smartReporting` capability; Hyros key lives only in server env (`HYROS_API_KEY`), never in the browser bundle.

## 7. Needs live-account verification (hand to builder/admin)

1. Base URL `https://api.hyros.com/v1` — smoke-test `GET /api/v1.0/user-info` with the real key.
2. Exact in-app location of the API key (Settings → Profile vs Settings → API Keys vs Settings → Integrations → API).
3. `nextPageId` termination semantics on non-ad-account endpoints (null vs absent).
4. `lead.opted.in.first.time` payload shape (enum-only event, undocumented).
5. `GET /api/v1.0/requests/{request_id}` (referenced, undefined) — async write status lookup?
6. Webhook retry count/schedule and the auto-disable threshold.
7. Whether REST entity ids carry prefixes (`sle-`, `cll-`) like webhook bodies do, or bare hex like the REST examples.
8. `Source.creationDate` integer unit (epoch seconds vs ms).
9. Full real-world `trafficSource.name` vocabulary + whether NEONMONKI's account uses custom categories/goals.
10. Whether `/sales` emits one row per order item (shared `orderId`) — affects revenue aggregation.
