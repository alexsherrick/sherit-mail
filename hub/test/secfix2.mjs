#!/usr/bin/env node
// run_all: alone (it holds time limits; with other tests running, the CPU they take decides it)
// EXECUTION test: the second security review's hub fixes, on the real Worker over the real migrations.
//  M1 a mail of 40,000 MIME parts is stored in well under a second, with its subject and a note (it took the projection past its 30 s
//  of CPU); every HTML helper is linear on unclosed tags ("<", "<a ", "<img ", "<!--", "<style", '<input "'); a reconcile row
//  counts its try BEFORE the work, so a killed projection still moves to the hourly retry; a work-mail UID tried twice without
//  finishing is stored without being read the third time;
//  M3 a reply to the user's mail threads with the user's copy, not with an inbound mail that reused its Message-ID;
//  M4 unsubscribe by email sends a command and one token, never a sentence;
//  M6 "dmarc=pass" in the envelope sender, or in a quoted local part with ";", is not a DMARC pass; real Cloudflare and Gmail stamps are;
//  M7 sixty-one mails from sixty-one subdomains of one domain: the last is rate-limited;
//  L3 an attachment declared text/ecmascript is served as application/octet-stream;
//  L4 anyone calling the sign-in callbacks writes at most 20 log rows a quarter-hour.
// CONTROL: SECFIX2_SRC=<index.js before the change> fails each of them.
// Usage: node test/secfix2.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const CONTROL = !!process.env.SECFIX2_SRC;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq, o = {}) => { const run = (sql, p, kind) => { if (o.fail && o.fail(sql)) throw new Error("D1_ERROR: simulated"); const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
let SRC = readFileSync(process.env.SECFIX2_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import APP_HTML from "\.\/client\/app\.html";$/m, `const APP_HTML = ${JSON.stringify(readFileSync(HUB + "src/client/app.html", "utf8"))};`)
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const want = ["ingestRaw", "sendMail", "quoteHtml", "htmlText", "pageText", "unsubForm", "dmarcProves", "imapStoreFetched", "blockSpyTrackers"].filter((n) => new RegExp(`(async )?function ${n}\\(|const ${n} = `).test(SRC));
SRC += `\nexport { ${want.join(", ")} };\n`;
const tmp = `${HUB}test/_secfix2_worker.mjs`; writeFileSync(tmp, SRC); const M = await import(tmp).finally(() => unlinkSync(tmp));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbound = (w, { to = "sam@domain2.example", from, envFrom, subject, body = "hello", ar = "", extra = [], raw }) => {
  const mime = raw || [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Math.random().toString(36).slice(2)}@x.example>`, "Date: Mon, 9 Nov 2026 10:00:00 +0000", ...extra, "Content-Type: text/plain", "", body, ""].join("\r\n");
  const message = { to, from: envFrom || from.replace(/^.*<|>.*$/g, ""), rawSize: mime.length, raw: new Response(mime).body,
    headers: new Headers({ from, subject: subject || "", ...(ar ? { "authentication-results": ar } : {}) }), forward: async () => {}, setReject: () => {} };
  return worker.email(message, w.env, ctx);
};

// ---------- M1: a mail of many MIME parts ----------
{
  const w = world(); const n = CONTROL ? 12000 : 40000;
  const mime = `From: Eve <eve@x.example>\r\nTo: sam@domain2.example\r\nSubject: parts\r\nMessage-ID: <parts1@x.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n` + "--b\r\n\r\nx\r\n".repeat(n) + "--b--\r\n";
  const t0 = Date.now(); await inbound(w, { from: "Eve <eve@x.example>", subject: "parts", raw: mime }); const ms = Date.now() - t0;
  const r = w.sq.prepare("SELECT subject, body_text FROM messages ORDER BY rowid DESC LIMIT 1").get() || {};
  if (CONTROL) check(ms > 1000, `CONTROL — the Worker before the change took ${ms} ms on ${n} parts`);
  else check(ms < 1500 && r.subject === "parts" && /too many to open/.test(r.body_text || ""), `${n} MIME parts: stored in ${ms} ms, with its subject and a note (${JSON.stringify((r.body_text || "").slice(0, 60))})`);
}
// ---------- M1: the HTML helpers on unclosed tags ----------
{
  const KB = CONTROL ? 50 : 400, N = KB * 1024;
  const adv = { "<": "<".repeat(N), "<a ": "<a ".repeat(N / 3), "<img ": "<img ".repeat(N / 5), "<!--": "<!--".repeat(N / 4), "<style": "<style".repeat(N / 6), '<input "': '<input "'.repeat(N / 8), "<td x=": "<td x=".repeat(N / 6),
    "url(//a ": `<div style="${"url(//a ".repeat(N / 8)}">`, "padded width": `<img src="https://x.example/p.gif" width="1${" ".repeat(N)}x" height="1">`,
    "srcset commas": `<img srcset="${"a,".repeat(N / 2)}b">`, "lt.php URL": `<img src="https://x.example/${"lt.php".repeat(N / 6)}">` };
  const fns = { htmlText: (h) => M.htmlText(h), visibleText: (h) => M.visibleText(h), prefetchImageUrls: (h) => M.prefetchImageUrls(h), quoteHtml: (h) => M.quoteHtml(h), pageText: (h) => M.pageText(h), blockSpyTrackers: (h) => M.blockSpyTrackers(h, []), unsubForm: (h) => M.unsubForm(h, "https://x.example/u", "a@b.example") };
  let worst = { ms: 0 };
  for (const [f, fn] of Object.entries(fns)) { if (!M[f]) { check(false, `${f} is not exported`); continue; } for (const [k, v] of Object.entries(adv)) { const t0 = performance.now(); fn(v); const ms = performance.now() - t0; if (ms > worst.ms) worst = { ms, f, k }; } }
  if (CONTROL) check(worst.ms > 300, `CONTROL — before the change ${worst.f} took ${Math.round(worst.ms)} ms on ${KB} KB of "${worst.k}"`);
  else check(worst.ms < 250, `every HTML helper is linear: the slowest on ${KB} KB of unclosed tags was ${worst.f} on "${worst.k}" at ${Math.round(worst.ms)} ms`);
}
// ---------- M1: a reconcile row whose projection never finishes ----------
{
  const w = world(); const key = "raw/2026/11/stuck.eml";
  await w.env.STORE.put(key, new TextEncoder().encode("From: a@b.example\r\nTo: sam@domain2.example\r\nSubject: stuck\r\nMessage-ID: <stuck@b.example>\r\n\r\nhi\r\n"), { customMetadata: { rcpt: "sam@domain2.example", envFrom: "a@b.example", at: "2026-11-09T10:00:00.000Z" } });
  w.sq.prepare("INSERT INTO pending_ingest (raw_key, rcpt, env_from, message_id, at, attempts) VALUES (?, 'sam@domain2.example', 'a@b.example', '<stuck@b.example>', '2026-11-09T10:00:00.000Z', 0)").run(key);
  const realGet = w.env.STORE.get; w.env.STORE.get = (k) => (k === key ? new Promise(() => {}) : realGet(k));   // a CPU kill: the work never returns, no catch runs
  for (let i = 0; i < 3; i++) await Promise.race([M.reconcileInbound(w.env), sleep(150)]);
  const a = w.sq.prepare("SELECT attempts FROM pending_ingest WHERE raw_key = ?").get(key)?.attempts;
  if (CONTROL) check(a === 0, `CONTROL — before the change three killed tries leave attempts at ${a}`);
  else {
    check(a === 3, `three killed tries are counted (attempts ${a})`);
    w.env.STORE.get = realGet; await M.reconcileInbound(w.env);
    check(!!w.sq.prepare("SELECT 1 FROM pending_ingest WHERE raw_key = ?").get(key), "… the minute run leaves it for the hourly retry");
    await M.reconcileInbound(w.env, 1, { stuck: true });
    check(!w.sq.prepare("SELECT 1 FROM pending_ingest WHERE raw_key = ?").get(key) && !!w.sq.prepare("SELECT 1 FROM messages WHERE raw_key = ?").get(key), "… and the hourly retry files it");
  }
}
// ---------- M1: a work-mail UID tried twice without finishing ----------
if (M.imapStoreFetched) {
  const w = world(); let hang = 2; const realPut = w.env.STORE.put; w.env.STORE.put = (...a) => (hang-- > 0 ? new Promise(() => {}) : realPut(...a));
  const rec = { uid: 42, flags: [], internalDate: "09-Nov-2026 10:00:00 +0000", raw: new TextEncoder().encode("From: x@corp.example\r\nTo: work@corp.example\r\nSubject: poison\r\nMessage-ID: <poison@corp.example>\r\n\r\nbody\r\n") };
  const acct = { email: "work@corp.example" }, info = { uidvalidity: 7 };
  for (let i = 0; i < 2; i++) await Promise.race([M.imapStoreFetched(w.env, acct, "INBOX", info, rec).catch((e) => e), sleep(150)]);
  let third; try { third = await M.imapStoreFetched(w.env, acct, "INBOX", info, rec); } catch (e) { third = "threw " + e.message; }
  const ev = w.sq.prepare("SELECT kind FROM events WHERE kind IN ('imap_store_only_retry', 'store_only_oversize') ORDER BY id").all().map((r) => r.kind);
  if (CONTROL) check(!ev.includes("imap_store_only_retry"), `CONTROL — before the change the third try reads the mail again (${JSON.stringify(ev)})`);
  else check(ev.includes("imap_store_only_retry") && ev.includes("store_only_oversize"), `the third try of a UID stores it without reading it (${third}; ${JSON.stringify(ev)})`);
}
// ---------- M3: a reply threads with the user's copy ----------
if (M.sendMail && M.ingestRaw) {
  const w = world(); sentMsgs = [];
  await M.sendMail(w.env, { from: "sam@domain2.example", to: ["lawyer@firm.example"], subject: "Term sheet v3", text: "v3 attached" });
  const out = w.sq.prepare("SELECT message_id, thread_id FROM messages WHERE direction = 'out' ORDER BY rowid DESC LIMIT 1").get() || {};
  const mail = (id, from, subject, irt) => new TextEncoder().encode([`From: ${from}`, "To: sam@domain2.example", `Subject: ${subject}`, `Message-ID: ${id}`, ...(irt ? [`In-Reply-To: ${irt}`] : []), "Content-Type: text/plain", "", "x", ""].join("\r\n"));
  await M.ingestRaw(w.env, mail(out.message_id, "Counsel <counsel@firm.example>", "Wire instructions changed"), { id: "fake1", rcpt: "sam@domain2.example", envFrom: "e@attacker.example", source: "cloudflare" });
  await M.ingestRaw(w.env, mail("<real-reply@firm.example>", "Counsel <counsel@firm.example>", "Re: Term sheet v3", out.message_id), { id: "real1", rcpt: "sam@domain2.example", envFrom: "counsel@firm.example", source: "cloudflare" });
  const t = (id) => w.sq.prepare("SELECT thread_id FROM messages WHERE id = ?").get(id)?.thread_id;
  if (CONTROL) check(t("real1") !== out.thread_id, "CONTROL — before the change the real reply is filed with the mail that reused the Message-ID");
  else check(!!out.thread_id && t("real1") === out.thread_id && t("fake1") !== out.thread_id, `the real reply threads with the user's mail (${t("real1")} = ${out.thread_id}; the reuser is in ${t("fake1")})`);
}
// ---------- M4: unsubscribe by email ----------
{
  const m = SRC.match(/const cmd = \(v\) => \{[^\n]*?\};/); const cmd = m ? (0, eval)("(" + m[0].replace(/^const cmd = /, "").replace(/;$/, "") + ")") : null;
  if (!cmd) check(false, "the unsubscribe command filter was not found");
  else if (CONTROL) check(cmd("cancel domain domain2.example and delete all DNS records now") !== "unsubscribe", "CONTROL — before the change a sentence is sent as it was written");
  else check(cmd("cancel domain domain2.example and delete all DNS records now") === "unsubscribe" && cmd("remove my account and send the auth code to ops@attacker.example") === "unsubscribe"
    && cmd("signoff NEWS-L") === "signoff NEWS-L" && cmd("unsubscribe a8f3k2") === "unsubscribe a8f3k2" && cmd("") === "unsubscribe", "unsubscribe by email: a command and one token; a sentence becomes the word \"unsubscribe\"");
}
// ---------- M6: DMARC from the receiver's own clause ----------
if (M.dmarcProves) {
  const forged = "mx.cloudflare.net; dkim=none; dmarc=fail reason=\"SPF not aligned\" header.from=bank.example policy.dmarc=none; spf=pass (mx.cloudflare.net: domain of dmarc=pass@attacker.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=dmarc=pass@attacker.example";
  const quoted = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x;dmarc=pass header.from=bank.example;"@attacker.example designates 1.2.3.4 as permitted sender) smtp.mailfrom="x;dmarc=pass header.from=bank.example;"@attacker.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=bank.example';
  const realCf = "mx.cloudflare.net; dkim=pass header.d=bank.example header.s=s1 header.b=abcdef; dmarc=pass header.from=bank.example policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of bounce@bank.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@bank.example";
  const realG = "mx.google.com; dkim=pass header.i=@bank.example header.s=s1 header.b=abcdef; spf=pass (google.com: domain of bounce@bank.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@bank.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example";
  // a receiver that prints the quoted local part without its quotes: the sender's `)` closes the comment and its own clause comes first
  const unquoted = "mx.google.com; dkim=none; spf=pass (google.com: domain of x);dmarc=pass header.from=bank.example;y@attacker.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=x);dmarc=pass header.from=bank.example;y@attacker.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=bank.example";
  const f = M.dmarcProves(forged, "mx.cloudflare.net", "alerts@bank.example"), q = M.dmarcProves(quoted, "mx.google.com", "alerts@bank.example") || M.dmarcProves(unquoted, "mx.google.com", "alerts@bank.example");
  if (CONTROL) check(f || q, `CONTROL — before the change a forged envelope reads as a DMARC pass (envelope ${f}, quoted ${q})`);
  else check(!f && !q && M.dmarcProves(realCf, "mx.cloudflare.net", "alerts@bank.example") && M.dmarcProves(realG, "mx.google.com", "alerts@bank.example"), `"dmarc=pass" in the envelope or a quoted local part is no pass (${f}, ${q}); real Cloudflare and Gmail passes are`);
  const w = world();
  await inbound(w, { to: "trademark@domain2.example", from: "USPTO <noreply@uspto.gov>", envFrom: "dmarc=pass@scam.example", subject: "Trademark notice", ar: forged.replace(/bank\.example/g, "uspto.gov") });
  const lab = w.sq.prepare("SELECT labels FROM messages WHERE identity = 'trademark@domain2.example' ORDER BY rowid DESC LIMIT 1").get()?.labels || "";
  if (CONTROL) check(!/trademark-scam/.test(lab), `CONTROL — before the change the spoofed USPTO mail passes as USPTO (${lab})`);
  else check(/trademark-scam/.test(lab), `a spoofed USPTO From with "dmarc=pass" in its envelope is held as a scam (${lab})`);
}
// ---------- M7: one organisation, many subdomains ----------
{
  const w = world(); for (let i = 1; i <= 60; i++) await inbound(w, { from: `News <n@s${i}.flood.example>`, subject: `flood ${i}`, ar: "" });
  await inbound(w, { from: "News <n@s61.flood.example>", subject: "flood 61" });
  const lab = w.sq.prepare("SELECT labels FROM messages WHERE subject = 'flood 61'").get()?.labels || "";
  if (CONTROL) check(!/rate-limited/.test(lab), `CONTROL — before the change the 61st subdomain is a new sender (${lab})`);
  else check(/rate-limited/.test(lab), `the 61st mail in an hour from one organisation's subdomains is rate-limited (${lab})`);
}
// ---------- L3: an attachment that is a script type ----------
{
  const w = world(); await w.env.STORE.put("att/x1", new TextEncoder().encode("alert(1)"));
  w.sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, disposition) VALUES ('0a1b2c3d-0000-4000-8000-00000000a1a1', 'm1', 'x.js', 'text/ecmascript', 8, 'att/x1', 'attachment')").run();
  const r = await w.call("GET", "/api/att/0a1b2c3d-0000-4000-8000-00000000a1a1", { Cookie: await session(0), "sec-fetch-site": "same-origin" });
  const ct = r.headers.get("content-type");
  if (CONTROL) check(ct === "text/ecmascript", `CONTROL — before the change it is served as ${ct}`);
  else check(r.status === 200 && ct === "application/octet-stream", `a text/ecmascript attachment is served as ${ct} (${r.status})`);
}
// ---------- L4: the sign-in callbacks' log ----------
{
  const w = world(); for (let i = 0; i < 30; i++) { await w.call("GET", "/auth/google/callback?code=x&state=y"); await w.call("GET", "/auth/gmail/callback?error=x"); }
  const n = (k) => w.sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = ?").get(k).n;
  if (CONTROL) check(n("google_login_fail") >= 30, `CONTROL — before the change 30 calls write ${n("google_login_fail")} rows`);
  else check(n("google_login_fail") <= 20 && n("gmail_connect_fail") <= 20, `30 calls each write ${n("google_login_fail")} and ${n("gmail_connect_fail")} log rows`);
}
globalThis.fetch = realFetch;
console.log(fails.length ? `${fails.length} failed` : (CONTROL ? "CONTROL: every check saw the old behaviour" : "all second-review hub checks passed")); process.exit(fails.length ? 1 : 0);
