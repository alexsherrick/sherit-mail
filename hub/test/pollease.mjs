#!/usr/bin/env node
// One Gmail poll per mailbox at a time. Pub/Sub delivers notifications in bursts and
// each started a poll of the same mailbox; overlapping runs fetched the same history and ran the sender rules twice (gmail_poll_dup,
// up to 11 a day). Pinned here against real migrations and real SQLite, with the poll body replaced by a probe:
//  two runs at once poll in turn, never together, and the second run's change is polled before the lease is let go;
//  a burst of five becomes two polls, not five; a poll that throws still lets go; a lease left by a dead run expires;
//  before the migration the poll runs as it always did.
// Usage: node test/pollease.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const fresh = (upTo = "9999") => {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    if (f.slice(0, 4) > upTo) continue;
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
  }
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at) VALUES ('me@gmail.example', 'x', 'x', 's', 'active', '2026-10-07')").run();
  return sq;
};
// Like D1: every statement is its own round trip, so other runs interleave between them.
const d1 = (sq) => ({ prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; }, first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { await tick(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); } });
const tick = () => new Promise((r) => setImmediate(r));
const SRC = readFileSync(process.env.LEASE_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_pollease.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
const E = "me@gmail.example";
const lease = (sq) => sq.prepare("SELECT poll_lease_until, poll_lease_token, poll_again FROM gmail_accounts WHERE email = ?").get(E);
// A probe poll: counts runs, records whether two ever overlap, and can be held open until released.
const probe = () => { const p = { runs: 0, live: 0, maxLive: 0, gates: [] }; p.fn = async () => { p.runs++; p.live++; p.maxLive = Math.max(p.maxLive, p.live); await new Promise((r) => p.gates.push(r)); p.live--; return { a: E, new: 0 }; }; p.open = async () => { for (let i = 0; i < 50 && !p.gates.length; i++) await tick(); const g = p.gates.shift(); if (g) g(); return !!g; }; return p; };

{ // two runs at once: the second leaves the flag; the holder polls again before letting go
  const sq = fresh(), db = d1(sq), p = probe();
  const a = mod.withMailboxLease(db, E, p.fn); await tick(); await tick(); await tick();
  const b = mod.withMailboxLease(db, E, p.fn);
  const rb = await b;
  check(rb && rb.queued && p.runs === 1 && lease(sq).poll_again === 1, `a run that finds the mailbox being polled leaves the flag and returns (${JSON.stringify(rb)}, flag ${lease(sq).poll_again})`);
  await p.open(); await p.open(); await a;
  check(p.runs === 2 && p.maxLive === 1, `the holder polls once more for it, and the two polls never overlap (runs ${p.runs}, most at once ${p.maxLive})`);
  const l = lease(sq); check(l.poll_lease_until === null && l.poll_lease_token === null && l.poll_again === 0, `then the lease is let go, with no flag left (${JSON.stringify(l)})`);
}
{ // a burst of five: two polls, not five
  const sq = fresh(), db = d1(sq), p = probe();
  const runs = [mod.withMailboxLease(db, E, p.fn)]; await tick(); await tick(); await tick();
  for (let i = 0; i < 4; i++) runs.push(mod.withMailboxLease(db, E, p.fn));
  for (let i = 0; i < 6; i++) await p.open();
  await Promise.all(runs);
  check(p.runs === 2 && p.maxLive === 1, `five notifications at once become two polls, one at a time (${p.runs} polls, most at once ${p.maxLive})`);
}
{ // a poll that throws still lets go
  const sq = fresh(), db = d1(sq);
  let threw = false; try { await mod.withMailboxLease(db, E, async () => { throw new Error("history 500"); }); } catch (_) { threw = true; }
  check(threw && lease(sq).poll_lease_until === null, `a poll that throws still releases the lease (threw ${threw}, lease ${lease(sq).poll_lease_until})`);
  let ran = 0; await mod.withMailboxLease(db, E, async () => { ran++; return {}; });
  check(ran === 1, "and the next poll runs");
}
{ // a lease left by a run that died expires
  const sq = fresh(), db = d1(sq);
  sq.prepare("UPDATE gmail_accounts SET poll_lease_until = ?, poll_lease_token = 'dead' WHERE email = ?").run(Date.now() + 30_000, E);
  let ran = 0; const r = await mod.withMailboxLease(db, E, async () => { ran++; return {}; });
  check(ran === 0 && r.queued, "a live lease held by another run is respected");
  sq.prepare("UPDATE gmail_accounts SET poll_lease_until = ?, poll_lease_token = 'dead' WHERE email = ?").run(Date.now() - 1, E);
  await mod.withMailboxLease(db, E, async () => { ran++; return {}; });
  check(ran === 1, "an expired one (its run died) is taken over");
}
{ // before migration 0034 the poll runs unleased, as it always did
  const sq = fresh("0033"), db = d1(sq);
  let ran = 0; await mod.withMailboxLease(db, E, async () => { ran++; return {}; });
  check(ran === 1, `without the lease columns the poll still runs (${ran})`);
}
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall poll-lease checks passed");
