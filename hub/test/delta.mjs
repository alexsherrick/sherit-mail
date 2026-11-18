#!/usr/bin/env node
// EXECUTION test for the /api/threads change feed: the real Worker handler, real migrations, real SQLite.
//
// A ticketco mail removed on the phone still showed on the desktop. The phone's action HAD landed (the
// hub row read state='trash'); what failed was the delta that tells the OTHER device about it. `/api/threads` defaults `box` to
// "inbox", and the delta branch reused the same filter as an ordinary listing, so a thread that had just been trashed or archived
// matched no row, fell out of `alive`, and was handed to the client as DELETED. The client then erased its local copy, and with it
// that thread's Message-IDs, which are exactly the set `isHubCopy()` uses to hide the Gmail forwarded copy. So acting on a
// conversation on one device made its Gmail duplicate POP BACK into the inbox on the other.
//
// The defect is in how the query is BUILT, so copying the SQL in here would prove nothing: the real handler runs. And because a
// green test that would also be green on the broken code is worth nothing, the last block re-runs the same scenario against a
// deliberately un-fixed copy of the Worker and requires it to FAIL. Usage: node test/delta.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const TID = "dddddddd-0000-4000-8000-000000000001";        // a thread id, shaped like production's
const MID = "dddddddd-0000-4000-8000-000000000002";
const MSGID = "<202609181610.000000000000000@e.ticketco.example>"; // and a Message-ID of the same shape

// ---------- real migrations into real SQLite ----------
// Split on ";" but keep a trigger body whole: "BEGIN INSERT...; END;" is ONE statement, and splitting it naively drops every
// trigger, which would silently disable the very change feed this test is about.
const statements = (sql) => {
  const out = []; let buf = "";
  for (const part of sql.split(";")) {
    buf += part + ";";
    const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length;
    if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; }
  }
  const t = buf.trim(); if (t && t !== ";") out.push(t);
  return out;
};
function buildDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of statements(sql)) { try { sq.exec(stmt); } catch (_) {} }
  }
  sq.exec(`INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread)
           VALUES ('${TID}', 'ticketco future of ticketing report', '["jason@ticketco.example","sam@domain2.example"]', '2026-09-18T16:10:00.000Z', 1, 'inbox', 1)`);
  sq.prepare(`INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, snippet, ingest_source, created_at)
              VALUES ('${MID}', '${TID}', 'in', 'sam@domain2.example', 'jason@ticketco.example', 'Ticketco Future of Ticketing Report', ?, 'x', 'cloudflare', '2026-09-18T16:10:00.000Z')`).run(MSGID);
  return sq;
}
// D1 refuses a statement with more than 100 bound values (developers.cloudflare.com/d1/platform/limits); SQLite allows 32,766, so
// without this the double could never show the user's "too many SQL variables".
const d1Over = (sq) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => { if (a.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${a.length} bound): SQLITE_ERROR`); return mk(a); },
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => Promise.all(xs.map((x) => x.run())),
});

// ---------- load the real Worker (Cloudflare-only imports stubbed, as test/budget.mjs does) ----------
const SRC = readFileSync(HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadWorker(tag, src) {
  const tmp = `${HUB}test/_delta_${tag}.mjs`;
  writeFileSync(tmp, src);
  try { return await import(tmp); } finally { unlinkSync(tmp); }
}

const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
};
const exp = Date.now() + 86400000;
const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const mkCall = (mod, env) => async (method, path, body) => {
  const r = await mod.default.fetch(new Request("https://hub.example" + path, {
    // Origin is required on anything but GET: the Worker refuses a cross-origin mutation ("cross-origin request refused").
    method, headers: { Cookie: COOKIE, Origin: "https://hub.example", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil: () => {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// One device trashes the conversation; ask what the other device is told.
async function trashScenario(mod) {
  const sq = buildDb();
  const call = mkCall(mod, { DB: d1Over(sq), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" });
  const first = await call("GET", "/api/threads?limit=500&since_seq=0");
  const patched = await call("PATCH", `/api/threads/${TID}`, { state: "trash" });
  const after = await call("GET", `/api/threads?limit=500&since_seq=${first.body?.cursor}`);
  return { sq, call, first, patched, after };
}

const mod = await loadWorker("fixed", SRC);
const s = await trashScenario(mod);

check(mod && s.first.status === 200, `the real Worker answers the delta (${s.first.status})`);
{ const t = (s.first.body?.threads || []).find((x) => x.id === TID);
  check(!!t, "the new conversation arrives on the change feed");
  check(Array.isArray(t?.msg_ids) && t.msg_ids.includes(MSGID),
    `and carries its Message-ID, which is what hides the Gmail copy (${JSON.stringify(t?.msg_ids)})`); }

check(s.patched.status === 200, `the phone's action is accepted (${s.patched.status})`);
check(s.sq.prepare(`SELECT state FROM threads WHERE id='${TID}'`).get().state === "trash", "and the hub row really is trashed");

const row = (s.after.body?.threads || []).find((x) => x.id === TID);
check(!(s.after.body?.deleted || []).includes(TID),
  "a TRASHED conversation is NOT reported as deleted — the other device keeps its copy instead of erasing it");
check(!!row, "the delta carries the trashed row itself, whatever state it is now in");
check(row?.state === "trash", `with its new state, so the other device can file it (${row?.state})`);
check(Array.isArray(row?.msg_ids) && row.msg_ids.includes(MSGID),
  "and still carries the Message-ID, so the Gmail forwarded copy stays hidden instead of popping back into the inbox");

// archiving must behave the same way: it was the box filter, not trash specifically
const arch = await (async () => {
  await s.call("PATCH", `/api/threads/${TID}`, { state: "archived" });
  return s.call("GET", `/api/threads?limit=500&since_seq=${s.after.body?.cursor}`);
})();
check(!(arch.body?.deleted || []).includes(TID) && (arch.body?.threads || []).some((x) => x.id === TID && x.state === "archived"),
  "archiving travels the same way — the bug was the box filter, not trash specifically");

// a REAL deletion must still be a tombstone, or the fix has broken the other half. A purge is only allowed from trash, so put it
// back there first and take a fresh cursor, otherwise this would be reading the state change instead of the delete.
await s.call("PATCH", `/api/threads/${TID}`, { state: "trash" });
const cur3 = (await s.call("GET", `/api/threads?limit=500&since_seq=${arch.body?.cursor}`)).body?.cursor;
const purged = await s.call("DELETE", `/api/threads/${TID}`);
check(purged.status === 200, `a purge is accepted (${purged.status})`);
const gone = await s.call("GET", `/api/threads?limit=500&since_seq=${cur3}`);
check((gone.body?.deleted || []).includes(TID),
  "a conversation actually purged on the hub IS still reported as deleted — tombstones survive the fix");
check(!(gone.body?.threads || []).some((x) => x.id === TID), "and it is not also handed back as a live row");

// ---------- more than 100 conversations in one page of changes, and a conversation of more than 100 messages ----------
// Founder, 2026-10-05, refreshing the Domains view: "D1_ERROR: too many SQL variables at offset 1333; SQLITE_ERROR". The import of
// 160 older work emails wrote thousands of changes; a page of 500 touched more than 100 conversations, and the feed put every one in
// a single IN list. Re-run against the Worker as committed before the fix, which must fail, so this cannot pass by accident.
async function manyScenario(mod) {
  const sq = buildDb(); const call = mkCall(mod, { DB: d1Over(sq), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" });
  const ins = sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES (?, ?, '[]', ?, 1, 'inbox', 0)");
  for (let i = 0; i < 150; i++) ins.run(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `old work mail ${i}`, new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString());
  const BIG = "11111111-1111-4111-8111-111111111111";
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES (?, 'long thread', '[]', '2026-10-01T00:00:00.000Z', 120, 'inbox', 0)").run(BIG);
  const msg = sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, message_id, snippet, ingest_source, created_at) VALUES (?, ?, 'in', 'sam@domain2.example', 'a@x.com', 'long thread', ?, 'x', 'cloudflare', ?)");
  for (let i = 0; i < 120; i++) msg.run(`22222222-2222-4222-8222-${String(i).padStart(12, "0")}`, BIG, `<m${i}@x.com>`, new Date(Date.UTC(2026, 8, 1) + i * 6e4).toISOString());
  sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key) VALUES ('att-last', ?, 'report.pdf', 'application/pdf', 10, 'k')").run("22222222-2222-4222-8222-000000000119");
  return { feed: await call("GET", "/api/threads?limit=500&since_seq=0"), open: await call("GET", `/api/threads/${BIG}`) };
}
{ const r = await manyScenario(mod);
  const got = new Set((r.feed.body?.threads || []).map((t) => t.id));
  check(r.feed.status === 200 && got.size === 152 && !(r.feed.body?.deleted || []).length, `a page of changes touching 152 conversations is answered in full (${r.feed.status}, ${got.size} rows, ${r.feed.body?.error || "no error"})`);
  const dates = (r.feed.body?.threads || []).map((t) => t.last_message_at);
  check(dates.every((d, i) => !i || String(dates[i - 1]) >= String(d)), "newest first, as one query would have returned them");
  check(r.open.status === 200 && (r.open.body?.messages || []).length === 120 && (r.open.body?.attachments || r.open.body?.messages?.flatMap((m) => m.attachments || []) || []).some?.((a) => a.filename === "report.pdf" || a.id === "att-last"),
    `a conversation of 120 messages opens, with the attachment on its last message (${r.open.status}, ${(r.open.body?.messages || []).length} messages, ${r.open.body?.error || "no error"})`);
  const { execSync } = await import("node:child_process"); const gitHas = (sha) => { try { execSync(`git cat-file -e ${sha}^{commit}`, { cwd: HUB, stdio: "ignore" }); return true; } catch (_) { console.log(`SKIP control: ${sha} is not in this checkout`); return false; } };
  if (gitHas("75d27d5")) { const before = execSync("git show 75d27d5:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 << 20 })
    .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
    .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
    .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
  const old = await manyScenario(await loadWorker("before_slices", before));
  check(old.feed.status !== 200 && old.open.status !== 200, `and the Worker before the fix fails both, as the user saw (feed ${old.feed.status}, open ${old.open.status})`); }
}

// ---------- the image key: the hub serves only /api/img URLs the app wrote ----------
// A message frame is same-origin with a CSP of img-src 'self', so a mail's own relative <img src="/api/img?u=…"> carries the session
// cookie. Without the key the hub fetched whatever URL the sender put there, at the moment the mail was opened.
const IMGK = await (async () => {
  const env = { DB: d1Over(buildDb()), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const get = (path) => mod.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} });
  const me = await (await get("/api/me")).json(), boot = await (await get("/api/bootstrap")).json();
  check(typeof me.img_key === "string" && me.img_key.length >= 16 && boot.me?.img_key === me.img_key, `the app is given the image key at boot (/api/me and /api/bootstrap agree: ${!!me.img_key && boot.me?.img_key === me.img_key})`);
  let upstream = 0; const realFetch = globalThis.fetch; globalThis.fetch = async () => { upstream++; return new Response("x"); };
  try {
    const mail = await get("/api/img?u=" + encodeURIComponent("https://sender.example/open.png?r=founder"));
    const wrong = await get("/api/img?u=" + encodeURIComponent("https://sender.example/open.png?r=founder") + "&k=" + "A".repeat(22));
    check(mail.status === 403 && wrong.status === 403 && upstream === 0, `a mail's own /api/img URL (no key, or a wrong one) is refused and nothing is fetched (${mail.status}, ${wrong.status}, ${upstream} upstream)`);
    // an IMAGE load of any other API route needs the key too (a mail's CSS url() or svg <image> aimed at a hub address); a download,
    // which is a navigation, does not
    const as = (path, dest) => mod.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE, "Sec-Fetch-Dest": dest } }), env, { waitUntil: () => {} });
    const ATT = "/api/att/00000000-0000-4000-8000-000000000000";
    const [attImg, attKeyed, attDoc, stats, gatt] = await Promise.all([as(ATT, "image"), as(ATT + "?k=" + me.img_key, "image"), as(ATT, "document"), as("/api/stats", "image"), as("/api/gmail/att/sam%40x.com/m1/a1", "image")]);
    check(attImg.status === 403 && attKeyed.status !== 403 && attDoc.status !== 403, `an attachment image needs the key, an attachment download does not (${attImg.status}, keyed ${attKeyed.status}, download ${attDoc.status})`);
    check(stats.status === 403 && gatt.status === 403 && upstream === 0, `an image load of any other hub route without the key is refused before it runs (stats ${stats.status}, gmail attachment ${gatt.status}, ${upstream} upstream)`);
  } finally { globalThis.fetch = realFetch; }
  return me.img_key;
})();

// ---------- spy trackers: the image proxy never fetches a named one (backstop for client/app.js blockSpyTrackers) ----------
{ const env = { DB: d1Over(buildDb()), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  let upstream = 0; const realFetch = globalThis.fetch; globalThis.fetch = async (...a) => { upstream++; return realFetch(...a); };
  try {
    const r = await mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent("https://u2.ct.sendgrid.net/wf/open?upn=abc") + "&k=" + IMGK, { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} });
    check(r.status === 204 && r.headers.get("x-tracker") === "SendGrid" && upstream === 0, `a SendGrid open pixel is answered empty and never fetched (${r.status}, ${r.headers.get("x-tracker")}, ${upstream} upstream calls)`);
  } finally { globalThis.fetch = realFetch; }
}

// ---------- arrival-time image prefetch ----------
{
  // 1. the worker's copy of the client's tracker code is the client's, character for character
  const APP = readFileSync(HUB + "src/client/app.js", "utf8"), WRK = readFileSync(HUB + "src/index.js", "utf8");
  const sharedOf = (t) => { const a = t.indexOf('const PIXEL_GIF = "data:image/gif'), b = t.indexOf("\nfunction blockSpyTrackers(h, found) {"); const e = t.indexOf("\n}\n", b) + 3; return a >= 0 && b > a ? t.slice(a, e) : null; };
  check(sharedOf(APP) && sharedOf(APP) === sharedOf(WRK), "the worker's tracker code is the client's, verbatim");
  // 2. the URLs prefetched at arrival are exactly the ones the client will ask /api/img for
  const html = `<img src="https://cdn.ex.com/a.png?w=1&amp;h=2" width="600" height="300"><img src=https://cdn.ex.com/bare.jpg width=40 height=40>
    <img src="//cdn.ex.com/proto.png" width="80" height="80"><td background="https://cdn.ex.com/bg.jpg"></td>
    <img srcset="https://cdn.ex.com/1x.png 1x, https://cdn.ex.com/2x.png 2x" src="https://cdn.ex.com/s.png" width="9" height="9">
    <div style="background-image:url('https://cdn.ex.com/css.png')"></div><style>.h{background:url(https://cdn.ex.com/block.png)}</style>
    <img src="cid:logo@x"><img src="data:image/png;base64,AAAA"><img src="https://u2.ct.sendgrid.net/wf/open?upn=x" width="1" height="1">
    <img src="https://trk.ex.net/o/1" width="1" height="1"><picture><source srcset="https://cdn.ex.com/src.webp"><img src="https://cdn.ex.com/pic.png" width="50" height="50"></picture>
    <img src="HTTPS://CDN.EX.COM/Upper.png" width="40" height="40"><div style="background-image:url('https://cdn.ex.com/q.png?a=1&amp;b=2');color:red">x</div>
    <style>.p{background:url(//cdn.ex.com/rel.png)}</style>`;
  const a = APP.indexOf("const SPY_TRACKERS = ["), b = APP.indexOf("function proxyImages(h, atts, found = [], t = 0) {"), c = APP.indexOf("\n}\n", b) + 3;
  const escC = (x) => String(x ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const proxyImages = new Function("esc", "ico", APP.slice(a, b) + APP.slice(b, c) + "\nreturn proxyImages;")(escC, () => "");
  // compared as /api/img keys them (new URL(…).href): a srcset separator comma is not part of the URL
  const fromClient = [...proxyImages(html, []).matchAll(/\/api\/img\?u=([^"'\s)&]+)/g)].map((m) => new URL(decodeURIComponent(m[1].replace(/,+$/, ""))).href).sort();
  const fromWorker = mod.prefetchImageUrls(html).sort();
  console.log("prefetch URLs:", JSON.stringify(fromWorker));
  check(JSON.stringify(fromClient) === JSON.stringify(fromWorker), `prefetch fetches exactly what the client will ask for (client ${fromClient.length}, worker ${fromWorker.length}: ${fromClient.filter((x) => !fromWorker.includes(x)).concat(fromWorker.filter((x) => !fromClient.includes(x))).join(" | ")})`);
  check(!fromWorker.some((u) => /sendgrid|trk\.ex\.net/.test(u)) && fromWorker.includes("https://cdn.ex.com/src.webp"), "no tracker is on the prefetch list, and a <picture> source is (the browser picks it, so it must load)");
  check(fromWorker.includes("https://cdn.ex.com/q.png?a=1&b=2") && fromWorker.includes("https://cdn.ex.com/rel.png") && fromWorker.includes("https://cdn.ex.com/Upper.png"), "a style attribute's url() is entity-decoded, a protocol-relative url() is fetched over https, and a URL is listed as /api/img keys it");
  // 3. prefetchImages stores them in R2 and never calls a tracker host; /api/img then serves R2 without going upstream
  const r2 = new Map(); const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct } } : null), put: async (k, buf, o) => { r2.set(k, { buf, ct: o?.httpMetadata?.contentType }); } };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
  const hosts = [], uas = []; const realFetch = globalThis.fetch;
  // Cloudflare's edge cache, absent in Node; modelled as Cloudflare documents it: a response marked private or no-store is not stored
  const edge = new Map(); globalThis.caches = { default: { match: async (req) => { const r = edge.get(req.url); return r ? r.clone() : undefined; }, put: async (req, res) => { if (/private|no-store/i.test(res.headers.get("cache-control") || "")) return; edge.set(req.url, res); } } };
  globalThis.fetch = async (input, init) => { const u = new URL(typeof input === "string" ? input : input.url); hosts.push(u.hostname); if (u.hostname !== "cloudflare-dns.com") uas.push(init?.headers?.["User-Agent"] || "");
    if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
    return new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } }); };
  const env = { DB: d1Over(buildDb()), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  try {
    const r = await mod.prefetchImages(env, html, "test");
    check(r.stored === fromWorker.length && r2.size === fromWorker.length, `every image is kept in R2 on arrival (${r.stored} stored, ${r2.size} in R2, ${r.failed} failed)`);
    check(!hosts.some((h) => /sendgrid|trk\.ex\.net/.test(h)), `no tracker host was ever contacted (${[...new Set(hosts)].join(", ")})`);
    const dns = hosts.filter((h) => h === "cloudflare-dns.com").length;
    check(dns === 2, `DNS is asked once per host, not once per image (${dns} lookups for ${fromWorker.length} images on one host)`);
    check(uas.length > 0 && uas.every((ua) => /Safari\//.test(ua) && !/mailhub/i.test(ua)), `the sender sees an ordinary browser, not a named proxy (${[...new Set(uas)].join(" | ")})`);
    const again = await mod.prefetchImages(env, html, "test"); check(again.had === fromWorker.length && again.stored === 0, `a second arrival of the same images fetches nothing (${again.had} already held)`);
    hosts.length = 0;
    const waits = []; const res = await mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent("https://cdn.ex.com/a.png?w=1&h=2") + "&k=" + IMGK, { headers: { Cookie: COOKIE } }), env, { waitUntil: (p) => waits.push(p) });
    const body = new Uint8Array(await res.arrayBuffer()); await Promise.all(waits);
    check(res.status === 200 && res.headers.get("x-img-source") === "r2" && body.length === PNG.length && !hosts.some((h) => h === "cdn.ex.com" || h === "cloudflare-dns.com"), `an opened image comes from R2, with no DNS lookup and the sender's server not asked (${res.status}, ${res.headers.get("x-img-source")}, upstream: ${hosts.filter((h) => h === "cdn.ex.com").length})`);
    // An original is not put in the edge cache (its sizes will replace it) and the browser asks again in 5 minutes; a
    // written size is served under its own key, kept a year, and its next open is the edge cache's, with no R2 read.
    let r2reads = 0; const get0 = STORE.get; STORE.get = async (k) => { r2reads++; return get0(k); };
    const ask = async (extra = "") => { const x = await mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent("https://cdn.ex.com/a.png?w=1&h=2") + "&k=" + IMGK + extra, { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} }); await x.arrayBuffer(); return x; };
    const res3 = await ask();
    check(res3.headers.get("x-img-source") === "r2" && r2reads >= 1 && res3.headers.get("cache-control") === "private, max-age=300", `an original's second open is R2 again, not the edge cache, and the browser asks again in 5 minutes (${res3.headers.get("x-img-source")}, ${r2reads} R2 reads, ${res3.headers.get("cache-control")})`);
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(new URL("https://cdn.ex.com/a.png?w=1&h=2").href).digest("hex");
    r2.set(`imgv/${sha}-1600`, { buf: new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), ct: "image/webp" });
    const res4 = await ask("&w=1600"); r2reads = 0; const res5 = await ask("&w=1600"); STORE.get = get0;
    check(res4.headers.get("x-img-source") === "r2-1600" && res4.headers.get("cache-control") === "private, max-age=31536000, immutable" && res5.headers.get("x-img-source") === "edge" && r2reads === 0,
      `a written size is served under its own key, kept a year, and its next open is the edge cache's (${res4.headers.get("x-img-source")}, ${res4.headers.get("cache-control")}; then ${res5.headers.get("x-img-source")}, ${r2reads} R2 reads)`);
    // and an image the hub has never seen is fetched once, then kept
    const pending = []; const res2 = await mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent("https://cdn.ex.com/new.png") + "&k=" + IMGK, { headers: { Cookie: COOKIE } }), env, { waitUntil: (p) => pending.push(p) });
    await res2.arrayBuffer(); await Promise.all(pending);
    check(res2.headers.get("x-img-source") === "upstream" && [...r2.keys()].length === fromWorker.length + 2, `an unseen image is fetched once and kept for every later open (R2 also holds the size written above) (${res2.headers.get("x-img-source")}, R2 now ${r2.size})`);
    const open = (u, ctx = { waitUntil: () => {} }) => mod.default.fetch(new Request("https://hub.example/api/img?u=" + encodeURIComponent(u) + "&k=" + IMGK, { headers: { Cookie: COOKIE } }), env, ctx);
    // an image written with an upper-case host was kept at arrival under the key the proxy looks up
    hosts.length = 0; const up = await open("HTTPS://CDN.EX.COM/Upper.png"); await up.arrayBuffer();
    check(up.headers.get("x-img-source") === "r2" && !hosts.includes("cdn.ex.com"), `an image whose URL the parser normalises is found in R2 at open (${up.headers.get("x-img-source")})`);
    // two opens in flight at once: each one's background work goes to its own invocation
    const ctxA = { n: 0, waitUntil(p) { this.n++; } }, ctxB = { n: 0, waitUntil(p) { this.n++; } };
    const [ra, rb] = await Promise.all([open("https://cdn.ex.com/bare.jpg", ctxA), open("https://cdn.ex.com/proto.png", ctxB)]); await ra.arrayBuffer(); await rb.arrayBuffer();
    check(ctxA.n >= 1 && ctxB.n >= 1, `concurrent requests keep their own background work (${ctxA.n} and ${ctxB.n} waitUntil calls)`);
    // a batch that is out of time stops, rather than running past the waitUntil that carries it
    const late = await mod.prefetchImages(env, '<img src="https://cdn.ex.com/late1.png"><img src="https://cdn.ex.com/late2.png">', "test", { deadline: Date.now() - 1, left: { images: 99, bytes: 1e9 } });
    check(late.stored === 0 && late.skipped === 2, `a prefetch past its batch deadline fetches nothing (${late.stored} stored, ${late.skipped} skipped)`);
    // the day's cap: once 1,000 images have been kept in 24 h, arrival-time fetching stops until the window moves
    await env.DB.prepare("INSERT INTO events (kind, detail) VALUES ('img_prefetch', 'test n=1000 stored=1000 had=0 failed=0 bytes=1')").run();
    hosts.length = 0; const capped = await mod.prefetchImages(env, '<img src="https://cdn.ex.com/cap.png" width="40" height="40">', "test");
    const logged = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'img_prefetch_over_budget'").first();
    check(capped.over === true && !hosts.includes("cdn.ex.com") && logged.n === 1, `past the day's cap nothing is fetched or stored, and the day is logged (${JSON.stringify(capped)}, ${logged.n} logged)`);
  } finally { globalThis.fetch = realFetch; }
}

// ---------- the session generation is cached a few seconds per isolate, and a bump still applies at once ----------
{ const db = d1Over(buildDb()); let reads = 0;
  const DB = { ...db, prepare: (q) => { if (/key = 'session_gen'/.test(q)) reads++; return db.prepare(q); } };
  const env = { DB, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, o = {}) => mod.default.fetch(new Request("https://hub.example" + path, { ...o, headers: { Cookie: COOKIE, Origin: "https://hub.example", ...(o.headers || {}) } }), env, { waitUntil: () => {} });
  const a = await call("/api/me"), b = await call("/api/me");
  check(a.status === 200 && b.status === 200 && reads === 1, `two signed-in requests read the session generation from D1 once, not twice (${reads} reads)`);
  const out = await call("/logout", { method: "POST", body: JSON.stringify({ everywhere: true }) });
  const after = await call("/api/me");
  check(out.status === 200 && after.status === 401, `"sign out everywhere" still refuses the old session at once on the isolate that did it (${out.status}, then ${after.status})`);
}

// ---------- each app's speed report is kept per device and read back ----------
{ const objs = new Map(); const STORE = { put: async (k, v) => { objs.set(k, typeof v === "string" ? v : String(v)); }, get: async (k) => (objs.has(k) ? { text: async () => objs.get(k) } : null) };
  const env = { DB: d1Over(buildDb()), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const report = { version: "v1", ua: "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", rows: [{ name: "open-thread:visible", n: 3, p50: 9 }] };
  const post = await mod.default.fetch(new Request("https://hub.example/api/perf", { method: "POST", body: JSON.stringify(report), headers: { Cookie: COOKIE, Origin: "https://hub.example" } }), env, { waitUntil: () => {} });
  const bad = await mod.default.fetch(new Request("https://hub.example/api/perf", { method: "POST", body: JSON.stringify({ hello: 1 }), headers: { Cookie: COOKIE, Origin: "https://hub.example" } }), env, { waitUntil: () => {} });
  const got = await (await mod.default.fetch(new Request("https://hub.example/api/perf", { headers: { Cookie: COOKIE } }), env, { waitUntil: () => {} })).json();
  check(post.status === 200 && bad.status === 400 && got.android?.rows?.[0]?.p50 === 9 && [...objs.keys()].some((k) => /^perf\/android\/\d{4}-\d{2}-\d{2}\.json$/.test(k)), `a device's speed report is stored by device and day and read back; anything else is refused (${post.status}, ${bad.status}, ${[...objs.keys()].join(" ")})`);
}

// ---------- negative control: the same scenario on the un-fixed Worker must FAIL ----------
// Without this, every check above would still pass if the fix were reverted to a no-op, and the suite would report green on the
// exact defect it exists to catch.
const BROKEN = SRC.replace("`, s, true))", "`, s))");   // the delta's rowsOf call, sliced since 2026-10-05; un-fixed = no allStates
check(BROKEN !== SRC, "the control could actually un-apply the fix (if this fails, the control below proves nothing)");
const broken = await trashScenario(await loadWorker("broken", BROKEN));
check((broken.after.body?.deleted || []).includes(TID),
  "CONTROL: on the un-fixed Worker the trashed conversation IS reported as deleted — this is the user's bug, reproduced");
check(!(broken.after.body?.threads || []).some((x) => x.id === TID),
  "CONTROL: and its row, with its Message-IDs, never reaches the other device — which is what unhid the Gmail copy");

// ---------- the list's paperclip: has_att ----------
// A part is a FILE unless the body shows it (cid:… in the HTML). Every shape the 2026-10-09 production census found is here: the
// disposition header does not decide it (60 parts had none but a Content-ID; the body showed 45 of them).
{
  const sq = buildDb();
  let k = 0;
  const add = (dir, html, parts) => {
    k += 1; const tid = `aaaaaaaa-0000-4000-8000-${String(k).padStart(12, "0")}`, mid = `bbbbbbbb-0000-4000-8000-${String(k).padStart(12, "0")}`;
    sq.exec(`INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state, unread) VALUES ('${tid}', 's-${k}', '[]', '2026-10-09T16:33:29.752Z', 1, 'inbox', 1)`);
    sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, subject, snippet, ingest_source, created_at, body_html) VALUES (?, ?, ?, 'sam@yourdomain.example', 'x@vendor.example', 's', 'x', 'imap', '2026-10-09T16:33:29.752Z', ?)").run(mid, tid, dir, html);
    parts.forEach(([disp, cid], i) => sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(`${mid}-a${i}`, mid, `f${i}`, "application/pdf", 10, `att/${mid}/${i}`, cid, disp));
    return tid;
  };
  const SHOWS = '<p>hi <img src="cid:logo@x"></p>';
  const cases = [
    ["a filed PDF, no Content-ID", 1, add("in", "<p>hi</p>", [["attachment", null]])],
    ["an inline image the body shows", 0, add("in", SHOWS, [["inline", "<logo@x>"]])],
    ["no disposition, Content-ID the body shows", 0, add("in", SHOWS, [[null, "<logo@x>"]])],
    ["no disposition, Content-ID the body does not show", 1, add("in", "<p>hi</p>", [[null, "<file@x>"]])],
    ["marked inline but not shown", 1, add("in", "<p>hi</p>", [["inline", "<logo@x>"]])],
    ["marked attachment with a Content-ID", 1, add("in", SHOWS, [["attachment", "<other@x>"]])],
    ["an empty Content-ID", 1, add("in", SHOWS, [["inline", ""]])],
    ["a body image plus a real file", 1, add("in", SHOWS, [["inline", "<logo@x>"], ["attachment", null]])],
    ["no HTML body at all", 1, add("in", null, [[null, "<logo@x>"]])],
    ["a sent message with a file", 1, add("out", "<p>attached</p>", [["attachment", null]])],
    ["no attachment", 0, add("in", "<p>hi</p>", [])],
  ];
  const call = mkCall(mod, { DB: d1Over(sq), SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" });
  for (const path of ["/api/threads?limit=200&box=inbox", "/api/threads?limit=500&since_seq=0"]) {
    const r = await call("GET", path); const by = Object.fromEntries((r.body?.threads || []).map((t) => [t.id, t.has_att]));
    const wrong = cases.filter(([, want, tid]) => by[tid] !== want).map(([name, want, tid]) => `${name}: ${by[tid]}, want ${want}`);
    check(r.status === 200 && !wrong.length, `${path.split("&")[1]}: has_att is right for all ${cases.length} attachment shapes (${wrong.join("; ") || "none wrong"})`);
  }
}

console.log(fails.length ? "FAILED: " + fails.join("; ") : "all change-feed checks passed");
process.exit(fails.length ? 1 : 0);
