#!/usr/bin/env node
// EXECUTION test: a send goes out once, however its retries arrive (findings bf1d496443, 9071a5e189, a0a3a82192, 6e56f01724; the
// reservation added). The real Worker, the real migrations in SQLite, a fake R2 and a send binding the test can
// hold open, so the second request of a race arrives while the first mail is still going out.
//
// The defect: sendMail looked for the idempotency key in events before sending and wrote it only after the mail, its stored copy and
// its rows. A retry of the same queued send (a phone that lost the answer, a platform 5xx) arriving in between found nothing and sent
// the mail a second time. CONTROL: UNSUBJOB_SRC-style, SENDCLAIM_SRC=<the Worker before the change> fails the race.
// Usage: node test/sendclaim.mjs
import { DatabaseSync } from "node:sqlite";
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
const SRC = readFileSync(process.env.SENDCLAIM_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_sendclaim_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

function world() {
  const sq = buildDb(); const objs = new Map(); const sends = []; let gate = null, failNext = 0;
  sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('sam@domain2.example', 'Sam', 1, 'domain2.example')").run();
  const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "domain2.example",
    STORE: { put: async (k, v) => { objs.set(k, v); }, get: async (k) => (objs.has(k) ? { body: objs.get(k), arrayBuffer: async () => new ArrayBuffer(0) } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } },
    EMAIL: { send: async (m) => { if (failNext > 0) { failNext--; throw new Error("EMAIL binding: upstream 503"); } sends.push(m); if (gate) await gate; return { messageId: `<p${sends.length}@domain2.example>` }; } } };
  const call = async (body) => { const r = await mod.default.fetch(new Request("https://hub.example/api/send", { method: "POST", headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { sq, env, sends, call, hold: () => { let open; gate = new Promise((r) => (open = r)); return () => { gate = null; open(); }; }, failOnce: () => { failNext = 1; } };
}
const mail = (key) => ({ from: "sam@domain2.example", to: ["friend@example.com"], subject: "Dinner", text: "Thursday?", idempotency_key: key });

{ // the race: a retry of the same send arrives while the first is still going out
  const w = world(); const release = w.hold();
  const first = w.call(mail("row-key-0001"));
  await new Promise((r) => setTimeout(r, 30));          // the first is inside EMAIL.send now
  const secondP = w.call(mail("row-key-0001"));         // the old code sent again here and waited on the same hold
  await new Promise((r) => setTimeout(r, 100)); release();
  const [one, second] = await Promise.all([first, secondP]);
  check(one.status === 200 && !!one.body?.id, `the first send goes (${one.status})`);
  check(w.sends.length === 1, `the retry that raced it does not send a second time (${w.sends.length} send(s))`);
  check(second.status === 409 && second.body?.code === "ambiguous_send", `the retry is told it may already be on its way, 409 ambiguous_send, which the app shows as "Not confirmed" (${second.status} ${second.body?.code})`);
  const third = await w.call(mail("row-key-0001"));
  check(third.status === 200 && third.body?.dedup === true && third.body?.id === one.body?.id && w.sends.length === 1, `a retry after it finished gets the same message back, not a new send (${third.status} dedup ${third.body?.dedup})`);
}
{ // the binding threw once the mail was handed to it: it may have gone, so the key stays held
  const w = world(); w.failOnce();
  const a = await w.call(mail("row-key-0002"));
  check(a.status === 400 && w.sends.length === 0, `the binding threw: the app hears it failed (${a.status})`);
  const b = await w.call(mail("row-key-0002"));
  check(b.status === 409 && b.body?.code === "ambiguous_send" && w.sends.length === 0, `a retry of the same send is not sent again: it may have gone (${b.status} ${b.body?.code})`);
  check(w.sq.prepare("SELECT state FROM send_claims WHERE key = 'row-key-0002'").get()?.state === "sending", "and the key stays held");
  const c = await w.call(mail("row-key-0099"));
  check(c.status === 200 && w.sends.length === 1, "a new send (the user sending it again, a new key) goes");
}
{ // different keys are different sends; no key, no reservation
  const w = world();
  await w.call(mail("row-key-0003")); await w.call(mail("row-key-0004")); await w.call({ ...mail(undefined) });
  check(w.sends.length === 3, `two keys and a keyless send: three sends (${w.sends.length})`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
