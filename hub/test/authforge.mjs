#!/usr/bin/env node
// EXECUTION test: a Google sign-in state is never a session, and the Gmail-connect error page runs no script.
// GET /auth/google hands anyone a state `${exp}.${uuid}.${hmac(exp.uuid)}` (the session cookie's shape
// under the same key) and sessionValid read the uuid's leading digits with parseInt, so about one state in forty was a session (full
// API access for its ten minutes, no sign-in, no click). And /auth/gmail/callback?error=<markup> wrote the markup into a page on the
// hub's origin, where the signed-in user's browser ran it.
// Checks, on the real Worker over the real migrations: 600 states from /auth/google, each sent as the cookie, open nothing; at session
// generation 0 and at 3; a real session still opens /api/me, a revoked generation's does not; a fresh state still passes the callback's
// own check (it reaches Google's token exchange) and a state signed the old way does not; the error page escapes the markup and carries a
// script-free CSP.
// CONTROL: AUTHFORGE_SRC=<the Worker before the change> forges a session and echoes the markup.
// Usage: node test/authforge.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const CONTROL = !!process.env.AUTHFORGE_SRC;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} } return sq; }
const d1 = (sq) => { const run = (sql, p, kind) => { const st = sq.prepare(sql); return kind === "all" ? { results: st.all(...p) } : kind === "first" ? (st.get(...p) ?? null) : { meta: { changes: Number(st.run(...p).changes) } }; };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a.map((v) => (v === undefined ? null : v))), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
    batch: async (xs) => Promise.all(xs.map((x) => x.run())) }; };
const SRC = readFileSync(process.env.AUTHFORGE_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_authforge_worker.mjs`; writeFileSync(tmp, SRC); const mod = await import(tmp).finally(() => unlinkSync(tmp));
const worker = mod.default;

const SECRET = "test-session-secret", ORIGIN = "https://hub.example";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const session = async (gen) => { const exp = Date.now() + 86400000; return `mh=${exp}.${gen}.${await hmac(SECRET, `${exp}.${gen}`)}`; };
const sq = buildDb();
const env = { DB: d1(sq), SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", ALLOWED_GOOGLE_EMAIL: "founder@example.com", CLI_TOKEN: "cli-secret",
  GMAIL_CLIENT_ID: "gid", GMAIL_CLIENT_SECRET: "gsec", GMAIL_TOKEN_KEY: "k".repeat(44), DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, { headers }), env, ctx);
const setGen = (g) => sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('session_gen', ?, '2026-11-09') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(g));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));   // the generation is cached for 5 s per database (sessionGen)

async function forge(tries) {
  let opened = 0;
  for (let i = 0; i < tries; i++) {
    const r = await get("/auth/google"); const st = new URL(r.headers.get("location")).searchParams.get("state");
    if ((await get("/api/me", { Cookie: `mh=${st}` })).status === 200) opened++;
  }
  return opened;
}

// 1. a state from /auth/google, sent as the session cookie
setGen(0); await wait(5100);
const at0 = await forge(600);
if (CONTROL) check(at0 > 0, `CONTROL — the Worker before the change takes a sign-in state as a session (${at0} of 600 at generation 0)`);
else check(at0 === 0, `no sign-in state opens the API at generation 0 (${at0} of 600)`);
if (!CONTROL) {
  setGen(3); await wait(5100);
  const at3 = await forge(600);
  check(at3 === 0, `… nor at generation 3 (${at3} of 600)`);
  // 2. real sessions still work; a revoked generation's do not
  check((await get("/api/me", { Cookie: await session(3) })).status === 200, "a session of the current generation opens /api/me");
  check((await get("/api/me", { Cookie: await session(0) })).status === 401, "a session of a revoked generation does not");
  check((await get("/api/me", { Cookie: await session("03") })).status === 401, "a generation written any other way (\"03\") does not");
  // 3. the callback still takes a fresh state (it gets as far as Google's token exchange), and not one signed the old way
  const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const st = new URL((await get("/auth/google")).headers.get("location")).searchParams.get("state");
    const ok = await (await get(`/auth/google/callback?code=c&state=${encodeURIComponent(st)}`, { Cookie: `mh_oauth=${st}` })).text();
    check(/token exchange failed/.test(ok), `a fresh state passes the callback's check (${ok.slice(0, 80)})`);
    const exp = Date.now() + 600000, nonce = crypto.randomUUID(), old = `${exp}.${nonce}.${await hmac(SECRET, `${exp}.${nonce}`)}`;
    const bad = await (await get(`/auth/google/callback?code=c&state=${encodeURIComponent(old)}`, { Cookie: `mh_oauth=${old}` })).text();
    check(/state invalid or expired/.test(bad), `a state signed the old way does not (${bad.slice(0, 80)})`);
  } finally { globalThis.fetch = realFetch; }
}
// 4. the Gmail-connect error page
const evil = '<img src=x onerror=alert(document.domain)>';
const r = await get(`/auth/gmail/callback?error=${encodeURIComponent(evil)}`, { Cookie: await session(CONTROL ? 0 : 3) });
const body = await r.text(), csp = r.headers.get("content-security-policy") || "";
if (CONTROL) check(body.includes(evil), `CONTROL — … and writes the error parameter's markup into the page (${r.status})`);
else {
  // The page shows the app's ghost, so it has one <img>: the hub's own icon, and never the parameter's.
  const imgs = body.match(/<img\b[^>]*>/g) || [];
  check(!body.includes(evil) && imgs.length === 1 && imgs[0].startsWith('<img src="/icons/icon-512.png"') && body.includes("&lt;img src=x onerror=alert(document.domain)&gt;"), `the Gmail-connect error page escapes the error parameter (${imgs.length} img; ${body.slice(body.indexOf("<h1>"), body.indexOf("<h1>") + 160)})`);
  check(/default-src 'none'/.test(csp) && !/script-src|unsafe-inline|unsafe-eval/.test(csp), `… and runs no script (${csp})`);
}
console.log(fails.length ? `${fails.length} failed` : "all auth checks passed");
process.exit(fails.length ? 1 : 0);
