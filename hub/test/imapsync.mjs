#!/usr/bin/env node
// EXECUTION test for the work-mailbox sync. The user connected his work mailbox and saw a September 2024 message at
// the top of the inbox as "today", and the sync was stuck: its first full run took ~65 s, the cron starts one every minute, two runs
// stored the same message, the second hit the unique index and aborted, and progress was only saved at the end, so every run
// started over. Pinned here, with the real Worker, real migrations and a fake IMAP server holding old mail:
//  messages are stored with the server's date; two syncs at once cannot collide; a run cut off part-way resumes, not restarts;
//  a message already stored with the wrong date is put back; a first sync of old mail announces nothing.
// Usage: node test/imapsync.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname; const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; const o = (buf.match(/\bBEGIN\b/gi) || []).length, c = (buf.match(/\bEND\b/gi) || []).length; if (o === c) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
function buildDb() { const sq = new DatabaseSync(":memory:"); for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n"))) { try { sq.exec(st); } catch (_) {} } return sq; }
let sq = buildDb(); const hooks = { beforeInsertMessage: null };
// The concurrent writer's insert is its OWN committed transaction, so it is made before our batch opens, never inside it (a rollback
// of our batch must not erase it: on D1 it could not).
const d1 = { prepare(sql) { const mk = (p) => ({ sql, params: p, bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null,
  run: async () => { await new Promise((r) => setImmediate(r)); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); },
  batch: async (xs) => { if (hooks.beforeInsertMessage) for (const x of xs) if (/^\s*INSERT INTO messages \(id, thread_id, direction/.test(x.sql)) await hooks.beforeInsertMessage(x.params);
    sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };   // like D1: one transaction, all or nothing

// ---------- a fake IMAP server: an INBOX of old mail, optionally cut off after N fetches ----------
const ACCT = "work@corp.example", PASS = "pw-1";
const MSGS = [];   // { uid, date (INTERNALDATE), msgid, subject }
const SENT = [];   // the Sent folder: { uid, internal, msgid, subject, from: ACCT, to }
const folderMsgs = (f) => f === "INBOX.Sent" ? SENT : f === "INBOX" ? MSGS : [];
const mkMsgs = (n, startUid, ageDays) => { for (let i = 0; i < n; i++) { const t = new Date(Date.UTC(2024, 8, 1 + i, 16, 33, 57)); MSGS.push({ uid: startUid + i, internal: imapDate(ageDays === 0 ? new Date(Date.now() - 3600e3) : t), msgid: `<m${startUid + i}@corp.example>`, subject: `Message ${startUid + i}` }); } };
function imapDate(d) { const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]; const dd = String(d.getUTCDate()).padStart(2, " "); const p = (n) => String(n).padStart(2, "0"); return `${dd}-${mo}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; }
const rawOf = (m) => [...(m.msgid ? [`Message-ID: ${m.msgid}`] : []), ...(m.irt ? [`In-Reply-To: ${m.irt}`, `References: ${m.irt}`] : []), `From: ${m.from || "Kelly Cole <kcole@gridenergy.example>"}`, `To: ${m.to || ACCT}`, `Subject: ${m.subject}`, `Date: ${m.internal}`, `Content-Type: text/plain; charset=utf-8`, ``, `Body of ${m.subject}.`, ``].join("\r\n");
const srv = { fetchLimit: Infinity, fetches: 0, logins: 0 };
globalThis.__fakeConnect = ({ hostname, port }) => {
  let ctrl; const enc = new TextEncoder(), dec = new TextDecoder(); let buf = ""; let BOX = MSGS;   // the folder SELECTed
  const say = (s) => queueMicrotask(() => { try { ctrl.enqueue(enc.encode(s)); } catch (_) {} });
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const onLine = (line) => {
    const [tag, cmd, ...rest] = line.split(" "); const C = (cmd || "").toUpperCase(); const R = rest.join(" ");
    if (C === "AUTHENTICATE") { srv.logins++; if (srv.refuse) return say(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`); return say(`${tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] Logged in\r\n`); }
    if (C === "LIST") return say(`* LIST (\\HasNoChildren) "." "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "." "INBOX.Sent"\r\n* LIST (\\HasNoChildren \\Trash) "." "INBOX.Trash"\r\n* LIST (\\HasNoChildren \\Archive) "." "INBOX.Archive"\r\n* LIST (\\HasNoChildren) "." "INBOX.Snoozed"\r\n${tag} OK done\r\n`);
    if (C === "SELECT") { BOX = folderMsgs(R.replace(/^"|"$/g, "")); const next = BOX.length ? Math.max(...BOX.map((m) => m.uid)) + 1 : 1; return say(`* ${BOX.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${next}] ok\r\n${tag} OK [READ-WRITE] done\r\n`); }
    if (C === "UID" && /^SEARCH/i.test(R)) { const m = /UID (\d+):(\*|\d+)/i.exec(R); const lo = +m[1], hi = m[2] === "*" ? Infinity : +m[2]; return say(`* SEARCH ${BOX.filter((x) => x.uid >= lo && x.uid <= hi).map((x) => x.uid).join(" ")}\r\n${tag} OK done\r\n`); }
    if (C === "UID" && /^FETCH/i.test(R)) {
      const set = R.split(" ")[1]; const full = /BODY\.PEEK\[\]/i.test(R), headOnly = /BODY\.PEEK\[HEADER\]/i.test(R), sized = /RFC822\.SIZE/i.test(R);
      if (headOnly) { srv.headerFetches = (srv.headerFetches || 0) + 1; const pick = BOX.filter((x) => set.split(",").map(Number).includes(x.uid)); let out = ""; pick.forEach((m, i) => { const head = rawOf(m).split("\r\n\r\n")[0] + "\r\nContent-Type: multipart/mixed; boundary=zz\r\n\r\n"; out += `* ${i + 1} FETCH (UID ${m.uid} FLAGS (\\Seen) INTERNALDATE "${m.internal}" RFC822.SIZE ${m.size || rawOf(m).length} BODY[HEADER] {${Buffer.byteLength(head)}}\r\n${head})\r\n`; }); return say(out + `${tag} OK done\r\n`); }
      if (full) { const want = BOX.filter((x) => set.split(",").map(Number).includes(x.uid)); if (want.some((m) => m.size > 30 * 1048576)) srv.bigBodyAsked = true; }
      if (full && ++srv.fetches > srv.fetchLimit) { try { ctrl.close(); } catch (_) {} return; }   // the run is cut off here
      const pick = set === "1:*" ? BOX : BOX.filter((x) => set.split(",").map(Number).includes(x.uid));
      let out = ""; pick.forEach((m, i) => { const raw = rawOf(m); out += full ? `* ${i + 1} FETCH (UID ${m.uid} FLAGS (\\Seen) INTERNALDATE "${m.internal}" RFC822.SIZE ${m.size || raw.length} BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n` : sized && !/FLAGS/i.test(R) ? `* ${i + 1} FETCH (UID ${m.uid} RFC822.SIZE ${m.size || raw.length})\r\n` : `* ${i + 1} FETCH (UID ${m.uid} FLAGS (\\Seen) INTERNALDATE "${m.internal}")\r\n`; });
      return say(out + `${tag} OK done\r\n`);
    }
    if (C === "LOGOUT") { say(`* BYE\r\n${tag} OK done\r\n`); return queueMicrotask(() => { try { ctrl.close(); } catch (_) {} }); }
    return say(`${tag} OK done\r\n`);
  };
  const writable = new WritableStream({ write(ch) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } } });
  say("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Dovecot ready.\r\n");
  return { opened: Promise.resolve(), readable, writable, close() { try { ctrl.close(); } catch (_) {} } };
};
globalThis.fetch = async () => new Response("{}");   // push / DoH: nothing reaches the network here

// IMAPSYNC_SRC: run this against another copy of the Worker (e.g. the code before this fix) to see it fail.
const SRC = readFileSync(process.env.IMAPSYNC_SRC || HUB + "src/index.js", "utf8").replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, "const connect = (...a) => globalThis.__fakeConnect(...a);").replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_imapsync_worker.mjs`; writeFileSync(tmp, SRC); let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const env = { DB: d1, CLI_TOKEN: "cli", DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", WORK_PASS: PASS, STORE: { put: async () => ({}), get: async () => null, delete: async () => {} },
  IMAP_ACCOUNTS: JSON.stringify([{ email: ACCT, label: "Corp", host: "mail.corp.example", port: 993, secret: "WORK_PASS", smtp_host: "mail.corp.example", smtp_port: 465 }]) };
const sync = async () => { const waits = []; const r = await mod.default.fetch(new Request("https://hub.example/api/imap/sync", { method: "POST", headers: { Authorization: "Bearer cli", "content-type": "application/json" }, body: "{}" }), env, { waitUntil: (p) => waits.push(p) }); await Promise.allSettled(waits); return (await r.json()).results?.[0] || {}; };
const folder = () => sq.prepare("SELECT highwater, lowwater, last_error, sync_until, sync_token FROM imap_folders WHERE account = ? AND folder = 'INBOX'").get(ACCT) || {};
const rows = () => sq.prepare("SELECT message_id, created_at FROM messages WHERE imap_account = ?").all(ACCT);

mkMsgs(20, 1001, 30);   // twenty old messages, September 2024
{ // a run cut off part-way saves what it did, and the next run continues from there
  srv.fetchLimit = 2;   // two batches of four, then the connection drops
  let r = await sync();
  const f = folder();
  check(rows().length === 8 && f.highwater === 1008, `a run cut off after two batches keeps both: 8 stored, progress saved at UID ${f.highwater}`);
  check(!f.sync_token && !f.sync_until, "and its lease is released (or would expire) — the next run is not locked out");
  srv.fetchLimit = Infinity; srv.fetches = 0;
  r = await sync();
  check(rows().length === 20 && r.fetched === 12 && r.dup === 0, `the next run fetches only the remaining 12 (fetched ${r.fetched}, duplicates ${r.dup})`);
}
{ // every message carries the server's date, not the time of the sync
  const bad = rows().filter((x) => !x.created_at.startsWith("2024-09-"));
  check(bad.length === 0, `all 20 are dated September 2024, as the server says (${bad.length} dated otherwise)`);
}
{ // a first sync of old mail announces nothing; fresh mail is announced
  const before = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get()?.n ?? 0;
  check(before === 0, `storing 20 old messages raised no notification (${before} in the feed)`);
  mkMsgs(1, 2000, 0); const r = await sync();
  const after = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get()?.n ?? 0;
  check(r.fetched === 1 && r.recent === 1 && after === 1, `a message from an hour ago is announced (recent ${r.recent}, feed ${after})`);
}
{ // two syncs at once (the Connect's first sync and the cron): one runs, one stands aside; nothing collides
  sq = buildDb(); MSGS.length = 0; mkMsgs(16, 3001, 30); srv.fetches = 0; srv.fetchLimit = Infinity;
  const [a, b] = await Promise.all([sync(), sync()]);
  const skipped = [a, b].filter((x) => /another sync/.test(x.skipped || "")).length;
  check(skipped === 1 && rows().length === 16 && !folder().last_error, `one of two simultaneous syncs stands aside; 16 stored once each, no error (${JSON.stringify([a.skipped || a.fetched, b.skipped || b.fetched])})`);
}
{ // a message already stored with the wrong date (the 2026-10-05 row) is put back by the next sweep
  sq.prepare("UPDATE messages SET created_at = '2026-10-05T17:50:45.671Z' WHERE message_id = '<m3005@corp.example>'").run();
  sq.prepare("UPDATE imap_folders SET last_sweep_at = NULL WHERE account = ?").run(ACCT);
  const r = await sync();
  const d = sq.prepare("SELECT created_at FROM messages WHERE message_id = '<m3005@corp.example>'").get()?.created_at;
  const th = sq.prepare("SELECT t.last_message_at FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.message_id = '<m3005@corp.example>'").get()?.last_message_at;
  check(d && d.startsWith("2024-09-05") && th && th.startsWith("2024-09-05") && r.redated === 1, `the misdated message and its conversation are back on 2024-09-05 (${d}, conversation ${th})`);
}
{ // stored by someone else between the check and the insert: a duplicate, not an aborted run
  MSGS.length = 0; mkMsgs(4, 4001, 30); let injected = false;
  hooks.beforeInsertMessage = async (p) => { if (!injected && p[10] === "<m4002@corp.example>") { injected = true; sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, created_at, ingest_source) VALUES ('race-row', 't-race', 'in', ?, 'x@y.z', 's', '<m4002@corp.example>', '2026-10-05T17:50:45.671Z', 'imap')").run(ACCT); } };
  sq.prepare("UPDATE imap_folders SET highwater = 4000 WHERE account = ?").run(ACCT);
  const r = await sync(); hooks.beforeInsertMessage = null;
  const race = sq.prepare("SELECT created_at, imap_uid FROM messages WHERE id = 'race-row'").get();
  check(injected && !r.error && !folder().last_error && r.fetched === 3 && r.dup === 1, `a message stored by a concurrent writer counts as a duplicate and the run completes (${r.error || `fetched ${r.fetched}, dup ${r.dup}`})`);
  check(race && race.imap_uid === 4002 && race.created_at.startsWith("2024-09-02"), `and that copy is linked to its UID and given the server's date (${race && race.created_at})`);
  const empty = sq.prepare("SELECT COUNT(*) n FROM threads t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id) AND t.id <> 't-race'").get().n;
  check(empty === 0, `and the collision leaves no empty conversation behind — the "(no subject)" shell of 2026-10-05 (${empty})`);
}
// ---------- the adversarial audit of 2026-10-05 ----------
const syncWith = async (body) => { const waits = []; const r = await mod.default.fetch(new Request("https://hub.example/api/imap/sync", { method: "POST", headers: { Authorization: "Bearer cli", "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) }); await Promise.allSettled(waits); return (await r.json()).results?.[0] || {}; };
const dt = (y, mo, d, h = 16) => imapDate(new Date(Date.UTC(y, mo, d, h, 33, 57)));
{ // a malformed INTERNALDATE no longer throws out of the run (it used to: new Date("…").toISOString() is a RangeError)
  sq = buildDb(); MSGS.length = 0; MSGS.push({ uid: 5001, internal: "not a date", msgid: "<m5001@corp.example>", subject: "Bad date" });
  const r = await sync(); const n = sq.prepare("SELECT COUNT(*) n FROM messages WHERE imap_uid = 5001").get().n;
  check(!r.error && !folder().last_error && n === 1, `a message whose server date cannot be read is stored and the run completes (${r.error || folder().last_error || "stored " + n})`);
}
{ // mail without a Message-ID fetched again (a repeated batch) is not stored twice
  sq = buildDb(); MSGS.length = 0; MSGS.push({ uid: 6001, internal: dt(2024, 8, 3), msgid: null, subject: "No id one" }, { uid: 6002, internal: dt(2024, 8, 4), msgid: null, subject: "No id two" });
  await sync(); sq.prepare("UPDATE imap_folders SET highwater = 0, lowwater = NULL WHERE account = ?").run(ACCT);   // as if the batch had to run again
  const r = await sync(); const n = sq.prepare("SELECT COUNT(*) n FROM messages WHERE imap_uid IN (6001, 6002)").get().n + sq.prepare("SELECT COUNT(*) n FROM messages WHERE subject LIKE 'No id%' AND imap_uid IS NULL").get().n;
  check(n === 2 && r.dup === 2, `a repeated batch of mail with no Message-ID stores nothing twice (${n} rows, dup ${r.dup})`);
}
{ // a run whose lease is taken over mid-way stops instead of storing alongside the new run
  sq = buildDb(); MSGS.length = 0; mkMsgs(8, 7001, 30); let took = false;
  hooks.beforeInsertMessage = async (pr) => { if (!took && pr[10] === "<m7002@corp.example>") { took = true; sq.prepare("UPDATE imap_folders SET sync_token = 'another-run', sync_until = ? WHERE account = ?").run(Date.now() + 120000, ACCT); } };
  const r = await sync(); hooks.beforeInsertMessage = null; const n = sq.prepare("SELECT COUNT(*) n FROM messages WHERE imap_uid BETWEEN 7001 AND 7008").get().n;
  check(took && n === 4 && /lost its lease/.test(String(r.error || folder().last_error || "")), `a run that lost its lease stops after its batch: ${n} of 8 stored (${r.error || folder().last_error || "no error"})`);
  sq.prepare("UPDATE imap_folders SET sync_token = NULL, sync_until = NULL WHERE account = ?").run(ACCT);
}
{ // an older message backfilled into an archived conversation leaves it archived; a new one brings it back
  sq = buildDb(); MSGS.length = 0; MSGS.push({ uid: 10, internal: dt(2024, 8, 1), msgid: "<root@corp.example>", subject: "Quarterly plan" });
  await sync(); MSGS.push({ uid: 12, internal: dt(2024, 8, 10), msgid: "<r12@corp.example>", irt: "<root@corp.example>", subject: "Re: Quarterly plan" }); await sync();
  const tid = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<root@corp.example>'").get().thread_id;
  sq.prepare("UPDATE threads SET state = 'archived', unread = 0 WHERE id = ?").run(tid);
  MSGS.push({ uid: 9, internal: dt(2024, 8, 5), msgid: "<r9@corp.example>", irt: "<root@corp.example>", subject: "Re: Quarterly plan" });
  const b = await syncWith({ backfill: 5 }); const t1 = sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid); const joined = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<r9@corp.example>'").get();
  check(b.backfilled === 1 && joined && joined.thread_id === tid && t1.state === "archived", `a backfilled older reply joins the archived conversation and leaves it archived (${t1.state}, backfilled ${b.backfilled})`);
  MSGS.push({ uid: 13, internal: imapDate(new Date(Date.now() - 3600e3)), msgid: "<r13@corp.example>", irt: "<root@corp.example>", subject: "Re: Quarterly plan" });
  await sync(); const t2 = sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid);
  check(t2.state === "inbox", `a new reply still brings it back to the inbox (${t2.state})`);
}
{ // A refused password waits before the next try (5, then 10 minutes...), the app is told, and a good sign-in clears it.
  // On 2026-10-07 the work mailbox refused 202 sign-ins in 11 hours, one sync a minute with no backoff, while Settings said "connected".
  sq = buildDb(); MSGS.length = 0; srv.refuse = true; srv.logins = 0;
  const st = () => sq.prepare("SELECT auth_failures, auth_retry_at, last_error FROM imap_folders WHERE account = ? AND folder = 'INBOX'").get(ACCT) || {};
  await sync(); const a1 = st();
  check(srv.logins === 1 && a1.auth_failures === 1 && a1.auth_retry_at > Date.now() + 4.5 * 60e3 && a1.auth_retry_at < Date.now() + 5.5 * 60e3, `a refused sign-in waits 5 minutes before the next (logins ${srv.logins}, failures ${a1.auth_failures}, wait ${Math.round((a1.auth_retry_at - Date.now()) / 60e3)} min)`);
  await sync(); await sync();
  check(srv.logins === 1, `the next minutes' syncs do not sign in again (${srv.logins} sign-in)`);
  const me = await (await mod.default.fetch(new Request("https://hub.example/api/me", { headers: { Authorization: "Bearer cli" } }), env, { waitUntil: () => {} })).json();
  const pub = (me.imap_accounts || []).find((x) => x.email === ACCT) || {};
  check(pub.signin_refused === true && !!pub.retry_at && /AUTHENTICATIONFAILED/.test(pub.last_error || ""), `the app is told the server refuses the password (${JSON.stringify({ r: pub.signin_refused, at: pub.retry_at, e: (pub.last_error || "").slice(0, 40) })})`);
  sq.prepare("UPDATE imap_folders SET auth_retry_at = ? WHERE account = ?").run(Date.now() - 1, ACCT);
  await sync(); const a2 = st();
  check(srv.logins === 2 && a2.auth_failures === 2 && a2.auth_retry_at > Date.now() + 9.5 * 60e3, `a second refusal in a row waits 10 minutes (failures ${a2.auth_failures}, wait ${Math.round((a2.auth_retry_at - Date.now()) / 60e3)} min)`);
  srv.refuse = false; sq.prepare("UPDATE imap_folders SET auth_retry_at = ? WHERE account = ?").run(Date.now() - 1, ACCT);
  await sync(); const a3 = st();
  check(srv.logins === 3 && a3.auth_failures === 0 && a3.auth_retry_at == null, `a good sign-in clears the wait (failures ${a3.auth_failures}, retry ${a3.auth_retry_at})`);
  const me2 = await (await mod.default.fetch(new Request("https://hub.example/api/me", { headers: { Authorization: "Bearer cli" } }), env, { waitUntil: () => {} })).json();
  check(((me2.imap_accounts || []).find((x) => x.email === ACCT) || {}).signin_refused === false, "and the app is told it is fine again");
}
{ // a message too large to download is never read whole: its size is asked first, it is kept as its headers
  sq = buildDb(); MSGS.length = 0; srv.refuse = false; srv.headerFetches = 0; srv.bigBodyAsked = false; srv.fetches = 0; srv.fetchLimit = Infinity;
  MSGS.push({ uid: 501, internal: dt(2024, 8, 1), msgid: "<small@corp.example>", subject: "Small one" }, { uid: 502, internal: dt(2024, 8, 2), msgid: "<huge@corp.example>", subject: "Board deck (huge)", size: 31 * 1048576 });
  await sync();
  const huge = sq.prepare("SELECT subject, body_text FROM messages WHERE message_id = '<huge@corp.example>'").get();
  check(!srv.bigBodyAsked && srv.headerFetches === 1, `the 31 MB message's body is never asked for; its headers are (${srv.headerFetches} header fetch, body asked ${srv.bigBodyAsked})`);
  check(huge?.subject === "Board deck (huge)" && /31 MB, too large for the hub to download/.test(huge?.body_text || ""), `it is stored under its own subject, saying where to read it (${JSON.stringify(huge)})`);
  check(!!sq.prepare("SELECT 1 x FROM messages WHERE message_id = '<small@corp.example>'").get() && folder().highwater === 502, `the mail beside it is stored whole and the mailbox moves past both (highwater ${folder().highwater})`);
}
{ // trash rules: new mail matching one is stored in Trash on a conversation of its own, moved to the server's Trash
  // through the write-back queue, and never announced. Mail that arrives beside it is announced as usual.
  sq = buildDb(); MSGS.length = 0; srv.fetches = 0; srv.fetchLimit = Infinity;
  sq.prepare("INSERT INTO trash_rules (id, scope, name, subject, created_at) VALUES ('tr1', ?, 'webmail', '', '2026-10-21')").run(ACCT);
  sq.prepare("INSERT INTO trash_rules (id, scope, name, subject, created_at) VALUES ('tr2', 'someone@else.example', 'kelly', '', '2026-10-21')").run();
  mkMsgs(2, 6001, 0); MSGS[0].from = '"Webmail" <support@phish.example>'; MSGS[0].subject = "Please review your encrypted messages";
  const r = await sync();
  const ph = sq.prepare("SELECT m.id, m.labels, t.state, t.unread, t.labels tl FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = '<m6001@corp.example>'").get() || {};
  const ok = sq.prepare("SELECT t.state FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = '<m6002@corp.example>'").get() || {};
  const ops = sq.prepare("SELECT op FROM imap_ops WHERE message_id = ?").all(ph.id || "").map((x) => x.op);
  const feed = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get()?.n ?? 0;
  check(ph.state === "trash" && /trash-rule/.test(ph.tl || "") && ok.state === "inbox", `the Webmail mail is filed in Trash with the trash-rule label, the other in the inbox (${ph.state}, ${ph.tl}; ${ok.state})`);
  check(ops.includes("trash"), `and the server copy is queued to move to the server's Trash (${JSON.stringify(ops)})`);
  check(r.trashed === 1 && r.recent === 1 && feed === 1, `only the other message is announced (trashed ${r.trashed}, recent ${r.recent}, feed ${feed})`);
  check(sq.prepare("SELECT hits FROM trash_rules WHERE id = 'tr1'").get().hits === 1 && sq.prepare("SELECT hits FROM trash_rules WHERE id = 'tr2'").get().hits === 0, "the rule counts it; another account's rule does nothing here");
  // a backfill of old mail is never moved: rules are for what arrives
  MSGS.length = 0; MSGS.push({ uid: 50, internal: dt(2024, 8, 1), msgid: "<old-webmail@corp.example>", subject: "Old one", from: "Webmail <x@y.example>" });
  sq.prepare("UPDATE imap_folders SET lowwater = 51 WHERE account = ?").run(ACCT);
  await (await mod.default.fetch(new Request("https://hub.example/api/imap/sync", { method: "POST", headers: { Authorization: "Bearer cli", "content-type": "application/json" }, body: JSON.stringify({ backfill: 10 }) }), env, { waitUntil: () => {} })).text();
  const old = sq.prepare("SELECT t.state FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = '<old-webmail@corp.example>'").get();
  check(!old || old.state !== "trash", `old mail a backfill brings in is not trashed (${old ? old.state : "not fetched by this backfill"})`);
}
{ // "Delete unless it mentions…" on the work mailbox: new mail from a sender a "hub" rule covers that mentions none of the
  // words is stored in Trash on a conversation of its own, moved to the server's Trash and never announced; one with a word arrives as usual.
  sq = buildDb(); MSGS.length = 0; srv.fetches = 0; srv.fetchLimit = Infinity;
  sq.prepare(`INSERT INTO mention_rules (id, pattern, scope, words, created_at) VALUES ('mr1', '*@lakeside.example', 'hub', '["SXSW"]', '2026-11-16')`).run();
  mkMsgs(2, 7001, 0);
  MSGS[0].from = "Lakeside House <hello@lakeside.example>"; MSGS[0].subject = "Final hours for two-for-one passes this season";
  MSGS[1].from = "Lakeside House <hello@lakeside.example>"; MSGS[1].subject = "Our SXSW house is back in March";
  const r = await sync();
  const st = (mid) => sq.prepare("SELECT m.id, t.state, t.labels tl FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ?").get(mid) || {};
  const drop = st("<m7001@corp.example>"), keep = st("<m7002@corp.example>");
  const ops = sq.prepare("SELECT op FROM imap_ops WHERE message_id = ?").all(drop.id || "").map((x) => x.op);
  const feed = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get()?.n ?? 0;
  const dec = sq.prepare("SELECT decision FROM mention_decisions WHERE account = 'hub' ORDER BY decision").all().map((x) => x.decision);
  check(drop.state === "trash" && /mention-rule/.test(drop.tl || "") && keep.state === "inbox", `mentions none of the words: filed in Trash with the mention-rule label; the SXSW one in the inbox (${drop.state}, ${drop.tl}; ${keep.state})`);
  check(ops.includes("trash"), `and the server copy is queued to move to the server's Trash (${JSON.stringify(ops)})`);
  check(r.trashed === 1 && feed === 1, `only the one that mentions a word is announced (trashed ${r.trashed}, feed ${feed})`);
  const cnt = sq.prepare("SELECT kept, dropped FROM mention_rules WHERE id = 'mr1'").get();
  check(JSON.stringify(dec) === '["dropped","kept"]' && cnt.dropped === 1 && cnt.kept === 1, `both decided and counted (${JSON.stringify(dec)}, ${JSON.stringify(cnt)})`);
}
// ---------- the Sent folder ----------
// Only the Inbox was ever read, so Sent under the work account was empty: 0 sent messages stored against 311 received (D1).
const api = async (path, init = {}) => { const waits = []; const r = await mod.default.fetch(new Request("https://hub.example" + path, { ...init, headers: { Authorization: "Bearer cli", "content-type": "application/json" } }), env, { waitUntil: (p) => waits.push(p) }); await Promise.allSettled(waits); return r.json(); };
const KW = "Kelly Cole <kcole@gridenergy.example>", ME = `Sam <${ACCT}>`;
const sentFolder = () => sq.prepare("SELECT highwater, lowwater, exists_count, last_error FROM imap_folders WHERE account = ? AND folder = 'INBOX.Sent'").get(ACCT) || {};
{ // sent mail joins its conversation or starts one archived, is never announced, and brings nothing back to the inbox
  sq = buildDb(); MSGS.length = 0; SENT.length = 0; srv.fetches = 0; srv.fetchLimit = Infinity; srv.refuse = false;
  MSGS.push({ uid: 20, internal: dt(2024, 8, 1), msgid: "<k1@grid.example>", subject: "Project queue" }, { uid: 22, internal: dt(2024, 8, 1, 9), msgid: "<n1@news.example>", subject: "Weekly market notes", from: "Grid News <news@news.example>" });
  await sync();
  const tid = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<k1@grid.example>'").get().thread_id;
  const newsTid = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<n1@news.example>'").get().thread_id;
  sq.prepare("UPDATE threads SET state = 'archived', unread = 0 WHERE id = ?").run(tid);
  SENT.push({ uid: 5, internal: dt(2024, 8, 2), msgid: "<s1@corp.example>", irt: "<k1@grid.example>", subject: "Re: Project queue", from: ME, to: KW },
    { uid: 6, internal: dt(2024, 8, 3), msgid: "<s2@corp.example>", subject: "Proposal", from: ME, to: "Pat Morgan <dan@utility.example>" },
    { uid: 7, internal: imapDate(new Date(Date.now() - 3600e3)), msgid: "<s3@corp.example>", subject: "Sent an hour ago", from: ME, to: "Pat Morgan <dan@utility.example>" });
  const feed0 = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n;
  const r = await sync();
  const sent = sq.prepare("SELECT message_id, direction, status, identity, imap_folder, imap_uid, created_at, thread_id, raw_key FROM messages WHERE ingest_source = 'imap-sent' ORDER BY imap_uid").all();
  check(sent.length === 3 && sent.every((m) => m.direction === "out" && m.status === "sent" && m.identity === ACCT && m.imap_folder === "INBOX.Sent"), `the three messages in Sent are stored as the user's own, in INBOX.Sent (${JSON.stringify(sent.map((m) => [m.direction, m.imap_folder, m.imap_uid]))})`);
  check(sent.length === 3 && sent[0].created_at.startsWith("2024-09-02") && sent.every((m) => m.raw_key.startsWith("out/")), `with the server's dates, kept under out/ where the R2 sweep never replays them as received mail (${sent[0]?.created_at}, ${sent[0]?.raw_key?.slice(0, 4)})`);
  const t = sq.prepare("SELECT state, unread, message_count FROM threads WHERE id = ?").get(tid);
  check(sent[0]?.thread_id === tid && t.state === "archived" && t.unread === 0 && t.message_count === 2, `the reply joins Kelly's archived conversation and leaves it archived and read (${t.state}, unread ${t.unread}, ${t.message_count} messages)`);
  const own = sent[1] ? sq.prepare("SELECT state FROM threads WHERE id = ?").get(sent[1].thread_id) : {};
  check(sent[1] && sent[1].thread_id !== tid && own.state === "archived", `a conversation the user started is born archived: in Sent, not the inbox (${own.state})`);
  const feed1 = sq.prepare("SELECT COUNT(*) n FROM notify_feed").get().n;
  check(feed1 === feed0 && r.sent?.fetched === 3 && !r.error, `nothing is announced, not even the one sent an hour ago (feed ${feed0} -> ${feed1}; ${JSON.stringify(r.sent || r.error)})`);
  // Kelly answers. The conversation's newest message is hers, and it is still in Sent, as in Gmail.
  MSGS.push({ uid: 23, internal: dt(2024, 8, 4), msgid: "<k2@grid.example>", irt: "<s1@corp.example>", subject: "Re: Project queue" });
  await sync();
  const list = await api("/api/threads?box=sent&limit=50"); const ids = (list.threads || []).map((x) => x.id); const row = (list.threads || []).find((x) => x.id === tid);
  check(row && row.has_out === 1 && row.last?.direction === "in" && ids.includes(sent[1]?.thread_id) && !ids.includes(newsTid), `Sent lists the conversation Kelly answered last, and the one the user started, and not mail he never answered (${ids.length} listed; has_out ${row?.has_out}, last ${row?.last?.direction})`);
  const all = await api("/api/threads?box=all&limit=50"); const news = (all.threads || []).find((x) => x.id === newsTid);
  check(news && news.has_out === 0 && news.has_in === 1, `a conversation of received mail only says has_out 0 (${news?.has_out})`);
  // Kelly's mail is archived in Outlook: gone from the server's Inbox. The conversation is archived here too, sent copy or not.
  sq.prepare("UPDATE threads SET state = 'inbox' WHERE id = ?").run(tid); sq.prepare("UPDATE imap_folders SET last_sweep_at = NULL WHERE account = ?").run(ACCT);
  MSGS.splice(0, MSGS.length, ...MSGS.filter((m) => !/^<k/.test(m.msgid)));
  await syncWith({ sweep: true });
  check(sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid).state === "archived", `a conversation whose received mail left the server's Inbox is archived although it holds a sent copy (${sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid).state})`);
  // Trash in the hub moves the received mail on the server, never the user's copy in Sent
  sq.prepare("DELETE FROM imap_ops").run();
  await api(`/api/threads/${tid}`, { method: "PATCH", body: JSON.stringify({ state: "trash" }) });
  const opsFor = sq.prepare("SELECT m.message_id, o.op FROM imap_ops o JOIN messages m ON m.id = o.message_id WHERE m.thread_id = ? ORDER BY m.message_id").all(tid).map((x) => x.message_id);
  check(opsFor.length === 2 && opsFor.every((x) => /^<k/.test(x)), `trashing the conversation queues moves for Kelly's two messages only, not the sent reply (${JSON.stringify(opsFor)})`);
}
{ // a mail sent from the hub, already stored, is linked to its copy in Sent, not stored twice; a run read again stores nothing twice;
  // a mail the user sent himself keeps its Inbox copy where it is
  const sentRows = () => sq.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n;
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES ('t-hubsent', 'rate case', '[\"dan@utility.example\"]', '2024-09-06T10:00:00.000Z', 1, 'archived')").run();
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, created_at, ingest_source, status, imap_account, imap_folder) VALUES ('m-hubsent', 't-hubsent', 'out', ?, ?, 'Rate case', '<hubsent@corp.example>', '2024-09-06T10:00:00.000Z', 'imap-smtp', 'sent', ?, 'INBOX.Sent')").run(ACCT, ACCT, ACCT);
  SENT.push({ uid: 8, internal: dt(2024, 8, 6, 10), msgid: "<hubsent@corp.example>", subject: "Rate case", from: ME, to: "Pat Morgan <dan@utility.example>" });
  const n0 = sentRows(); const r = await sync(); const hs = sq.prepare("SELECT imap_uid FROM messages WHERE message_id = '<hubsent@corp.example>'").all();
  check(sentRows() === n0 && hs.length === 1 && hs[0].imap_uid === 8 && r.sent?.dup === 1, `the hub's own send is linked to UID 8 in Sent, one row (${hs.length} rows, uid ${hs[0]?.imap_uid}, dup ${r.sent?.dup})`);
  sq.prepare("UPDATE imap_folders SET highwater = 0, lowwater = NULL WHERE account = ? AND folder = 'INBOX.Sent'").run(ACCT);
  const r2 = await sync();
  check(sentRows() === n0 && r2.sent?.dup === 4 && r2.sent?.fetched === 0, `Sent read again from the start stores nothing twice (${r2.sent?.dup} duplicates, ${r2.sent?.fetched} new)`);
  MSGS.push({ uid: 30, internal: dt(2024, 8, 7), msgid: "<self@corp.example>", subject: "Note to self", from: ME, to: ACCT });
  SENT.push({ uid: 9, internal: dt(2024, 8, 7), msgid: "<self@corp.example>", subject: "Note to self", from: ME, to: ACCT });
  await sync();
  const self = sq.prepare("SELECT direction, imap_folder FROM messages WHERE message_id = '<self@corp.example>' ORDER BY direction").all();
  check(self.length === 2 && self[0].direction === "in" && self[0].imap_folder === "INBOX" && self[1].direction === "out" && self[1].imap_folder === "INBOX.Sent", `a mail sent to himself keeps its Inbox copy in INBOX and its Sent copy in INBOX.Sent (${JSON.stringify(self)})`);
}
{ // a long Sent folder: the newest 50 first, then 20 older each run with nothing new, until all of it is in; new mail always first
  sq = buildDb(); MSGS.length = 0; SENT.length = 0;
  for (let i = 0; i < 60; i++) SENT.push({ uid: 101 + i, internal: imapDate(new Date(Date.UTC(2023, 0, 1 + i, 15))), msgid: `<old${101 + i}@corp.example>`, subject: `Old sent ${101 + i}`, from: ME, to: "Pat Morgan <dan@utility.example>" });
  const count = () => sq.prepare("SELECT COUNT(*) n FROM messages WHERE ingest_source = 'imap-sent'").get().n;
  const a = await sync(); const c1 = count(), f1 = sentFolder();
  check(c1 === 50 && f1.highwater === 160 && f1.lowwater === 111 && a.sent?.backfilled === 0, `the first run reads the newest 50 (stored ${c1}, UIDs ${f1.lowwater}..${f1.highwater})`);
  SENT.push({ uid: 161, internal: imapDate(new Date(Date.now() - 600e3)), msgid: "<new161@corp.example>", subject: "Just sent", from: ME, to: "Pat Morgan <dan@utility.example>" });
  const b = await sync();
  check(count() === 51 && b.sent?.fetched === 1 && b.sent?.backfilled === 0, `a run with a new sent mail reads that, not older mail (new ${b.sent?.fetched}, older ${b.sent?.backfilled})`);
  const c = await sync(); const f3 = sentFolder();
  check(count() === 61 && c.sent?.backfilled === 10 && f3.lowwater === 101, `the next run reads the 10 older ones left (older ${c.sent?.backfilled}, lowest UID ${f3.lowwater})`);
  const d = await sync(); const f4 = sentFolder();
  check(count() === 61 && f4.lowwater === 1 && !f4.last_error && d.sent?.backfilled === 0, `then the folder is marked complete and nothing more is read (lowwater ${f4.lowwater}, ${count()} stored)`);
}
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall work-mailbox sync checks passed");
