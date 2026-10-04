/* =====================================================================
   Not Your Type — rails server
   ---------------------------------------------------------------------
   Two front doors onto one set of logic (lib/core.js):

     MCP   POST /mcp   — how AgenticOrg consumes it. Register this URL
                         as an MCP connector; the tools then have to show
                         up as authorized tools on the agent.
     REST  /api/...    — Delhivery's own paths, so the shapes can be
                         checked against their docs with curl, and so the
                         form-encoding quirk on create.json is reproduced.

   Failures are deterministic: trigger them with X-Mock-Scenario, ?mock=,
   a `mock` tool argument, or a reserved pincode. Never random, so a
   recording can show a failure the moment it's needed.
   ===================================================================== */

const express = require("express");
const core = require("../lib/core.js");
const { mountMcp, publicTools } = require("../lib/mcp.js");

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true, limit: "1mb" }));   // create.json
app.use(express.json({ limit: "4mb" }));
app.use(express.text({ type: "*/*", limit: "1mb" }));

/* ------------------------------------------------------------------ */
/* MCP first, and deliberately WITHOUT the token gate.                 */
/* The commonest reason a registered MCP server shows zero tools is the */
/* client failing auth on initialize and giving up quietly. There is no */
/* real data here, so the handshake is left open and the REST side keeps */
/* the realistic auth.                                                 */
/* ------------------------------------------------------------------ */
mountMcp(app, ["/mcp", "/mcp/", "/"]);

/* ------------------------------------------------------------------ */
/* REST: Delhivery uses  Authorization: Token <api_key>                */
/* ------------------------------------------------------------------ */
app.use((req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/health" || req.path === "/mcp/tools")) return next();
  if (req.path.startsWith("/__mock")) return next();
  const m = /^Token\s+(.+)$/i.exec((req.get("Authorization") || "").trim());
  if (!m || !m[1].trim()) {
    return res.status(401).json({ success: false, rmk: "Authentication credentials were not provided.", hint: "Send  Authorization: Token <any-non-empty-string>" });
  }
  next();
});

/* send a core result as an HTTP response */
function reply(res, r) {
  if (r.headers) res.set(r.headers);
  if (r.raw !== undefined) return res.status(r.status).type(r.type || "application/json").send(r.raw);
  return res.status(r.status).json(r.body);
}
const body = (req) => {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
};
const forced = (req) => req.get("X-Mock-Scenario") || req.query.mock || body(req).mock;

/* ---- Delhivery paths --------------------------------------------- */

app.get("/c/api/pin-codes/json/", async (req, res) =>
  reply(res, await core.checkPincode({ pin: req.query.filter_codes, mock: forced(req), delay_ms: req.query.delay_ms })));

app.get("/waybill/api/bulk/json/", async (req, res) =>
  reply(res, await core.fetchWaybills({ count: req.query.count, mock: forced(req), delay_ms: req.query.delay_ms })));

app.post("/api/cmu/create.json", async (req, res) => {
  // The real API takes form-encoded  format=json&data={...}  — not raw JSON.
  // Reproduced on purpose: it is the first thing that breaks an integration.
  let rawData = null, b = req.body;
  if (b && typeof b === "object" && typeof b.data === "string") {
    rawData = b.data;
    if (String(b.format || "").toLowerCase() !== "json") return res.status(400).json({ success: false, rmk: "format=json is required in the form body", packages: [] });
  } else if (typeof b === "string" && b.includes("data=")) {
    const p = new URLSearchParams(b);
    rawData = p.get("data");
    if ((p.get("format") || "").toLowerCase() !== "json") return res.status(400).json({ success: false, rmk: "format=json is required in the form body", packages: [] });
  } else {
    return res.status(400).json({ success: false, rmk: "Expected form-encoded body: format=json&data={...}. Raw JSON is not accepted.", packages: [] });
  }

  let payload;
  try { payload = JSON.parse(rawData); }
  catch { return res.status(400).json({ success: false, rmk: "data is not valid JSON", packages: [] }); }

  reply(res, await core.createShipment({ payload, mock: forced(req), delay_ms: req.query.delay_ms }));
});

app.get("/api/v1/packages/json/", async (req, res) =>
  reply(res, await core.trackShipment({ waybill: req.query.waybill, ref_ids: req.query.ref_ids, mock: forced(req), delay_ms: req.query.delay_ms })));

app.post("/api/p/edit", async (req, res) =>
  reply(res, await core.editShipment({ ...body(req), mock: forced(req) })));

app.get("/api/p/packing_slip", async (req, res) =>
  reply(res, await core.packingSlip({ wbns: req.query.wbns, mock: forced(req), delay_ms: req.query.delay_ms })));

app.post("/api/p/update", async (req, res) =>
  reply(res, await core.ndrAction({ data: body(req).data, mock: forced(req) })));

app.get("/api/p/update", async (req, res) =>
  reply(res, await core.ndrStatus({ request_id: req.query.request_id })));

app.get("/api/kinko/v1/invoice/charges/.json", async (req, res) =>
  reply(res, await core.shippingCost({ origin_pin: req.query.o_pin, destination_pin: req.query.d_pin, weight_g: req.query.cgm, payment_mode: req.query.pt, mock: forced(req), delay_ms: req.query.delay_ms })));

/* ---- catalogue (not Delhivery; the shop side) -------------------- */

app.post("/catalogue/search", async (req, res) =>
  reply(res, await core.productSearch({ ...body(req), mock: forced(req) })));

app.get("/catalogue/search", async (req, res) =>
  reply(res, await core.productSearch({ ...req.query, mock: forced(req) })));

/* ---- the three capabilities no rail provides --------------------- */

app.post("/gap/parse_spoken_budget_and_date", async (req, res) =>
  reply(res, await core.parseSpoken({ ...body(req), mock: forced(req) })));

app.post("/gap/pre_debit_notice", async (req, res) =>
  reply(res, await core.preDebitNotice({ ...body(req), mock: forced(req) })));

app.post("/gap/pre_debit_notice/:id/respond", async (req, res) =>
  reply(res, await core.preDebitRespond({ notice_id: req.params.id, reply: body(req).reply })));

app.post("/gap/pre_debit_notice/:id/expire", async (req, res) =>
  reply(res, await core.preDebitExpire({ notice_id: req.params.id })));

app.get("/gap/pre_debit_notice/:id", async (req, res) =>
  reply(res, await core.preDebitGet({ notice_id: req.params.id })));

app.post("/gap/record_fit_return_reason", async (req, res) =>
  reply(res, await core.recordFit({ ...body(req), mock: forced(req) })));

app.get("/gap/fit_ledger/:user_id", async (req, res) =>
  reply(res, await core.getLedger({ user_id: req.params.user_id })));

/* ---- demo control ------------------------------------------------ */

app.post("/__mock/advance", async (req, res) => reply(res, await core.advance(body(req))));
app.get("/__mock/state", async (req, res) => reply(res, await core.state()));
app.post("/__mock/reset", async (req, res) => reply(res, await core.reset()));

/* ---- index ------------------------------------------------------- */

// A plain list of the MCP tools, for eyeballing in a browser when the
// platform claims a connector has none.
app.get("/mcp/tools", (req, res) => res.json({ count: publicTools().length, tools: publicTools().map((t) => ({ name: t.name, title: t.title })) }));

app.get(["/", "/health"], (req, res) => {
  res.json({
    service: "Not Your Type — rails (Delhivery sandbox + the three missing capabilities)",
    note: "Mock. Deterministic failures. Delhivery paths and payload shapes mirror their docs.",
    mcp: { endpoint: "POST /mcp", transport: "Streamable HTTP, stateless", protocolVersion: require("../lib/mcp.js").PROTOCOL_VERSION, tools: publicTools().length, auth: "none required", list: "GET /mcp/tools" },
    rest: {
      auth: "Authorization: Token <any-non-empty-string>",
      delhivery: [
        "GET  /c/api/pin-codes/json/?filter_codes=110001",
        "GET  /waybill/api/bulk/json/?count=5",
        "POST /api/cmu/create.json           (form-encoded: format=json&data={...})",
        "GET  /api/v1/packages/json/?waybill=...",
        "POST /api/p/edit",
        "GET  /api/p/packing_slip?wbns=...",
        "POST /api/p/update                  (NDR action)",
        "GET  /api/p/update?request_id=...   (NDR status)",
      ],
      gaps: [
        "POST /gap/parse_spoken_budget_and_date",
        "POST /gap/pre_debit_notice   + /:id/respond  + /:id/expire  + GET /:id",
        "POST /gap/record_fit_return_reason   + GET /gap/fit_ledger/:user_id",
      ],
      mock_control: ["POST /__mock/advance", "GET /__mock/state", "POST /__mock/reset"],
    },
    scenarios: core.SCENARIOS,
    scenario_pincodes: core.PIN_SCENARIO,
  });
});

app.use((req, res) => res.status(404).json({ success: false, rmk: "No such endpoint: " + req.method + " " + req.path }));

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("nyt-rails listening on http://localhost:" + port + "   (MCP at /mcp)"));
}
