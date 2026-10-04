/* =====================================================================
   core.js — all the logic, transport-free.
   Both the REST routes and the MCP server call these. One behaviour,
   two front doors, so what the agent sees through MCP is exactly what
   a curl against the REST path shows.
   Every op returns { status, body } or { status, raw, type }.
   ===================================================================== */

const DB = {
  waybills: new Map(),
  issued: new Set(),
  notices: new Map(),
  ledger: new Map(),
  ndr: new Map(),
};

const SCENARIOS = ["ok", "no_rider", "low_balance", "timeout", "malformed", "rate_limited", "auth_fail", "oda"];

const PIN_SCENARIO = {
  "110001": "ok", "400001": "ok", "560001": "ok",
  "190001": "no_cod",
  "744101": "oda",
  "799001": "no_rider", "999999": "no_rider",
  "100000": "timeout", "100001": "malformed", "100002": "rate_limited", "100003": "low_balance",
};

function resolveScenario(forced, pin) {
  if (forced && SCENARIOS.includes(String(forced))) return String(forced);
  if (pin && PIN_SCENARIO[String(pin)]) return PIN_SCENARIO[String(pin)];
  return "ok";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Returns a response when the scenario is a failure, else null. */
async function failureResponse(scenario, delayMs) {
  switch (scenario) {
    case "timeout": {
      await sleep(Math.min(Number(delayMs) || 6000, 8000));
      return { status: 504, body: { success: false, rmk: "Upstream timed out", error: "GatewayTimeout" } };
    }
    case "malformed":
      return { status: 200, type: "application/json", raw: '{"success": true, "packages": [{"waybill": "13401110000' };
    case "rate_limited":
      return { status: 429, headers: { "Retry-After": "30" }, body: { success: false, rmk: "Too many requests", error: "RateLimited" } };
    case "auth_fail":
      return { status: 401, body: { success: false, rmk: "Invalid token", error: "Unauthorized" } };
    case "low_balance":
      return { status: 200, body: { success: false, rmk: "Insufficient balance in client account", error: "InsufficientBalance", package_count: 0, packages: [] } };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
let wbCounter = 13401110000001;
const nextWaybill = () => String(wbCounter++);
const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function scan(status, type, location, instructions) {
  return { ScanDetail: { Scan: status, ScanType: type, ScanDateTime: nowIso(), ScannedLocation: location, Instructions: instructions || "", StatusDateTime: nowIso() } };
}

const SORT = { "110001": "DEL/XYZ", "400001": "BOM/ABC", "560001": "BLR/PQR", "190001": "SXR/AAA", "744101": "IXZ/ODA" };
const DISTRICT = { "110001": ["New Delhi", "DL"], "400001": ["Mumbai", "MH"], "560001": ["Bengaluru", "KA"], "190001": ["Srinagar", "JK"], "744101": ["South Andaman", "AN"] };

/* ==================================================================== */
/*  Delhivery ops                                                       */
/* ==================================================================== */

async function checkPincode(a = {}) {
  const pin = String(a.pin || "").trim();
  const s = resolveScenario(a.mock, pin);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  if (!pin) return { status: 400, body: { delivery_codes: [], error: "pin is required" } };
  if (s === "no_rider") return { status: 200, body: { delivery_codes: [] } };

  const oda = s === "oda";
  const [district, state] = DISTRICT[pin] || ["Unknown", "XX"];
  return { status: 200, body: { delivery_codes: [{ postal_code: {
    pin: Number(pin), district, state_code: state, country_code: "IN",
    sort_code: SORT[pin] || "DEL/GEN", inc: "", max_amount: 50000, max_weight: 10000,
    is_oda: oda ? "Y" : "N", pre_paid: "Y",
    cash: s === "no_cod" ? "N" : "Y", cod: s === "no_cod" ? "N" : "Y",
    pickup: "Y", repl: "Y",
    remarks: oda ? "ODA — add 2 days to TAT" : "",
    center: [{ cn: "Mock_Hub_D", code: (SORT[pin] || "DEL/GEN").split("/")[0], sort_code: SORT[pin] || "DEL/GEN", ud: "Y", cod: s === "no_cod" ? "N" : "Y" }],
  } }] } };
}

async function fetchWaybills(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const count = Math.min(Math.max(Number(a.count) || 1, 1), 50);
  const list = [];
  for (let i = 0; i < count; i++) { const w = nextWaybill(); DB.issued.add(w); list.push(w); }
  return { status: 200, type: "application/json", raw: JSON.stringify(list.join(",")) };
}

const REQUIRED = ["order", "pin", "phone", "add", "name", "payment_mode"];

async function createShipment(a = {}) {
  const payload = a.payload || {};
  const shipments = Array.isArray(payload.shipments) ? payload.shipments : [];
  const pickup = payload.pickup_location && payload.pickup_location.name;
  const s = resolveScenario(a.mock, shipments[0] && shipments[0].pin);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;

  if (!pickup) return { status: 200, body: { success: false, package_count: 0, packages: [], rmk: "ClientWarehouse matching query does not exist." } };

  const out = shipments.map((sh) => {
    const missing = REQUIRED.filter((k) => sh[k] === undefined || sh[k] === null || sh[k] === "");
    if (missing.length) return { client: pickup, refnum: sh.order || "", status: "Fail", waybill: "", remarks: ["Mandatory field(s) missing: " + missing.join(", ")], serviceable: false, sort_code: "" };

    const pinScn = resolveScenario(a.mock, sh.pin);
    if (pinScn === "no_rider") return { client: pickup, refnum: sh.order, status: "Fail", waybill: "", remarks: ["Pincode " + sh.pin + " is not serviceable"], serviceable: false, sort_code: "" };
    if (pinScn === "no_cod" && String(sh.payment_mode).toUpperCase() === "COD") return { client: pickup, refnum: sh.order, status: "Fail", waybill: "", remarks: ["COD is not available for pincode " + sh.pin], serviceable: true, sort_code: SORT[sh.pin] || "" };

    const waybill = sh.waybill && String(sh.waybill).trim() ? String(sh.waybill).trim() : nextWaybill();
    const eta = new Date(Date.now() + (pinScn === "oda" ? 6 : 4) * 864e5);

    DB.waybills.set(waybill, {
      waybill, refnum: sh.order,
      order_type: String(sh.payment_mode).toUpperCase() === "COD" ? "COD" : "Pre-paid",
      cod_amount: Number(sh.cod_amount || 0),
      consignee: { name: sh.name, phone: sh.phone, address: sh.add, pin: String(sh.pin), city: sh.city || "", state: sh.state || "" },
      pickup_location: pickup,
      promised_date: eta.toISOString().slice(0, 10),
      status: { Status: "Manifested", StatusType: "UD", StatusLocation: (SORT[sh.pin] || "DEL/GEN").split("/")[0], Instructions: "Shipment created" },
      scans: [scan("Manifested", "UD", pickup, "Shipment created")],
      created_at: new Date().toISOString(),
      products: sh.products_desc || "", quantity: Number(sh.quantity || 1),
    });

    return { client: pickup, refnum: sh.order, status: "Success", waybill, remarks: [], serviceable: true,
             sort_code: SORT[sh.pin] || "DEL/GEN", cod_amount: Number(sh.cod_amount || 0), payment: String(sh.payment_mode).toUpperCase() };
  });

  const ok = out.filter((p) => p.status === "Success").length;
  return { status: 200, body: {
    success: ok > 0, package_count: out.length, packages: out,
    cash_pickups_count: out.filter((p) => p.payment === "COD").length,
    cash_pickups: 0, pickups_count: 0, replacement_count: 0,
    upload_wbn: "UPL" + Date.now(),
    rmk: ok === out.length ? "" : "Some shipments failed; see packages[].remarks",
  } };
}

async function trackShipment(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;

  const wbs = String(a.waybill || "").split(",").map((x) => x.trim()).filter(Boolean);
  const refs = String(a.ref_ids || "").split(",").map((x) => x.trim()).filter(Boolean);
  let found = wbs.map((w) => DB.waybills.get(w)).filter(Boolean);
  if (refs.length) found = found.concat([...DB.waybills.values()].filter((sh) => refs.includes(String(sh.refnum))));

  return { status: 200, body: { ShipmentData: found.map((sh) => ({ Shipment: {
    AWB: sh.waybill, ReferenceNo: sh.refnum, OrderType: sh.order_type, CODAmount: sh.cod_amount,
    PromisedDeliveryDate: sh.promised_date, ExpectedDeliveryDate: sh.promised_date,
    Origin: sh.pickup_location, Destination: sh.consignee.city || sh.consignee.pin,
    Consignee: { Name: sh.consignee.name, City: sh.consignee.city, PinCode: Number(sh.consignee.pin), State: sh.consignee.state, Country: "India" },
    Status: { Status: sh.status.Status, StatusType: sh.status.StatusType, StatusLocation: sh.status.StatusLocation, StatusDateTime: nowIso(), Instructions: sh.status.Instructions, RecievedBy: sh.status.RecievedBy || "" },
    Scans: sh.scans, Quantity: String(sh.quantity),
  } })) } };
}

async function editShipment(a = {}) {
  const s = resolveScenario(a.mock, a.pin);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const sh = DB.waybills.get(String(a.waybill || ""));
  if (!sh) return { status: 200, body: { status: false, remark: ["Waybill not found"] } };
  if (["Delivered", "RTO Delivered"].includes(sh.status.Status)) return { status: 200, body: { status: false, remark: ["Shipment already " + sh.status.Status + "; cannot edit"] } };

  // Cancellation rides on the same endpoint, as it does at Delhivery.
  if (a.cancellation === true || String(a.cancellation) === "true") {
    if (sh.status.Status === "Canceled") return { status: 200, body: { status: false, remark: ["Already cancelled"], waybill: sh.waybill } };
    sh.status = { Status: "Canceled", StatusType: "CN", StatusLocation: sh.status.StatusLocation, Instructions: "Shipment cancelled by client" };
    sh.scans.push(scan("Canceled", "CN", sh.status.StatusLocation, "Shipment cancelled by client"));
    return { status: 200, body: { status: true, remark: [], waybill: sh.waybill, cancelled: true } };
  }

  if (a.name) sh.consignee.name = a.name;
  if (a.phone) sh.consignee.phone = a.phone;
  if (a.add) sh.consignee.address = a.add;
  if (a.pin) sh.consignee.pin = String(a.pin);
  sh.scans.push(scan("Address updated", "UD", sh.status.StatusLocation, "Consignee details edited by client"));
  return { status: 200, body: { status: true, remark: [], waybill: sh.waybill } };
}

async function packingSlip(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const wbs = String(a.wbns || "").split(",").map((x) => x.trim()).filter(Boolean);
  const pkgs = wbs.map((w) => DB.waybills.get(w)).filter(Boolean).map((sh) => ({
    wbn: sh.waybill, order_id: sh.refnum, pt: sh.order_type, cod_amount: sh.cod_amount,
    destination: sh.consignee.pin, sort_code: SORT[sh.consignee.pin] || "DEL/GEN",
    barcode: "https://mock.invalid/barcode/" + sh.waybill + ".png",
    consignee: sh.consignee, products: sh.products,
  }));
  return { status: 200, body: { packages_found: pkgs.length, packages: pkgs } };
}

const NDR_ACTS = ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS", "RTO"];

async function ndrAction(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const rows = Array.isArray(a.data) ? a.data : [];
  if (!rows.length) return { status: 400, body: { status: false, remark: ["data[] is required"] } };

  const request_id = "NDR" + Date.now();
  const results = rows.map((r) => {
    const sh = DB.waybills.get(String(r.waybill || ""));
    if (!sh) return { waybill: r.waybill, status: "Fail", remark: "Waybill not found" };
    if (sh.status.StatusType !== "UD" || sh.status.Status !== "Undelivered") return { waybill: r.waybill, status: "Fail", remark: "Shipment is not in an NDR state" };
    const act = String(r.act || "").toUpperCase();
    if (!NDR_ACTS.includes(act)) return { waybill: r.waybill, status: "Fail", remark: "act must be one of " + NDR_ACTS.join(", ") };
    if (act === "RE-ATTEMPT") {
      sh.status = { Status: "In Transit", StatusType: "UD", StatusLocation: sh.status.StatusLocation, Instructions: "Re-attempt scheduled" };
      sh.scans.push(scan("In Transit", "UD", sh.status.StatusLocation, "Re-attempt scheduled on client request"));
    } else if (act === "RTO") {
      sh.status = { Status: "RTO In Transit", StatusType: "RT", StatusLocation: sh.status.StatusLocation, Instructions: "Return to origin" };
      sh.scans.push(scan("RTO In Transit", "RT", sh.status.StatusLocation, "RTO initiated on client request"));
    } else {
      sh.scans.push(scan("In Transit", "UD", sh.status.StatusLocation, act + " accepted"));
    }
    return { waybill: r.waybill, status: "Success", remark: act + " accepted" };
  });

  DB.ndr.set(request_id, { request_id, received_at: new Date().toISOString(), results });
  return { status: 200, body: { request_id, status: results.every((r) => r.status === "Success"), data: results } };
}

async function ndrStatus(a = {}) {
  const r = DB.ndr.get(String(a.request_id || ""));
  if (!r) return { status: 404, body: { status: false, remark: ["Unknown request_id"] } };
  return { status: 200, body: r };
}

/* ==================================================================== */
/*  GAP 1 — spoken budget and date                                      */
/* ==================================================================== */
const HI_NUM = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, pandrah: 15, bees: 20, pachees: 25,
  tees: 30, chalees: 40, pachas: 50, sau: 100, adha: 0.5, dhai: 2.5, dedh: 1.5, sava: 1.25,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, half: 0.5,
};
const NUM_WORDS = Object.keys(HI_NUM).sort((x, y) => y.length - x.length).join("|");
const MULT = { k: 1e3, thousand: 1e3, hazaar: 1e3, hazar: 1e3, hajar: 1e3, hzr: 1e3, lakh: 1e5, lac: 1e5, lakhs: 1e5, sau: 1e2, hundred: 1e2, crore: 1e7 };
const MULT_WORDS = Object.keys(MULT).sort((x, y) => y.length - x.length).join("|");
const FEST = { diwali: "11-08", deepavali: "11-08", holi: "03-04", rakhi: "08-09", raksha: "08-09", onam: "09-02", pongal: "01-15", eid: "03-20", navratri: "10-12", dussehra: "10-20", christmas: "12-25", "new year": "01-01" };
const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, somvaar: 1, mangalvaar: 2, budhvaar: 3, guruvaar: 4, shukravaar: 5, shanivaar: 6, ravivaar: 0 };

function parseBudget(t) {
  const s = t.toLowerCase().replace(/,/g, "");
  const range = s.match(/(?:between\s+)?(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|thousand|hazaar|hazar|lakh|lac)?\s*(?:-|to|se|and|aur)\s*(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|thousand|hazaar|hazar|lakh|lac)?/);
  if (range) {
    const u2 = MULT[range[4]] || 1, u1 = MULT[range[2]] || u2;
    return { min: Math.round(Number(range[1]) * u1), max: Math.round(Number(range[3]) * u2), basis: "range" };
  }
  const num = s.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|thousand|hazaar|hazar|hajar|lakh|lac|crore|sau|hundred)?/);
  let value = num ? Math.round(Number(num[1]) * (MULT[num[2]] || 1)) : null;
  if (value === null) {
    // The multiplier is required: a bare "a" or "three" in ordinary speech
    // ("a nice shirt") is not a budget, and guessing one is worse than asking.
    const w = s.match(new RegExp("\\b(" + NUM_WORDS + ")\\s+(" + MULT_WORDS + ")\\b"));
    if (w) value = Math.round(HI_NUM[w[1]] * MULT[w[2]]);
  }
  if (value === null) return { min: null, max: null, basis: "not_found" };
  const upper = /(under|below|less than|within|upto|up to|max|maximum|se kam|tak|ke andar|niche)/.test(s);
  const lower = /(above|over|more than|at least|minimum|se zyada|se upar)/.test(s);
  const around = /(around|about|roughly|approx|near|ke aas paas|jitna)/.test(s);
  if (lower) return { min: value, max: null, basis: "floor" };
  if (around) return { min: Math.round(value * 0.85), max: Math.round(value * 1.15), basis: "approx" };
  return { min: null, max: value, basis: upper ? "ceiling" : "ceiling_implied" };
}

function parseDate(t, todayStr) {
  const s = t.toLowerCase();
  const today = todayStr ? new Date(todayStr + "T00:00:00Z") : new Date();
  const d0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const out = (d, basis, text) => ({ deliver_by: d.toISOString().slice(0, 10), basis, matched: text });

  if (/\b(today|aaj)\b/.test(s)) return out(d0, "explicit_day", "today");
  if (/\b(tomorrow|kal)\b/.test(s)) return out(new Date(+d0 + 864e5), "explicit_day", "tomorrow");
  if (/\b(day after tomorrow|parso)\b/.test(s)) return out(new Date(+d0 + 2 * 864e5), "explicit_day", "day after tomorrow");

  const rel = s.match(/(?:in|within|next|agle)\s+(\d+|a|ek|do|teen)\s*(day|days|din|week|weeks|hafte|hafta|month|months|mahine)/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : (HI_NUM[rel[1]] || 1);
    const days = /week|hafte|hafta/.test(rel[2]) ? n * 7 : /month|mahine/.test(rel[2]) ? n * 30 : n;
    return out(new Date(+d0 + days * 864e5), "relative", rel[0]);
  }

  const dowM = s.match(new RegExp("(this|next|agle)?\\s*(" + Object.keys(DOW).join("|") + ")"));
  if (dowM) {
    const target = DOW[dowM[2]];
    let delta = (target - d0.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (/next|agle/.test(dowM[1] || "")) delta += 7;
    return out(new Date(+d0 + delta * 864e5), "weekday", dowM[0].trim());
  }

  for (const key of Object.keys(FEST)) {
    if (s.includes(key)) {
      const [mm, dd] = FEST[key].split("-").map(Number);
      const y = d0.getUTCFullYear();
      let d = new Date(Date.UTC(y, mm - 1, dd));
      if (d < d0) d = new Date(Date.UTC(y + 1, mm - 1, dd));
      return out(d, "festival_approx", key);
    }
  }

  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const dm = s.match(new RegExp("(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + months.join("|") + ")"));
  if (dm) {
    const mi = months.indexOf(dm[2]);
    const y = d0.getUTCFullYear();
    let d = new Date(Date.UTC(y, mi, Number(dm[1])));
    if (d < d0) d = new Date(Date.UTC(y + 1, mi, Number(dm[1])));
    return out(d, "explicit_date", dm[0]);
  }
  return { deliver_by: null, basis: "not_found", matched: null };
}

async function parseSpoken(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const transcript = String(a.transcript || "").trim();
  if (!transcript) return { status: 400, body: { ok: false, error: "transcript is required" } };

  const budget = parseBudget(transcript);
  const date = parseDate(transcript, a.today);
  const unresolved = [];
  if (budget.basis === "not_found") unresolved.push("budget");
  if (date.basis === "not_found") unresolved.push("deliver_by");
  const soft = date.basis === "festival_approx" || budget.basis === "approx" || budget.basis === "ceiling_implied";

  return { status: 200, body: {
    ok: true, transcript, language: a.language || "en-IN",
    budget: { min: budget.min, max: budget.max, currency: "INR", basis: budget.basis },
    deliver_by: date.deliver_by, date_basis: date.basis, date_matched: date.matched,
    confidence: unresolved.length ? "low" : soft ? "medium" : "high",
    unresolved,
    clarifying_question: unresolved.length
      ? (unresolved.includes("budget") && unresolved.includes("deliver_by") ? "What's your budget, and by when do you need it?"
        : unresolved.includes("budget") ? "What's the most you want to spend?" : "By when do you need it?")
      : null,
  } };
}

/* ==================================================================== */
/*  GAP 2 — pre-debit notice                                            */
/* ==================================================================== */
async function preDebitNotice(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;

  const need = ["user_id", "amount", "mandate_id", "line_items"];
  const missing = need.filter((k) => a[k] === undefined || a[k] === null || a[k] === "");
  if (missing.length) return { status: 400, body: { ok: false, error: "missing: " + missing.join(", ") } };

  const hours = Number(a.notice_hours || 24);
  const deadline = new Date(Date.now() + hours * 36e5);
  const items = Array.isArray(a.line_items) ? a.line_items : [];
  const notice = {
    notice_id: "PDN" + Date.now(),
    user_id: String(a.user_id), mandate_id: String(a.mandate_id),
    amount: Number(a.amount), currency: "INR", line_items: a.line_items,
    channel: a.channel || "whatsapp",
    sent_at: new Date().toISOString(),
    debit_not_before: deadline.toISOString(),
    state: "awaiting_reply", reply: null, replied_at: null,
    message:
      "Not Your Type — before I buy\n" +
      (items.length ? items.map((i) => "• " + (i.title || i.name) + (i.size ? " (size " + i.size + ")" : "") + " — ₹" + i.price).join("\n") : String(a.line_items)) +
      "\nTotal ₹" + Number(a.amount) +
      "\nI'll place this after " + deadline.toISOString().slice(0, 16).replace("T", " ") +
      " IST unless you say no.\nReply YES to go ahead, NO to drop it, or CHANGE to pick something else.",
  };
  DB.notices.set(notice.notice_id, notice);
  return { status: 200, body: { ok: true, ...notice } };
}

async function preDebitRespond(a = {}) {
  const n = DB.notices.get(String(a.notice_id || ""));
  if (!n) return { status: 404, body: { ok: false, error: "Unknown notice_id" } };
  if (n.state !== "awaiting_reply") return { status: 409, body: { ok: false, error: "Notice already " + n.state, state: n.state } };

  const raw = String(a.reply || "").trim().toLowerCase();
  const yes = /^(y|yes|haan|han|ha|ok|okay|go|go ahead|sure|theek|thik|kar do|buy)$/.test(raw);
  const no = /^(n|no|nahi|nah|stop|cancel|don'?t|mat karo|rehne do)$/.test(raw);
  const change = /^(change|alag|dusra|other|different|edit)$/.test(raw);

  n.reply = raw; n.replied_at = new Date().toISOString();
  n.state = yes ? "approved" : no ? "declined" : change ? "revision_requested" : "unparsed";
  return { status: 200, body: {
    ok: true, notice_id: n.notice_id, state: n.state,
    debit_allowed: n.state === "approved",
    next: n.state === "approved" ? "call Pine Labs SBMD debit"
      : n.state === "declined" ? "abandon cart, keep the shortlist"
      : n.state === "revision_requested" ? "re-open the shortlist with the human"
      : "ask again in plain words; do not debit",
  } };
}

async function preDebitExpire(a = {}) {
  const n = DB.notices.get(String(a.notice_id || ""));
  if (!n) return { status: 404, body: { ok: false, error: "Unknown notice_id" } };
  if (n.state !== "awaiting_reply") return { status: 200, body: { ok: true, state: n.state, debit_allowed: n.state === "approved" } };
  n.state = "expired_no_reply";
  return { status: 200, body: { ok: true, notice_id: n.notice_id, state: n.state, debit_allowed: false, next: "silence is not consent — do not debit; ask again once" } };
}

async function preDebitGet(a = {}) {
  const n = DB.notices.get(String(a.notice_id || ""));
  if (!n) return { status: 404, body: { ok: false, error: "Unknown notice_id" } };
  return { status: 200, body: { ok: true, ...n, debit_allowed: n.state === "approved" } };
}

/* ==================================================================== */
/*  GAP 3 — fit-and-returns ledger                                      */
/* ==================================================================== */
const REASONS = {
  tight_shoulders: { part: "shoulder", dir: "up" },
  tight_chest: { part: "chest", dir: "up" },
  tight_waist: { part: "waist", dir: "up" },
  tight_hips: { part: "hip", dir: "up" },
  loose_overall: { part: "overall", dir: "down" },
  loose_waist: { part: "waist", dir: "down" },
  sleeve_long: { part: "sleeve", dir: "shorter" },
  sleeve_short: { part: "sleeve", dir: "longer" },
  length_short: { part: "length", dir: "longer" },
  length_long: { part: "length", dir: "shorter" },
  fabric_thin: { part: "fabric", dir: "avoid" },
  fabric_itchy: { part: "fabric", dir: "avoid" },
  colour_off: { part: "colour", dir: "avoid" },
  not_as_pictured: { part: "trust", dir: "avoid" },
  changed_mind: { part: null, dir: null },
};

async function recordFit(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;
  const need = ["user_id", "brand", "garment_type", "size_ordered", "reason_code"];
  const missing = need.filter((k) => !a[k]);
  if (missing.length) return { status: 400, body: { ok: false, error: "missing: " + missing.join(", ") } };
  if (!REASONS[a.reason_code]) return { status: 400, body: { ok: false, error: "reason_code must be one of " + Object.keys(REASONS).join(", ") } };

  const event = {
    event_id: "FIT" + Date.now(),
    user_id: String(a.user_id), waybill: a.waybill || null, order_id: a.order_id || null,
    brand: String(a.brand), garment_type: String(a.garment_type), size_ordered: String(a.size_ordered),
    kept: !!a.kept, reason_code: a.reason_code, free_text: a.free_text || null, body: a.body || null,
    recorded_at: new Date().toISOString(), source: a.source || "agent_followup",
  };
  const list = DB.ledger.get(event.user_id) || [];
  list.push(event);
  DB.ledger.set(event.user_id, list);
  return { status: 200, body: { ok: true, event_id: event.event_id, learned: derive(list), events_for_user: list.length } };
}

async function getLedger(a = {}) {
  const list = DB.ledger.get(String(a.user_id || "")) || [];
  return { status: 200, body: { ok: true, user_id: a.user_id, events: list, learned: derive(list) } };
}

/* Two events for the same brand+garment+part before a rule fires —
   one return is noise. */
function derive(list) {
  const byKey = new Map(), avoidFabric = new Map(), avoidBrand = new Map();

  for (const e of list) {
    const r = REASONS[e.reason_code];
    if (!r || !r.part) continue;
    if (r.part === "fabric" || r.part === "colour" || r.part === "trust") {
      const m = r.part === "fabric" ? avoidFabric : avoidBrand;
      m.set(e.brand, (m.get(e.brand) || 0) + 1);
      continue;
    }
    const key = e.brand + "|" + e.garment_type + "|" + r.part + "|" + r.dir;
    const row = byKey.get(key) || { brand: e.brand, garment_type: e.garment_type, part: r.part, direction: r.dir, count: 0, sizes: [] };
    row.count++; row.sizes.push(e.size_ordered);
    byKey.set(key, row);
  }

  const rules = [...byKey.values()].map((r) => ({
    ...r,
    confidence: r.count >= 3 ? "high" : r.count >= 2 ? "medium" : "low",
    active: r.count >= 2,
    rule: r.direction === "up" ? `${r.brand} ${r.garment_type}: size up one — ${r.part} runs tight`
      : r.direction === "down" ? `${r.brand} ${r.garment_type}: size down one — runs loose at ${r.part}`
      : r.direction === "shorter" ? `${r.brand} ${r.garment_type}: prefer shorter ${r.part}`
      : r.direction === "longer" ? `${r.brand} ${r.garment_type}: prefer longer ${r.part}`
      : `${r.brand} ${r.garment_type}: check ${r.part}`,
  })).sort((x, y) => y.count - x.count);

  return {
    rules,
    hard_rejects: [
      ...[...avoidFabric.entries()].filter(([, c]) => c >= 2).map(([b]) => ({ type: "fabric", brand: b, note: "fabric complaints twice — reject by default" })),
      ...[...avoidBrand.entries()].filter(([, c]) => c >= 2).map(([b]) => ({ type: "listing_trust", brand: b, note: "listing did not match twice — reject by default" })),
    ],
    return_rate: list.length ? Number((list.filter((e) => !e.kept).length / list.length).toFixed(2)) : 0,
    sample_size: list.length,
  };
}

/* ==================================================================== */
/*  mock control                                                        */
/* ==================================================================== */
const STATE = {
  "In Transit": { t: "UD", i: "Shipment in transit" },
  "Out for delivery": { t: "UD", i: "Out for delivery" },
  "Undelivered": { t: "UD", i: "Consignee not available" },
  "Delivered": { t: "DL", i: "Delivered to consignee" },
  "RTO In Transit": { t: "RT", i: "Returning to origin" },
  "RTO Delivered": { t: "RT", i: "Returned to origin" },
  "Lost": { t: "LT", i: "Shipment lost in network" },
};

async function advance(a = {}) {
  const sh = DB.waybills.get(String(a.waybill || ""));
  if (!sh) return { status: 404, body: { ok: false, error: "Unknown waybill" } };
  const to = String(a.to || "");
  if (!STATE[to]) return { status: 400, body: { ok: false, error: "to must be one of " + Object.keys(STATE).join(", ") } };
  sh.status = { Status: to, StatusType: STATE[to].t, StatusLocation: sh.status.StatusLocation, Instructions: a.instructions || STATE[to].i, RecievedBy: to === "Delivered" ? (a.received_by || "self") : "" };
  sh.scans.push(scan(to, STATE[to].t, sh.status.StatusLocation, sh.status.Instructions));
  return { status: 200, body: { ok: true, waybill: sh.waybill, status: sh.status } };
}

async function state() {
  return { status: 200, body: {
    waybills: [...DB.waybills.values()].map((s) => ({ waybill: s.waybill, refnum: s.refnum, status: s.status.Status, pin: s.consignee.pin, promised_date: s.promised_date })),
    notices: [...DB.notices.values()],
    ledger_users: [...DB.ledger.keys()],
    scenarios: SCENARIOS, pin_scenarios: PIN_SCENARIO,
  } };
}

async function reset() {
  DB.waybills.clear(); DB.issued.clear(); DB.notices.clear(); DB.ledger.clear(); DB.ndr.clear();
  wbCounter = 13401110000001;
  return { status: 200, body: { ok: true } };
}

/* ==================================================================== */
/*  Catalogue + shipping cost                                           */
/*                                                                      */
/*  The catalogue is deliberately DUMB. It filters on category, colour, */
/*  brand, size and price — the things a filter can see. It knows       */
/*  nothing about the person, and it will cheerfully return a brand the */
/*  user has already rejected twice. That is the point: the tiering      */
/*  lives in the agent, against the fit ledger, not in the search.      */
/* ==================================================================== */
const CATALOGUE = [
  { id: "P101", title: "Oversized linen shirt",  brand: "Zara",      category: "shirt",    colour: "white", fabric: "linen",        fit: "oversized", sizes: ["S","M","L","XL"],       price: 1799, rating: 4.4, size_chart: { S:{shoulder_cm:43,chest_cm:98}, M:{shoulder_cm:45,chest_cm:103}, L:{shoulder_cm:47,chest_cm:108}, XL:{shoulder_cm:49,chest_cm:113} } },
  { id: "P102", title: "Regular linen shirt",     brand: "Zara",      category: "shirt",    colour: "white", fabric: "linen",        fit: "regular",   sizes: ["S","M","L","XL"],       price: 1499, rating: 4.2, size_chart: { S:{shoulder_cm:42,chest_cm:96}, M:{shoulder_cm:44,chest_cm:100}, L:{shoulder_cm:46,chest_cm:105}, XL:{shoulder_cm:48,chest_cm:110} } },
  { id: "P103", title: "Cotton oxford shirt",     brand: "H&M",       category: "shirt",    colour: "blue",  fabric: "cotton",       fit: "slim",      sizes: ["S","M","L","XL"],       price: 1299, rating: 4.1, size_chart: { S:{shoulder_cm:41,chest_cm:94}, M:{shoulder_cm:43,chest_cm:99}, L:{shoulder_cm:45,chest_cm:104}, XL:{shoulder_cm:47,chest_cm:109} } },
  { id: "P104", title: "Khadi short kurta",       brand: "Fabindia",  category: "kurta",    colour: "beige", fabric: "khadi cotton", fit: "regular",   sizes: ["S","M","L","XL"],       price: 2199, rating: 4.3, size_chart: { S:{shoulder_cm:42,chest_cm:97}, M:{shoulder_cm:44,chest_cm:102}, L:{shoulder_cm:46,chest_cm:107}, XL:{shoulder_cm:48,chest_cm:112} } },
  { id: "P105", title: "Chikankari kurta",        brand: "Fabindia",  category: "kurta",    colour: "white", fabric: "cotton voile", fit: "relaxed",   sizes: ["M","L","XL"],           price: 1899, rating: 4.0, size_chart: { M:{shoulder_cm:45,chest_cm:104}, L:{shoulder_cm:47,chest_cm:109}, XL:{shoulder_cm:49,chest_cm:114} } },
  { id: "P106", title: "Mandarin collar kurta",   brand: "Manyavar",  category: "kurta",    colour: "navy",  fabric: "silk blend",   fit: "regular",   sizes: ["S","M","L","XL"],       price: 2499, rating: 4.5, size_chart: { S:{shoulder_cm:42,chest_cm:96}, M:{shoulder_cm:44,chest_cm:101}, L:{shoulder_cm:46,chest_cm:106}, XL:{shoulder_cm:48,chest_cm:111} } },
  { id: "P107", title: "Slim chinos",             brand: "Levi's",    category: "trousers", colour: "khaki", fabric: "cotton twill", fit: "slim",      sizes: ["28","30","32","34","36"], price: 1899, rating: 4.2, size_chart: { "30":{waist_cm:76}, "32":{waist_cm:81}, "34":{waist_cm:86} } },
  { id: "P108", title: "Relaxed cargo trousers",  brand: "Snitch",    category: "trousers", colour: "black", fabric: "cotton",       fit: "relaxed",   sizes: ["28","30","32","34","36"], price: 1599, rating: 4.0, size_chart: { "30":{waist_cm:78}, "32":{waist_cm:83}, "34":{waist_cm:88} } },
  { id: "P109", title: "Oversized hoodie",        brand: "Bewakoof",  category: "hoodie",   colour: "black", fabric: "fleece",       fit: "oversized", sizes: ["S","M","L","XL"],       price: 1199, rating: 3.9, size_chart: { M:{shoulder_cm:48,chest_cm:110}, L:{shoulder_cm:50,chest_cm:115}, XL:{shoulder_cm:52,chest_cm:120} } },
  { id: "P110", title: "Merino crew sweater",     brand: "Uniqlo",    category: "sweater",  colour: "navy",  fabric: "merino wool",  fit: "regular",   sizes: ["S","M","L","XL"],       price: 2990, rating: 4.6, size_chart: { S:{shoulder_cm:42,chest_cm:96}, M:{shoulder_cm:44,chest_cm:101}, L:{shoulder_cm:46,chest_cm:106}, XL:{shoulder_cm:48,chest_cm:111} } },
];

async function productSearch(a = {}) {
  const s = resolveScenario(a.mock, null);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;

  const low = (v) => String(v || "").toLowerCase();
  let out = CATALOGUE.slice();
  if (a.category) out = out.filter((p) => low(p.category) === low(a.category));
  if (a.colour)   out = out.filter((p) => low(p.colour) === low(a.colour));
  if (a.brand)    out = out.filter((p) => low(p.brand) === low(a.brand));
  if (a.fabric)   out = out.filter((p) => low(p.fabric).includes(low(a.fabric)));
  if (a.size)     out = out.filter((p) => p.sizes.includes(String(a.size)));
  if (a.min_price != null) out = out.filter((p) => p.price >= Number(a.min_price));
  if (a.max_price != null) out = out.filter((p) => p.price <= Number(a.max_price));
  out.sort((x, y) => x.price - y.price);

  return { status: 200, body: {
    ok: true, count: out.length, products: out,
    // Said out loud in the payload so an agent that skips the ledger has
    // no excuse: this list is unfiltered by anything about the person.
    note: "Catalogue filters only. No personalisation applied — apply the user's hard rejects and size rules from get_fit_ledger before showing any of this.",
  } };
}

async function shippingCost(a = {}) {
  const s = resolveScenario(a.mock, a.destination_pin);
  const f = await failureResponse(s, a.delay_ms); if (f) return f;

  const grams = Math.max(Number(a.weight_g) || 500, 1);
  const slabs = Math.ceil(grams / 500);
  const oda = resolveScenario(null, a.destination_pin) === "oda";
  const base = 50 + (slabs - 1) * 35;
  const odaCharge = oda ? 100 : 0;
  const codCharge = String(a.payment_mode || "").toUpperCase() === "COD" ? 40 : 0;
  const total = base + odaCharge + codCharge;

  return { status: 200, body: {
    charge: total, currency: "INR",
    breakdown: { forward: base, oda: odaCharge, cod: codCharge },
    weight_grams: grams, weight_slabs: slabs,
    origin_pin: a.origin_pin || "", destination_pin: a.destination_pin || "",
    payment_mode: a.payment_mode || "Pre-paid",
    note: oda ? "Out of delivery area — surcharge applied and 2 days added to TAT" : "",
  } };
}

module.exports = {
  DB, SCENARIOS, PIN_SCENARIO, STATE, REASONS, NDR_ACTS, CATALOGUE,
  productSearch, shippingCost,
  resolveScenario, failureResponse,
  checkPincode, fetchWaybills, createShipment, trackShipment, editShipment, packingSlip, ndrAction, ndrStatus,
  parseSpoken, preDebitNotice, preDebitRespond, preDebitExpire, preDebitGet,
  recordFit, getLedger, advance, state, reset,
};
