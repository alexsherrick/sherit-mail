#!/usr/bin/env node
// EXECUTION test: the security review's server fixes, on the real Worker over the real migrations.
//  B1 an encoded Message-ID / References / Subject that decodes to CR/LF is stored on one line, and a reply's In-Reply-To and
//  References carry no line break: for mail stored before the fix too;
//  B4 a lookalike From (`"<x@uspto.gov>" <y@uspto.gov.attacker.example>`, DMARC-signed by the lookalike) is not uspto.gov;
//  C1 /api/prefs never returns the session generation or an app sign-in code, and a client cannot write the generation;
//  C2 a session check that cannot read the generation answers 503, never "generation 0";
//  C4 a session's GET from another site is refused; the app's own, and the CLI's, are not;
//  C7 one sender's domain stops at its share of the day's pictures; another sender's still come;
//  C8 the letterhead quote escapes an unfinished tag;
//  C9 an Authentication-Results on mail read over IMAP is not stored as Cloudflare's verdict;
//  B6 the app shell carries a script policy with a fresh nonce, the same one its script tag has.
// (B2 and C6, the unsubscribe job, are in unsubjob.mjs; C3 in ingest.mjs; the sign-in state in authforge.mjs.)
// CONTROL: SECFIX_SRC=<index.js before the change> fails each of them.
// Usage: node test/secfix.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const CONTROL = !!process.env.SECFIX_SRC;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq, o = {}) => { const run = (sql, p, kind) => { if (o.fail && o.fail(sql)) throw new Error("D1_ERROR: simulated"); const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
let SRC = readFileSync(process.env.SECFIX_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import APP_HTML from "\.\/client\/app\.html";$/m, `const APP_HTML = ${JSON.stringify(readFileSync(HUB + "src/client/app.html", "utf8"))};`)
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const want = ["ingestRaw", "sendMail", "quoteHtml"].filter((n) => new RegExp(`(async )?function ${n}\\(`).test(SRC));
SRC += `\nexport { ${want.join(", ")} };\n`;
const tmp = `${HUB}test/_secfix_worker.mjs`; writeFileSync(tmp, SRC); const M = await import(tmp).finally(() => unlinkSync(tmp));
const worker = M.default;

const SECRET = "test-session-secret", ORIGIN = "https://hub.example";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const session = async (gen) => { const exp = Date.now() + 86400000; return `mh=${exp}.${gen}.${await hmac(SECRET, `${exp}.${gen}`)}`; };
const store = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : await new Response(v).arrayBuffer())); },
  head: async (k) => (m.has(k) ? { key: k, size: m.get(k).length } : null), get: async (k) => (m.has(k) ? { body: new Response(m.get(k)).body, arrayBuffer: async () => m.get(k).buffer, text: async () => new TextDecoder().decode(m.get(k)), size: m.get(k).length, httpMetadata: {} } : null), delete: async (k) => m.delete(k) }; };
const ctx = { waitUntil() {}, passThroughOnException() {} };
let sentMsgs = [];
const world = (o = {}) => { const sq = buildDb(); const env = { DB: d1(sq, o), STORE: store(), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "k".repeat(44), CLI_TOKEN: "cli-secret",
  EMAIL: { send: async (m) => { sentMsgs.push(m); return { messageId: "<sent@x>" }; } } }; return { sq, env, call: (method, path, headers = {}, body) => worker.fetch(new Request(ORIGIN + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx) }; };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;
const png = (n) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30]); return b; };
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  if (/^img\./.test(u.hostname)) return new Response(png(2000), { headers: { "content-type": "image/png", "content-length": "2000" } });
  return new Response("not here", { status: 404 });
};
const enc = (s) => `=?utf-8?B?${Buffer.from(s).toString("base64")}?=`;
const CRLF = /[\r\n]/;

// ---------- B1: reply headers ----------
if (M.ingestRaw && M.sendMail) {
  const w = world();
  const raw = ["From: Attacker <a@evil.example>", "To: sam@domain2.example", "Cc: partner@victim.example", "Subject: " + enc("Quick question\r\nBcc: x@evil.example"),
    `Message-ID: <m1@evil.example>${enc("\r\nReply-To: <boss@evil.example>\r\n\r\nNEW BANK DETAILS")}`, `References: ${enc("<r0@evil.example>\r\n\r\nPlease wire\r\nX-A: <z@evil.example>")}`,
    "Date: Mon, 9 Nov 2026 10:00:00 +0000", "Content-Type: text/plain", "", "hello", ""].join("\r\n");
  await M.ingestRaw(w.env, new TextEncoder().encode(raw), { id: "in1", rcpt: "sam@domain2.example", envFrom: "a@evil.example", source: "cloudflare" });
  const row = w.sq.prepare("SELECT message_id, refs, subject FROM messages WHERE id = 'in1'").get() || {};
  if (CONTROL) check(CRLF.test(row.message_id || "") || CRLF.test(row.refs || ""), `CONTROL — the Worker before the change stores a decoded line break in the mail's ids (${JSON.stringify(row.message_id)})`);
  else check(!CRLF.test(row.message_id || "x\n") && !/\s/.test(row.message_id) && row.message_id.startsWith("<m1@evil.example>"), `an encoded line break in Message-ID is stored without it (${JSON.stringify(row.message_id)})`);
  if (!CONTROL) check(!CRLF.test(row.refs || "") && !CRLF.test(row.subject || ""), `… References and Subject on one line too (${JSON.stringify(row.refs)} | ${JSON.stringify(row.subject)})`);
  const replyHdrs = async (parentId) => { sentMsgs = []; try { await M.sendMail(w.env, { from: "sam@domain2.example", to: ["a@evil.example"], subject: "Re: Quick question", text: "Sure.", reply_to_id: parentId }); } catch (e) { return { err: e.message }; } return (sentMsgs[0] && sentMsgs[0].headers) || {}; };
  // a parent stored before the fix: the line breaks are in the row itself
  w.sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES ('t-old', 'x', 'x', '2026-11-01T00:00:00Z', 1, 'inbox')").run();
  w.sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, refs, status, ingest_source, created_at) VALUES ('old1', 't-old', 'in', 'sam@domain2.example', 'a@evil.example', 'Quick question', ?, ?, 'received', 'cloudflare', '2026-11-01T00:00:00Z')")
    .run("<m0@evil.example>\r\nReply-To: <boss@evil.example>\r\n\r\nNEW BANK DETAILS", "<r0@evil.example>\r\n\r\nPlease wire\r\nX-A: <z@evil.example> <a\r\nB: c@evil.example>");
  const h = await replyHdrs("old1"), vals = Object.values(h).map(String);
  if (CONTROL) check(vals.some((v) => CRLF.test(v)), `CONTROL — … and its reply carries the line break into In-Reply-To (${JSON.stringify(h).slice(0, 120)})`);
  else check(!h.err && h["In-Reply-To"] && !vals.some((v) => CRLF.test(v)) && !/Reply-To:|NEW BANK|Please wire/.test(vals.join(" ")), `a reply to a parent stored before the fix carries no line break or sender text in its headers (${JSON.stringify(h).slice(0, 160)})`);
  const h2 = await replyHdrs("in1");
  if (!CONTROL) check(!h2.err && !Object.values(h2).map(String).some((v) => CRLF.test(v)), `a reply to the mail stored now carries none either (${JSON.stringify(h2).slice(0, 120)})`);
}

// ---------- B4: the USPTO rule and a lookalike From ----------
{
  const deliverTo = async (w, from, ar, envFrom) => {
    const mime = [`From: ${from}`, "To: trademark@domain2.example", "Subject: Trademark notice", `Message-ID: <${Math.random().toString(36).slice(2)}@x.example>`, "Date: Mon, 9 Nov 2026 10:00:00 +0000", "Content-Type: text/plain", "", "notice", ""].join("\r\n");
    const fwd = []; const message = { to: "trademark@domain2.example", from: envFrom, rawSize: mime.length, raw: new Response(mime).body,
      headers: new Headers({ from, subject: "Trademark notice", "authentication-results": ar, "message-id": "<x@x.example>" }), forward: async (a) => { fwd.push(a); }, setReject: () => {} };
    await worker.email(message, w.env, ctx);
    const r = w.sq.prepare("SELECT labels FROM messages WHERE identity = 'trademark@domain2.example' ORDER BY rowid DESC LIMIT 1").get();
    return { labels: r?.labels || "", fwd };
  };
  const w = world();
  const fake = await deliverTo(w, '"<trademarks@uspto.gov>" <notice@uspto.gov.attacker.example>', "mx.cloudflare.net; dkim=pass header.d=uspto.gov.attacker.example header.s=s1 header.b=abc12345; spf=pass smtp.mailfrom=notice@uspto.gov.attacker.example; dmarc=pass header.from=uspto.gov.attacker.example", "notice@uspto.gov.attacker.example");
  if (CONTROL) check(/USPTO/.test(fake.labels), `CONTROL — the Worker before the change takes the lookalike for USPTO (${fake.labels})`);
  else check(!/USPTO/.test(fake.labels) && /trademark-scam/.test(fake.labels), `a lookalike From is not uspto.gov: held as a scam, not labelled USPTO (${fake.labels}; forwarded ${fake.fwd.length})`);
  if (!CONTROL) {
    const real = await deliverTo(w, "USPTO <trademarks@uspto.gov>", "mx.cloudflare.net; dkim=pass header.d=uspto.gov header.s=s1 header.b=abc12345; spf=pass smtp.mailfrom=bounce@uspto.gov; dmarc=pass header.from=uspto.gov", "bounce@uspto.gov");
    check(/USPTO/.test(real.labels), `the real uspto.gov still is (${real.labels})`);
  }
}

// ---------- C1: prefs ----------
{
  const w = world(); const cookie = await session(0);
  w.sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('applogin:abcdefghijabcdefghij12', '{\"challenge\":\"c\"}', '2026-11-09T00:00:00Z')").run();
  const g = await (await w.call("GET", "/api/prefs", { Cookie: cookie })).json();
  const p = g.prefs || {};
  if (CONTROL) check(Object.keys(p).some((k) => k.startsWith("applogin:")), `CONTROL — the Worker before the change returns app sign-in codes in /api/prefs (${Object.keys(p).join(",")})`);
  else check(!Object.keys(p).some((k) => k.startsWith("applogin:") || k.startsWith("appcb:") || k === "session_gen"), `/api/prefs returns no app sign-in code and no session generation (${Object.keys(p).join(",")})`);
  w.sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('session_gen', '3', '2026-11-09T00:00:00Z') ON CONFLICT(key) DO UPDATE SET value = '3'").run();
  await new Promise((r) => setTimeout(r, 5100));
  const put = await w.call("PUT", "/api/prefs", { Cookie: await session(3), Origin: ORIGIN, "content-type": "application/json" }, { session_gen: 0, theme: "dark" });
  const gen = w.sq.prepare("SELECT value FROM prefs WHERE key = 'session_gen'").get()?.value, theme = w.sq.prepare("SELECT value FROM prefs WHERE key = 'theme'").get()?.value;
  if (CONTROL) check(String(gen) === "0", `CONTROL — … and lets a client write the session generation back to 0 (${gen})`);
  else check(put.status === 200 && String(gen) === "3" && theme === '"dark"', `a client cannot write the session generation; its other prefs still save (${put.status}, gen ${gen}, theme ${theme})`);
}

// ---------- C2: the generation unreadable ----------
{
  const w = world({ fail: (sql) => /key = 'session_gen'/.test(sql) });
  const r = await w.call("GET", "/api/me", { Cookie: await session(0) });
  if (CONTROL) check(r.status === 200, `CONTROL — the Worker before the change takes generation 0 when it cannot read it (${r.status})`);
  else check(r.status === 503, `a session check that cannot read the generation answers 503, not "generation 0" (${r.status})`);
}

// ---------- C4: cross-site GETs ----------
{
  const w = world(); const cookie = await session(0);
  const x = await w.call("GET", "/api/threads?limit=5", { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
  if (CONTROL) check(x.status === 200, `CONTROL — the Worker before the change answers a session's GET from another site (${x.status})`);
  else {
    const same = await w.call("GET", "/api/threads?limit=5", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }), none = await w.call("GET", "/api/threads?limit=5", { Cookie: cookie, "Sec-Fetch-Site": "none" });
    const cli = await w.call("GET", "/api/threads?limit=5", { Authorization: "Bearer cli-secret", "Sec-Fetch-Site": "cross-site" });
    check(x.status === 403 && same.status === 200 && none.status === 200 && cli.status === 200, `a session's GET from another site is refused (${x.status}); the app's own (${same.status}), a native shell's (${none.status}) and the CLI's (${cli.status}) are not`);
  }
}

// ---------- C7: one sender's share of the day's pictures ----------
{
  const pf = M.prefetchImages;
  if (pf) {
    const w = world();
    w.sq.prepare("INSERT INTO events (kind, at, detail) VALUES ('img_prefetch', datetime('now','-1 hour'), 'hub:old from=flood.example n=250 stored=250 had=0 failed=0 over=0 skipped=0 sized=0 bytes=500000 ms=1')").run();
    const html = (tag) => [1, 2, 3].map((i) => `<img src="https://img.${tag}.example/p${i}.png" width="40" height="30">`).join("");
    const a = await pf(w.env, html("flood"), "hub:new1", { from: "news@flood.example", left: { images: 1000, bytes: 60 * 1024 * 1024 } });
    if (CONTROL) check((a.stored || 0) > 0, `CONTROL — the Worker before the change keeps fetching for a sender past any share (${a.stored} stored)`);
    else {
      const b = await pf(w.env, html("calm"), "hub:new2", { from: "hi@calm.example", left: { images: 1000, bytes: 60 * 1024 * 1024 } });
      check((a.stored || 0) === 0 && !!a.over && (b.stored || 0) === 3, `a sender past its share of the day gets none (${a.stored} stored, ${a.over} over); another sender's come (${b.stored} stored)`);
      const ev = w.sq.prepare("SELECT detail FROM events WHERE kind = 'img_prefetch' AND detail LIKE 'hub:new2%'").get()?.detail || "";
      check(/ from=calm\.example /.test(ev), `the day's record names the sender's domain (${ev.slice(0, 60)})`);
    }
  }
}

// ---------- C8: the letterhead quote ----------
if (M.quoteHtml) {
  const q = M.quoteHtml('<p>Hi there</p>a < b<img src=x onerror=alert(1) style="position:fixed"');
  if (CONTROL) check(/<img src=x onerror/.test(q), `CONTROL — the Worker before the change passes an unfinished tag through (${q})`);
  else check(!/<img/i.test(q) && /&lt;img src=x onerror/.test(q) && /<p>Hi there<\/p>/.test(q), `an unfinished tag at the end of a quote is text, the rest kept (${q})`);
}

// ---------- C9: a forged stamp on mail read over IMAP ----------
if (M.ingestRaw) {
  const w = world();
  const raw = (id) => ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=bank.example header.s=s header.b=abcdefgh; dmarc=pass header.from=bank.example", "From: Bank <alerts@bank.example>", "To: sam@work.example", "Subject: Notice", `Message-ID: <${id}@bank.example>`, "Date: Mon, 9 Nov 2026 10:00:00 +0000", "Content-Type: text/plain", "", "hello", ""].join("\r\n");
  await M.ingestRaw(w.env, new TextEncoder().encode(raw("imap1")), { id: "imap1", rcpt: "sam@work.example", envFrom: "alerts@bank.example", source: "imap" });
  const ar = w.sq.prepare("SELECT auth_results FROM messages WHERE id = 'imap1'").get()?.auth_results;
  if (CONTROL) check(!!ar, `CONTROL — the Worker before the change stores a sender-written stamp on IMAP mail as Cloudflare's (${String(ar).slice(0, 40)})`);
  else {
    await M.ingestRaw(w.env, new TextEncoder().encode(raw("cf1")), { id: "cf1", rcpt: "sam@domain2.example", envFrom: "alerts@bank.example", source: "cloudflare" });
    const ar2 = w.sq.prepare("SELECT auth_results FROM messages WHERE id = 'cf1'").get()?.auth_results;
    check(!ar && !!ar2, `a stamp on IMAP mail is not stored as Cloudflare's (${ar}); on mail Cloudflare received it is (${String(ar2).slice(0, 30)}…)`);
  }
}

// ---------- B6: the shell's script policy ----------
{
  const w = world(); const cookie = await session(0);
  const r1 = await w.call("GET", "/", { Cookie: cookie }), r2 = await w.call("GET", "/", { Cookie: cookie });
  const csp1 = r1.headers.get("content-security-policy") || "", csp2 = r2.headers.get("content-security-policy") || "", body = await r1.text();
  const n1 = (/'nonce-([A-Za-z0-9_-]+)'/.exec(csp1) || [])[1], n2 = (/'nonce-([A-Za-z0-9_-]+)'/.exec(csp2) || [])[1];
  if (CONTROL) check(!csp1, `CONTROL — the Worker before the change sends the shell with no policy (${csp1})`);
  else check(/script-src 'self'/.test(csp1) && /object-src 'none'/.test(csp1) && n1 && n2 && n1 !== n2 && n1.length >= 20 && body.includes(`nonce="${n1}" src="/app.js`) && !body.includes("__NONCE__"),
    `the shell carries a script policy with a fresh nonce each time, the same as its script tag's (${n1} / ${n2}; ${csp1.slice(0, 80)})`);
}
globalThis.fetch = realFetch;
console.log(fails.length ? `${fails.length} failed` : "all security-fix checks passed");
process.exit(fails.length ? 1 : 0);
