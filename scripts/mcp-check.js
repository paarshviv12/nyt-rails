#!/usr/bin/env node
/* Prove the MCP server works, independently of any platform.
   Run it against your deployed URL BEFORE you build the agent:

     node scripts/mcp-check.js https://your-app.vercel.app

   If this prints 16 tools and the platform still shows none, the problem
   is on their side — and this output is the evidence. Save it.         */

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const url = base + "/mcp";

async function rpc(method, params, id) {
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); }
  catch { const m = /^data: (.*)$/m.exec(text); if (m) { try { json = JSON.parse(m[1]); } catch {} } }
  return { ms: Date.now() - started, status: res.status, ctype: res.headers.get("content-type"), json, text };
}

(async () => {
  console.log("MCP endpoint:", url, "\n");

  let r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-check", version: "1.0.0" } }, 1);
  console.log("1. initialize        HTTP " + r.status + "  " + r.ms + "ms");
  if (!r.json || !r.json.result) { console.log("   unexpected reply:\n", r.text.slice(0, 500)); process.exit(1); }
  console.log("   protocolVersion:", r.json.result.protocolVersion);
  console.log("   serverInfo:     ", JSON.stringify(r.json.result.serverInfo));
  console.log("   capabilities:   ", JSON.stringify(r.json.result.capabilities), "\n");

  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  console.log("2. initialized notification sent\n");

  r = await rpc("tools/list", {}, 2);
  const tools = r.json && r.json.result && r.json.result.tools;
  if (!tools) { console.log("3. tools/list FAILED\n", r.text.slice(0, 500)); process.exit(1); }
  console.log("3. tools/list        HTTP " + r.status + "  " + r.ms + "ms  —  " + tools.length + " tools\n");
  for (const t of tools) console.log("   • " + t.name.padEnd(32) + (t.title || ""));

  r = await rpc("tools/call", { name: "delhivery_check_pincode", arguments: { pin: "110001" } }, 3);
  const c = r.json && r.json.result && r.json.result.content;
  console.log("\n4. tools/call        HTTP " + r.status + "  " + r.ms + "ms");
  console.log("   delhivery_check_pincode(110001) ->", c ? c[0].text.split("\n")[0] : "no content");
  console.log("   isError:", r.json && r.json.result && !!r.json.result.isError);

  console.log("\nHandshake complete. " + tools.length + " tools advertised.");
})().catch((e) => { console.error("\nFailed to reach the server:", e.message); process.exit(1); });
