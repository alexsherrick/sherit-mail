#!/usr/bin/env node
// Receipt for the parked-op design. An action against a
// mailbox with no password must still be RECORDED (durably, as 'deferred', never retried) and must be released the moment that
// mailbox has credentials. Dropping it meant the hub write succeeded while the mailbox never learned, and the two diverged with
// nothing to reconcile. Usage: node test/deferred.mjs (exit 1 on any failed check)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const stub = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_deferred_mod.mjs";
writeFileSync(tmp, stub);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

// NOTE: the password is NOT part of IMAP_ACCOUNTS; imapAccounts() reads it from env[a.secret || "WORK_IMAP_PASSWORD"], i.e. a
// Worker secret. A first draft of this test put it in the JSON and the promotion never fired, which is the harness being wrong
// rather than the product; getting it wrong here is exactly how a test ends up asserting nothing.
const ACC = () => JSON.stringify([{ email: "sam@work.example", label: "Work", host: "imap.work.example", port: 993,
  smtp_host: "smtp.work.example", smtp_port: 465, user: "sam@work.example" }]);

function db(log, rows) {
  const answer = (sql) => {
    if (/FROM messages WHERE thread_id/.test(sql)) return [{ id: "m1", imap_account: "sam@work.example" }];
    if (/FROM imap_ops WHERE status = 'deferred'/.test(sql)) return rows.parked || [];
    if (/FROM imap_ops WHERE status = 'pending'/.test(sql)) return rows.pending || [];
    return [];
  };
  const stmt = (sql) => ({ bind: (...b) => (log.push({ sql, b }), stmt(sql)), run: async () => (log.push({ sql, run: true }), { meta: { changes: rows.changes ?? 0 } }),
    all: async () => ({ results: answer(sql) }), first: async () => answer(sql)[0] || null });
  return { prepare: (sql) => stmt(sql.replace(/\s+/g, " ").trim()), batch: async (xs) => xs.map(() => ({ results: [] })) };
}
const ENV = (pw) => ({ IMAP_ACCOUNTS: ACC(), ...(pw ? { WORK_IMAP_PASSWORD: "s3cret" } : {}), DOMAINS: "example.com", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" });
const req = (id) => new Request(`https://h/api/threads/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: "mh=x" }, body: JSON.stringify({ state: "archived" }) });

// The Worker's session check will refuse an unauthenticated PATCH, so this drives the exported surface it CAN reach: the cron,
// which runs runImapOps() (that is where promotion lives) and asserts on the SQL actually issued.
{
  const log = [];
  await mod.default.scheduled({ scheduledTime: Date.now() }, { ...ENV(false), DB: db(log, {}) }, { waitUntil: () => {} }).catch(() => {});
  const promo = log.filter((e) => /UPDATE imap_ops SET status = 'pending' WHERE status = 'deferred'/.test(e.sql));
  check(promo.length === 0, `with NO password, nothing is promoted (${promo.length} promotion statement(s))`);
}
// A message archived while the mailbox was down, then restored, then the password arrives. Replaying both in order would land the
// ARCHIVE last and undo what the user did second: the "zombie op" that sank the first design.
const PARKED = [
  { id: "op-old", message_id: "m1", op: "archive", created_at: "2026-09-18T01:00:00Z" },
  { id: "op-new", message_id: "m1", op: "restore", created_at: "2026-09-18T02:00:00Z" },
  { id: "op-other", message_id: "m2", op: "seen", created_at: "2026-09-18T01:30:00Z" },
];
{
  const log = [];
  await mod.default.scheduled({ scheduledTime: Date.now() }, { ...ENV(true), DB: db(log, { changes: 3, parked: PARKED }) }, { waitUntil: () => {} }).catch(() => {});
  const sup = log.filter((e) => /UPDATE imap_ops SET status = 'superseded'/.test(e.sql));
  const supIds = sup.flatMap((e) => e.b || []);
  check(sup.length > 0 && supIds.includes("op-old"), `the older, contradicted op is superseded before anything runs — ${supIds.filter((x) => String(x).startsWith("op"))}`);
  check(!supIds.includes("op-new"), "the newest intent for that message survives");
  check(!supIds.includes("op-other"), "and an unrelated message's op is untouched — collapsing is per message and per family");
  // The sweep's own bookkeeping, not an orphaning UPDATE: since the dwell is measured from imap_account_absent, nothing is orphaned
  // unless an account has been missing for days, which this fake database never says. Counting UPDATEs made this check fail in the one
  // minute an hour it was really tested (minute 0), on every revision since (found in October 2026). (This fake logs only
  // statements that bind or run, so the parameterless SELECT DISTINCT cannot be the marker.)
  const swept = log.filter((e) => /DELETE FROM imap_account_absent/.test(e.sql));
  const onTheHour = new Date().getUTCMinutes() === 0;
  check(onTheHour ? swept.length > 0 : swept.length === 0,
    `the orphan sweep runs hourly, not every minute (minute ${new Date().getUTCMinutes()}, ${swept.length} sweep(s))`);
}
{
  const log = [];
  await mod.default.scheduled({ scheduledTime: Date.now() }, { ...ENV(true), DB: db(log, { changes: 3, parked: PARKED }) }, { waitUntil: () => {} }).catch(() => {});
  const promo = log.filter((e) => /UPDATE imap_ops SET status = 'pending' WHERE status = 'deferred'/.test(e.sql));
  check(promo.length > 0, `once the mailbox HAS a password, parked ops are released (${promo.length} promotion statement(s))`);
  const bound = promo.find((e) => Array.isArray(e.b) && e.b.includes("sam@work.example"));
  check(!!bound, "and the release is scoped to that account, not every row in the table");
  const ordered = log.some((e) => /FROM imap_ops WHERE status = 'pending'.*ORDER BY created_at/.test(e.sql));
  check(ordered, "the runner still applies them oldest-first, so promotion order cannot reorder a message's ops");
}
// Two concurrent cron invocations must not apply the same op twice.
// The claim sits immediately before an op is applied, which is AFTER the IMAP connection, and this harness has no sockets, so
// that line cannot be reached here. Rather than assert something unreachable and call it proof,
//  the guard is checked at the source level and labelled as exactly that. What it protects against is real:
// cron overlap was proved on 2026-09-11, and scheduled_actions has claimed its rows since migration 0010.
{
  const src = readFileSync(HUB + "src/index.js", "utf8").replace(/\s+/g, " ");
  // (the claim, the fence and the release are now EXECUTED against real SQLite in test/claim.mjs; see npm run test:claim.
  //  What stays here are the statements that test cannot reach, because they need the Worker's own control flow.)
  check(/if \(!\(claimed\.meta\?\.changes\)\) continue;/.test(src),
    "SOURCE: a caller that loses the claim skips the op instead of applying it");
  check(/if \(!\(claimed\.meta\?\.changes\)\) continue;/.test(src),
    "SOURCE: a caller that loses the claim skips the op instead of applying it");
  check(/if \(miss\.meta\?\.changes\) await logEvent\(db, "imap_op_fail"/.test(src),
    "SOURCE: only the claim owner reports a failure — a fenced-out stale owner does not raise a false alarm");
  check(/imap_account_absent/.test(src),
    "SOURCE: the dwell is measured from when the account went missing, not from the op's created_at");
  // Reversed in round five, with evidence rather than worry: in imap_ops a snooze is `await move(roles.snoozed || roles.archive)`
  // — a folder move. The scheduled RETURN lives in scheduled_actions, a different subsystem. Separating it let a snooze and an
  // archive both survive the collapse and both apply.
  check(/snooze: "place"/.test(src),
    "SOURCE: snooze collapses as a placement, because in this table that is all it is");
  check(/if \(known\.length\) \{/.test(src),
    "SOURCE: the orphan sweep is skipped entirely when IMAP_ACCOUNTS is empty — the production loss path");
  check(/UPDATE imap_ops SET status = 'deferred' WHERE status = 'orphaned'/.test(src),
    "SOURCE: retirement is reversible — a mailbox that returns reclaims its work");
  check(/attempts = attempts \+ 1, error = \?, claimed_at = NULL/.test(src),
    "SOURCE: a failed op releases its claim, so a retry can re-take the row");
  const mig = readFileSync(HUB + "migrations/0017_imap_ops_claims.sql", "utf8");
  check(/ALTER TABLE imap_ops ADD COLUMN claimed_at TEXT/.test(mig), "SOURCE: the claim column exists as a migration");
}
console.log(fails.length ? "FAILED: " + fails.join("; ") : "all deferred-op checks passed");
process.exit(fails.length ? 1 : 0);
