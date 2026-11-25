#!/usr/bin/env node
// The picture queue: a picture its mail's arrival did not
// keep is retried by the cron on the arrival's schedule, and an open of it never reaches the sender. The real Worker runs over the
// real migrations against a fake sender that counts every request; the same open against f6beaa9's Worker must reach the sender.
// Checks that:
//  - arrival writes a row per picture and removes it once kept; a failed one keeps its row: an error → 15 min, over the arrival cap →
//  a minute, not an image → given up;
//  - an open of a picture with a row is answered 404 "withheld" and asks the sender nothing, and counts the open on the row;
//  - an open during the arrival fetch waits for it and is served from R2, still without asking the sender;
//  - a picture with no row (mail from before the queue) is fetched at the open as before, and counted as img_open_upstream;
//  - the cron keeps the retried pictures (the big one at the open cap), logs them for the day's allowance, and the next open is R2;
//  - a picture that always fails is tried 4 times (15 min, 2 h, 12 h apart) and then given up, still withheld;
//  - the day's allowance spent: rows wait an hour, withheld; the arrival cut off by its deadline: the cron takes the rest;
//  - the arrival's last write lost: the rows written ahead are taken by the cron once the fetch window has passed;
//  - a week waiting gives a row up, 90 days removes a given-up one;
//  - CONTROL: f6beaa9's Worker sends the open of a picture whose arrival fetch failed to the sender.
// Usage: node test/imgqueue.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process"; const gitHas = (sha) => { try { execSync(`git cat-file -e ${sha}^{commit}`, { cwd: HUB, stdio: "ignore" }); return true; } catch (_) { console.log(`SKIP control: ${sha} is not in this checkout`); return false; } };

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };

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
  return sq;
}
const d1 = (sq, faults = {}) => ({
  prepare(sql) {
    const mk = (params) => ({
      sql, bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => { if (faults.batch && faults.batch(xs)) throw new Error("D1 batch lost (injected)"); return Promise.all(xs.map((x) => x.run())); },
});

const stub = (src) => src
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadWorker(tag, src) {
  const tmp = `${HUB}test/_imgqueue_${tag}.mjs`;
  writeFileSync(tmp, stub(src));
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

// ---------- the fake sender: every request counted; /flaky.png fails until the sender decides the mail has been "opened" ----------
const MIB = 1024 * 1024;
const png = (n) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30]); return b; };
const sender = { asked: [], flakyUp: false, slowMs: 0 };
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  sender.asked.push(u.pathname);
  if (sender.slowMs) await new Promise((r) => setTimeout(r, sender.slowMs));
  const ok = (n) => new Response(png(n), { headers: { "content-type": "image/png", "content-length": String(n) } });
  if (u.pathname.startsWith("/ok")) return ok(2000);
  if (u.pathname === "/flaky.png") return sender.flakyUp ? ok(3000) : new Response("busy", { status: 503 });
  if (u.pathname === "/always.png") return new Response("gone", { status: 500 });
  if (u.pathname === "/big.png") return ok(9 * MIB);
  if (u.pathname === "/page.png") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  // A PNG under a wrong type (a school district's mail host, a clinic's CDN), an SVG, and a picture that needs its token
  if (u.pathname === "/mislabeled.png") return new Response(png(1500), { headers: { "content-type": "application/x-www-form-urlencoded" } });
  if (u.pathname === "/undef.png") return new Response(png(1600), { headers: { "content-type": "undefined" } });
  if (u.pathname === "/icon.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { "content-type": "image/svg+xml" } });
  if (u.pathname === "/tok.png") return u.searchParams.get("alt") === "media" && u.searchParams.get("token") === "abc" ? ok(1700) : new Response("no token", { status: 403 });
  return new Response("nope", { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const IMG = (p) => "https://img.sender.example" + p;
const mail = (...ps) => ps.map((p) => `<img src="${IMG(p)}" width="40" height="30">`).join("");

async function setup(src, tag, faults) {
  const r2 = new Map(), sq = buildDb();
  const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k).buf).body, httpMetadata: { contentType: r2.get(k).ct } } : null), put: async (k, buf, o) => { r2.set(k, { buf, ct: o?.httpMetadata?.contentType, via: o?.customMetadata?.via }); } };
  const m = await loadWorker(tag, src), env = { DB: d1(sq, faults), STORE, SESSION_SECRET: SECRET, DOMAINS: "domain2.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, ctx) => m.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE } }), env, ctx);
  const key = (await (await call("/api/me", { waitUntil: () => {} })).json()).img_key;
  const open = async (p, extra = "") => {
    const waits = [], n0 = sender.asked.length;
    const res = await call("/api/img?u=" + encodeURIComponent(p.startsWith("http") ? p : IMG(p)) + "&k=" + key + extra, { waitUntil: (x) => waits.push(x) });
    const len = (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength; await Promise.allSettled(waits);
    return { status: res.status, source: res.headers.get("x-img-source"), len, asked: sender.asked.length - n0 };
  };
  const row = (p) => sq.prepare("SELECT * FROM img_queue WHERE url = ?").get(IMG(p)) || null;
  const due = (p) => sq.prepare("UPDATE img_queue SET next_at = ? WHERE url = ?").run(new Date(Date.now() - 1000).toISOString(), IMG(p));
  const mins = (p) => { const x = row(p); return x ? Math.round((Date.parse(x.next_at) - Date.now()) / 60000) : null; };
  return { m, env, sq, r2, call, open, row, due, mins };
}
const SRC = readFileSync(HUB + "src/index.js", "utf8");
const BIG = { images: 99, bytes: 1e9 };

// ---------- 1. arrival ----------
{
  const s = await setup(SRC, "a");
  sender.flakyUp = false;
  const r = await s.m.prefetchImages(s.env, mail("/ok1.png", "/flaky.png", "/big.png", "/page.png"), "test", { left: { ...BIG } });
  check(r.stored === 1 && r.failed === 3, `arrival keeps the one good picture and fails three (${JSON.stringify(r)})`);
  check(!s.row("/ok1.png"), "the kept picture has no row left");
  const f = s.row("/flaky.png"), b = s.row("/big.png"), p = s.row("/page.png");
  check(f && f.state === "pending" && f.kind === "fail" && f.tries === 1 && s.mins("/flaky.png") === 15 && !f.fetching_until, `the sender's error: retried in 15 min (${f && [f.state, f.kind, f.tries, s.mins("/flaky.png")]})`);
  check(b && b.state === "pending" && b.kind === "big" && s.mins("/big.png") <= 1, `over the arrival cap: retried within a minute (${b && [b.state, b.kind, s.mins("/big.png")]})`);
  check(p && p.state === "dead", `not an image: given up (${p && [p.state, p.note]})`);
  // 2. opens
  const o1 = await s.open("/ok1.png"), of = await s.open("/flaky.png"), ob = await s.open("/big.png"), op = await s.open("/page.png");
  check(o1.status === 200 && o1.source === "r2" && o1.asked === 0, `the kept picture opens from R2 (${JSON.stringify(o1)})`);
  check(of.status === 404 && of.source === "withheld" && of.asked === 0, `the open of the failed one is withheld and asks the sender nothing (${JSON.stringify(of)})`);
  check(ob.asked === 0 && op.asked === 0 && ob.source === "withheld" && op.source === "withheld", `so are the big one and the given-up one (${ob.source}, ${op.source}; asked ${ob.asked + op.asked})`);
  check(s.row("/flaky.png").opens === 1, `the withheld open is counted on its row (${s.row("/flaky.png").opens})`);
  // 3. a picture with no row: as before
  const old = await s.open("/ok-old.png");
  const ev = s.sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'img_open_upstream'").get().n;
  check(old.status === 200 && old.source === "upstream" && old.asked === 1 && ev === 1, `a picture with no row is fetched at the open as before, and counted (${JSON.stringify(old)}, events ${ev})`);
  // 5. the cron
  sender.flakyUp = true; s.due("/flaky.png"); s.due("/big.png"); const n0 = sender.asked.length;
  const d = await s.m.drainImgQueue(s.env);
  check(d.stored === 2 && !s.row("/flaky.png") && !s.row("/big.png") && s.row("/page.png"), `the cron keeps the two retried pictures, the given-up one stays (${JSON.stringify(d)})`);
  const bigKept = [...s.r2.values()].find((x) => x.buf.byteLength === 9 * MIB);
  check(bigKept && bigKept.via === "queue", `the big one is kept at the open cap (${bigKept ? bigKept.buf.byteLength : "none"} bytes, via ${bigKept?.via})`);
  const qev = s.sq.prepare("SELECT detail FROM events WHERE kind = 'img_prefetch' AND detail LIKE 'queue %'").get();
  const left = await s.m.prefetchAllowance(s.env);
  check(qev && /stored=2/.test(qev.detail) && left.bytes <= 250 * MIB - 9 * MIB - 3000, `and logs them for the day's allowance (${qev?.detail}; ${left.bytes} bytes left)`);
  const of2 = await s.open("/flaky.png");
  check(of2.status === 200 && of2.source === "r2" && of2.asked === 0, `the next open of the retried one is R2 (${JSON.stringify(of2)})`);
  check(sender.asked.length - n0 === 2, `the cron asked the sender once for each, at times the arrival set (${sender.asked.length - n0})`);
  // 6. always failing: 4 attempts, then given up
  await s.m.prefetchImages(s.env, mail("/always.png"), "test", { left: { ...BIG } }); const gaps = [s.mins("/always.png")];
  for (let i = 0; i < 3; i++) { s.due("/always.png"); await s.m.drainImgQueue(s.env); gaps.push(s.row("/always.png").state === "dead" ? "dead" : s.mins("/always.png")); }
  const a = s.row("/always.png");
  check(JSON.stringify(gaps) === JSON.stringify([15, 120, 720, "dead"]) && a.tries === 4, `a picture that always fails is retried 15 min, 2 h and 12 h later, then given up (${JSON.stringify(gaps)}, tries ${a.tries})`);
  check((await s.open("/always.png")).asked === 0, "and its open still asks the sender nothing");
  // 10. prune
  s.sq.prepare("INSERT INTO img_queue (hk, url, state, kind, tries, next_at, at) VALUES (1, 'https://x.example/a', 'pending', 'fail', 1, ?, ?), (2, 'https://x.example/b', 'dead', 'fail', 4, ?, ?)").run(new Date().toISOString(), new Date(Date.now() - 8 * 86400e3).toISOString(), new Date().toISOString(), new Date(Date.now() - 91 * 86400e3).toISOString());
  await s.m.pruneImgQueue(s.env);
  const p1 = s.sq.prepare("SELECT state FROM img_queue WHERE hk = 1").get(), p2 = s.sq.prepare("SELECT state FROM img_queue WHERE hk = 2").get();
  check(p1?.state === "dead" && !p2, `a week waiting gives a row up; 90 days removes a given-up one (${p1?.state}, ${p2 ? p2.state : "gone"})`);
}
// ---------- 4. an open during the arrival fetch waits for it ----------
{
  const s = await setup(SRC, "w");
  sender.slowMs = 1500;
  const arrival = s.m.prefetchImages(s.env, mail("/ok-slow.png"), "test", { left: { ...BIG } });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now(), o = await s.open("/ok-slow.png"), waited = Date.now() - t0; await arrival; sender.slowMs = 0;
  check(o.status === 200 && o.source === "r2" && o.asked === 0, `an open during the arrival fetch waits for it and is served from R2 (${JSON.stringify(o)}, ${waited} ms)`);
}
// ---------- 7. the day's allowance spent; 8. the deadline ----------
{
  const s = await setup(SRC, "o");
  const r = await s.m.prefetchImages(s.env, mail("/ok2.png", "/ok3.png"), "test", { left: { images: 0, bytes: 0 } });
  const x = s.row("/ok2.png");
  check(r.over && x && x.kind === "over" && s.mins("/ok2.png") === 60 && (await s.open("/ok2.png")).asked === 0, `the day's allowance spent: the rows wait an hour and the open is withheld (${x && [x.kind, s.mins("/ok2.png")]})`);
  const r2 = await s.m.prefetchImages(s.env, mail("/ok4.png", "/ok5.png"), "test", { left: { ...BIG }, deadline: Date.now() - 1 });
  const y = s.row("/ok5.png");
  check(r2.stored === 0 && y && y.kind === "new" && !y.fetching_until && Date.parse(y.next_at) <= Date.now(), `cut off by its deadline: the rows are due for the cron at once (${y && [y.kind, y.next_at]})`);
  const d = await s.m.drainImgQueue(s.env);
  check(d.stored === 2 && !s.row("/ok4.png") && !s.row("/ok5.png"), `and the cron keeps them (${JSON.stringify(d)})`);
}
// ---------- 9. the arrival's last write lost ----------
{
  let lose = false;
  const s = await setup(SRC, "l", { batch: (xs) => lose && xs.some((x) => /^(UPDATE|DELETE) img_queue|^UPDATE img_queue/.test(x.sql)) });
  sender.flakyUp = false; lose = true;
  await s.m.prefetchImages(s.env, mail("/flaky.png"), "test", { left: { ...BIG } }); lose = false;
  const x = s.row("/flaky.png");
  check(x && x.kind === "new" && x.fetching_until && (await s.open("/flaky.png")).asked === 0, `the last write lost: the row written ahead stays, and the open is still withheld (${x && [x.kind, x.fetching_until ? "fetching" : ""]})`);
  s.sq.prepare("UPDATE img_queue SET fetching_until = ?, next_at = ? WHERE url = ?").run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), IMG("/flaky.png"));
  sender.flakyUp = true; const d = await s.m.drainImgQueue(s.env);
  check(d.stored === 1 && !s.row("/flaky.png"), `once its fetch window has passed the cron takes it (${JSON.stringify(d)})`);
}
// ---------- 10. each sender's share holds in the cron's drain ----------
{
  const s = await setup(SRC, "n2");
  s.sq.prepare("INSERT INTO events (kind, detail) VALUES ('img_prefetch', ?)").run("hub:x from=attacker.example n=250 stored=250 had=0 failed=0 over=0 skipped=0 sized=0 bytes=500000 ms=1");
  const a = await s.m.prefetchImages(s.env, mail("/ok-a1.png", "/ok-a2.png"), "test", { left: { ...BIG }, from: "promo@mail.attacker.example" });
  const b = await s.m.prefetchImages(s.env, mail("/ok-b1.png"), "test", { left: { images: 0, bytes: 0 }, from: "news@other.example" });
  const c = await s.m.prefetchImages(s.env, mail("/ok-c1.png"), "test", { left: { images: 0, bytes: 0 }, from: "not an address" });
  check(a.over && s.row("/ok-a1.png")?.dom === "attacker.example" && s.row("/ok-b1.png")?.dom === "other.example" && s.row("/ok-c1.png")?.dom === "-",
    `each queued picture keeps its sender's organisation, "-" for a From with no readable domain (${[s.row("/ok-a1.png")?.dom, s.row("/ok-b1.png")?.dom, s.row("/ok-c1.png")?.dom]})`);
  for (const p of ["/ok-a1.png", "/ok-a2.png", "/ok-b1.png", "/ok-c1.png"]) s.due(p);
  const d = await s.m.drainImgQueue(s.env);
  check(d.over === 2 && d.stored === 2 && s.row("/ok-a1.png")?.kind === "over" && !s.row("/ok-b1.png") && !s.row("/ok-c1.png"),
    `a sender past its share at arrival stays past it in the cron's drain; others' pictures are kept (${JSON.stringify(d)})`);
  const ev = s.sq.prepare("SELECT detail FROM events WHERE kind = 'img_prefetch' AND detail LIKE 'queue%' ORDER BY id").all().map((x) => x.detail);
  check(ev.some((e) => e === "queue from=other.example stored=1 bytes=2000") && ev.some((e) => e === "queue from=- stored=1 bytes=2000") && ev.some((e) => /^queue n=4 stored=0 .* bytes=0 /.test(e)),
    `what the drain keeps is counted once, against its sender (${ev.join(" | ")})`);
}
// ---------- 11. No open-time fetch for recent mail; ages; counting ----------
{
  const s = await setup(SRC, "c8"), DAY = 864e5, today = Math.floor(Date.now() / DAY) * DAY;
  // finding 8: a mail of 201 pictures: the 201st has no row; opened, it is not fetched from the sender
  const many = Array.from({ length: 201 }, (_, i) => `/ok-m${i}.png`);
  await s.m.prefetchImages(s.env, mail(...many), "test", { left: { ...BIG }, from: "news@many.example" });
  const o201 = await s.open("/ok-m200.png", "&t=" + today);
  check(!s.row("/ok-m200.png") && o201.status === 404 && o201.source === "not-kept" && o201.asked === 0,
    `the 201st picture of a mail received today has no row and is not fetched at the open (${o201.status} ${o201.source}, ${o201.asked} asked)`);
  const old = await s.open("/ok-old.png", "&t=" + (today - 100 * DAY)), pre = await s.open("/ok-pre.png", "&t=" + Date.parse("2026-11-01T00:00:00Z")), none = await s.open("/ok-none.png");
  check(old.asked === 1 && pre.asked === 1 && none.asked === 1, `mail older than 90 days, mail from before the queue and an app that sends no t are fetched at the open as before (${old.asked}, ${pre.asked}, ${none.asked})`);
  // finding 4: an address the hub would never fetch at arrival is not fetched at an open
  const long = await s.open("https://img.sender.example/ok-" + "z".repeat(2100) + ".png"), host = await s.open("https://" + "a.".repeat(130) + "example.net/ok.png");
  check(long.status === 400 && host.status === 400 && long.asked === 0 && host.asked === 0, `an address past 2,048 characters or a host past 253 is refused at the open (${long.status}, ${host.status})`);
  // finding 7: a new arrival gives an old given-up row a new age, so the day's prune does not take it
  await s.m.prefetchImages(s.env, mail("/always.png"), "test", { left: { ...BIG }, from: "news@sender.example" });   // fails: its row stays
  const before = s.row("/always.png");
  s.sq.prepare("UPDATE img_queue SET state = 'dead', at = ? WHERE url = ?").run(new Date(Date.now() - 100 * DAY).toISOString(), IMG("/always.png"));
  await s.m.prefetchImages(s.env, mail("/always.png"), "test", { left: { ...BIG }, from: "news@sender.example" });   // the same picture again
  await s.m.pruneImgQueue(s.env);
  const after = s.row("/always.png");
  check(before && after && Date.now() - Date.parse(after.at) < 60e3, `a given-up row 100 days old that arrives again with new mail gets a new age, and the prune keeps it (${after ? after.state + " " + after.at : "gone"})`);
  // finding 12: a picture whose store failed is not counted as kept for its sender
  s.sq.prepare("DELETE FROM events").run();
  await s.m.prefetchImages(s.env, mail("/ok-put.png"), "test", { left: { images: 0, bytes: 0 }, from: "news@put.example" });
  s.due("/ok-put.png"); const put0 = s.env.STORE.put; s.env.STORE.put = async () => { throw new Error("R2 down"); };
  const d = await s.m.drainImgQueue(s.env); s.env.STORE.put = put0;
  const ev = s.sq.prepare("SELECT detail FROM events WHERE kind = 'img_prefetch' AND detail LIKE 'queue%'").all().map((x) => x.detail);
  check(d.stored === 0 && !ev.some((e) => /from=put\.example/.test(e)) && ev.every((e) => !/stored=-/.test(e)), `a store that fails is counted for no one (${ev.join(" | ")})`);
}
// ---------- a bare src is read to its end, and a picture's bytes decide its type ----------
// Google's notices write `src=https://…?alt=media&amp;token=…` unquoted; the reader stopped at the first `=`, so the arrival fetched
// `…?alt`, the host refused it, and the open (asking for the same cut URL) was withheld. A PNG served as
// application/x-www-form-urlencoded, or as "undefined", was given up as "not an image".
const TOK = IMG("/tok.png") + "?alt=media&token=abc";
const bareMail = `<img src=${IMG("/tok.png")}?alt=media&amp;token=abc alt="Visit us" width=33><img src="${IMG("/mislabeled.png")}"><img src="${IMG("/undef.png")}"><img src="${IMG("/icon.svg")}">`;
async function bareAndTyped(src, tag) {
  const s = await setup(src, tag);
  const urls = s.m.prefetchImageUrls(bareMail);
  const r = await s.m.prefetchImages(s.env, bareMail, "test", { left: { ...BIG } });
  const opens = { tok: await s.open(TOK), mis: await s.open("/mislabeled.png"), undef: await s.open("/undef.png"), svg: await s.open("/icon.svg") };
  return { s, urls, r, opens };
}
{
  const { s, urls, r, opens } = await bareAndTyped(SRC, "b");
  check(urls.includes(TOK) && !urls.some((u) => /\?alt$/.test(u)), `a bare src is read to its end, token and all (${urls.filter((u) => /tok/.test(u)).join(", ")})`);
  check(r.stored === 3 && r.failed === 1, `arrival keeps the tokened picture and the two mislabelled PNGs, and fails the SVG (${JSON.stringify(r)})`);
  check(opens.tok.status === 200 && opens.tok.source === "r2" && opens.tok.asked === 0, `the tokened picture opens from R2 (${JSON.stringify(opens.tok)})`);
  check([opens.mis, opens.undef].every((o) => o.status === 200 && o.source === "r2" && o.asked === 0), `so do the PNGs served as form data and as "undefined" (${JSON.stringify([opens.mis, opens.undef])})`);
  const kept = [...s.r2.values()].filter((x) => x.buf.byteLength === 1500 || x.buf.byteLength === 1600);
  check(kept.length === 2 && kept.every((x) => x.ct === "image/png"), `and they are kept as image/png, what their bytes are (${kept.map((x) => x.ct)})`);
  const sv = s.row("/icon.svg");
  check(sv && sv.state === "dead" && sv.note === "not an image" && opens.svg.source === "withheld" && opens.svg.asked === 0, `an SVG is still not an image: given up, withheld (${sv && [sv.state, sv.note]}, ${opens.svg.source})`);
}
if (gitHas("f9eaedd")) {
  const OLD = execSync("git show f9eaedd:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const { urls, r, opens } = await bareAndTyped(OLD, "bc");
  check(!urls.includes(TOK) && urls.some((u) => /\?alt$/.test(u)), `CONTROL — f9eaedd's Worker reads the bare src as …?alt (${urls.filter((u) => /tok/.test(u)).join(", ")})`);
  check(r.stored === 0 && opens.mis.status === 404 && opens.undef.status === 404, `CONTROL — and gives up both mislabelled PNGs (${JSON.stringify(r)}; ${opens.mis.source}, ${opens.undef.source})`);
}
// ---------- CONTROL ----------
if (gitHas("f6beaa9")) {
  const HEAD = execSync("git show f6beaa9:hub/src/index.js", { cwd: HUB, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const s = await setup(HEAD, "c");
  sender.flakyUp = false;
  await s.m.prefetchImages(s.env, mail("/flaky.png"), "test", { left: { ...BIG } });
  sender.flakyUp = true; const o = await s.open("/flaky.png");
  check(o.asked === 1 && o.source === "upstream", `CONTROL — f6beaa9's Worker sends the open of a picture whose arrival fetch failed to the sender (asked ${o.asked}, ${o.source})`);
}
console.log(fails.length ? `${fails.length} failed` : "all picture-queue checks passed");
process.exit(fails.length ? 1 : 0);
