#!/usr/bin/env node
// An invitation's answer goes the way calendars read one: `calendar: { method: "REPLY", ics }` on a send makes the hub
// send the text and the iTIP REPLY as multipart/alternative, text/plain then text/calendar; method=REPLY (RFC 6047), from a hub address
// through the EMAIL binding and, with the same builder, from the work mailbox over SMTP. Anything but a REPLY, or files beside it, is
// refused before anything goes. And an arriving invitation's calendar parts are stored as the files they are: postal-mime hands them over
// as Uint8Array, which the hub stored as the text of its byte values.
// The real Worker on real migrations and SQLite, its sends captured from the EMAIL binding.
// Usage: node test/invitereply.mjs (exit 1 on any failed check)
// CONTROL: INVITE_SRC=<an index.js from before the change> node test/invitereply.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
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
const SRC = readFileSync(process.env.INVITE_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_invite_worker.mjs`; writeFileSync(tmp, SRC + "\nexport const __cal = typeof calendarMime === \"function\" ? { calendarMime, calendarOf } : null;\n");
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const parsed = async (x) => (x && x.raw ? await PostalMime.parse(x.raw) : {});

const sq = buildDb(); const objs = new Map(); const sends = [];
sq.prepare("INSERT INTO identities (email, display_name, is_active, domain) VALUES ('sam@hub.example', 'Sam Example', 1, 'hub.example')").run();
sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES ('t1', 'planning', '[]', '2026-11-26T02:37:25Z', 1, 'inbox', 0)").run();
sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, subject, message_id, body_text, created_at) VALUES ('m1', 't1', 'in', 'sam@hub.example', 'dana@work.example', 'Dana', '[{\"address\":\"sam@hub.example\"}]', 'Invitation: Planning', '<inv1@work.example>', 'You are invited', '2026-11-26T02:37:25Z')").run();
const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "hub.example",
  STORE: { put: async (k, v) => { objs.set(k, new Uint8Array(await new Response(v instanceof Uint8Array ? v.slice() : v).arrayBuffer())); return { key: k }; },
    get: async (k) => { if (!objs.has(k)) return null; const b = objs.get(k); return { body: new Response(b).body, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => new TextDecoder().decode(b), httpMetadata: {}, customMetadata: {} }; },
    head: async (k) => (objs.has(k) ? { size: objs.get(k).length, customMetadata: {} } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } },
  EMAIL: { send: async (m) => { sends.push(m); return { messageId: `<p${sends.length}@hub.test>` }; } } };
const call = async (path, body) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method: "POST", headers: { Authorization: "Bearer cli-token", "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: () => {}, passThroughOnException: () => {} }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const ICS = ["BEGIN:VCALENDAR", "PRODID:-//Sherit Mail//EN", "VERSION:2.0", "METHOD:REPLY", "BEGIN:VEVENT", "UID:evt-42@work.example", "DTSTAMP:20261126T020000Z",
  "DTSTART;TZID=America/Chicago:20261201T100000", "DTEND;TZID=America/Chicago:20261201T110000", "SEQUENCE:0", "ORGANIZER;CN=Dana:mailto:dana@work.example",
  'ATTENDEE;PARTSTAT=ACCEPTED;CN="Sam Example":mailto:sam@hub.example', "SUMMARY:Planning", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const calOf = (m) => (m.attachments || []).find((a) => /^text\/calendar/i.test(a.mimeType || ""));
try {
  const r = await call("/api/send", { from: "sam@hub.example", to: ["dana@work.example"], subject: "Accepted: Planning", text: "Sam Example accepted this invitation: Planning", in_reply_to: "inv1@work.example", calendar: { method: "REPLY", ics: ICS } });
  const x = sends[0]; const raw = x && x.raw ? String(x.raw) : "";
  check(r.status === 200 && !!raw, `a send with a calendar answer goes, as a built message (${r.status} ${JSON.stringify(r.j).slice(0, 120)})`);
  const top = raw.split("\r\n\r\n")[0];
  check(/^Message-ID: <[0-9a-f-]{36}@hub\.example>$/m.test(top), `the hub's own answer carries a Message-ID, as its other built sends do`);
  check(/^Content-Type: multipart\/alternative;/m.test(top) && /^From: "Sam Example" <sam@hub\.example>$/m.test(top) && /^To: dana@work\.example$/m.test(top) && /^In-Reply-To: <inv1@work\.example>$/m.test(top), `its headers: alternative parts, From with the name, To the organizer, In-Reply-To the invitation (${top.replace(/\r\n/g, " | ").slice(0, 300)})`);
  check(/\r\n--=_cal_[0-9a-f]+\r\nContent-Type: text\/plain; charset=UTF-8\r\n[\s\S]*\r\n--=_cal_[0-9a-f]+\r\nContent-Type: text\/calendar; charset=UTF-8; method=REPLY\r\n/.test(raw), "text/plain first, then text/calendar; method=REPLY");
  const p = await parsed(x); const c = calOf(p); const icsBack = c ? new TextDecoder().decode(c.content) : "";
  check(c && c.method === "REPLY" && /ATTENDEE;PARTSTAT=ACCEPTED;CN="Sam Example":mailto:sam@hub\.example/.test(icsBack) && /UID:evt-42@work\.example/.test(icsBack) && String(p.text || "").includes("accepted this invitation"), `a mail app reads the text and the REPLY back (${c ? c.method : "no calendar part"})`);
  const sent = sq.prepare("SELECT thread_id, direction FROM messages WHERE direction = 'out'").get();
  check(sent && sent.thread_id === "t1", `the answer is filed in the invitation's conversation (${JSON.stringify(sent)})`);
  const bad1 = await call("/api/send", { from: "sam@hub.example", to: ["dana@work.example"], subject: "x", text: "x", calendar: { method: "REQUEST", ics: ICS.replace("METHOD:REPLY", "METHOD:REQUEST") } });
  const bad2 = await call("/api/send", { from: "sam@hub.example", to: ["dana@work.example"], subject: "x", text: "x", calendar: { method: "REPLY", ics: "hello" } });
  const bad3 = await call("/api/send", { from: "sam@hub.example", to: ["dana@work.example"], subject: "x", text: "x", calendar: { method: "REPLY", ics: ICS }, attachments: [{ filename: "a.txt", type: "text/plain", content: "aGk=" }] });
  const bad4 = await call("/api/send", { from: "sam@hub.example", to: ["dana@work.example"], subject: "x", text: "x", calendar: { method: "REPLY", ics: ICS.replace("BEGIN:VEVENT", "BEGIN:VEVENT\r\nBEGIN:VEVENT\r\nUID:planted\r\nEND:VEVENT").replace("END:VCALENDAR", "BEGIN:VTODO\r\nEND:VTODO\r\nEND:VCALENDAR") } });
  check(bad4.status === 400, `a REPLY with a second event or another component nested in it is refused (${bad4.status})`);
  check(bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && sends.length === 1, `anything but a REPLY, a body that is not one, or files beside it, refused before anything goes (${bad1.status} ${bad2.status} ${bad3.status}, ${sends.length} sent)`);
  // the work mailbox builds with the same function, its own Message-ID and threading headers
  const cm = mod.__cal;
  const w = cm ? cm.calendarMime({ from: "sam@corp.example", fromName: "Ålex Exämple", to: [{ email: "dana@work.example", name: "Dana, D." }], cc: [], subject: "Accepted: Plänning", messageId: "<w1@corp.example>", headers: { "In-Reply-To": "<inv1@work.example>", References: "<inv1@work.example>" }, text: "ok", cal: cm.calendarOf({ calendar: { method: "REPLY", ics: ICS } }) }) : "";
  const wp = w ? await PostalMime.parse(w) : {};
  check(!!w && /^Message-ID: <w1@corp\.example>$/m.test(w) && wp.subject === "Accepted: Plänning" && wp.from?.name === "Ålex Exämple" && (wp.to || [])[0]?.name === "Dana, D." && calOf(wp)?.method === "REPLY", `the work mailbox's answer: its Message-ID, names and subject outside ASCII intact, the REPLY part (${wp.subject} / ${wp.from?.name} / ${(wp.to || [])[0]?.name})`);
  // ---------- an invitation arriving: its calendar parts are kept as the files they are ----------
  const INV = ICS.replace("METHOD:REPLY", "METHOD:REQUEST").replace('ATTENDEE;PARTSTAT=ACCEPTED;CN="Sam Example"', "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE");
  const b64 = Buffer.from(INV).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const inRaw = ["From: Dana <dana@work.example>", "To: <sam@hub.example>", "Subject: Invitation: Planning", "Message-ID: <inv2@work.example>", "Date: Wed, 25 Nov 2026 20:00:00 +0000", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="MX"', "", "--MX", 'Content-Type: multipart/alternative; boundary="ALT"', "", "--ALT", "Content-Type: text/plain; charset=UTF-8", "", "You are invited", "--ALT",
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST', "Content-Transfer-Encoding: 7bit", "", INV.trimEnd(), "--ALT--", "--MX", 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64", "", b64, "--MX--", ""].join("\r\n");
  let waits = []; const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  await mod.default.email({ to: "sam@hub.example", from: "dana@work.example", rawSize: inRaw.length, raw: inRaw, headers: new Headers({ subject: "Invitation: Planning", "message-id": "<inv2@work.example>", from: "Dana <dana@work.example>" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  for (let i = 0; i < 5; i++) { const w = waits; waits = []; await Promise.allSettled(w); await new Promise((r) => setTimeout(r, 10)); }
  const rows = sq.prepare("SELECT a.content_type, a.size_bytes, a.r2_key, a.filename FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.message_id = '<inv2@work.example>' ORDER BY a.r2_key").all();
  const kept = rows.map((r) => ({ type: r.content_type, size: r.size_bytes, head: objs.has(r.r2_key) ? new TextDecoder().decode(objs.get(r.r2_key)).slice(0, 15) : null, exact: objs.has(r.r2_key) && new TextDecoder().decode(objs.get(r.r2_key)).replace(/\r?\n/g, "\n").trim() === INV.replace(/\r\n/g, "\n").trim() }));
  check(rows.length === 2 && kept.every((k) => k.head === "BEGIN:VCALENDAR" && k.exact && k.size < 1200), `an arriving invitation's calendar part and its invite.ics are kept as the files they are, not as their byte values (${JSON.stringify(kept)})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall invitation-answer checks passed");
process.exit(fails.length ? 1 : 0);
