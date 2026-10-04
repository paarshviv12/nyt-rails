/* =====================================================================
   mcp.js — Model Context Protocol server (Streamable HTTP, stateless).

   AgenticOrg registers a custom integration by URL + auth, so the tools
   have to arrive over MCP rather than as plain REST paths. Same logic
   underneath: every handler here calls lib/core.js, so a tool call
   through MCP and a curl against the REST path cannot disagree.

   Stateless by design — no session id, no server-initiated messages —
   because each Vercel invocation is a fresh process. Replies are framed
   as JSON or as SSE depending on the client's Accept header, since MCP
   clients differ on which they demand.
   ===================================================================== */

const core = require("./core.js");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "nyt-rails", title: "Not Your Type — rails", version: "1.0.0" };

const str = (d) => ({ type: "string", description: d });
const num = (d) => ({ type: "number", description: d });
const bool = (d) => ({ type: "boolean", description: d });

const MOCK_ARG = str("Optional. Force a failure for testing: no_rider, low_balance, timeout, malformed, rate_limited, auth_fail, oda.");

/* ------------------------------------------------------------------ */
/* Tool definitions. The description is what the model reads when it    */
/* decides whether to call — so the guardrails live in here too, not    */
/* only in the system prompt.                                          */
/* ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: "delhivery_check_pincode",
    title: "Check pincode serviceability",
    description:
      "Check whether Delhivery delivers to a pincode, whether COD is available, and whether it is out-of-delivery-area (ODA, +2 days). " +
      "Call this BEFORE showing any shortlist. An empty delivery_codes array means NOT serviceable — it is not a success.",
    inputSchema: { type: "object", properties: { pin: str("6-digit Indian pincode."), mock: MOCK_ARG }, required: ["pin"] },
    run: (a) => core.checkPincode({ pin: a.pin, mock: a.mock }),
  },
  {
    name: "delhivery_fetch_waybills",
    title: "Reserve waybills",
    description: "Reserve waybill numbers before creating shipments. Returns a comma-separated string.",
    inputSchema: { type: "object", properties: { count: num("How many, 1–50. Default 1."), mock: MOCK_ARG } },
    run: (a) => core.fetchWaybills({ count: a.count, mock: a.mock }),
  },
  {
    name: "delhivery_create_shipment",
    title: "Create a shipment",
    description:
      "Create one Delhivery shipment. Only call this after a purchase has been approved. " +
      "IMPORTANT: this returns HTTP 200 even when the shipment FAILED — read packages[0].status and packages[0].remarks, " +
      "and never report success on the status code alone. " +
      "(The real API takes a form-encoded body, format=json&data={...}; this connector handles that for you.)",
    inputSchema: {
      type: "object",
      properties: {
        order_id: str("Your order reference."),
        name: str("Consignee name."),
        phone: str("Consignee phone."),
        address: str("Full delivery address."),
        pin: str("Delivery pincode."),
        city: str("City."), state: str("State."),
        payment_mode: { type: "string", enum: ["Prepaid", "COD"], description: "Prepaid or COD." },
        cod_amount: num("Amount to collect, COD only."),
        products_desc: str("What's in the parcel."),
        quantity: num("Item count. Default 1."),
        pickup_location: str("Registered warehouse name. Default 'NYT Warehouse'."),
        waybill: str("Optional pre-reserved waybill."),
        mock: MOCK_ARG,
      },
      required: ["order_id", "name", "phone", "address", "pin", "payment_mode"],
    },
    run: (a) => core.createShipment({
      mock: a.mock,
      payload: {
        pickup_location: { name: a.pickup_location || "NYT Warehouse" },
        shipments: [{
          order: a.order_id, name: a.name, phone: a.phone, add: a.address, pin: a.pin,
          city: a.city, state: a.state, payment_mode: a.payment_mode,
          cod_amount: a.cod_amount, products_desc: a.products_desc,
          quantity: a.quantity, waybill: a.waybill,
        }],
      },
    }),
  },
  {
    name: "delhivery_track_shipment",
    title: "Track a shipment",
    description: "Current status and full scan history for one or more waybills. An empty ShipmentData means the waybill is unknown.",
    inputSchema: { type: "object", properties: { waybill: str("One waybill, or several comma-separated."), ref_ids: str("Or look up by your order reference."), mock: MOCK_ARG } },
    run: (a) => core.trackShipment({ waybill: a.waybill, ref_ids: a.ref_ids, mock: a.mock }),
  },
  {
    name: "delhivery_edit_shipment",
    title: "Edit consignee details",
    description: "Change the consignee name, phone, address or pincode. Refused once the shipment is Delivered.",
    inputSchema: { type: "object", properties: { waybill: str("Waybill to edit."), name: str("New name."), phone: str("New phone."), add: str("New address."), pin: str("New pincode."), mock: MOCK_ARG }, required: ["waybill"] },
    run: (a) => core.editShipment(a),
  },
  {
    name: "delhivery_packing_slip",
    title: "Get packing slip data",
    description: "Packing slip fields for one or more waybills.",
    inputSchema: { type: "object", properties: { wbns: str("Waybills, comma-separated."), mock: MOCK_ARG }, required: ["wbns"] },
    run: (a) => core.packingSlip(a),
  },
  {
    name: "delhivery_ndr_action",
    title: "Act on a failed delivery",
    description:
      "Tell Delhivery what to do about an undelivered parcel: RE-ATTEMPT, DEFER_DLV, EDIT_DETAILS or RTO. " +
      "Only valid while the shipment is in an NDR state (status 'Undelivered'). Ask the human before choosing RTO — that ends the order.",
    inputSchema: {
      type: "object",
      properties: { waybill: str("Waybill in NDR."), act: { type: "string", enum: core.NDR_ACTS, description: "Action to take." }, mock: MOCK_ARG },
      required: ["waybill", "act"],
    },
    run: (a) => core.ndrAction({ data: [{ waybill: a.waybill, act: a.act }], mock: a.mock }),
  },
  {
    name: "delhivery_ndr_status",
    title: "Check an NDR request",
    description: "Status of an NDR action you raised earlier, by request_id.",
    inputSchema: { type: "object", properties: { request_id: str("request_id from delhivery_ndr_action.") }, required: ["request_id"] },
    run: (a) => core.ndrStatus(a),
  },

  {
    name: "delhivery_cancel_shipment",
    title: "Cancel a shipment",
    description: "Cancel a shipment that has not been delivered. Irreversible — confirm with the human first, and start a refund if they have already been charged.",
    inputSchema: { type: "object", properties: { waybill: str("Waybill to cancel."), mock: MOCK_ARG }, required: ["waybill"] },
    run: (a) => core.editShipment({ waybill: a.waybill, cancellation: true, mock: a.mock }),
  },
  {
    name: "get_shipping_cost",
    title: "Quote the delivery charge",
    description:
      "What delivery will cost, by weight, distance, ODA surcharge and COD handling. " +
      "Add this to the item price BEFORE sending a pre-debit notice — the total on the notice is what you may spend, " +
      "so a shipping charge discovered afterwards means you spent more than they approved.",
    inputSchema: {
      type: "object",
      properties: { origin_pin: str("Warehouse pincode."), destination_pin: str("Delivery pincode."), weight_g: num("Weight in grams. Default 500."), payment_mode: { type: "string", enum: ["Pre-paid", "COD"], description: "Pre-paid or COD." }, mock: MOCK_ARG },
      required: ["destination_pin"],
    },
    run: (a) => core.shippingCost(a),
  },
  {
    name: "product_search",
    title: "Search the catalogue",
    description:
      "Find candidate items by category, colour, brand, fabric, size and price. " +
      "This search knows NOTHING about the user. It will happily return a brand they have already rejected twice. " +
      "Always call get_fit_ledger first and remove the hard_rejects from these results yourself — the personalisation " +
      "is your job, not the catalogue's. Filters describe products; they have never described people.",
    inputSchema: {
      type: "object",
      properties: {
        category: str("shirt, kurta, trousers, hoodie, sweater."),
        colour: str("Colour."), brand: str("Brand."), fabric: str("Fabric, partial match."),
        size: str("Only items offered in this size."),
        min_price: num("Floor in INR."), max_price: num("Ceiling in INR — use the budget from parse_spoken_budget_and_date."),
        mock: MOCK_ARG,
      },
    },
    run: (a) => core.productSearch(a),
  },

  /* ---- the three capabilities no rail provides ---- */
  {
    name: "parse_spoken_budget_and_date",
    title: "Turn speech into a budget and a date",
    description:
      "Convert a spoken request into a numeric budget and a calendar date. Handles English and Hinglish — 'under 2000', '2.5k', " +
      "'do hazaar ke andar', 'paanch sau', 'one lakh', and 'kal', 'parso', 'next Friday', 'in 2 weeks', 'before Diwali'. " +
      "Call this on every voice request before searching. " +
      "If unresolved[] is non-empty, ASK the clarifying_question — do not invent a budget or a date. " +
      "If confidence is not 'high', confirm your reading with the human in plain words before spending anything.",
    inputSchema: {
      type: "object",
      properties: { transcript: str("The user's words, as transcribed."), language: str("BCP-47 tag, e.g. hi-IN. Default en-IN."), today: str("YYYY-MM-DD to resolve relative dates against. Defaults to now.") },
      required: ["transcript"],
    },
    run: (a) => core.parseSpoken(a),
  },
  {
    name: "pre_debit_notice_send",
    title: "Tell the human before spending",
    description:
      "Send an itemised notice of what you are about to buy, and wait for a reply. This is the consent gate: " +
      "you may NOT call a Pine Labs debit until pre_debit_notice_status returns debit_allowed = true. " +
      "Sending this notice is not permission — the reply is.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: str("Who is being charged."),
        mandate_id: str("The Pine Labs SBMD mandate this would debit."),
        amount: num("Total in INR. Must equal the sum of line_items."),
        line_items: { type: "array", description: "What's in the basket.", items: { type: "object", properties: { title: str("Item name."), size: str("Size."), price: num("Price in INR."), brand: str("Brand.") }, required: ["title", "price"] } },
        notice_hours: num("Hours to wait before the debit window opens. Default 24."),
        channel: { type: "string", enum: ["whatsapp", "telegram", "email"], description: "Where to send it. Default whatsapp." },
        mock: MOCK_ARG,
      },
      required: ["user_id", "mandate_id", "amount", "line_items"],
    },
    run: (a) => core.preDebitNotice(a),
  },
  {
    name: "pre_debit_notice_status",
    title: "Check whether you may spend",
    description:
      "Read the consent state of a notice. debit_allowed is true in exactly ONE state: 'approved'. " +
      "'awaiting_reply', 'unparsed', 'declined', 'revision_requested' and 'expired_no_reply' all mean DO NOT DEBIT. " +
      "Silence is not consent, and neither is a reply you could not read.",
    inputSchema: { type: "object", properties: { notice_id: str("notice_id from pre_debit_notice_send.") }, required: ["notice_id"] },
    run: (a) => core.preDebitGet(a),
  },
  {
    name: "pre_debit_notice_respond",
    title: "Record the human's reply",
    description:
      "Record the reply to a notice. Reads yes/no in English and Hinglish (yes, haan, theek / no, nahi, rehne do / change). " +
      "Anything it cannot read becomes 'unparsed' and does NOT allow a debit.",
    inputSchema: { type: "object", properties: { notice_id: str("notice_id."), reply: str("Exactly what the human said.") }, required: ["notice_id", "reply"] },
    run: (a) => core.preDebitRespond(a),
  },
  {
    name: "record_fit_return_reason",
    title: "Record why something didn't fit",
    description:
      "Write a return into the fit ledger — the thing no rail stores: which body, which garment, what went wrong. " +
      "Ask the human a closed question and map the answer to a reason_code; never put free prose in reason_code. " +
      "Returns 'learned' — the size rules and hard rejects to apply from now on. A rule only activates after TWO matching " +
      "events, because one return is noise.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: str("Whose ledger."),
        brand: str("Brand of the returned item."),
        garment_type: str("shirt, kurta, trousers, dress…"),
        size_ordered: str("The size that was sent."),
        reason_code: { type: "string", enum: Object.keys(core.REASONS), description: "Closed taxonomy. Pick the closest; use changed_mind when it is not a fit problem." },
        kept: bool("True if the item was kept despite the complaint."),
        free_text: str("Their own words, stored but never ranked on."),
        waybill: str("Waybill, if known."), order_id: str("Order reference, if known."),
        body: { type: "object", description: "Measurements in cm, if known.", properties: { shoulder_cm: num("Shoulder"), chest_cm: num("Chest"), waist_cm: num("Waist"), hip_cm: num("Hip"), height_cm: num("Height") } },
        mock: MOCK_ARG,
      },
      required: ["user_id", "brand", "garment_type", "size_ordered", "reason_code"],
    },
    run: (a) => core.recordFit(a),
  },
  {
    name: "get_fit_ledger",
    title: "Read what past returns taught",
    description:
      "Read a user's fit history and the rules derived from it. Call this BEFORE ranking a shortlist. " +
      "hard_rejects are Tier 1 — remove those items entirely, do not merely rank them lower. " +
      "Only rules with active = true should change a size.",
    inputSchema: { type: "object", properties: { user_id: str("Whose ledger.") }, required: ["user_id"] },
    run: (a) => core.getLedger(a),
  },

  /* ---- demo control ---- */
  {
    name: "mock_advance_shipment",
    title: "Move a parcel (demo only)",
    description: "Testing only — force a shipment to a new status so a delivery, NDR or RTO can be shown on demand. Never call this in a real conversation with a user.",
    inputSchema: {
      type: "object",
      properties: { waybill: str("Waybill to move."), to: { type: "string", enum: Object.keys(core.STATE), description: "Target status." }, instructions: str("Optional scan note."), received_by: str("Who received it, for Delivered.") },
      required: ["waybill", "to"],
    },
    run: (a) => core.advance(a),
  },
  {
    name: "mock_reset",
    title: "Clear all mock state (demo only)",
    description: "Testing only — wipe shipments, notices and ledgers for a clean recorded run.",
    inputSchema: { type: "object", properties: {} },
    run: () => core.reset(),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const publicTools = () => TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));

/* ------------------------------------------------------------------ */
/* JSON-RPC                                                            */
/* ------------------------------------------------------------------ */
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };

  let r;
  try { r = await tool.run(args || {}); }
  catch (e) { return { content: [{ type: "text", text: "Tool threw: " + (e && e.message ? e.message : String(e)) }], isError: true }; }

  // The HTTP status is surfaced in the text so the agent reasons about the
  // same failures a REST caller would see — including the 200-that-failed.
  const text = r.raw !== undefined ? r.raw : JSON.stringify(r.body, null, 2);
  return { content: [{ type: "text", text: "HTTP " + r.status + "\n" + text }], isError: r.status >= 400 };
}

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { response: error(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid Request") };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return { response: result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Rails for a voice shopping agent. Check serviceability before showing a shortlist. " +
          "Read the fit ledger before ranking. Never debit unless pre_debit_notice_status says debit_allowed is true.",
      }) };

    case "notifications/initialized":
    case "initialized":
      return { response: null };            // notification: no reply

    case "ping":
      return { response: result(id, {}) };

    case "tools/list":
      return { response: result(id, { tools: publicTools() }) };

    case "tools/call": {
      const name = params && params.name;
      if (!name) return { response: error(id, -32602, "params.name is required") };
      return { response: result(id, await callTool(name, params && params.arguments)) };
    }

    case "resources/list":  return { response: result(id, { resources: [] }) };
    case "prompts/list":    return { response: result(id, { prompts: [] }) };

    default:
      if (isNotification) return { response: null };
      return { response: error(id, -32601, "Method not found: " + method) };
  }
}

/* ------------------------------------------------------------------ */
/* Express handler. Accepts a single message or a batch, and answers    */
/* in JSON or SSE framing depending on Accept — MCP clients differ.     */
/* ------------------------------------------------------------------ */
function mountMcp(app, paths) {
  const handler = async (req, res) => {
    let msg = req.body;
    if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch { return res.status(400).json(error(null, -32700, "Parse error")); } }

    const wantsSse = /text\/event-stream/i.test(req.get("Accept") || "");
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = [];
    for (const m of batch) {
      const { response } = await handleRpc(m);
      if (response) out.push(response);
    }

    if (!out.length) return res.status(202).end();          // notifications only
    const payload = Array.isArray(msg) ? out : out[0];

    if (wantsSse) {
      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write("event: message\ndata: " + JSON.stringify(payload) + "\n\n");
      return res.end();
    }
    res.status(200).json(payload);
  };

  for (const p of paths) {
    app.post(p, handler);
    if (p === "/") continue;              // GET / is the human-readable index
    // Spec-correct answer for a stateless server with no server-initiated
    // messages. Some clients probe GET first; a clean 405 lets them fall
    // back to POST instead of hanging.
    app.get(p, (req, res) => res.status(405).set("Allow", "POST").json(error(null, -32000, "This MCP server is stateless; use POST.")));
    app.delete(p, (req, res) => res.status(405).set("Allow", "POST").json(error(null, -32000, "No sessions to terminate.")));
  }
}

module.exports = { mountMcp, handleRpc, callTool, publicTools, TOOLS, PROTOCOL_VERSION, SERVER_INFO };
