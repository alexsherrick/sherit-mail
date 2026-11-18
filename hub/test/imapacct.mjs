#!/usr/bin/env node
// EXECUTION test for work mailboxes added from Settings: the real Worker handler, real migrations, real SQLite,
// and fake IMAP / SMTP servers behind cloudflare:sockets that record every connection and every credential they are offered.
//
// Work-mailbox passwords must be handled securely. What is pinned here: nothing is stored without a login that works
// on BOTH servers; the password is in no response, no event row and no database column in readable form; a table edit that points
// an account at another server makes the Worker refuse instead of sending the password there; hosts and ports outside the rules
// never get a socket; the check is rate-limited; an app account authorizes its own address and not its domain.
// Usage: node test/imapacct.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const PASS = "Tr0ub4dor&3-xyzzy-unique";              // distinctive, so any leak of it anywhere is findable
const B64PASS = Buffer.from(PASS).toString("base64");

// ---------- real migrations into real SQLite (as test/delta.mjs) ----------
const statements = (sql) => { const out = []; let buf = "";
  for (const part of sql.split(";")) { buf += part + ";"; const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length; if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } }
  const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  // inline "--..." comments go too: 0005's carry semicolons, which the statement split would otherwise cut through
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n");
  for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
}
sq.exec("INSERT INTO gmail_accounts (email, status, refresh_token_enc, refresh_iv, created_at) VALUES ('me@gmail.com', 'active', 'x', 'x', '2026-10-01')");
const d1 = { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }) }); return mk([]); }, batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };   // like D1: one transaction, all or nothing

// ---------- fake mail servers behind connect() ----------
const servers = {                                     // host -> what it speaks and the login it accepts
  "mail.corp.example": { user: "work@corp.example", pass: PASS },
  "mail.newco.example": { user: "me@newco.example", pass: PASS },   // a mailbox that exists only in the app, never in config
  "evil.example": { user: "*", pass: "*" },
  "echo.example": { user: "x@echo.example", pass: PASS, echo: true },             // rejects every login and echoes the credential back
  "echoafter.example": { user: "y@echoafter.example", pass: PASS, echoAfter: true }, // accepts, then echoes it in later errors
  "uni.example": { user: "u@uni.example", pass: "pässwörd-ü-ß" },                   // a password outside Latin-1 // accepts anything: the server a tampered row would point at
};
const conns = [], creds = [];                          // every socket opened; every credential decoded by a server
globalThis.__fakeConnect = ({ hostname, port }) => {
  conns.push(`${hostname}:${port}`);
  const srv = servers[hostname]; let ctrl; const enc = new TextEncoder(), dec = new TextDecoder(); let buf = "", inData = false;
  const say = (s) => queueMicrotask(() => { try { ctrl.enqueue(enc.encode(s)); } catch (_) {} });
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const ok = (b64) => { const [, u, p] = Buffer.from(b64, "base64").toString().split("\u0000"); creds.push({ host: hostname, port, user: u, pass: p }); return srv && (srv.user === "*" || (u === srv.user && p === srv.pass)); };
  const imap = port === 993;
  const onLine = (line) => {
    if (imap) {
      const [tag, cmd, ...rest] = line.split(" "); const C = (cmd || "").toUpperCase();
      if (C === "AUTHENTICATE") { const good = ok(rest[1]); if (srv.echo) return say(`${tag} NO [${PASS}] Authentication failed for ${PASS} (${rest[1]}) ${B64PASS}\r\n`); return say(good ? `${tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] Logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`); }
      if (srv.echoAfter && C === "SELECT") return say(`${tag} NO Mailbox locked by ${PASS} / ${B64PASS}\r\n`);
      if (C === "LIST") return say(`* LIST (\\HasNoChildren) "." "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "." "Sent"\r\n* LIST (\\HasNoChildren \\Trash) "." "Trash"\r\n* LIST (\\HasNoChildren \\Archive) "." "Archive"\r\n${tag} OK List completed\r\n`);
      if (C === "SELECT") return say(`* 0 EXISTS\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n* OK [UIDNEXT 1] Predicted next UID\r\n${tag} OK [READ-WRITE] Select completed\r\n`);
      if (C === "UID" && /^SEARCH$/i.test(rest[0])) return say(`* SEARCH\r\n${tag} OK Search completed\r\n`);
      if (C === "LOGOUT") { say(`* BYE Logging out\r\n${tag} OK Logout completed\r\n`); return queueMicrotask(() => { try { ctrl.close(); } catch (_) {} }); }
      return say(`${tag} OK done\r\n`);
    }
    if (inData) { if (line === ".") { inData = false; say("250 2.0.0 Ok: queued\r\n"); } return; }
    const C = line.split(" ")[0].toUpperCase();
    if (C === "EHLO") return say("250-mail.corp.example\r\n250 AUTH PLAIN LOGIN\r\n");
    if (C === "AUTH") { const good = ok(line.split(" ")[2]); if (srv.echo) return say(`535 5.7.8 ${PASS} rejected (${line.split(" ")[2]}) ${B64PASS}\r\n`); return say(good ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6\r\n"); }
    if (srv.echoAfter && C === "MAIL") return say(`550 5.7.1 sender ${PASS} ${B64PASS} refused\r\n`);
    if (C === "DATA") { inData = true; return say("354 End data with <CR><LF>.<CR><LF>\r\n"); }
    if (C === "QUIT") { say("221 2.0.0 Bye\r\n"); return queueMicrotask(() => { try { ctrl.close(); } catch (_) {} }); }
    return say("250 2.1.0 Ok\r\n");
  };
  const writable = new WritableStream({ write(chunk) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } } });
  const opened = srv ? Promise.resolve() : Promise.reject(new Error("connect ECONNREFUSED"));
  opened.catch(() => {});
  if (srv) say(imap ? "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=LOGIN] Dovecot ready.\r\n" : "220 mail.corp.example ESMTP Postfix\r\n");
  return { opened, readable, writable, close() { try { ctrl.close(); } catch (_) {} } };
};
// DNS-over-HTTPS: public answers, except names that resolve privately; no SRV records
const PRIVATE = new Set(["sneaky.corp.example"]);
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type");
    if (type === "SRV") return new Response(JSON.stringify({ Answer: name.endsWith("srv.example") ? Array.from({ length: 12 }, (_, i) => ({ type: 33, data: `0 0 ${name.startsWith("_imaps") ? 993 : 465} t${i}.srv.example.` })) : [] }));
    const ip = PRIVATE.has(name) ? (type === "A" ? "10.0.0.5" : null) : (type === "A" ? "203.0.113.10" : null);
    return new Response(JSON.stringify({ Answer: ip ? [{ type: type === "A" ? 1 : 28, data: ip }] : [] }));
  }
  throw new Error("unexpected fetch " + u.href);
};

// ---------- the real Worker ----------
const SRC = readFileSync(process.env.IMAPACCT_SRC || HUB + "src/index.js", "utf8")   // IMAPACCT_SRC: run against a deliberately broken copy
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, "const connect = (...a) => globalThis.__fakeConnect(...a);")
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_imapacct_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmacB = async (k, d) => b64u(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(d)));
const exp = Date.now() + 86400000; const COOKIE = `mh=${exp}.0.${await hmacB(SECRET, `${exp}.0`)}`;
const stored = new Map();                              // every R2 put: key -> { bytes, type }
const env = { DB: d1, SESSION_SECRET: SECRET, CLI_TOKEN: "cli", GMAIL_TOKEN_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", STORE: { put: async (k, v, o) => { stored.set(k, { bytes: typeof v === "string" ? Buffer.from(v) : Buffer.from(v), type: o?.httpMetadata?.contentType }); return {}; }, get: async () => null, delete: async () => {}, head: async () => null },
  IMAP_ACCOUNTS: JSON.stringify([{ email: "work@corp.example", label: "Corp", host: "mail.corp.example", port: 993, secret: "NOT_SET_SECRET", smtp_host: "mail.corp.example", smtp_port: 465 }]) };
const bodies = [];                                     // every response body, to search for the password afterwards
const call = async (method, path, body, { origin = "https://hub.example", cookie = COOKIE, token = null } = {}) => {
  const headers = { "content-type": "application/json", ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) };
  const waits = [];
  const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: (p) => waits.push(p) });
  const text = await r.text(); bodies.push(text); await Promise.allSettled(waits);
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, body: j, text };
};
const add = (over = {}) => call("POST", "/api/imap/accounts", { email: "work@corp.example", password: PASS, host: "mail.corp.example", smtp_host: "mail.corp.example", label: "Work co", ...over });
const row = () => sq.prepare("SELECT * FROM imap_accounts WHERE email = 'work@corp.example'").get();
const row2 = (e) => sq.prepare("SELECT * FROM imap_accounts WHERE email = ?").get(e);
const resetRate = () => sq.exec("DELETE FROM events WHERE kind = 'imap_verify'");

{ // before anything: the config entry is listed, not ready, and there is no app row
  const r = await call("GET", "/api/imap/status");
  const a = r.body?.accounts?.find((x) => x.email === "work@corp.example");
  check(a && a.source === "config" && a.ready === false, `the configured mailbox is listed as needing its password (${JSON.stringify(a && { source: a.source, ready: a.ready })})`);
}
{ // fields refused before any socket opens
  for (const [over, why] of [[{ password: "" }, "no password"], [{ password: "a\u0000b" }, "a NUL in the password"], [{ host: "203.0.113.9" }, "an IP literal"], [{ host: "localhost" }, "localhost"], [{ host: "printer.lan" }, "a home-network name"], [{ host: "sneaky.corp.example" }, "a name resolving to a private address"], [{ port: 143 }, "plaintext IMAP port 143"], [{ smtp_port: 587 }, "STARTTLS SMTP port 587"], [{ email: "not-an-address" }, "a malformed address"], [{ email: "me@gmail.com" }, "a connected Gmail account"], [{ email: "sam@yourdomain.example" }, "an address on a hub domain"], [{ username: "a\u0000b" }, "a NUL in the username"]]) {
    const c0 = conns.length; const r = await add(over);
    check(r.status >= 400 && r.status < 500 && conns.length === c0, `refused without connecting: ${why} (${r.status} ${r.body?.error || ""})`);
  }
}
{ // a wrong password stores nothing, and the error is the server's, not the password
  resetRate(); const c0 = creds.length;
  const r = await add({ password: "wrong-password-123" });
  check(r.status === 422 && /refused the login/.test(r.body?.error || ""), `a wrong password is refused with the server's reply (${r.status} ${r.body?.error})`);
  check(!row(), "and nothing is stored");
  check(creds.slice(c0).some((c) => c.port === 993) && creds.slice(c0).some((c) => c.port === 465), "both servers were asked (IMAP and SMTP, in parallel)");
  check(!r.text.includes("wrong-password-123"), "the response does not echo the password");
}
{ // the right password: verified, sealed, stored; never readable anywhere
  resetRate(); const c0 = creds.length, k0 = conns.length;
  const r = await add();
  const rw = row();
  check(r.status === 200 && r.body?.ok && r.body.account?.ready === true && r.body.account?.source === "app", `the right password connects the mailbox (${r.status} ${JSON.stringify(r.body?.account && { ready: r.body.account.ready, source: r.body.account.source })})`);
  check(rw && rw.pass_enc && rw.pass_iv && !rw.pass_enc.includes(PASS) && !rw.pass_enc.includes(B64PASS) && !JSON.stringify(rw).includes(PASS), "the stored row holds ciphertext, not the password or its base64");
  check(creds.slice(c0).filter((c) => c.pass === PASS).every((c) => c.host === "mail.corp.example"), "the password went only to the server named in the form");
  check(conns.slice(k0).every((h) => h.startsWith("mail.corp.example:")), `no other server was contacted (${[...new Set(conns.slice(k0))].join(", ")})`);
  check(r.body && "synced" in r.body, `the first sync ran before answering (synced ${r.body?.synced})`);
}
{ // nothing the API returns, and nothing it records, contains the password or the ciphertext
  for (const p of ["/api/imap/status", "/api/bootstrap", "/api/me"]) await call("GET", p);
  const rw = row(); const everything = bodies.join("\n");
  check(!everything.includes(PASS) && !everything.includes(B64PASS), "no API response contains the password");
  check(!everything.includes(rw.pass_enc) && !everything.includes(rw.pass_iv), "no API response contains the ciphertext or its IV");
  const ev = JSON.stringify(sq.prepare("SELECT kind, detail FROM events").all());
  check(!ev.includes(PASS) && !ev.includes(B64PASS) && !ev.includes(rw.pass_enc), "no event row contains the password or the ciphertext");
  const me = (await call("GET", "/api/me")).body?.imap_accounts?.find((a) => a.email === "work@corp.example");
  check(me && me.ready === true && me.source === "app" && !("password" in me), `the app sees it connected, with no password field (${JSON.stringify(me)})`);
}
{ // the sync unlocks it and logs in with it
  const c0 = creds.length;
  await call("POST", "/api/imap/sync", {});
  check(creds.slice(c0).some((c) => c.host === "mail.corp.example" && c.port === 993 && c.pass === PASS), "a sync unlocks the sealed password and logs in with it");
}
{ // a send authenticates to SMTP with it, as that address
  const c0 = creds.length;
  const r = await call("POST", "/api/send", { from: "work@corp.example", to: ["someone@else.example"], subject: "hi", text: "hello" });
  check(r.status === 200 && creds.slice(c0).some((c) => c.port === 465 && c.pass === PASS), `a send as the work address authenticates with it (${r.status} ${r.body?.error || ""})`);
  // `mail reply --dry-run` on work mail: resolved through the same route, and no server is contacted
  const k1 = conns.length, n1 = sq.prepare("SELECT COUNT(*) n FROM messages").get().n;
  const pv = await call("POST", `/api/messages/${r.body?.id}/reply/preview`, { text: "and this", attachments: [{ filename: "a.txt", type: "text/plain", content: btoa("hello") }] });
  check(pv.status === 200 && pv.body?.dry_run === true && pv.body.via === "smtp" && /work@corp\.example>?$/.test(pv.body.from || "") && JSON.stringify(pv.body.to) === '["someone@else.example"]' && pv.body.subject === "Re: hi" && pv.body.attachments?.[0]?.bytes === 5,
    `a work-mail reply preview resolves From, To, Subject and the file (${pv.status} ${JSON.stringify(pv.body).slice(0, 200)})`);
  check(conns.length === k1 && sq.prepare("SELECT COUNT(*) n FROM messages").get().n === n1, `and it contacts no server and stores nothing (${conns.length - k1} connections)`);
}
{ // a file sent from the work address is listed under Sent with its own bytes, as the other send path keeps it
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 250, 251, 252]);
  const r = await call("POST", "/api/send", { from: "work@corp.example", to: ["someone@else.example"], subject: "the error page", text: "see attached",
    attachments: [{ filename: "Screenshot 2026-11-16 125614.png", type: "image/png", content: png.toString("base64") }, { filename: "logo.png", type: "image/png", content: png.toString("base64"), disposition: "inline", contentId: "<logo1>" }] });
  const rows = sq.prepare("SELECT filename, content_type, size_bytes, r2_key, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY r2_key").all(r.body?.id ?? "");
  check(r.status === 200 && rows.length === 2, `a work-mail send with two files writes two attachment rows (${r.status} ${rows.length} ${r.body?.error || ""})`);
  const shot = rows.find((x) => x.filename === "Screenshot 2026-11-16 125614.png"), logo = rows.find((x) => x.filename === "logo.png");
  check(shot && shot.content_type === "image/png" && shot.size_bytes === png.length && shot.disposition === "attachment" && shot.content_id === null && shot.r2_key === `att/${r.body.id}/1-Screenshot_2026-11-16_125614.png`,
    `the file's row has its name, type, decoded size and att/ key (${JSON.stringify(shot)})`);
  check(logo && logo.disposition === "inline" && logo.content_id === "logo1", `an inline picture keeps its disposition and bare Content-ID (${JSON.stringify(logo)})`);
  check(rows.every((x) => stored.get(x.r2_key)?.bytes.equals(png) && stored.get(x.r2_key)?.type === "image/png"), "each file's own bytes are stored under its key, not the base64");
  const th = await call("GET", `/api/threads/${sq.prepare("SELECT thread_id FROM messages WHERE id = ?").get(r.body?.id ?? "")?.thread_id}`);
  const sent = th.body?.messages?.find((m) => m.id === r.body?.id);
  check(sent?.attachments?.length === 2 && sent.attachments.some((a) => a.filename === "Screenshot 2026-11-16 125614.png"), `and the conversation the app opens lists them on the sent message (${sent?.attachments?.length})`);
  const k0 = conns.length, m0 = sq.prepare("SELECT COUNT(*) n FROM messages").get().n;
  const bad = await call("POST", "/api/send", { from: "work@corp.example", to: ["someone@else.example"], subject: "x", text: "x", attachments: [{ filename: "a.bin", content: "not*base64!" }] });
  check(bad.status >= 400 && conns.slice(k0).every((h) => !h.endsWith(":465")) && sq.prepare("SELECT COUNT(*) n FROM messages").get().n === m0, `a file that is not base64 is refused before the SMTP server is contacted (${bad.status} ${bad.body?.error || ""})`);
}
{ // an app mailbox authorizes its own address, not its whole domain (a config one is a deploy-time act and does; that is unchanged)
  resetRate();
  const a = await call("POST", "/api/imap/accounts", { email: "me@newco.example", password: PASS, host: "mail.newco.example" });
  check(a.status === 200, `a mailbox that exists only in the app connects (${a.status} ${a.body?.error || ""})`);
  const k0 = conns.length;
  const r = await call("POST", "/api/send", { from: "boss@newco.example", to: ["someone@else.example"], subject: "hi", text: "hello" });
  check(r.status >= 400 && /sender not allowed/.test(r.body?.error || "") && conns.slice(k0).length === 0, `sending as another address at its domain is refused as not allowed (${r.status} ${r.body?.error || ""})`);
  await call("DELETE", "/api/imap/accounts/me%40newco.example");
}
{ // a table edit that points the account at another server makes it refuse: the password never reaches that server
  const saved = row();
  for (const [col, val] of [["host", "evil.example"], ["smtp_host", "evil.example"]]) {
    sq.prepare(`UPDATE imap_accounts SET ${col} = ? WHERE email = 'work@corp.example'`).run(val);
    const c0 = creds.length, k0 = conns.length;
    await call("POST", "/api/imap/sync", {});
    await call("POST", "/api/send", { from: "work@corp.example", to: ["someone@else.example"], subject: "hi", text: "hello" });
    check(!creds.slice(c0).some((c) => c.host === "evil.example") && !conns.slice(k0).some((h) => h.startsWith("evil.example")), `${col} edited in the database: nothing connects to the new server, no password goes there (${[...new Set(conns.slice(k0))].join(", ") || "no connections"})`);
    sq.prepare(`UPDATE imap_accounts SET ${col} = ? WHERE email = 'work@corp.example'`).run(saved[col]);
  }
  // ciphertext moved onto a row it was not sealed for
  sq.prepare("INSERT INTO imap_accounts (email, label, host, port, username, smtp_host, smtp_port, pass_enc, pass_iv, created_at, updated_at) VALUES ('other@evil.example', 'x', 'evil.example', 993, 'other@evil.example', 'evil.example', 465, ?, ?, 'x', 'x')").run(saved.pass_enc, saved.pass_iv);
  const c0 = creds.length, k0 = conns.length; await call("POST", "/api/imap/sync", {});
  check(!creds.slice(c0).some((c) => c.host === "evil.example") && !conns.slice(k0).some((h) => h.startsWith("evil.example")), "ciphertext copied onto another row does not decrypt there: that row never connects");
  sq.exec("DELETE FROM imap_accounts WHERE email = 'other@evil.example'");
  const c1 = creds.length; await call("POST", "/api/imap/sync", {});
  check(creds.slice(c1).some((c) => c.host === "mail.corp.example" && c.pass === PASS), "and the untouched row still works once the edits are undone");
}
{ // changing a server or the password through PATCH is refused; a rename is fine
  let r = await call("PATCH", "/api/imap/accounts/work%40corp.example", { host: "evil.example" });
  check(r.status === 400 && row().host === "mail.corp.example", `PATCH cannot move the account to another server (${r.status})`);
  r = await call("PATCH", "/api/imap/accounts/work%40corp.example", { label: "Work", color: "#10b981" });
  check(r.status === 200 && row().label === "Work" && row().color === "#10b981", "PATCH renames and recolours");
}
{ // only the signed-in same-origin app, or the CLI token
  const c0 = conns.length;
  let r = await call("POST", "/api/imap/accounts", { email: "work@corp.example", password: PASS, host: "mail.corp.example" }, { origin: "https://evil.example" });
  check(r.status === 403 && conns.length === c0, `a cross-origin POST with the session cookie is refused (${r.status})`);
  r = await call("POST", "/api/imap/accounts", { email: "work@corp.example", password: PASS, host: "mail.corp.example" }, { cookie: null, origin: null });
  check(r.status === 401 && conns.length === c0, `no credentials: refused (${r.status})`);
  r = await call("GET", "/api/imap/discover?email=work%40corp.example", null, { cookie: null, origin: null });
  check(r.status === 401, `discovery needs a session too (${r.status})`);
}
{ // not a password-guessing service: 10 checks per 15 minutes
  resetRate(); let last = null; const statuses = [];
  for (let i = 0; i < 11; i++) { const c0 = conns.length; last = await add({ password: "guess-" + i }); statuses.push(last.status); if (i === 10) check(conns.length === c0, "the 11th attempt opens no socket"); }
  check(statuses.slice(0, 10).every((s) => s === 422) && statuses[10] === 429, `ten checks are answered, the eleventh is refused (${statuses.join(",")})`);
  resetRate();
}
{ // discovery finds the server without sending any credential
  const c0 = creds.length;
  const r = await call("GET", "/api/imap/discover?email=someone%40corp.example");
  check(r.status === 200 && r.body?.host === "mail.corp.example" && r.body?.smtp_host === "mail.corp.example", `discovery finds mail.<domain> by its greeting (${JSON.stringify(r.body)})`);
  check(creds.length === c0, "and sends no credential to do it");
}
{ // removal: the row and its password are gone, and nothing logs in any more
  const had = sq.prepare("SELECT COUNT(*) n FROM imap_folders WHERE account = 'work@corp.example'").get().n;
  const r = await call("DELETE", "/api/imap/accounts/work%40corp.example");
  check(r.status === 200 && r.body?.removed === 1 && !row(), "remove deletes the row and the sealed password");
  check(had > 0, `(it had a sync position to forget: ${had} folder row(s))`);
  check(!sq.prepare("SELECT COUNT(*) n FROM imap_folders WHERE account = 'work@corp.example'").get().n, "and where its sync stood, so a re-add on any server starts clean");
  const c0 = creds.length; await call("POST", "/api/imap/sync", {});
  check(!creds.slice(c0).some((c) => c.pass === PASS), "after removal, no sync logs in with it");
  const a = (await call("GET", "/api/me")).body?.imap_accounts?.find((x) => x.email === "work@corp.example");
  check(a && a.source === "config" && a.ready === false, "the configured entry is back to needing its password");
}
{ // a server that echoes the credential in its refusal: nothing it says reaches a response or an event
  resetRate();
  const r = await call("POST", "/api/imap/accounts", { email: "x@echo.example", password: PASS, host: "echo.example" });
  const ev = JSON.stringify(sq.prepare("SELECT detail FROM events").all());
  check(r.status === 422 && !r.text.includes(PASS) && !r.text.includes(B64PASS) && !r.text.includes(Buffer.from("\u0000x@echo.example\u0000" + PASS).toString("base64")), `an echoing server's refusal is reduced to codes (${r.body?.error})`);
  check(!ev.includes(PASS) && !ev.includes(B64PASS), "and nothing of it is stored in events");
}
{ // a server that accepts, then echoes the credential in later errors: sync and send errors are scrubbed
  resetRate();
  const a = await call("POST", "/api/imap/accounts", { email: "y@echoafter.example", password: PASS, host: "echoafter.example" });
  check(a.status === 200, `a server that echoes only after login connects (${a.status} ${a.body?.error || ""})`);
  await call("POST", "/api/imap/sync", {});
  const s = await call("POST", "/api/send", { from: "y@echoafter.example", to: ["z@else.example"], subject: "hi", text: "hello" });
  const stored = JSON.stringify(sq.prepare("SELECT * FROM events").all()) + JSON.stringify(sq.prepare("SELECT * FROM imap_folders").all());
  check(s.status >= 400 && !s.text.includes(PASS) && !s.text.includes(B64PASS), `a send refused with the credential in the reply returns it scrubbed (${s.body?.error})`);
  check(!stored.includes(PASS) && !stored.includes(B64PASS) && /\[redacted\]/.test(stored), "sync and send errors are stored with it cut out ([redacted])");
  await call("DELETE", "/api/imap/accounts/y%40echoafter.example");
}
{ // a password outside Latin-1 logs in (SASL PLAIN is UTF-8)
  resetRate();
  const r = await call("POST", "/api/imap/accounts", { email: "u@uni.example", password: "pässwörd-ü-ß", host: "uni.example" });
  check(r.status === 200, `a password with ä ö ü ß connects (${r.status} ${r.body?.error || ""})`);
  await call("DELETE", "/api/imap/accounts/u%40uni.example");
}
{ // fifteen at once: no more than ten logins happen
  resetRate(); const c0 = creds.length;
  const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => add({ password: "burst-" + i })));
  const imapTries = creds.slice(c0).filter((c) => c.port === 993).length;
  check(imapTries <= 10 && rs.filter((r) => r.status === 429).length >= 5, `15 concurrent attempts: ${imapTries} IMAP logins, ${rs.filter((r) => r.status === 429).length} refused (limit 10)`);
  resetRate();
}
{ // the configured mailbox is pinned to its configured servers
  resetRate(); const k0 = conns.length;
  const r = await add({ host: "mail.newco.example", smtp_host: "mail.newco.example" });
  check(r.status === 409 && conns.length === k0, `the configured address cannot be pointed at other servers (${r.status} ${r.body?.error})`);
}
{ // an app mailbox cannot be moved in place
  resetRate();
  const a = await call("POST", "/api/imap/accounts", { email: "me@newco.example", password: PASS, host: "mail.newco.example" });
  const k0 = conns.length;
  const r = await call("POST", "/api/imap/accounts", { email: "me@newco.example", password: PASS, host: "evil.example" });
  check(a.status === 200 && r.status === 409 && conns.length === k0 && row2("me@newco.example")?.host === "mail.newco.example", `an added mailbox cannot be moved to another server in place (${r.status} ${r.body?.error})`);
  const alerts = sq.prepare("SELECT detail FROM events WHERE kind = 'security_alert'").all().map((x) => x.detail).join("\n");
  check(/Work mailbox added: me@newco\.example now syncs through mail\.newco\.example/.test(alerts) && /Work mailbox removed: work@corp\.example/.test(alerts), "adds and removals are announced as security alerts, naming the server");
  await call("DELETE", "/api/imap/accounts/me%40newco.example");
}
{ // at most five mailboxes
  resetRate();
  for (let i = 0; i < 5; i++) sq.prepare("INSERT INTO imap_accounts (email, host, port, username, smtp_host, smtp_port, pass_enc, pass_iv, created_at, updated_at) VALUES (?, 'mail.newco.example', 993, ?, 'mail.newco.example', 465, 'x', 'x', 'x', 'x')").run(`f${i}@fill.example`, `f${i}@fill.example`);
  const k0 = conns.length; const r = await call("POST", "/api/imap/accounts", { email: "me@newco.example", password: PASS, host: "mail.newco.example" });
  check(r.status === 409 && /At most 5/.test(r.body?.error || "") && conns.length === k0, `a sixth mailbox is refused before any login (${r.status} ${r.body?.error})`);
  sq.exec("DELETE FROM imap_accounts WHERE email LIKE '%@fill.example'");
}
{ // discovery: three candidates at most per role, and 30 lookups per 15 minutes
  sq.exec("DELETE FROM events WHERE kind = 'imap_discover'"); const k0 = conns.length;
  await call("GET", "/api/imap/discover?email=a%40srv.example");
  check(conns.length - k0 <= 6, `a domain publishing 12 SRV targets costs at most 6 sockets (${conns.length - k0})`);
  const st = []; for (let i = 0; i < 30; i++) st.push((await call("GET", "/api/imap/discover?email=b%40nowhere.example")).status);
  check(st.filter((x) => x === 429).length === 1 && st[st.length - 1] === 429, `the 31st lookup in 15 minutes is refused (${st.filter((x) => x === 200).length} answered)`);
  sq.exec("DELETE FROM events WHERE kind = 'imap_discover'");
}
{ // the final sweep: the password appears in no response body and no database row
  const all = bodies.join("\n"); const db = JSON.stringify(sq.prepare("SELECT * FROM events").all()) + JSON.stringify(sq.prepare("SELECT * FROM imap_folders").all());
  check(!all.includes(PASS) && !all.includes(B64PASS), `the password is in none of the ${bodies.length} responses`);
  check(!db.includes(PASS) && !db.includes(B64PASS), "and in no event or folder row");
}

if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall work-mailbox checks passed");
