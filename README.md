# nyt-rails

An **MCP server** carrying a mock of Delhivery's One Express API, plus the three capabilities that **no rail provides today** — the ones named in the Round 2 answers.

Two front doors onto one set of logic (`lib/core.js`):

- **MCP** at `POST /mcp` — how AgenticOrg consumes it. Register this URL as a custom MCP connector and 16 tools appear on the agent.
- **REST** at Delhivery's own paths — so the shapes can be checked against their docs with curl, and so the form-encoding quirk on `create.json` is reproduced rather than hidden.

A tool call through MCP and a curl against the REST path cannot disagree, because both run the same function.

Two reasons this exists rather than pointing the agent at Delhivery staging:

1. **Failures are on cue, not on chance.** Every failure is triggered by a header, a query param, or a reserved pincode. When you're recording a run and need "no rider in that pincode" to happen, it happens on that request, not eventually.
2. **The gap capabilities have somewhere to live.** `parse_spoken_budget_and_date`, `pre_debit_notice` and `record_fit_return_reason` are the three things you told the judges don't exist. Here they exist as real HTTP endpoints, so the agent calls them the same way it calls Delhivery — and the missing rail is a *shape*, not a claim.

Request and response shapes mirror Delhivery's docs, including the awkward part: `create.json` takes a **form-encoded** body, not raw JSON.

---

## Run it

```bash
npm install
npm start          # http://localhost:3000   (MCP at /mcp)
npm test           # 111 assertions — REST, MCP, and every failure mode
```

Deploy (Vercel, free): push this folder to a repo → **New Project** → import → deploy. `vercel.json` routes everything to `api/index.js`. No env vars, no build step, **root directory left blank**.

---

## Register it on AgenticOrg

1. Deploy, then **verify the handshake yourself first**:

   ```bash
   node scripts/mcp-check.js https://your-app.vercel.app
   ```

   It prints the `initialize` reply and lists all 19 tools. **Save that output.** If the platform later shows a connector with no tools, this is your proof the server is fine — that exact bug was open at the Pine Labs demo, and arriving with evidence turns a day of guessing into a support ticket.

2. Register a **custom MCP connector** with:
   - **Server URL:** `https://your-app.vercel.app/mcp`
   - **Auth:** none required. (It is also accepted at `/` and `/mcp/`, so a URL typed without the path still works.)
3. Confirm the 19 tools show up as **authorized tools** on the agent before you write a single line of prompt. If they don't appear, nothing downstream will work and no amount of prompting will fix it.

**Why MCP has no auth gate** while the REST side does: the commonest reason a registered MCP server shows zero tools is the client silently failing auth on `initialize` and giving up. There is no real data here, so the handshake is left open and the realistic `Authorization: Token` gate stays on the REST paths.

### The 19 tools

`delhivery_check_pincode` · `delhivery_fetch_waybills` · `delhivery_create_shipment` · `delhivery_track_shipment` · `delhivery_edit_shipment` · `delhivery_cancel_shipment` · `delhivery_packing_slip` · `delhivery_ndr_action` · `delhivery_ndr_status` · `get_shipping_cost` · `product_search` · `parse_spoken_budget_and_date` · `pre_debit_notice_send` · `pre_debit_notice_status` · `pre_debit_notice_respond` · `record_fit_return_reason` · `get_fit_ledger` · `mock_advance_shipment` · `mock_reset`

Each tool's **description carries its own guardrail**, because the model reads the description when it decides whether to call. `delhivery_create_shipment` says in as many words that a 200 can still be a failure. `pre_debit_notice_status` says `debit_allowed` is true in exactly one state. A system prompt can be edited away by accident; a tool description travels with the tool.

Transport notes: Streamable HTTP, stateless — no session id, no server-initiated messages, because each Vercel invocation is a fresh process. Replies are framed as JSON or SSE depending on the client's `Accept` header, since MCP clients differ on which they demand. `GET /mcp` returns a clean `405 Allow: POST` so a client that probes GET falls back instead of hanging. `GET /mcp/tools` is a plain browser-readable list, for when a platform claims the connector has none.

---

## REST auth

```
Authorization: Token <any-non-empty-string>
```

Same header shape as Delhivery. Any non-empty token passes; a missing one returns Delhivery's own 401 body. This is so the agent's connector config looks exactly like the real one — swapping in the real base URL and a real key is a one-line change.

`GET /` and `/health` need no token and list every endpoint.

---

## REST endpoints (the Delhivery paths)

| Method | Path | What it does |
|---|---|---|
| GET | `/c/api/pin-codes/json/?filter_codes=110001` | Serviceability, COD, ODA |
| GET | `/waybill/api/bulk/json/?count=5` | Reserve waybills (returns a JSON **string**, comma-separated) |
| POST | `/api/cmu/create.json` | Create shipment — **`format=json&data={...}`, form-encoded** |
| GET | `/api/v1/packages/json/?waybill=...` | Track (also `?ref_ids=`) |
| POST | `/api/p/edit` | Change consignee name / phone / address / pin |
| GET | `/api/p/packing_slip?wbns=...` | Packing slip data |
| POST | `/api/p/update` | NDR action: `RE-ATTEMPT`, `DEFER_DLV`, `EDIT_DETAILS`, `RTO` |
| GET | `/api/p/update?request_id=NDR...` | NDR status |

> **Verify before you submit.** I confirmed `/c/api/pin-codes/json/` and `POST /api/cmu/create.json` (including the form-encoding) against Delhivery's published docs. The tracking, edit, packing-slip and NDR paths come from the operation names, not a fetched reference page. The brief asks you to name endpoints *exactly* as Delhivery names them, so check those four against the developer portal you can log into and rename here if they differ. Changing a path is one line in `api/index.js`.

### Realistic behaviour, not just 200s

- `create.json` **rejects raw JSON** with a 400 saying so — the same trap the real API sets.
- Missing `pickup_location` returns Delhivery's actual message: `ClientWarehouse matching query does not exist.`
- Missing mandatory fields come back **named**, per shipment, inside `packages[].remarks`.
- A per-shipment failure is `packages[].status: "Fail"` while the request is still HTTP 200 — so an agent that only checks the status code will look like it succeeded. That's a real failure mode and one of your eval cases.
- COD on a prepaid-only pincode fails at create, not at delivery.
- `RE-ATTEMPT` is refused unless the shipment is actually in an NDR state.
- Editing is refused once the shipment is `Delivered`.

---

## Failure scenarios

Trigger any of them three ways — header `X-Mock-Scenario: <name>`, query `?mock=<name>`, or a reserved pincode.

| Scenario | What comes back |
|---|---|
| `ok` | normal |
| `no_rider` | pincode not serviceable — `delivery_codes: []`, and create fails per shipment |
| `low_balance` | HTTP 200, `success: false`, `error: "InsufficientBalance"` |
| `timeout` | stalls then HTTP 504. `?delay_ms=` up to 8000 (Vercel caps a function at 10s) |
| `malformed` | HTTP 200, `Content-Type: application/json`, **truncated body** |
| `rate_limited` | HTTP 429 + `Retry-After: 30` |
| `auth_fail` | HTTP 401 |
| `oda` | serviceable but out of delivery area, +2 days on the promise |

### Reserved pincodes

Use these when the agent platform won't let you set a custom header — the scenario rides in the data.

| Pincode | Behaviour |
|---|---|
| `110001` `400001` `560001` | Delhi / Mumbai / Bengaluru — prepaid + COD |
| `190001` | Srinagar — **prepaid only**, COD refused |
| `744101` | Port Blair — **ODA**, +2 days |
| `799001`, `999999` | **not serviceable** |
| `100000` | timeout |
| `100001` | malformed reply |
| `100002` | rate limited |
| `100003` | insufficient balance |

---

## Mock control — move a parcel on cue

Not Delhivery endpoints. They exist so a recording can show delivery, an NDR or an RTO happening *now*.

```bash
curl -s -X POST $BASE/__mock/advance -H "Authorization: Token k" \
  -H 'Content-Type: application/json' \
  -d '{"waybill":"13401110000001","to":"Undelivered"}'
```

`to` is one of: `In Transit`, `Out for delivery`, `Undelivered`, `Delivered`, `RTO In Transit`, `RTO Delivered`, `Lost`. Each call appends a real scan, so tracking shows a believable history.

- `GET /__mock/state` — every waybill, notice and ledger user right now
- `POST /__mock/reset` — clean slate before a recorded run

State is in memory. A Vercel cold start wipes it, so do a recorded run in one sitting.

---

## The three gap capabilities

### 1. `POST /gap/parse_spoken_budget_and_date`

Gnani hands you a transcript. Nothing hands you a **number and a date**. This does, and — more importantly — it tells you when it couldn't.

```bash
curl -s -X POST $BASE/gap/parse_spoken_budget_and_date -H "Authorization: Token k" \
  -H 'Content-Type: application/json' \
  -d '{"transcript":"do hazaar ke andar, Diwali se pehle","today":"2026-09-30"}'
```

Handles `under 2000`, `2.5k`, `₹4,000`, `between 1500 and 3000`, `around 4k`, `at least 1000`, `do hazaar`, `paanch sau`, `one lakh`; and `today`/`aaj`, `kal`, `parso`, `in 2 weeks`, `next Friday`, `before Diwali`, `15 Oct`.

Returns `budget {min, max, basis}`, `deliver_by`, `date_basis`, `confidence`, `unresolved[]`, and a `clarifying_question`.

Two design choices that matter more than the parsing:

- **`basis` is always returned.** `ceiling` (they said "under") is not the same claim as `ceiling_implied` (they just said a number) or `approx` ("around 4k" → ±15%). The agent must be able to tell how much it's assuming.
- **A bare number word without a multiplier is not a budget.** "a nice shirt" returns `not_found` and a question, not ₹1. Guessing a budget is worse than asking for one, and `festival_approx` never returns `high` confidence — "before Diwali" is a real date but not a promise.

### 2. `POST /gap/pre_debit_notice`

Pine Labs SBMD can debit a mandate. Nothing tells the human first and **waits**. This is the consent gate.

```bash
curl -s -X POST $BASE/gap/pre_debit_notice -H "Authorization: Token k" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u1","mandate_id":"SBMD-1","amount":2398,"notice_hours":24,
       "line_items":[{"title":"Linen shirt","size":"M","price":1499},
                     {"title":"Chinos","size":"32","price":899}]}'
```

Returns a `notice_id`, a `debit_not_before` timestamp, and the exact WhatsApp text the human sees — itemised, with the total and the deadline spelled out.

Then one of:

- `POST /gap/pre_debit_notice/:id/respond` `{"reply":"haan"}` → `approved`, `debit_allowed: true`
- `{"reply":"nahi"}` → `declined`
- `{"reply":"change"}` → `revision_requested`
- anything unreadable → `unparsed`, `debit_allowed: false`
- `POST /gap/pre_debit_notice/:id/expire` → `expired_no_reply`, `debit_allowed: false`

**`debit_allowed` is true in exactly one state.** Silence is not consent, and neither is a reply the agent couldn't read. A second reply to a settled notice gets a 409 — the mandate can't be re-litigated after the money moved. Yes/no is read in English and Hinglish (`haan`, `nahi`, `theek`, `rehne do`).

### 3. `POST /gap/record_fit_return_reason`

Delhivery knows a parcel came back. It does not know **which body** didn't fit **which garment** and **why**. That's the fourth rail.

```bash
curl -s -X POST $BASE/gap/record_fit_return_reason -H "Authorization: Token k" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u1","brand":"Zara","garment_type":"shirt","size_ordered":"M",
       "reason_code":"tight_shoulders","kept":false,
       "body":{"shoulder_cm":46,"chest_cm":98}}'
```

`reason_code` is a closed taxonomy, because free text can't be ranked on: `tight_shoulders`, `tight_chest`, `tight_waist`, `tight_hips`, `loose_overall`, `loose_waist`, `sleeve_long`, `sleeve_short`, `length_short`, `length_long`, `fabric_thin`, `fabric_itchy`, `colour_off`, `not_as_pictured`, `changed_mind`.

Every write returns `learned` — the rules the ranker can use right now:

```json
{"rules":[{"brand":"Zara","garment_type":"shirt","part":"shoulder","direction":"up",
           "count":2,"confidence":"medium","active":true,
           "rule":"Zara shirt: size up one — shoulder runs tight"}],
 "hard_rejects":[{"type":"fabric","brand":"Fabindia",
                  "note":"fabric complaints twice — reject by default"}],
 "return_rate":1,"sample_size":4}
```

- **Two events before a rule activates.** One return is noise; a pattern is a pattern. `active: false` until then, and the ranker ignores inactive rules.
- **Fabric, colour and listing-trust complaints become `hard_rejects`, not weights.** That's Tier 1 in your model — a hard reject, not a slightly lower score. Fit complaints become Tier 2 size adjustments.
- `changed_mind` is recorded and deliberately teaches nothing. Not every return is a fit signal, and treating it as one is how a recommender goes wrong.

Read it back any time: `GET /gap/fit_ledger/:user_id`.

---

## What the tests cover

`npm test` runs 97 assertions in-process: the MCP handshake, `tools/list`, SSE framing and a call of every tool; then REST auth, all eight Delhivery paths, per-shipment failures, the full tracking state machine, every failure scenario, eight budget-parsing cases, all five consent states, and the two-event rule threshold. It exits non-zero on any failure, so it goes straight into your decision log as evidence the connector worked before the agent ever touched it.
