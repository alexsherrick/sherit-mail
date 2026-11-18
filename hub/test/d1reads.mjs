#!/usr/bin/env node
// The change feed's bounds query. On production D1, `SELECT MIN(seq) mn, MAX(seq) mx FROM thread_changes` read the whole
// table on every device poll (22,169 rows, 98 % of the hub's D1 reads); two single-aggregate subqueries read 2. On the real migrations in
// SQLite: the query index.js runs plans as SEARCH (no SCAN of thread_changes) and returns the same bounds as the old one; CONTROL, the
// old query plans as a SCAN. The Gmail relabel (gmailMirrorCommit) finds each changed message by its primary key and
// changes only those, and its compare-and-swap guard still refuses a stale run; the send-idempotency lookups use the partial indexes of
// migration 0039. CONTROLS: the old relabel form walks the account's date index; without 0039 the lookups scan events.
// Usage: node test/d1reads.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} }
const ins = sq.prepare("INSERT INTO thread_changes (thread_id, op, at) VALUES (?, 'u', ?)");
for (let i = 0; i < 5000; i++) ins.run("t" + i, new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString());
sq.exec("DELETE FROM thread_changes WHERE seq < 40");   // pruned from the bottom, as the hub's retention does
const SRC = readFileSync(HUB + "src/index.js", "utf8");
const used = (SRC.match(/const head = await db\.prepare\("([^"]*thread_changes[^"]*)"\)\.first\(\);/) || [])[1];
check(!!used, `index.js's change-feed bounds query was found (${used})`);
const plan = (q) => sq.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail);
const OLD = "SELECT MIN(seq) mn, MAX(seq) mx FROM thread_changes";
const p = plan(used), pOld = plan(OLD);
check(p.some((d) => /SEARCH thread_changes/.test(d)) && !p.some((d) => /SCAN thread_changes/.test(d)), `the query the hub runs searches thread_changes, no scan (${p.join(" | ")})`);
check(JSON.stringify(sq.prepare(used).get()) === JSON.stringify(sq.prepare(OLD).get()), `and gives the same bounds as before (${JSON.stringify(sq.prepare(used).get())})`);
check(pOld.some((d) => /SCAN thread_changes/.test(d)), `CONTROL: the old query scans the table (${pOld.join(" | ")})`);
// ---------- The Gmail relabel ----------
const migrated = (skip = "") => { const db = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) { if (skip && f.startsWith(skip)) continue; for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { db.exec(st); } catch (_) {} } } return db; };
const stub = (src) => src.replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };').replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_d1reads_worker.mjs"; writeFileSync(tmp, stub(SRC)); const W = await import(tmp).finally(() => unlinkSync(tmp));
{
  const db = migrated(), seen = [];
  const d1 = { prepare(sql) { const mk = (params) => ({ bind: (...a) => mk(a), run: async () => { seen.push(sql); return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; }, first: async () => db.prepare(sql).get(...params) ?? null, all: async () => ({ results: db.prepare(sql).all(...params) }) }); return mk([]); }, batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; } };
  db.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, mirror_state, mirror_history_id, mirror_progress) VALUES ('a@x', 'x', 'x', 's', 'active', '2026', 'ready', '5', '{\"v\":1}')").run();
  const ins = db.prepare("INSERT INTO gmail_messages (account, id, thread_id, labels, internal_date, meta, history_id, updated_at) VALUES ('a@x', ?, ?, '[]', ?, '{}', '1', 'x')");
  for (let i = 0; i < 7600; i++) ins.run("m" + i, "t" + i, 1e12 + i);
  const relabel = Array.from({ length: 50 }, (_, i) => ({ id: "m" + i * 97, l: '["INBOX"]', h: "9" }));
  const acct = db.prepare("SELECT * FROM gmail_accounts WHERE email = 'a@x'").get();
  const changed = await W.gmailMirrorCommit(d1, acct, { relabel, state: "ready", cursor: "6", progress: {}, synced: true });
  const inbox = db.prepare("SELECT COUNT(*) n FROM gmail_messages WHERE labels = '[\"INBOX\"]'").get().n, hit = db.prepare("SELECT COUNT(*) n FROM gmail_messages WHERE id IN ('m0','m97','m4753') AND labels = '[\"INBOX\"]'").get().n;
  check(changed === 1 && inbox === 50 && hit === 3, `the relabel changes exactly the 50 listed messages of 7,600, and the commit lands (${inbox} relabelled, commit ${changed})`);
  const stale = await W.gmailMirrorCommit(d1, acct, { relabel: [{ id: "m1", l: '["SPAM"]', h: "10" }], state: "ready", cursor: "7", progress: {}, synced: true });
  check(stale === 0 && db.prepare("SELECT labels FROM gmail_messages WHERE id = 'm1'").get().labels === "[]", `a run with a stale cursor still changes nothing (commit ${stale})`);
  const sql = seen.find((q) => /UPDATE gmail_messages SET labels/.test(q)), pl = plan(sql.replace(/\?/g, "NULL"));
  check(pl.some((d) => /SEARCH gmail_messages USING INDEX sqlite_autoindex_gmail_messages_1 \(account=\? AND id=\?\)/.test(d)) && !pl.some((d) => /ix_gmail_messages_date/.test(d)), `each changed message is found by its primary key (${pl.join(" | ")})`);
  const guard = "EXISTS (SELECT 1 FROM gmail_accounts WHERE email = NULL AND mirror_history_id IS NULL AND json_extract(mirror_progress, '$.v') IS NULL)";
  const OLDR = `UPDATE gmail_messages SET labels = j.l, history_id = COALESCE(j.h, gmail_messages.history_id), updated_at = NULL FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.l') AS l, json_extract(value, '$.h') AS h FROM json_each(NULL)) AS j WHERE gmail_messages.account = NULL AND gmail_messages.id = j.id AND (gmail_messages.history_id IS NULL OR j.h IS NULL OR CAST(gmail_messages.history_id AS INTEGER) <= CAST(j.h AS INTEGER)) AND ${guard}`;
  const po = plan(OLDR);
  check(po.some((d) => /ix_gmail_messages_date \(account=\?\)/.test(d)), `CONTROL: the old relabel walks the account's date index (${po.join(" | ")})`);
}
// ---------- The send-idempotency lookups ----------
{
  const lookups = [...SRC.matchAll(/db\.prepare\("(SELECT [^"]*FROM events WHERE kind (?:= 'send_idem'|IN \('send_attempt','send_idem','send_sent','send_failed'\)) AND detail LIKE \?[^"]*)"\)/g)].map((m) => m[1].replace(/\?/g, "NULL"));
  const withIdx = migrated(), without = migrated("0039");
  const p1 = lookups.map((q) => withIdx.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail).join(" | "));
  const p0 = lookups.map((q) => without.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail).join(" | "));
  check(lookups.length === 2 && p1.every((p) => /USING (COVERING )?INDEX ix_events_send/.test(p)), `both send lookups use their partial index (${p1.join(" || ")})`);
  check(p0.every((p) => /SCAN events(?! USING)/.test(p)), `CONTROL: without migration 0039 they scan events (${p0.join(" || ")})`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
