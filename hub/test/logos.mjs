#!/usr/bin/env node
// A business sender's logo comes from the hub, found once per domain and kept: the BIMI logo of a domain that enforces
// DMARC, else the largest icon its home page names, else /apple-touch-icon.png; nothing for a domain that does not enforce DMARC, for a
// free mailbox domain, for a host that resolves to a private address, for an icon under 48 px, or for an SVG carrying script. Served
// with a sandbox CSP; a second ask fetches nothing; a sending subdomain asks for its organisation's logo; arriving business mail looks
// its logo up before anyone lists it; a domain the list asks for that was never looked up is looked up at once and its logo
// answered in the same request.
// The real Worker on real migrations and SQLite; the network is a fake (DNS-over-HTTPS and the senders' sites).
// Usage: node test/logos.mjs (exit 1 on any failed check)
// CONTROL: LOGOS_SRC=<an index.js from before the change> node test/logos.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } }; };
// ---------- the fake network ----------
const png = (w, h) => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
const ico16 = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Brand</title><rect width="10" height="10" fill="#e00"/></svg>';
const TXT = { "_dmarc.bimi.example": "v=DMARC1; p=reject", "default._bimi.bimi.example": "v=BIMI1; l=https://cdn.bimi.example/logo.svg; a=",
  "_dmarc.touch.example": "v=DMARC1; p=quarantine; rua=mailto:x@touch.example", "_dmarc.lax.example": "v=DMARC1; p=none", "default._bimi.lax.example": "v=BIMI1; l=https://lax.example/bimi.svg", "_dmarc.copycat.example": "v=DMARC1; p=reject", "_dmarc.sister.example": "v=DMARC1; p=reject", "_dmarc.newco.example": "v=DMARC1; p=reject", "_dmarc.dark.example": "v=DMARC1; p=reject", "_dmarc.tiny.example": "v=DMARC1; p=reject",
  "_dmarc.evil.example": "v=DMARC1; p=reject", "default._bimi.evil.example": "v=BIMI1; l=https://evil.example/logo.svg", "_dmarc.inner.example": "v=DMARC1; p=reject", "_dmarc.plain.example": "v=DMARC1; p=reject", "_dmarc.bare.example": "v=DMARC1; p=reject", "_dmarc.gmail.com": "v=DMARC1; p=none" };
const PRIVATE = new Set(["inner.example"]);
const SITES = {
  "https://cdn.bimi.example/logo.svg": { ct: "image/svg+xml", body: SVG },
  "https://touch.example/": { ct: "text/html; charset=utf-8", body: '<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/static/touch.png"></head><body>' + "x".repeat(200) + "</body></html>" },
  "https://touch.example/static/touch.png": { ct: "image/png", body: png(180, 180) },
  "https://lax.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://lax.example/t.png": { ct: "image/png", body: png(183, 183) }, "https://oldnone.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://oldnone.example/t.png": { ct: "image/png", body: png(184, 184) },
  "https://tiny.example/": { ct: "text/html", body: '<html><head><link rel="icon" href="/favicon.ico"></head></html>' }, "https://tiny.example/favicon.ico": { ct: "image/x-icon", body: ico16 },
  "https://evil.example/logo.svg": { ct: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>' },
  "https://evil.example/": { ct: "text/html", body: "<html><head></head></html>" },
  "https://plain.example/": { ct: "text/html", body: '<html><head><link rel="shortcut icon" href="https://cdn.plain.example/fav.png"></head></html>' }, "https://cdn.plain.example/fav.png": { ct: "image/png", body: png(64, 64) },
  "https://copycat.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://copycat.example/t.png": { ct: "image/png", body: png(180, 180) },
  "https://sister.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://sister.example/t.png": { ct: "image/png", body: png(180, 180) },
  "https://newco.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://newco.example/t.png": { ct: "image/png", body: png(181, 181) },
  "https://dark.example/": { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="/t.png"></head></html>' }, "https://dark.example/t.png": { ct: "image/png", body: png(182, 182) },
  "https://bare.example/": { ct: "text/html", body: "<html><head><title>x</title></head></html>" }, "https://bare.example/favicon.ico": { ct: "image/x-icon", body: new Uint8Array([0, 0, 1, 0, 1, 0, 64, 64, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0]) },
};
const fetched = [];
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type");
    if (type === "TXT") return new Response(JSON.stringify({ Answer: TXT[name] ? [{ type: 16, data: `"${TXT[name]}"` }] : [] }));
    const ip = PRIVATE.has(name) ? "10.0.0.7" : "203.0.113.20";
    return new Response(JSON.stringify({ Answer: type === "A" ? [{ type: 1, data: ip }] : [] }));
  }
  if (u.hostname === "tranco-list.eu") {
    if (u.pathname === "/api/lists/date/latest") return Response.json({ list_id: "L2", available: true });
    if (u.pathname === "/download/L2/10000") return new Response(["touch.example", "bimi.example", "abc.example", "www.sub.example", ...Array.from({ length: 1200 }, (_, i) => `site${i}.example`)].map((d, i) => `${i + 1},${d}`).join("\r\n"));
  }
  fetched.push(u.href);
  const s = SITES[u.href]; if (!s) return new Response("not found", { status: 404 });
  return new Response(s.body, { status: 200, headers: { "content-type": s.ct } });
};
const SRC = readFileSync(process.env.LOGOS_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_logos_worker.mjs`; writeFileSync(tmp, SRC + "\nexport const __logo = typeof logoDaily === \"function\" ? { logoDaily, logoCorpusTick: typeof logoCorpusTick === \"function\" ? logoCorpusTick : null } : null;\nexport const __proof = { only: typeof gmailProofOnly === \"function\" ? gmailProofOnly : null, headers: GMAIL_META_HEADERS };\n");
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const sq = buildDb(); const objs = new Map(); const meta = new Map();
// the mailhub-img fingerprint, faked: a picture's fingerprint is its bytes' SHA-256, so a copy is the same bytes
const marked = [];
const IMGW = { fetch: async (u, init) => { const b = new Uint8Array(await new Response(init.body).arrayBuffer()); marked.push(b.length); const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return Response.json({ ph: h.slice(0, 16), sig: (h + h).slice(0, 96), sd: 40, ink: 0.5 }); } };
const IMGW_DOWN = { fetch: async () => Response.json({ error: "down" }, { status: 500 }) };
const env = { IMGW, DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "hub.example", EMAIL: { send: async () => ({ messageId: "<x@hub.test>" }) },
  STORE: { put: async (k, v, o = {}) => { objs.set(k, new Uint8Array(await new Response(v instanceof Uint8Array ? v.slice() : v).arrayBuffer())); meta.set(k, o); return { key: k }; },
    get: async (k) => { if (!objs.has(k)) return null; const b = objs.get(k), o = meta.get(k) || {}; return { body: new Response(b).body, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => new TextDecoder().decode(b), httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }; },
    head: async (k) => (objs.has(k) ? { size: objs.get(k).length, httpMetadata: (meta.get(k) || {}).httpMetadata || {}, customMetadata: (meta.get(k) || {}).customMetadata || {} } : null),
    list: async (o = {}) => ({ objects: [...objs.keys()].filter((k) => k.startsWith(o.prefix || "")).sort().slice(0, o.limit || 1000).map((k) => ({ key: k, size: objs.get(k).length, customMetadata: (meta.get(k) || {}).customMetadata || {} })), truncated: false }), delete: async (k) => { objs.delete(k); } } };
let waits = []; const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
const settle = async () => { for (let i = 0; i < 5; i++) { const w = waits; waits = []; await Promise.allSettled(w); await new Promise((r) => setTimeout(r, 10)); } };
const logo1 = async (d) => { const r = await mod.default.fetch(new Request("https://hub.example/api/logo?d=" + encodeURIComponent(d), { headers: { Authorization: "Bearer cli-token" } }), env, ctx); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, ct: r.headers.get("content-type") || "", csp: r.headers.get("content-security-policy") || "", len: b.length, head: new TextDecoder().decode(b.slice(0, 8)) }; };
// what the app sees: the first ask finds nothing kept and starts no lookup; the daily job looks it up; the next ask is served
const logo = async (d) => { let r = await logo1(d); if (r.status === 404 && mod.__logo) { await settle(); await mod.__logo.logoDaily(env); r = await logo1(d); } return r; };
// the protected brands: touch.example is a top site (brands/top.json, fresh), sister.example has written to the user
objs.set("brands/top.json", new TextEncoder().encode(JSON.stringify({ id: "L1", at: new Date().toISOString(), domains: ["touch.example", "abc.example"] })));
sq.prepare("INSERT INTO known_senders (address, status, first_seen_at, last_seen_at) VALUES ('news@sister.example', 'accepted', '2026-10-01', '2026-11-01')").run();
try {
  const cold = await logo1("bimi.example"); await settle();
  check(cold.status === 200 && cold.ct === "image/svg+xml" && objs.has("logo/bimi.example"), `asked by the list, a domain never looked up: looked up at once and its logo answered in the same request, then kept (${cold.status} ${cold.ct})`);
  const a = await logo("bimi.example");
  check(a.status === 200 && a.ct === "image/svg+xml" && /sandbox/.test(a.csp) && a.head.startsWith("<svg"), `a domain enforcing DMARC with a BIMI record: its SVG, served with a sandbox CSP (${a.status} ${a.ct} ${a.csp})`);
  const b = await logo("touch.example");
  check(b.status === 200 && b.ct === "image/png" && fetched.includes("https://touch.example/static/touch.png") && !fetched.includes("https://touch.example/favicon.ico"), `no BIMI: the home page's apple-touch-icon, not its small favicon (${b.status} ${b.ct})`);
  const n0 = fetched.length; const b2 = await logo("touch.example"); const c = await logo("news.touch.example");
  check(b2.status === 200 && c.status === 200 && fetched.length === n0, `asked again, or for a sending subdomain: served from what was kept, nothing fetched (${fetched.length - n0} fetches)`);
  objs.set("logo/oldnone.example", new Uint8Array(0)); meta.set("logo/oldnone.example", { customMetadata: { at: String(Date.now()), none: "1", v: "2" } });
  const on = await logo1("oldnone.example");
  check(on.status === 200, `a "none" kept under the earlier rules is looked up again at once, and its site's icon served (${on.status})`);
  const lax = await logo("lax.example");
  check(lax.status === 200 && fetched.includes("https://lax.example/t.png") && !fetched.includes("https://lax.example/bimi.svg"), `a domain that does not enforce DMARC: its site's icon, never its BIMI logo (${lax.status})`);
  const tiny = await logo("tiny.example");
  check(tiny.status === 404, `a 16 px favicon is not used (${tiny.status})`);
  const evil = await logo("evil.example");
  check(evil.status === 404, `an SVG carrying script is refused (${evil.status})`);
  const inner = await logo("inner.example"); const g = await logo("gmail.com");
  check(inner.status === 404 && !fetched.some((x) => x.includes("inner.example")) && g.status === 404 && !fetched.some((x) => x.includes("gmail.com")), `a host on a private address and a free mailbox domain: nothing fetched, no logo (${inner.status} ${g.status})`);
  const plain = await logo("plain.example"), bare = await logo("bare.example");
  check(plain.status === 200 && plain.ct === "image/png" && bare.status === 200 && bare.ct === "image/x-icon", `an icon named with no size, and a site's own /favicon.ico, are used when their bytes say 48 px or more (${plain.status} ${bare.status} ${bare.ct})`);
  // a "none" found under the earlier rules is looked at again
  objs.set("logo/plain2.example", new Uint8Array(0)); meta.set("logo/plain2.example", { customMetadata: { at: String(Date.now()), none: "1" } });
  TXT["_dmarc.plain2.example"] = "v=DMARC1; p=reject"; SITES["https://plain2.example/"] = SITES["https://plain.example/"];
  const again = await logo("plain2.example");
  check(again.status === 200, `a "none" kept under the earlier rules is looked for again (${again.status})`);
  const none = await logo("../../etc"); const bad = await logo("");
  check(none.status === 404 && bad.status === 404, "a name that is not a domain: no logo");
  // arriving business mail looks its logo up before anyone lists it
  const raw = ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=mail.shop.example; spf=pass smtp.mailfrom=mail.shop.example; dmarc=pass header.from=mail.shop.example", "From: Shop <news@mail.shop.example>", "To: <sam@hub.example>", "Subject: Our sale", "Message-ID: <sale1@shop.example>", "Date: Wed, 25 Nov 2026 20:00:00 +0000", "List-Unsubscribe: <https://shop.example/u>", "List-Id: <news.shop.example>", "Precedence: bulk", "Content-Type: text/plain; charset=utf-8", "", "Everything is on sale.", ""].join("\r\n");
  TXT["_dmarc.shop.example"] = "v=DMARC1; p=reject"; SITES["https://shop.example/"] = { ct: "text/html", body: '<html><head><link rel="apple-touch-icon" href="https://shop.example/a.png"></head></html>' }; SITES["https://shop.example/a.png"] = { ct: "image/png", body: png(152, 152) };
  sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('sam@hub.example', 'Sam', 1, 'hub.example')").run();
  await mod.default.email({ to: "sam@hub.example", from: "news@mail.shop.example", rawSize: raw.length, raw, headers: new Headers({ subject: "Our sale", "message-id": "<sale1@shop.example>", from: "Shop <news@mail.shop.example>" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  await settle();
  const cat = sq.prepare("SELECT category FROM messages WHERE message_id = '<sale1@shop.example>'").get();
  check(objs.has("logo/shop.example") && objs.get("logo/shop.example").length > 0, `arriving business mail (${cat && cat.category}) has its organisation's logo kept before anyone lists it`);
  // the same mail, from a domain it only claims (no DMARC pass in Cloudflare's stamp): no lookup, and its row is not proven
  TXT["_dmarc.claim.example"] = "v=DMARC1; p=reject"; SITES["https://claim.example/"] = SITES["https://shop.example/"];
  const raw2 = raw.replace(/^Authentication-Results:[^\r\n]*\r\n/, "Authentication-Results: mx.cloudflare.net; spf=softfail smtp.mailfrom=x.example; dmarc=fail header.from=claim.example\r\n").replace(/mail\.shop\.example/g, "claim.example").replace("sale1@shop.example", "sale2@claim.example");
  await mod.default.email({ to: "sam@hub.example", from: "news@claim.example", rawSize: raw2.length, raw: raw2, headers: new Headers({ subject: "Our sale", "message-id": "<sale2@claim.example>", from: "Shop <news@claim.example>" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  await settle();
  const list = await mod.default.fetch(new Request("https://hub.example/api/threads?limit=50&box=all", { headers: { Authorization: "Bearer cli-token" } }), env, ctx).then((r) => r.json());
  const pr = Object.fromEntries((list.threads || []).map((t) => [(t.last || {}).from_addr, (t.last || {}).proven]));
  check(!objs.has("logo/claim.example") && pr["news@mail.shop.example"] === 1 && pr["news@claim.example"] === 0 && !(list.threads || []).some((t) => t.last && "auth_results" in t.last), `mail that fails DMARC looks up no logo; the list says which rows are proven, without the stamp itself (${JSON.stringify(pr)})`);
  // The Gmail mirror keeps Gmail's own DMARC verdict for the devices (field report 2026-11-26): the topmost mx.google.com stamp, cut to
  // its one dmarc clause; a pass a sender planted below it, a stamp with two dmarc clauses, or no Gmail stamp keeps nothing.
  const P = mod.__proof, G = "mx.google.com; dkim=pass header.i=@x.example header.s=s1 header.b=abc; spf=pass (google.com: domain of b@x.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=b@x.example; ";
  const kept = (ars) => { if (!P.only) return "no gmailProofOnly"; const m = P.only({ id: "m", payload: { headers: [{ name: "From", value: "News <news@emails.shop.example>" }, ...ars.map((v) => ({ name: "Authentication-Results", value: v })), { name: "Subject", value: "Hi" }] } });
    const ar = m.payload.headers.filter((h) => h.name === "Authentication-Results").map((h) => h.value); return [m.payload.headers.length - ar.length, ...ar]; };
  check(P.headers.includes("Authentication-Results"), "the mirror asks Gmail for Authentication-Results");
  const k1 = kept([G + "dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=shop.example", "mx.google.com; dmarc=pass header.from=other.example"]);
  check(JSON.stringify(k1) === JSON.stringify([2, "mx.google.com; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=shop.example"]), `only Gmail's topmost verdict is kept, cut to its dmarc clause, the other headers untouched (${JSON.stringify(k1)})`);
  const k2 = kept(["mx.google.com; dmarc=pass header.from=a.example; dmarc=fail header.from=shop.example"]), k3 = kept(["spf.example.net; dmarc=pass header.from=shop.example"]), k4 = kept([]);
  check(JSON.stringify([k2, k3, k4]) === JSON.stringify([[2], [2], [2]]), `two dmarc clauses, a stamp that is not Gmail's, or none keep nothing (${JSON.stringify([k2, k3, k4])})`);
  // Copied logos: touch.example (a top site) keeps its own; copycat.example, a stranger whose icon is touch.example's
  // picture, shows its letter; sister.example, which has written to the user, keeps the same picture; newco.example, a stranger
  // with a picture of its own, shows its logo on its first ask; a stranger whose fingerprint cannot be had shows its letter.
  const r1 = await logo1("touch.example");
  const cc = await mod.default.fetch(new Request("https://hub.example/api/logo?d=copycat.example", { headers: { Authorization: "Bearer cli-token" } }), env, ctx);
  check(r1.status === 200 && cc.status === 404 && /touch\.example/.test(cc.headers.get("x-logo-refused") || ""), `a stranger whose logo is a protected brand's picture shows its letter (${cc.status} ${cc.headers.get("x-logo-refused")})`);
  const sis = await logo1("sister.example"), nc = await logo1("newco.example");
  check(sis.status === 200 && nc.status === 200, `the same picture from a domain that has written to the user, and a stranger's own picture on its first ask, are shown (${sis.status}, ${nc.status})`);
  env.IMGW = IMGW_DOWN; const dk = await logo1("dark.example"); await settle(); env.IMGW = IMGW;
  check(dk.status === 404, `a stranger whose logo's fingerprint cannot be had shows its letter (fails closed) (${dk.status})`);
  const row = sq.prepare("SELECT COUNT(*) n FROM logo_marks WHERE org = 'touch.example' AND src = 'kept'").get();
  check(row.n >= 1, `a kept logo's fingerprint is kept for the check (${row.n})`);
  // The brand set: fingerprints of the top sites' variants, a few a tick; the list fetched again from Tranco when 30 days old.
  if (mod.__logo?.logoCorpusTick) {
    const t1 = await mod.__logo.logoCorpusTick(env, 5000);
    const br = sq.prepare("SELECT COUNT(*) n FROM logo_marks WHERE org = 'touch.example' AND src = 'brand'").get();
    check(t1.n >= 1 && br.n >= 1, `the brand job fingerprints a top site's logo variants (${JSON.stringify(t1)}, ${br.n})`);
    objs.set("brands/top.json", new TextEncoder().encode(JSON.stringify({ id: "L1", at: "2026-09-01T00:00:00Z", domains: ["touch.example"] })));
    await new Promise((r) => setTimeout(r, 5)); const t2 = await mod.__logo.logoCorpusTick(env, 2000);
    const top = JSON.parse(new TextDecoder().decode(objs.get("brands/top.json")));
    check(top.id === "L2" && top.domains.length > 1000 && top.domains.includes("bimi.example") && !top.domains.includes("www.sub.example"), `a list 30 days old is fetched again from Tranco, registrable domains only (${top.id}, ${top.domains.length})`);
  } else check(false, "no logoCorpusTick");
  const orgs = await mod.default.fetch(new Request("https://hub.example/api/senders/orgs", { headers: { Authorization: "Bearer cli-token" } }), env, ctx).then((r) => r.json());
  check(Array.isArray(orgs.brands) && orgs.brands.includes("touch.example") && !orgs.brands.includes("abc.example"), `the apps get the top sites' names of four letters or more for their name check (${JSON.stringify((orgs.brands || []).slice(0, 4))})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall logo checks passed");
process.exit(fails.length ? 1 : 0);
