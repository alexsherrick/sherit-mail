#!/usr/bin/env node
// The work mailbox is watched, not polled. The hub signed in to it every minute (1,440 sign-ins a day), read it and hung
// up, so new work mail waited up to a minute, and the server refused about one sign-in in 8,000. Now each minute's cron run offers to
// watch it: the run that takes the mailbox's lease signs in once, catches up, and waits in IMAP IDLE (RFC 2177) for up to 14 minutes of
// its own wall time (free: Workers bill CPU, not duration), fetching on the same connection the moment the server says mail arrived.
// With the real Worker, real migrations and a fake Dovecot that speaks IDLE:
//  - one sign-in catches up and then waits; new mail is stored within a moment of the server saying so, on that same connection;
//  - while it watches, the minute's own check signs in to nothing; the wait is renewed in slices, and the lease is given up at its end;
//  - mail removed elsewhere (EXPUNGE) wakes it, and the mailbox is swept on that wake;
//  - a server without IDLE gets one read, as before; a connection dropped mid-wait ends the watcher, and the next one starts clean;
//  - a read that gave up waiting loses no byte (the IDLE slices end by timeout, and every DONE is answered);
//  - the minute's cron starts the watcher in its background.
// Usage: node test/imapidle.mjs (exit 1 on any failed check)
// CONTROL: IMAPIDLE_SRC=<an index.js from before the change> node test/imapidle.mjs must fail.
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
const srv = { fetchLimit: Infinity, fetches: 0, logins: 0, conns: 0, idles: 0, idle: true, sweeps: 0, idleTag: null, say: null, close: null };
globalThis.__fakeConnect = ({ hostname, port }) => {
  let ctrl; const enc = new TextEncoder(), dec = new TextDecoder(); let buf = ""; let BOX = MSGS;   // the folder SELECTed
  const say = (s) => queueMicrotask(() => { try { ctrl.enqueue(enc.encode(s)); } catch (_) {} });
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  srv.conns++; srv.say = say; srv.close = () => { try { ctrl.close(); } catch (_) {} };
  const onLine = (line) => {
    if (line === "DONE") { const t = srv.idleTag; srv.idleTag = null; return say(`${t} OK Idle completed.\r\n`); }
    const [tag, cmd, ...rest] = line.split(" ");
    if ((cmd || "").toUpperCase() === "IDLE") { if (!srv.idle) return say(`${tag} BAD Unknown command\r\n`); srv.idles++; srv.idleTag = tag; return say("+ idling\r\n"); }
    if ((cmd || "").toUpperCase() === "UID" && /^FETCH 1:\* /i.test(rest.join(" "))) srv.sweeps++; const C = (cmd || "").toUpperCase(); const R = rest.join(" ");
    if (C === "AUTHENTICATE") { srv.logins++; if (srv.refuse) return say(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`); return say(`${tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS${srv.idle ? " IDLE" : ""}] Logged in\r\n`); }
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
const SRC = readFileSync(process.env.IMAPIDLE_SRC || HUB + "src/index.js", "utf8").replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, "const connect = (...a) => globalThis.__fakeConnect(...a);").replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_imapidle_worker.mjs`; writeFileSync(tmp, SRC); let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const env = { DB: d1, CLI_TOKEN: "cli", DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", WORK_PASS: PASS, STORE: { put: async () => ({}), get: async () => null, delete: async () => {} },
  IMAP_ACCOUNTS: JSON.stringify([{ email: ACCT, label: "Corp", host: "mail.corp.example", port: 993, secret: "WORK_PASS", smtp_host: "mail.corp.example", smtp_port: 465 }]) };
const sync = async () => { const waits = []; const r = await mod.default.fetch(new Request("https://hub.example/api/imap/sync", { method: "POST", headers: { Authorization: "Bearer cli", "content-type": "application/json" }, body: "{}" }), env, { waitUntil: (p) => waits.push(p) }); await Promise.allSettled(waits); return (await r.json()).results?.[0] || {}; };
const folder = () => sq.prepare("SELECT highwater, lowwater, last_error, sync_until, sync_token FROM imap_folders WHERE account = ? AND folder = 'INBOX'").get(ACCT) || {};
const rows = () => sq.prepare("SELECT message_id, created_at FROM messages WHERE imap_account = ?").all(ACCT);


const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await new Promise((r) => setTimeout(r, 10)); } return null; };
const stored = (id) => sq.prepare("SELECT 1 FROM messages WHERE imap_account = ? AND message_id LIKE ?").get(ACCT, `%${id}%`);
try {
  if (typeof mod.imapWatchAll !== "function") throw new Error("the hub has no IMAP watcher (imapWatchAll)");
  mkMsgs(3, 1001, 30);
  mod.IMAP_WATCH.endMs = 2600; mod.IMAP_WATCH.sliceMs = 700; mod.IMAP_WATCH.marginMs = 100;
  // 1. one sign-in, caught up, then waiting; new mail stored the moment the server says so, on the same connection
  srv.logins = 0; srv.conns = 0; srv.idles = 0;
  const w = mod.imapWatchAll(env, Date.now());
  const idling = await until(() => !!srv.idleTag);
  check(idling !== null && rows().length === 3 && srv.logins === 1, `one sign-in catches up (3 stored) and then waits in IDLE (${srv.logins} sign-in, idling after ${idling} ms)`);
  mkMsgs(1, 3000, 0); const newId = MSGS[MSGS.length - 1].msgid;
  srv.say(`* ${MSGS.length} EXISTS\r\n`); const t0 = Date.now();
  const took = await until(() => !!stored(newId.replace(/[<>]/g, "")));
  check(took !== null && took < 500 && srv.logins === 1 && srv.conns === 1, `a new message is stored ${took} ms after the server says it arrived, on the same connection (${srv.logins} sign-in, ${srv.conns} connection)`);
  // 2. while it watches, the minute's own check signs in to nothing
  await until(() => !!srv.idleTag);
  const minute = await sync();
  check(srv.logins === 1 && /another sync/.test(JSON.stringify(minute)), `the minute's own check stands down while the mailbox is watched (${JSON.stringify(minute).slice(0, 120)})`);
  // 3. mail removed elsewhere wakes it, and the mailbox is swept on that wake
  await until(() => !!srv.idleTag);
  const gone = MSGS.shift(); const s0 = srv.sweeps; srv.say(`* 1 EXPUNGE\r\n`);
  const swept = await until(() => srv.sweeps > s0 && !!sq.prepare("SELECT 1 FROM messages WHERE message_id LIKE ? AND labels LIKE '%removed-on-server%'").get(`%${gone.msgid.replace(/[<>]/g, "")}%`));
  check(swept !== null, `a message expunged elsewhere wakes the watcher and is marked removed (${swept} ms)`);
  const res = await w;
  const f = folder(), ev = sq.prepare("SELECT detail FROM events WHERE kind = 'imap_watch' ORDER BY id DESC LIMIT 1").get()?.detail || "";
  check(srv.idles >= 3 && srv.idleTag === null && !f.sync_token && !f.sync_until && srv.logins === 1, `the wait is renewed in slices, every IDLE ended with DONE, and the lease is given up at the end (${srv.idles} IDLEs, ${srv.logins} sign-in, lease ${f.sync_token || "free"})`);
  check(/wakes=2 /.test(ev) && res[0]?.idle === true, `the watch is logged with its wakes (${ev})`);
  // 4. a server without IDLE: one read, as before
  srv.idle = false; srv.logins = 0; srv.idles = 0; mkMsgs(1, 4000, 0);
  const t1 = Date.now(); const r2 = await mod.imapWatchAll(env, Date.now());
  check(r2[0]?.idle === false && r2[0]?.syncs === 1 && srv.logins === 1 && Date.now() - t1 < 2000 && !folder().sync_token, `a server without IDLE gets one read and the lease back (${JSON.stringify(r2[0])})`);
  srv.idle = true;
  // 5. a connection dropped mid-wait ends the watcher; the next one starts clean
  srv.logins = 0; const w3 = mod.imapWatchAll(env, Date.now());
  await until(() => !!srv.idleTag); srv.close();
  const r3 = await w3;
  check(!!r3[0]?.error && !folder().sync_token, `a connection dropped mid-wait ends the watcher and frees the lease (${r3[0]?.error})`);
  srv.idleTag = null; srv.logins = 0; mod.IMAP_WATCH.endMs = 1200;
  const r4 = await mod.imapWatchAll(env, Date.now());
  check(!r4[0]?.error && r4[0]?.idle === true && srv.logins === 1, `and the next watcher starts clean (${JSON.stringify(r4[0])})`);
  // 6. the minute's cron starts it, in its background
  check(/ctxWaitUntil\(imapWatchAll\(env, event\.scheduledTime/.test(SRC), "the minute's cron run starts the watcher in its background");
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall IMAP watch checks passed");
process.exit(fails.length ? 1 : 0);
