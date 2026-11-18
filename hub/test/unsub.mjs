#!/usr/bin/env node
// EXECUTION test for how the hub reads an unsubscribe page, with the network stubbed at globalThis.fetch, and for the retired endpoint.
//
// History. Unsubscribing on the phone said "Failed to fetch" (a network-level ad blocker can block e.customeriomail.com), so the app
// handed the one-click URL to the hub, POST /api/unsubscribe. A link with no one-click is visited by the
// hub, and counts as done only when its page says so (a link only opened is not done: its page must say "you've been
// unsubscribed"). Then The app sends a job naming the conversation and the hub reads the
// headers itself, so that endpoint, which sent to any URL a client gave it, is retired (410). The page reader it used is the job's
// page step now; its checks stay here, against the function. The job (one-click, email, the form, DKIM, the sweep, the addresses it
// refuses) is test/unsubjob.mjs. Usage: node test/unsub.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

// ---------- load the real Worker (Cloudflare-only imports stubbed, as test/delta.mjs does) ----------
const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";')
  + "\nexport { visitUnsubPage as __visit, unsubLinks as __links };\n";
const tmp = `${HUB}test/_unsub_worker.mjs`;
writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

// ---------- a DB that only records events, and a network that records every outbound request ----------
const events = [];
const db = { prepare: (sql) => { const mk = (p) => ({ bind: (...a) => mk(a), first: async () => null, all: async () => ({ results: [] }), run: async () => { if (/INSERT INTO events/.test(sql)) events.push(p); return { meta: { changes: 1 } }; } }); return mk([]); }, batch: async () => [] };
const env = { DB: db, CLI_TOKEN: "cli-token" };
const PRIVATE = new Set(["sneaky.example"]);           // a name whose DNS answer is a private address
let sent = [], upstream = () => new Response("", { status: 200 });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type");
    const data = PRIVATE.has(name) ? (type === "A" ? "127.0.0.1" : "::1") : (type === "A" ? "35.244.218.227" : null);
    return new Response(JSON.stringify({ Answer: data ? [{ type: type === "A" ? 1 : 28, data }] : [] }), { headers: { "content-type": "application/dns-json" } });
  }
  sent.push({ url: u.href, method: init.method, body: init.body, headers: new Headers(init.headers || {}), redirect: init.redirect });
  return upstream(u);
};

{ // the retired endpoint: an old app is told to reload, nothing is sent, and the call is logged
  sent = []; events.length = 0;
  const r = await mod.default.fetch(new Request("https://hub.example/api/unsubscribe", { method: "POST", headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, body: JSON.stringify({ url: "https://e.customeriomail.com/unsubscribe/x" }) }), env, { waitUntil: () => {} });
  const b = await r.json().catch(() => null);
  check(r.status === 410 && /reload/.test(b?.error || "") && sent.length === 0, `POST /api/unsubscribe is retired: 410, "reload", nothing sent (${r.status}, ${sent.length} sent)`);
  check(events.some((e) => e[0] === "unsubscribe_legacy"), "and the call is logged, so an old app still out there shows up");
  const anon = await mod.default.fetch(new Request("https://hub.example/api/unsubscribe", { method: "POST", body: "{}" }), env, { waitUntil: () => {} });
  check(anon.status === 401, `without sign-in it is 401 (${anon.status})`);
}
{ // which links the hub will use at all: https only, never an IP literal, the first of each kind
  const L = mod.__links;
  const a = L("<mailto:leave@list.example?subject=unsub>, <https://e.customeriomail.com/unsubscribe/x>");
  check(a.mailto === "mailto:leave@list.example?subject=unsub" && a.https === "https://e.customeriomail.com/unsubscribe/x", "a mailto and an https link are both read");
  for (const [h, why] of [["<http://e.customeriomail.com/u>", "plain http"], ["<https://35.244.218.227/u>", "an IPv4 literal"], ["<https://[::1]/u>", "an IPv6 literal"], ["<javascript:alert(1)>", "a script URL"], ["<not a url>", "garbage"], ["https://bare.example/u", "a link without angle brackets"]])
    check(L(h).https === null, `not used: ${why}`);
}
// ---------- the page: visited, never POSTed to, and done only when it says so ----------
const PAGE = "https://list.example/unsub?id=42";
const html = (body) => () => new Response(`<!doctype html><html><head><style>.x{}</style><script>var s = "are you sure";</script></head><body>${body}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
const visit = (url = PAGE) => mod.__visit(new URL(url));
for (const [body, want, why] of [
  ["<h1>You&rsquo;ve been unsubscribed</h1><p>Changed your mind? <a href='/re'>Click here to resubscribe</a></p>", true, "“You’ve been unsubscribed” (an entity apostrophe), with a resubscribe link"],
  ["<p>you&#x27;re now unsubscribed from Weekly Deals.</p>", true, "“you're now unsubscribed” (a hex entity)"],
  ["<p>Your email address has been removed from our mailing list.</p>", true, "“has been removed from our mailing list”"],
  ["<p>Your unsubscribe request has been processed.</p>", true, "“unsubscribe request has been processed”"],
  ["<h2>Unsubscribe successful</h2>", true, "“Unsubscribe successful”"],
  ["<p>You are no longer subscribed to The Weekly Letter.</p>", true, "“You are no longer subscribed”"],
  ["<form method=post><p>Are you sure you want to unsubscribe?</p><button>Unsubscribe</button></form>", false, "a confirmation step (“Are you sure…?”)"],
  ["<p>Click the button below to unsubscribe from all marketing email.</p><button>Unsubscribe</button>", false, "a page that asks for a click to unsubscribe"],
  ["<p>Click below and you will no longer receive these emails.</p><button>Unsubscribe</button>", false, "“you will no longer receive” under a button: asking, not telling"],
  ["<p>Please confirm your unsubscribe request. Once done, you have been removed.</p>", false, "a done phrase on a page that also asks to confirm"],
  ["<p>Manage your email preferences</p><input type=checkbox> Weekly", false, "a preferences page"],
  ["", false, "an empty page (a script-drawn one)"],
]) {
  sent = []; upstream = html(body);
  const v = await visit();
  check(v.status === 200 && v.confirmed === want, `page: ${why} → confirmed ${want} (${v.status} ${v.confirmed})`);
}
{ // what is sent: one GET, nothing in it, the hops checked
  sent = []; upstream = html("<p>You have been unsubscribed.</p>");
  await visit(); const s = sent[0];
  check(sent.length === 1 && (s.method === undefined || s.method === "GET") && s.body === undefined, `page: one plain GET and no POST body (${JSON.stringify(sent.map((x) => (x.method || "GET") + " " + x.url))})`);
  check(s && !s.headers.has("cookie") && !s.headers.has("authorization") && s.redirect === "manual", "page: no cookie or credential, redirects taken by hand");
  sent = []; upstream = (u) => u.pathname === "/unsub" ? new Response(null, { status: 302, headers: { location: "https://landing.example/done" } }) : html("<p>You've been unsubscribed.</p>")();
  let v = await visit();
  check(v.confirmed === true && sent.map((x) => x.url).join(" ") === `${PAGE} https://landing.example/done`, `page: a redirect is followed to the page that says it (${JSON.stringify(sent.map((x) => x.url))})`);
  sent = []; upstream = (u) => u.hostname === "list.example" ? new Response(null, { status: 302, headers: { location: "https://sneaky.example/admin" } }) : html("<p>You've been unsubscribed.</p>")();
  v = await visit();
  check(v.confirmed === false && !sent.some((x) => x.url.includes("sneaky.example")), `page: a redirect to a private address is not followed (${JSON.stringify(sent.map((x) => x.url))})`);
  sent = []; upstream = (u) => u.hostname === "list.example" ? new Response(null, { status: 302, headers: { location: "http://landing.example/done" } }) : html("<p>You've been unsubscribed.</p>")();
  v = await visit();
  check(v.confirmed === false && !sent.some((x) => x.url.startsWith("http:")), `page: a redirect to plain http is not followed (${JSON.stringify(sent.map((x) => x.url))})`);
  sent = []; upstream = (u) => new Response(null, { status: 302, headers: { location: `https://list.example/hop${(+u.pathname.replace(/\D/g, "") || 0) + 1}` } });
  v = await visit();
  check(v.confirmed === false && sent.length === 6, `page: redirects stop after five hops (${sent.length} requests)`);
  sent = []; upstream = () => new Response("<p>You have been unsubscribed.</p>", { status: 404 });
  v = await visit();
  check(v.confirmed === false && v.status === 404, `page: an error page is never a confirmation (${v.status} ${v.confirmed})`);
  upstream = () => { throw new TypeError("network"); };
  let threw = false; try { await visit(); } catch (_) { threw = true; }
  check(threw, "page: an unreachable page throws, and the job records it as unreachable");
}
{ // a big page: only its first 256 KB is read, and the phrase past it does not count
  let pulled = 0; const chunk = new TextEncoder().encode("<p>" + "lorem ipsum ".repeat(5000) + "</p>");
  upstream = () => new Response(new ReadableStream({ pull(c) { pulled++; if (pulled > 200) { c.enqueue(new TextEncoder().encode("<p>You have been unsubscribed</p>")); c.close(); } else c.enqueue(chunk); } }), { status: 200 });
  const t0 = performance.now(); const v = await visit(); const ms = performance.now() - t0;
  check(v.confirmed === false && pulled < 12, `page: reading stops at 256 KB (${pulled} chunks of ${chunk.byteLength} B pulled of 201; ${ms.toFixed(1)} ms here)`);
}
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall unsubscribe checks passed");
