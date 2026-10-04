/* Smoke test — runs the whole happy path plus every failure scenario.
   node test/smoke.js     (server is started in-process, no port clash)   */

const app = require("../api/index.js");
const http = require("http");

const server = http.createServer(app);
let base = "";
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

async function call(method, path, opts = {}) {
  const headers = Object.assign({ Authorization: "Token test-key" }, opts.headers || {});
  let body;
  if (opts.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(opts.form).toString(); }
  else if (opts.json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
  const r = await fetch(base + path, { method, headers, body });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = "http://127.0.0.1:" + server.address().port;

  console.log("\nauth");
  const noAuth = await fetch(base + "/c/api/pin-codes/json/?filter_codes=110001");
  ok("401 without a token", noAuth.status === 401);
  ok("index needs no token", (await fetch(base + "/")).status === 200);

  console.log("\npincode serviceability");
  let r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001");
  ok("110001 serviceable, COD on", r.json.delivery_codes[0].postal_code.cod === "Y");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=190001");
  ok("190001 prepaid only", r.json.delivery_codes[0].postal_code.cod === "N");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=744101");
  ok("744101 is ODA", r.json.delivery_codes[0].postal_code.is_oda === "Y");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=799001");
  ok("799001 not serviceable (empty array)", Array.isArray(r.json.delivery_codes) && r.json.delivery_codes.length === 0);

  console.log("\nwaybills");
  r = await call("GET", "/waybill/api/bulk/json/?count=3");
  ok("returns a JSON string of 3 comma-separated waybills",
     typeof r.json === "string" && r.json.split(",").length === 3, r.json);

  console.log("\ncreate.json");
  r = await call("POST", "/api/cmu/create.json", { json: { shipments: [] } });
  ok("raw JSON is rejected", r.status === 400 && /form-encoded/.test(r.json.rmk), r.json);

  const shipment = {
    shipments: [{ order: "NYT-1001", name: "Test User", add: "12 Some Road", pin: "110001",
                  phone: "9999999999", payment_mode: "Prepaid", city: "New Delhi", state: "Delhi",
                  products_desc: "Linen shirt", quantity: 1 }],
    pickup_location: { name: "NYT Warehouse" },
  };
  r = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify(shipment) } });
  ok("form-encoded create succeeds", r.json.success === true && r.json.packages[0].status === "Success", r.json);
  const waybill = r.json.packages[0].waybill;

  r = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify({ shipments: shipment.shipments }) } });
  ok("missing pickup_location -> warehouse error", r.json.success === false && /ClientWarehouse/.test(r.json.rmk), r.json);

  r = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify({
    shipments: [{ order: "NYT-1002", name: "X", add: "Y", pin: "799001", phone: "9", payment_mode: "Prepaid" }],
    pickup_location: { name: "NYT Warehouse" } }) } });
  ok("unserviceable pin -> package Fail", r.json.packages[0].status === "Fail" && /not serviceable/.test(r.json.packages[0].remarks[0]), r.json);

  r = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify({
    shipments: [{ order: "NYT-1003", name: "X", add: "Y", pin: "190001", phone: "9", payment_mode: "COD", cod_amount: 1999 }],
    pickup_location: { name: "NYT Warehouse" } }) } });
  ok("COD on a prepaid-only pin -> Fail", r.json.packages[0].status === "Fail" && /COD is not available/.test(r.json.packages[0].remarks[0]), r.json);

  r = await call("POST", "/api/cmu/create.json", { form: { format: "json", data: JSON.stringify({
    shipments: [{ order: "NYT-1004", pin: "110001" }], pickup_location: { name: "NYT Warehouse" } }) } });
  ok("missing mandatory fields listed by name", /Mandatory field\(s\) missing/.test(r.json.packages[0].remarks[0]), r.json);

  console.log("\ntracking + advance");
  r = await call("GET", "/api/v1/packages/json/?waybill=" + waybill);
  ok("tracks as Manifested", r.json.ShipmentData[0].Shipment.Status.Status === "Manifested", r.json);
  await call("POST", "/__mock/advance", { json: { waybill, to: "Out for delivery" } });
  await call("POST", "/__mock/advance", { json: { waybill, to: "Undelivered" } });
  r = await call("GET", "/api/v1/packages/json/?waybill=" + waybill);
  ok("advances to Undelivered with 3 scans", r.json.ShipmentData[0].Shipment.Status.Status === "Undelivered" && r.json.ShipmentData[0].Shipment.Scans.length === 3, r.json.ShipmentData[0].Shipment.Scans.length);
  r = await call("GET", "/api/v1/packages/json/?waybill=00000");
  ok("unknown waybill -> empty ShipmentData", r.json.ShipmentData.length === 0);

  console.log("\nNDR");
  r = await call("POST", "/api/p/update", { json: { data: [{ waybill, act: "RE-ATTEMPT" }] } });
  ok("RE-ATTEMPT accepted in NDR state", r.json.status === true, r.json);
  const reqId = r.json.request_id;
  ok("NDR status readable by request_id", (await call("GET", "/api/p/update?request_id=" + reqId)).json.request_id === reqId);
  r = await call("POST", "/api/p/update", { json: { data: [{ waybill, act: "RE-ATTEMPT" }] } });
  ok("RE-ATTEMPT refused when not in NDR", r.json.data[0].status === "Fail", r.json);
  r = await call("POST", "/api/p/update", { json: { data: [{ waybill, act: "TELEPORT" }] } });
  ok("bad act rejected", r.json.data[0].status === "Fail");

  console.log("\nedit + packing slip");
  r = await call("POST", "/api/p/edit", { json: { waybill, add: "New address 42", pin: "110001" } });
  ok("edit accepted", r.json.status === true, r.json);
  r = await call("GET", "/api/p/packing_slip?wbns=" + waybill);
  ok("packing slip returns the package", r.json.packages_found === 1, r.json);
  await call("POST", "/__mock/advance", { json: { waybill, to: "Delivered" } });
  r = await call("POST", "/api/p/edit", { json: { waybill, add: "Too late" } });
  ok("edit refused after Delivered", r.json.status === false, r.json);

  console.log("\nfailure scenarios");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001&mock=rate_limited");
  ok("rate_limited -> 429 + Retry-After", r.status === 429 && r.headers.get("retry-after") === "30");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001&mock=auth_fail");
  ok("auth_fail -> 401", r.status === 401);
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001&mock=low_balance");
  ok("low_balance -> success:false, InsufficientBalance", r.json.success === false && r.json.error === "InsufficientBalance");
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001&mock=malformed");
  ok("malformed -> JSON content-type, unparseable body", r.json === null && r.text.startsWith("{"), r.text.slice(0, 40));
  const t0 = Date.now();
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=110001&mock=timeout&delay_ms=300");
  ok("timeout -> 504 after the delay", r.status === 504 && Date.now() - t0 >= 250, r.status);
  r = await call("GET", "/c/api/pin-codes/json/?filter_codes=100002");
  ok("scenario pincode works without a header", r.status === 429);

  console.log("\ngap 1 — parse_spoken_budget_and_date");
  const cases = [
    ["Something under 2000 rupees by Friday",            { max: 2000 }],
    ["do hazaar ke andar chahiye",                       { max: 2000 }],
    ["budget 2.5k, need it before Diwali",               { max: 2500 }],
    ["between 1500 and 3000",                            { min: 1500, max: 3000 }],
    ["around ₹4,000",                                    { min: 3400, max: 4600 }],
    ["paanch sau tak",                                   { max: 500 }],
    ["at least 1000",                                    { min: 1000 }],
    ["one lakh budget",                                  { max: 100000 }],
  ];
  for (const [t, want] of cases) {
    r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: t, today: "2026-09-30" } });
    const b = r.json.budget;
    const good = (want.min === undefined || b.min === want.min) && (want.max === undefined || b.max === want.max);
    ok('"' + t + '"', good, b);
  }
  r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: "under 2000 by tomorrow", today: "2026-09-30" } });
  ok("tomorrow resolves to 2026-10-01", r.json.deliver_by === "2026-10-01", r.json.deliver_by);
  r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: "need it in 2 weeks, 3k max", today: "2026-09-30" } });
  ok("in 2 weeks resolves to 2026-10-14", r.json.deliver_by === "2026-10-14", r.json.deliver_by);
  r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: "by next Friday", today: "2026-09-30" } });
  ok("next Friday resolves (Wed 30 Sep -> 9 Oct)", r.json.deliver_by === "2026-10-09", r.json.deliver_by);
  r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: "before Diwali", today: "2026-09-30" } });
  ok("festival flagged medium confidence, not high", r.json.date_basis === "festival_approx" && r.json.confidence !== "high", r.json);
  r = await call("POST", "/gap/parse_spoken_budget_and_date", { json: { transcript: "I want a nice shirt", today: "2026-09-30" } });
  ok("nothing parseable -> low confidence + a question", r.json.confidence === "low" && !!r.json.clarifying_question, r.json);

  console.log("\ngap 2 — pre_debit_notice");
  r = await call("POST", "/gap/pre_debit_notice", { json: {
    user_id: "u1", mandate_id: "SBMD-1", amount: 2398, notice_hours: 24,
    line_items: [{ title: "Linen shirt", size: "M", price: 1499 }, { title: "Chinos", size: "32", price: 899 }] } });
  ok("notice created, awaiting_reply", r.json.state === "awaiting_reply" && /Total ₹2398/.test(r.json.message), r.json.state);
  const nid = r.json.notice_id;
  ok("message names the deadline", /unless you say no/.test(r.json.message));
  r = await call("POST", "/gap/pre_debit_notice", { json: { user_id: "u1", amount: 100 } });
  ok("missing fields rejected", r.status === 400);
  r = await call("POST", "/gap/pre_debit_notice/" + nid + "/respond", { json: { reply: "haan" } });
  ok('"haan" -> approved, debit allowed', r.json.state === "approved" && r.json.debit_allowed === true, r.json);
  r = await call("POST", "/gap/pre_debit_notice/" + nid + "/respond", { json: { reply: "no" } });
  ok("second reply refused (409)", r.status === 409, r.json);

  r = await call("POST", "/gap/pre_debit_notice", { json: { user_id: "u2", mandate_id: "SBMD-2", amount: 500, line_items: [{ title: "Tee", price: 500 }] } });
  const nid2 = r.json.notice_id;
  r = await call("POST", "/gap/pre_debit_notice/" + nid2 + "/respond", { json: { reply: "nahi" } });
  ok('"nahi" -> declined, no debit', r.json.state === "declined" && r.json.debit_allowed === false);

  r = await call("POST", "/gap/pre_debit_notice", { json: { user_id: "u3", mandate_id: "SBMD-3", amount: 500, line_items: [{ title: "Tee", price: 500 }] } });
  const nid3 = r.json.notice_id;
  r = await call("POST", "/gap/pre_debit_notice/" + nid3 + "/respond", { json: { reply: "hmm maybe idk" } });
  ok("unreadable reply -> unparsed, no debit", r.json.state === "unparsed" && r.json.debit_allowed === false, r.json);

  r = await call("POST", "/gap/pre_debit_notice", { json: { user_id: "u4", mandate_id: "SBMD-4", amount: 500, line_items: [{ title: "Tee", price: 500 }] } });
  r = await call("POST", "/gap/pre_debit_notice/" + r.json.notice_id + "/expire", {});
  ok("silence -> expired_no_reply, no debit", r.json.state === "expired_no_reply" && r.json.debit_allowed === false, r.json);

  console.log("\ngap 3 — record_fit_return_reason");
  r = await call("POST", "/gap/record_fit_return_reason", { json: {
    user_id: "u1", brand: "Zara", garment_type: "shirt", size_ordered: "M",
    reason_code: "tight_shoulders", kept: false, body: { shoulder_cm: 46, chest_cm: 98 } } });
  ok("first event stored, rule not yet active", r.json.ok && r.json.learned.rules[0].active === false, r.json.learned.rules[0]);
  r = await call("POST", "/gap/record_fit_return_reason", { json: {
    user_id: "u1", brand: "Zara", garment_type: "shirt", size_ordered: "M", reason_code: "tight_shoulders", kept: false } });
  ok("second event activates the size-up rule", r.json.learned.rules[0].active === true && /size up one/.test(r.json.learned.rules[0].rule), r.json.learned.rules[0]);
  r = await call("POST", "/gap/record_fit_return_reason", { json: { user_id: "u1", brand: "Zara", garment_type: "shirt", size_ordered: "M", reason_code: "nonsense" } });
  ok("bad reason_code rejected with the taxonomy", r.status === 400 && /reason_code must be one of/.test(r.json.error));
  await call("POST", "/gap/record_fit_return_reason", { json: { user_id: "u1", brand: "Fabindia", garment_type: "kurta", size_ordered: "L", reason_code: "fabric_thin", kept: false } });
  r = await call("POST", "/gap/record_fit_return_reason", { json: { user_id: "u1", brand: "Fabindia", garment_type: "kurta", size_ordered: "L", reason_code: "fabric_itchy", kept: false } });
  ok("two fabric complaints -> hard reject (Tier 1)", r.json.learned.hard_rejects.some((h) => h.brand === "Fabindia" && h.type === "fabric"), r.json.learned.hard_rejects);
  r = await call("GET", "/gap/fit_ledger/u1");
  ok("ledger readable, return rate computed", r.json.events.length === 4 && r.json.learned.return_rate === 1, r.json.learned.return_rate);
  r = await call("GET", "/gap/fit_ledger/nobody");
  ok("unknown user -> empty ledger, no crash", r.json.events.length === 0);

  console.log("\nmisc");
  ok("404 shape", (await call("GET", "/api/nope")).status === 404);
  ok("state endpoint lists waybills", (await call("GET", "/__mock/state")).json.waybills.length >= 1);


  console.log("\nMCP — handshake and tools");
  async function rpc(method, params, id, accept) {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: accept || "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id === undefined ? 1 : id, method, params }),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {
      const m = /^data: (.*)$/m.exec(text);
      if (m) { try { json = JSON.parse(m[1]); } catch {} }
    }
    return { status: r.status, json, text, ctype: r.headers.get("content-type") || "" };
  }

  r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  ok("initialize returns protocolVersion + serverInfo", r.json && r.json.result && !!r.json.result.protocolVersion && !!r.json.result.serverInfo, r.json);
  ok("initialize needs no auth header", r.status === 200);
  ok("declares the tools capability", !!(r.json.result.capabilities && r.json.result.capabilities.tools));

  const notif = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  ok("initialized notification -> 202, no body", notif.status === 202);

  r = await rpc("tools/list", {});
  const tools = r.json.result.tools;
  ok("tools/list returns 19 tools", tools.length === 19, tools.length);
  ok("every tool has a name, description and inputSchema", tools.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === "object"), tools.filter((t) => !t.inputSchema).map((t) => t.name));
  for (const n of ["product_search", "delhivery_check_pincode", "delhivery_create_shipment", "parse_spoken_budget_and_date", "pre_debit_notice_send", "pre_debit_notice_status", "record_fit_return_reason", "get_fit_ledger"]) {
    ok("exposes " + n, tools.some((t) => t.name === n));
  }
  ok("required fields are declared", tools.find((t) => t.name === "delhivery_create_shipment").inputSchema.required.includes("pin"));
  ok("reason_code is an enum, not free text", Array.isArray(tools.find((t) => t.name === "record_fit_return_reason").inputSchema.properties.reason_code.enum));

  r = await rpc("ping", {});
  ok("ping answers", r.json.result && Object.keys(r.json.result).length === 0);
  r = await rpc("resources/list", {});
  ok("resources/list answers empty (clients probe it)", Array.isArray(r.json.result.resources));
  r = await rpc("prompts/list", {});
  ok("prompts/list answers empty", Array.isArray(r.json.result.prompts));
  r = await rpc("nonsense/method", {});
  ok("unknown method -> -32601", r.json.error && r.json.error.code === -32601);

  console.log("\nMCP — SSE framing");
  r = await rpc("tools/list", {}, 9, "text/event-stream");
  ok("SSE framing when the client asks for it", /event-stream/.test(r.ctype) && r.text.startsWith("event: message"), r.ctype);
  ok("SSE payload parses to the same result", r.json && r.json.result.tools.length === 19);

  console.log("\nMCP — tools/call");
  async function tool(name, args) {
    const rr = await rpc("tools/call", { name, arguments: args });
    const c = rr.json.result;
    const txt = c.content[0].text;
    const nl = txt.indexOf("\n");
    let parsed = null;
    try { parsed = JSON.parse(txt.slice(nl + 1)); } catch {}
    return { http: Number(txt.slice(5, nl)), isError: !!c.isError, parsed, txt };
  }

  await tool("mock_reset", {});
  let t = await tool("delhivery_check_pincode", { pin: "110001" });
  ok("check_pincode works over MCP", t.http === 200 && t.parsed.delivery_codes[0].postal_code.cod === "Y", t.txt.slice(0, 80));
  t = await tool("delhivery_check_pincode", { pin: "799001" });
  ok("unserviceable pin surfaces as an empty array, not an error", t.http === 200 && t.parsed.delivery_codes.length === 0);
  t = await tool("delhivery_check_pincode", { pin: "110001", mock: "rate_limited" });
  ok("a failure scenario sets isError and shows the status", t.isError === true && t.http === 429, t.txt.slice(0, 60));

  t = await tool("delhivery_create_shipment", { order_id: "MCP-1", name: "Test", phone: "9999999999", address: "12 Some Road", pin: "110001", city: "New Delhi", state: "Delhi", payment_mode: "Prepaid", products_desc: "Linen shirt" });
  ok("create_shipment works over MCP (connector handles form-encoding)", t.http === 200 && t.parsed.packages[0].status === "Success", t.txt.slice(0, 120));
  const mcpWb = t.parsed.packages[0].waybill;

  t = await tool("delhivery_create_shipment", { order_id: "MCP-2", name: "Test", phone: "9", address: "x", pin: "190001", payment_mode: "COD", cod_amount: 999 });
  ok("the 200-that-failed still reads as HTTP 200", t.http === 200 && t.isError === false && t.parsed.packages[0].status === "Fail", t.txt.slice(0, 120));

  t = await tool("mock_advance_shipment", { waybill: mcpWb, to: "Delivered" });
  ok("advance works over MCP", t.parsed.status.Status === "Delivered");
  t = await tool("delhivery_track_shipment", { waybill: mcpWb });
  ok("track reflects it", t.parsed.ShipmentData[0].Shipment.Status.Status === "Delivered");

  t = await tool("parse_spoken_budget_and_date", { transcript: "do hazaar ke andar, Diwali se pehle", today: "2026-10-01" });
  ok("budget parses over MCP", t.parsed.budget.max === 2000 && t.parsed.date_basis === "festival_approx", t.parsed.budget);

  t = await tool("pre_debit_notice_send", { user_id: "m1", mandate_id: "SBMD-9", amount: 1499, line_items: [{ title: "Linen shirt", size: "M", price: 1499 }] });
  const mcpNotice = t.parsed.notice_id;
  ok("notice sent over MCP", t.parsed.state === "awaiting_reply");
  t = await tool("pre_debit_notice_status", { notice_id: mcpNotice });
  ok("awaiting_reply -> debit_allowed false", t.parsed.debit_allowed === false);
  await tool("pre_debit_notice_respond", { notice_id: mcpNotice, reply: "haan" });
  t = await tool("pre_debit_notice_status", { notice_id: mcpNotice });
  ok("after yes -> debit_allowed true", t.parsed.debit_allowed === true && t.parsed.state === "approved");

  await tool("record_fit_return_reason", { user_id: "m1", brand: "Zara", garment_type: "shirt", size_ordered: "M", reason_code: "tight_shoulders" });
  t = await tool("record_fit_return_reason", { user_id: "m1", brand: "Zara", garment_type: "shirt", size_ordered: "M", reason_code: "tight_shoulders" });
  ok("two events activate the rule over MCP", t.parsed.learned.rules[0].active === true, t.parsed.learned.rules[0]);
  t = await tool("record_fit_return_reason", { user_id: "m1", brand: "Zara", garment_type: "shirt", size_ordered: "M", reason_code: "made up" });
  ok("bad reason_code rejected over MCP", t.isError === true && t.http === 400);
  t = await tool("get_fit_ledger", { user_id: "m1" });
  ok("ledger readable over MCP", t.parsed.events.length === 2);

  t = await tool("no_such_tool", {});
  ok("unknown tool -> isError, not a crash", t.isError === true);


  console.log("\ncatalogue, shipping cost, cancellation");
  t = await tool("product_search", { category: "shirt", colour: "white", max_price: 1600 });
  ok("search filters by category, colour and price", t.parsed.products.length === 1 && t.parsed.products[0].id === "P102", t.parsed.products.map((x) => x.id));
  ok("search says out loud that it is not personalised", /No personalisation applied/.test(t.parsed.note));
  t = await tool("product_search", { brand: "Fabindia" });
  ok("a hard-rejected brand is still returned by search (the agent must filter)", t.parsed.products.every((x) => x.brand === "Fabindia") && t.parsed.count === 2, t.parsed.count);
  t = await tool("product_search", { category: "shirt" });
  ok("results are price-ascending", t.parsed.products.every((x, i, arr) => i === 0 || arr[i - 1].price <= x.price));
  t = await tool("product_search", { category: "nothing_like_this" });
  ok("no match -> empty list, not an error", t.isError === false && t.parsed.count === 0);

  t = await tool("get_shipping_cost", { destination_pin: "110001", weight_g: 500 });
  ok("base shipping is ₹50 for one slab", t.parsed.charge === 50, t.parsed);
  t = await tool("get_shipping_cost", { destination_pin: "110001", weight_g: 1200, payment_mode: "COD" });
  ok("slabs and COD handling add up", t.parsed.charge === 50 + 2 * 35 + 40, t.parsed.breakdown);
  t = await tool("get_shipping_cost", { destination_pin: "744101", weight_g: 500 });
  ok("ODA adds a surcharge and says so", t.parsed.breakdown.oda === 100 && /Out of delivery area/.test(t.parsed.note));

  t = await tool("delhivery_create_shipment", { order_id: "CAN-1", name: "T", phone: "9", address: "x", pin: "110001", payment_mode: "Prepaid" });
  const canWb = t.parsed.packages[0].waybill;
  t = await tool("delhivery_cancel_shipment", { waybill: canWb });
  ok("cancel works", t.parsed.status === true && t.parsed.cancelled === true, t.parsed);
  t = await tool("delhivery_track_shipment", { waybill: canWb });
  ok("tracking shows Canceled", t.parsed.ShipmentData[0].Shipment.Status.Status === "Canceled");
  t = await tool("delhivery_cancel_shipment", { waybill: canWb });
  ok("double cancel refused", t.parsed.status === false);

  r = await call("GET", "/api/kinko/v1/invoice/charges/.json?d_pin=110001&cgm=500&pt=Pre-paid");
  ok("REST shipping-cost path works too", r.json.charge === 50, r.json);
  r = await call("GET", "/catalogue/search?category=kurta&max_price=2000");
  ok("REST catalogue search works", r.json.count === 1 && r.json.products[0].id === "P105", r.json.count);

  r = await fetch(base + "/mcp");
  ok("GET /mcp -> 405 with Allow: POST", r.status === 405 && (r.headers.get("allow") || "") === "POST");
  r = await call("GET", "/mcp/tools");
  ok("/mcp/tools lists 19 for eyeballing", r.json.count === 19, r.json.count);
  r = await call("GET", "/");
  ok("index still reachable and advertises MCP", r.status === 200 && r.json.mcp.tools === 19, r.json && r.json.mcp);

  console.log("\n" + pass + " passed, " + fail + " failed\n");
  server.close();
  process.exit(fail ? 1 : 0);
})();
