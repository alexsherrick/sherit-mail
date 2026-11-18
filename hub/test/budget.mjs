// D1 budget receipt: what one cron minute costs, measured, not reasoned about.
//
// Cloudflare began ENFORCING the Workers Free D1 limits on 2026-09-01: 5,000,000 rows READ and 100,000 rows WRITTEN per UTC day,
// after which queries fail outright until midnight UTC. "Rows read" is rows SCANNED to answer a query, not rows returned, so an
// unindexed query over a growing table is the thing that ends the free tier. The cron runs every minute (1,440/day), so anything it
// scans is multiplied by 1,440 before anything else has happened at all.
//
// Stage 1 loads src/index.js with the Cloudflare-only imports stubbed and runs scheduled() against a DB that records SQL instead of
// answering it. Stage 2 applies the real migrations to an in-memory SQLite, seeds it, and reads EXPLAIN QUERY PLAN for each statement
// the cron actually issued. Usage: node test/budget.mjs [sender_rules_rows] (default 200)
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const HUB = new URL("../", import.meta.url).pathname;
const RULES = Number(process.argv[2] || 200);
const DAY = 1440; // cron minutes per day

// ---------- stage 1: run the real scheduled() and record every statement ----------
const stub = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, "const $1 = \"\";")
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, "const $1 = \"\";");
const tmp = HUB + "test/_budget_mod.mjs";
writeFileSync(tmp, stub);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const ENV = {
  GMAIL_CLIENT_ID: "x", GMAIL_CLIENT_SECRET: "x", GMAIL_TOKEN_KEY: "x",
  GMAIL_PUBSUB_TOPIC: "projects/p/topics/t", GMAIL_PUSH_SA: "sa@p.iam", GMAIL_PUSH_AUDIENCE: "https://h/hook", GMAIL_PUSH_SECRET: "s",
  IMAP_ACCOUNTS: readFileSync(HUB + "wrangler.toml", "utf8").match(/IMAP_ACCOUNTS = '(.+)'/)[1], // the real one; its secret is unset, as in production today
  DOMAINS: "example.com", FORWARD_TO: "x@gmail.com",
};
// A mailbox whose Gmail watch is live: push drives it and the poll is only the ten-minute backstop Google asks for.
const WATCH = new Date(Date.now() + 5 * 864e5).toISOString();
function recordingDb(log) {
  const answer = (sql) => {
    if (/FROM gmail_accounts/.test(sql)) return [{ email: "a@gmail.com", poll_history_id: "1", watch_expiration: WATCH, last_poll_at: null, status: "active" }];
    return [];
  };
  const stmt = (sql) => ({ bind: () => stmt(sql), all: async () => (log.push(sql), { results: answer(sql) }), first: async () => (log.push(sql), answer(sql)[0] ?? null), run: async () => (log.push(sql), { meta: { changes: 0 } }) });
  return { prepare: (sql) => stmt(sql.replace(/\s+/g, " ").trim()), batch: async (xs) => xs.map(() => ({ results: [] })) };
}
// gmailPoll decides whether an account is due from `new Date().getUTCMinutes()`, NOT from event.scheduledTime, so unless the clock
// is pinned this whole receipt depends on the wall-clock minute it happens to run at, and reported "REGRESSION" on 6 minutes in
// every 60. Pinning it is what makes the measurement a measurement.
async function cronMinute(minute) {
  const log = []; const env = { ...ENV, DB: recordingDb(log) };
  const at = new Date(Date.UTC(2026, 8, 17, 14, minute, 0));
  const Real = Date;
  class Pinned extends Real { constructor(...a) { super(...(a.length ? a : [at.getTime()])); } static now() { return at.getTime(); } }
  globalThis.Date = Pinned;
  try { await mod.default.scheduled({ scheduledTime: at.getTime() }, env, { waitUntil: () => {} }); }
  finally { globalThis.Date = Real; }
  return log;
}

// ---------- stage 2: the same statements against the real schema ----------
const db = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) db.exec(readFileSync(HUB + "migrations/" + f, "utf8"));
for (let i = 0; i < RULES; i++) db.exec(`INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('id${i}', 'p${i}@x.example', 'block', '*', '2026-01-01')`);
db.exec("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, status, created_at) VALUES ('a@gmail.com', 'x', 'x', 'active', '2026-01-01')");
db.exec("INSERT INTO prefs (key, value, updated_at) VALUES ('notify', '\"all\"', '2026-01-01')");
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
function plan(sql) {
  const probe = sql.replace(/\?/g, "'2026-01-01T00:00:00Z'");
  try { return db.prepare("EXPLAIN QUERY PLAN " + probe).all().map((r) => r.detail).join(" / "); }
  catch (e) { return "unplannable: " + e.message; }
}
const TABLE = /FROM ([a-z_]+)/;
const scanned = (sql, detail) => { const t = (sql.match(TABLE) || [])[1]; return /SCAN/.test(detail) && t && tableRows(t) !== null ? tableRows(t) : /SEARCH/.test(detail) ? 0 : null; };
const tableRows = (t) => { try { return count(t); } catch (_) { return null; } };

// Only the idle minute is measured. A backstop minute (the Gmail poll's ten-minute fallback) goes to the network, which this harness
// deliberately does not simulate, and gmailPoll takes that decision from `new Date()`, not from event.scheduledTime, so the harness
// could not choose it anyway. The floor below is what EVERY minute costs before any mail, any poll and any user has happened.
console.log(`D1 budget — the idle cron minute, measured against the real migrations (sender_rules seeded with ${RULES} rows)\n`);
const log = await cronMinute(7);
console.log(`${log.length} queries, every minute of every day:`);
let idleRows = 0;
for (const sql of log) {
  const d = plan(sql); const n = scanned(sql, d);
  if (n !== null) idleRows += n;
  console.log(`  ${n === null ? "   ?" : String(n).padStart(5)} rows  ${/SCAN/.test(d) ? "SCAN  " : "SEARCH"}  ${sql.slice(0, 92)}`);
}
const pct = (r) => ((r * DAY / 5e6) * 100).toFixed(1);
console.log(`\n  → ${idleRows} rows scanned/minute = ${(idleRows * DAY).toLocaleString()} rows/day = ${pct(idleRows)}% of the 5,000,000/day free limit\n`);

// The idle minute is NOT the day. Six minutes in every hour (minute % 10 === 0) run the Gmail poll's ten-minute backstop, which
// does read sender_rules, so quoting the idle figure as the daily total understates it by more than twenty times. Measured, both.
const BACKSTOP_PER_DAY = 144;               // 6 per hour
const IDLE_PER_DAY = DAY - BACKSTOP_PER_DAY;
const blog = await cronMinute(10);
let backstopRows = 0;
for (const sql of blog) { const n = scanned(sql, plan(sql)); if (n !== null) backstopRows += n; }
const dayRows = idleRows * IDLE_PER_DAY + backstopRows * BACKSTOP_PER_DAY;
console.log(`  backstop minute (minute % 10 === 0, ${blog.length} queries): ${backstopRows} rows scanned`);
console.log(`  TRUE DAILY TOTAL: ${IDLE_PER_DAY} idle x ${idleRows} + ${BACKSTOP_PER_DAY} backstop x ${backstopRows}`
  + ` = ${dayRows.toLocaleString()} rows/day = ${((dayRows / 5e6) * 100).toFixed(2)}% of the free limit\n`);
const ceiling = Math.floor(5e6 / DAY);
console.log(`The cron may scan ${ceiling} rows/minute before it alone spends the day's budget.\n`);
// `sender_rules` is read with no WHERE clause and has no index to read instead, so every read scans the whole table, and the table
// gains a row on every unsubscribe and every block. It is no longer read on an idle minute; what is left reads it 144
// times a day (the ten-minute Gmail backstop) plus once per inbound message and once per Gmail push. Kept here as the trip-wire:
// if an idle minute ever scans sender_rules again, this column is what it costs.
const IDLE_SCANS_RULES = log.some((q) => /FROM sender_rules/.test(q));
console.log(`Does an idle minute scan sender_rules?  ${IDLE_SCANS_RULES ? "YES <-- REGRESSION" : "no"}`);
console.log("\n  If it did, at N rules it would cost:\n  sender_rules rows │ rows/day from the cron │ share of the free limit");
for (const n of [50, 200, 500, 1000, 2000, 3472]) console.log(`  ${String(n).padStart(17)} │ ${String((n + 1) * DAY).padStart(22)} │ ${pct(n + 1).padStart(6)}%${n === 3472 ? "   <-- the cron alone spends the day" : ""}`);
if (IDLE_SCANS_RULES) process.exit(1);
