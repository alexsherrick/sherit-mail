#!/usr/bin/env node
// EXECUTION test for the imap_ops claim and fence, not a source assertion.
// They were right, so this runs the real statements against a real SQLite carrying the real migrations, and simulates two Workers
// racing the same row. Usage: node test/claim.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const db = new DatabaseSync(":memory:");
// Comment lines are stripped PER LINE, not per statement: a statement preceded by a comment block starts with "--", and skipping
// those silently dropped the ALTER TABLEs: the table then had no claimed_at and the whole test errored instead of asserting.
let applied = 0;
for (const f of readdirSync(HUB + "migrations").sort()) {
  // Same decomment as test/ingest.mjs, and for the same reason: migrations 0005/0006 carry trailing "--" comments that
  // contain semicolons, so whole-line stripping let the splitter cut their CREATE TABLE in half and those tables were
  // never created here either.
  const sql = ((t) => { let o = "", q = false;
    for (let i = 0; i < t.length; i++) { const c = t[i];
      if (c === "'") { q = !q; o += c; continue; }
      if (!q && c === "-" && t[i + 1] === "-") { while (i < t.length && t[i] !== "\n") i++; o += "\n"; continue; }
      o += c; } return o; })(readFileSync(HUB + "migrations/" + f, "utf8"));
  for (const stmt of sql.split(";")) { const t = stmt.trim(); if (!t) continue; try { db.exec(t); applied++; } catch (_) {} }
}
{ const cols = db.prepare("PRAGMA table_info(imap_ops)").all().map((c) => c.name);
  check(cols.includes("claimed_at") && cols.includes("claim_token"),
    `the real migrations built the table this test needs (${applied} statements, columns: ${cols.join(", ")})`); }
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// the exact statements the Worker issues
const CLAIM = "UPDATE imap_ops SET status = 'running', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'pending'";
const DONE  = "UPDATE imap_ops SET status = 'done', done_at = ? WHERE id = ? AND status = 'running' AND claim_token = ?";
const FAIL  = "UPDATE imap_ops SET attempts = attempts + 1, error = ?, claimed_at = NULL, claim_token = NULL, status = CASE WHEN attempts + 1 >= 6 THEN 'failed' ELSE 'pending' END WHERE id = ? AND status = 'running' AND claim_token = ?";
const REL   = "UPDATE imap_ops SET status = 'pending', claimed_at = NULL WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)";
const seed = (id, status = "pending") => db.prepare("INSERT INTO imap_ops (id, account, message_id, op, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(id, "a@w.example", "m1", "archive", status, now());

{ // two Workers race the same row; exactly one may win
  seed("op-race");
  const t1 = uuid(), t2 = uuid();
  const w1 = db.prepare(CLAIM).run(now(), t1, "op-race");
  const w2 = db.prepare(CLAIM).run(now(), t2, "op-race");
  check(w1.changes === 1, `the first Worker takes the row (${w1.changes})`);
  check(w2.changes === 0, `the second gets NOTHING and skips it — the op is not applied twice (${w2.changes})`);
}
{ // a stale owner, fenced out, cannot finish or fail someone else's row
  seed("op-stale");
  const tOld = uuid();
  db.prepare(CLAIM).run(now(), tOld, "op-stale");
  db.prepare(REL).run(new Date(Date.now() + 60_000).toISOString());        // lease expires
  const tNew = uuid();
  const reclaim = db.prepare(CLAIM).run(now(), tNew, "op-stale");
  check(reclaim.changes === 1, "after the lease expires a new Worker can re-claim it");
  const staleDone = db.prepare(DONE).run(now(), "op-stale", tOld);
  check(staleDone.changes === 0, `the stale owner cannot mark it done (${staleDone.changes}) — no resurrecting a row it lost`);
  const staleFail = db.prepare(FAIL).run("boom", "op-stale", tOld);
  check(staleFail.changes === 0, `nor bump its attempts (${staleFail.changes}) — no false "GAVE UP" from a stale owner`);
  const realDone = db.prepare(DONE).run(now(), "op-stale", tNew);
  check(realDone.changes === 1, "while the real owner finishes normally");
}
{ // same-second claims must still be distinguishable: this is why the fence is a token, not a timestamp
  seed("op-sec");
  const ts = now(); const a = uuid(), b = uuid();
  db.prepare(CLAIM).run(ts, a, "op-sec");
  db.prepare(REL).run(new Date(Date.now() + 60_000).toISOString());
  db.prepare(CLAIM).run(ts, b, "op-sec");                                   // identical claimed_at, different token
  const wrong = db.prepare(DONE).run(now(), "op-sec", a);
  check(wrong.changes === 0, `two claims sharing a timestamp are still told apart (${wrong.changes}) — a uuid fence cannot collide`);
}
{ // a row stranded before migration 0017 has claimed_at NULL and must still be recoverable
  seed("op-null", "running");
  const rel = db.prepare(REL).run(now());
  const row = db.prepare("SELECT status FROM imap_ops WHERE id = ?").get("op-null");
  check(rel.changes >= 1 && row.status === "pending", `a pre-migration row with NULL claimed_at is released (${row.status})`);
}
// The dwell/orphan logic was itself unverified code;
// It needs no IMAP connection, so it can simply be run.
const ABSENT_INS = "INSERT INTO imap_account_absent (account, first_missing_at, last_confirmed_at) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET last_confirmed_at = excluded.last_confirmed_at";
const RIPE = "SELECT account, first_missing_at FROM imap_account_absent WHERE first_missing_at < ? AND last_confirmed_at > ?";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 864e5, HOUR = 3600e3;
{ // an absence nobody has been watching must not mature in the dark
  db.exec("DELETE FROM imap_account_absent");
  db.prepare(ABSENT_INS).run("stale@w.example", ago(40 * DAY), ago(30 * DAY));   // long gone, but last observed a month ago
  db.prepare(ABSENT_INS).run("watched@w.example", ago(9 * DAY), ago(5 * 60_000)); // long gone AND still being observed
  db.prepare(ABSENT_INS).run("new@w.example", ago(HOUR), ago(60_000));            // observed, but only just left
  const ripe = db.prepare(RIPE).all(ago(7 * DAY), ago(2 * HOUR)).map((r) => r.account);
  console.log("ripe for retirement:", ripe);
  check(ripe.includes("watched@w.example"), "an account absent 9 days AND confirmed missing minutes ago is retired");
  check(!ripe.includes("stale@w.example"), "an absence last confirmed a month ago is NOT retired — it matured unobserved");
  check(!ripe.includes("new@w.example"), "and an account that left an hour ago is nowhere near ripe");
}
{ // a returning mailbox clears its clock, so a later departure starts from zero
  db.exec("DELETE FROM imap_account_absent");
  db.prepare(ABSENT_INS).run("back@w.example", ago(40 * DAY), ago(60_000));
  db.prepare("DELETE FROM imap_account_absent WHERE account IN (?)").run("back@w.example");   // it is configured again
  db.prepare(ABSENT_INS).run("back@w.example", ago(60_000), ago(60_000));                      // and leaves once more, today
  const ripe = db.prepare(RIPE).all(ago(7 * DAY), ago(2 * HOUR)).map((r) => r.account);
  check(!ripe.includes("back@w.example"), "a mailbox that came back and left again starts a fresh seven days, not an instant retirement");
}
{ // the key is canonical, so a case difference cannot leave a row that nothing clears
  db.exec("DELETE FROM imap_account_absent");
  db.prepare(ABSENT_INS).run("Mixed@W.example".toLowerCase(), ago(40 * DAY), ago(60_000));
  const gone = db.prepare("DELETE FROM imap_account_absent WHERE account IN (?)").run("mixed@w.example");
  check(gone.changes === 1, `a lowercased key is cleared by a lowercased DELETE (${gone.changes})`);
}
console.log(fails.length ? "FAILED: " + fails.join("; ") : "all claim/fence checks passed");
process.exit(fails.length ? 1 : 0);
