#!/usr/bin/env node
// run_all: alone (it holds time limits; with other tests running, the CPU they take decides it)
// Spy trackers and email ads beyond the named list. Real Worker, real migrations, real SQLite, a fake R2, fake senders
// and fake list servers. Checks:
//  - the filter-list matcher: host, path, separator, anchors and exceptions; the rules a mail cannot use are left out; a hostile URL
//  costs milliseconds;
//  - a list is fetched; a rule that would hide a real picture or a spacer of the check set is refused; an unchanged list is a 304; a
//  version that blocks fewer of the check set's trackers and ads is refused whole and the one in use stays;
//  - at arrival a blocked picture is not fetched, its block reaches GET /api/trackers, and /api/img refuses it without asking the sender;
//  - the shared tracker block removes a blocked picture that declares a real box, with a link that held nothing else, and keeps a
//  pixel's box;
//  - learning: tiny pictures under one pattern in two mails make a watched pattern that blocks nothing; a picture seen in two mails
//  contradicts it and the watch restarts; 14 quiet days and it blocks; a picture under it that declares a real box is fetched, and its
//  real size turns the pattern off, withdraws its blocks and queues their pictures; a sample measuring a real picture does the same;
//  - Undo: a veto withdraws the blocks under a pattern and stops new ones; taking it back lets the pattern be learned and block again;
//  - the two vendored rules.
// Usage: node test/trackers.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

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
const d1 = (sq) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => { if (a.length > 100) throw new Error("D1_ERROR: too many SQL variables"); return mk(a); },
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; },
});
const stub = (src) => src
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
async function loadWorker(tag, src) {
  const tmp = `${HUB}test/_trackers_${tag}.mjs`;
  writeFileSync(tmp, stub(src));
  try { return await import(tmp); } finally { unlinkSync(tmp); }
}
const SECRET = "test-session-secret", CLI = "test-cli-token";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
};
const exp = Date.now() + 86400000;
const COOKIE = `mh=${exp}.0.${await hmac(SECRET, `${exp}.0`)}`;
const cat = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : [...p])));
const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], le16 = (n) => [n & 255, n >>> 8];
const pad = (u, n = 64) => { const o = new Uint8Array(Math.max(n, u.length)); o.set(u); return o; };
const png = (w, h) => pad(cat([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]));
const gif = (w, h) => pad(cat("GIF89a", le16(w), le16(h), [0xf7, 0, 0]));

const mod = await loadWorker("t", readFileSync(HUB + "src/index.js", "utf8"));

// ---------- fakes: the open web, the list servers, R2 ----------
const IMGS = new Map(), LISTS = new Map(); let upstream = [];
const etagOf = (t) => '"' + t.length + "-" + (t.match(/^! Version: *(\S+)/m) || [])[1] + '"';
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
  if (u.hostname === "easylist.to") {
    const t = LISTS.get(u.href); if (t == null) return new Response("gone", { status: 404 });
    const inm = (init.headers || {})["if-none-match"]; if (inm && inm === etagOf(t)) return new Response(null, { status: 304 });
    return new Response(t, { headers: { etag: etagOf(t), "content-type": "text/plain" } });
  }
  upstream.push(u.href); const b = IMGS.get(u.href); if (!b) return new Response("nope", { status: 404 });
  return new Response(b, { headers: { "content-type": b[0] === 0x89 ? "image/png" : "image/gif", "content-length": String(b.length) } });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fakeR2 = () => {
  const m = new Map();
  const obj = (b) => ({ body: new Response(b).body, arrayBuffer: async () => b.slice().buffer, text: async () => new TextDecoder().decode(b), httpMetadata: {} });
  return { m, head: async (k) => (m.has(k) ? { key: k } : null), get: async (k, o) => { if (!m.has(k)) return null; const b = m.get(k); return obj(o?.range ? b.slice(o.range.offset, o.range.offset + o.range.length) : b); },
    put: async (k, v) => { m.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer || v).slice()); }, delete: async (k) => { m.delete(k); } };
};
function world() {
  const sq = buildDb(), DB = d1(sq), STORE = fakeR2();
  const env = { DB, STORE, SESSION_SECRET: SECRET, CLI_TOKEN: CLI, DOMAINS: "own.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: "x" };
  const call = (path, { method = "GET", body = null, ctx = { waitUntil: () => {} } } = {}) => mod.default.fetch(new Request("https://hub.example" + path,
    method === "GET" ? { headers: { Cookie: COOKIE } } : { method, headers: { Authorization: "Bearer " + CLI, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  mod.trkForget();
  return { sq, env, call, q: (sql, ...b) => sq.prepare(sql).all(...b) };
}
const arrive = (w, html, tag) => mod.prefetchImages(w.env, html, tag, { left: { images: 999, bytes: 1e9 }, from: "news@mailer.example" });

// ---------- 1. the matcher ----------
{
  const ix = mod.abpCompile(["[Adblock Plus 2.0]", "||ads.example^", "||track.example/o/*", "/pixel.gif?", "@@||track.example/o/keep", "|https://exact.example/a|",
    "||scripts.example^$script", "||img.example^$image", "||page.example^$domain=news.example", "/\\/beacon\\d+\\//", "news.example##.ad", "||ap.example^$image,third-party"].join("\n"));
  const v = (u) => mod.abpVerdict(ix, u);
  check(!!v("https://ads.example/x.png") && !!v("https://cdn.ads.example/x.png") && !v("https://notads.example/x.png") && !v("https://ads.example.evil.example/x.png"),
    "||host^ blocks the host and its subdomains, not a longer name or a host that merely starts with it");
  check(!!v("https://track.example/o/123.gif") && !v("https://track.example/o/keep/1.gif") && !v("https://track.example/p/1.gif"), "a path rule blocks its path; an @@ exception wins");
  check(!!v("https://any.example/pixel.gif?id=1") && !v("https://any.example/pixel.gift"), "a rule with no anchor matches anywhere in the URL");
  check(!!v("https://exact.example/a") && !v("https://exact.example/ab"), "| anchors at both ends");
  check(!v("https://scripts.example/a.png") && !!v("https://img.example/a.png") && !v("https://page.example/a.png") && !v("https://x.example/beacon12/a.png") && !!v("https://ap.example/a.png"),
    "a rule for scripts only, a page-bound rule and a /regex/ rule are left out; $image and third-party rules apply");
  const big = mod.abpCompile(Array.from({ length: 4000 }, (_, i) => `/a${i}*b*c*d^`).join("\n") + "\n" + Array.from({ length: 2000 }, (_, i) => `||h${i}.example^`).join("\n"));
  const evil = ("https://x.example/" + "a1".repeat(500) + "b".repeat(400) + "c^".repeat(300)).slice(0, 2048);
  const t0 = performance.now(); for (let i = 0; i < 5; i++) mod.abpVerdict(big, evil); const ms = (performance.now() - t0) / 5;
  check(ms < 50, `a hostile 2,048-character URL against 6,000 rules takes ${ms.toFixed(1)} ms (under 50)`);
}

// ---------- 2. patterns, and the two vendored rules ----------
{
  check(mod.trkPattern("https://af17a4c0.open.mailer.example/AbCdEf1234567890xyz") === "*.open.mailer.example/*" && mod.trkPattern("https://go.mailer.example/r/AbC123xyZ9/1/QwE456rtY8") === "go.mailer.example/r/*/1/*",
    "a pattern folds an 8-hex first label and token-like path segments, and keeps the rest");
  mod.trkForget();
  const hits = []; mod.prefetchImageUrls('<img src="https://rs-stripe.news.example/stripe/image?cs_abc123" width="600" height="300"><img src="https://link.news.example/img/5f00aa11/abcdefgh.gif"><img src="https://link.news.example/img/5f00aa11/abc.gif">', hits);
  check(hits.length === 2 && hits.some((x) => x.name === "Jeeng" && x.cls === "ad") && hits.some((x) => x.name === "Sailthru" && x.cls === "tracker"), `Jeeng's stripe is an ad and Sailthru's 8-character pixel a tracker; a 3-character name is not (${JSON.stringify(hits.map((x) => x.name))})`);
}

// ---------- 3. the lists: fetched, checked, kept ----------
const EL = (ver, extra = []) => ["[Adblock Plus 2.0]", `! Version: ${ver}`, "! Title: EasyList", "||adserver.example^", "||slots.example/imp?", "/sponsor-banner/*$image", "||cdn.shop.example/img/*", "example.com##.ad", "||scripts.example^$script", ...extra].join("\n");
const EP = (ver, withOpen = true) => ["[Adblock Plus 2.0]", `! Version: ${ver}`, "! Title: EasyPrivacy", "||pixel.track.example^", ...(withOpen ? ["/open.gif?"] : []), "@@||pixel.track.example/keep/", "||page.example^$domain=news.example"].join("\n");
const CORPUS = [{ u: "https://cdn.shop.example/img/hero.jpg", k: "real" }, { u: "https://cdn.shop.example/img/spacer.gif", k: "spacer" }, { u: "https://adserver.example/ad1.png", k: "ad" },
  { u: "https://pixel.track.example/o/abc.gif", k: "tracker" }, { u: "https://mail.news.example/open.gif?id=1", k: "tracker" }].map((x) => JSON.stringify(x)).join("\n");
{
  const w = world(); await w.env.STORE.put("trk/corpus.jsonl", CORPUS);
  LISTS.set("https://easylist.to/easylist/easylist.txt", EL("202611100001")); LISTS.set("https://easylist.to/easylist/easyprivacy.txt", EP("202611100001"));
  const r1 = await mod.trkRefreshLists(w.env);
  const el = JSON.parse(w.q("SELECT v FROM trk_meta WHERE k = 'list:easylist'")[0]?.v || "{}"), ep = JSON.parse(w.q("SELECT v FROM trk_meta WHERE k = 'list:easyprivacy'")[0]?.v || "{}");
  check(el.version === "202611100001" && el.dropped.length === 1 && el.dropped[0] === "||cdn.shop.example/img/" && el.blocked === 1 && el.of === 3, `EasyList: the rule that would hide a real picture and a spacer of the check set is refused, the rest kept (${JSON.stringify({ dropped: el.dropped, blocked: el.blocked, of: el.of })})`);
  check(ep.version === "202611100001" && ep.dropped.length === 0 && ep.blocked === 2 && w.env.STORE.m.has(ep.r2key), `EasyPrivacy: kept in R2 as fetched; it blocks 2 of the check set's 3 trackers and ads (${r1.join(" | ")})`);
  const r2 = await mod.trkRefreshLists(w.env);
  check(r2.every((l) => /unchanged/.test(l)), `an unchanged list is asked for with its ETag and answered 304 (${r2.join(" | ")})`);
  LISTS.set("https://easylist.to/easylist/easyprivacy.txt", EP("202611110001", false));
  const r3 = await mod.trkRefreshLists(w.env), ep3 = JSON.parse(w.q("SELECT v FROM trk_meta WHERE k = 'list:easyprivacy'")[0].v);
  check(/REFUSED/.test(r3.join(" ")) && ep3.version === "202611100001", `a version that blocks fewer of the check set is refused whole; the one in use stays (${r3.find((l) => /EasyPrivacy/.test(l))})`);
  LISTS.set("https://easylist.to/easylist/easyprivacy.txt", EP("202611100001"));

  // arrival: blocked pictures are not fetched, and their blocks go to the apps
  mod.trkForget(); upstream = [];
  IMGS.set("https://pixel.track.example/keep/logo.png", png(100, 40)); IMGS.set("https://cdn.shop.example/img/hero.jpg", png(600, 300));
  const html = '<img src="https://adserver.example/banner.png" width="300" height="250"><img src="https://pixel.track.example/o/zzz.gif" width="1" height="1">' +
    '<img src="https://pixel.track.example/keep/logo.png" width="100" height="40"><img src="https://cdn.shop.example/img/hero.jpg" width="600" height="300"><img src="https://mail.news.example/open.gif?id=2">';
  const a = await arrive(w, html, "hub:a1");
  const v = w.q("SELECT url, name, cls, rule, gone FROM trk_verdict ORDER BY seq");
  check(upstream.length === 2 && upstream.includes("https://pixel.track.example/keep/logo.png") && upstream.includes("https://cdn.shop.example/img/hero.jpg"), `at arrival only the excepted logo and the picture under the refused rule are fetched (${JSON.stringify(upstream)})`);
  check(v.length === 3 && v.find((x) => x.url === "https://adserver.example/banner.png")?.cls === "ad" && v.find((x) => x.url === "https://pixel.track.example/o/zzz.gif")?.cls === "tracker" && v.every((x) => x.gone === 0),
    `the three blocks are kept for the apps, EasyList's as an ad, EasyPrivacy's as trackers (${JSON.stringify(v.map((x) => [x.name, x.cls, x.rule]))})`);
  const s0 = await (await w.call("/api/trackers?since=0")).json();
  check(s0.rows.length === 3 && s0.rows.every((r) => r.length === 4 && Number.isSafeInteger(r[0]) && r[3] === 0) && s0.seq === v.length, `GET /api/trackers gives each as [hash, name, class, gone] and the newest seq (${JSON.stringify(s0)})`);
  const s1 = await (await w.call("/api/trackers?since=" + s0.seq)).json();
  check(s1.rows.length === 0 && s1.seq === s0.seq, "asking again from that seq brings nothing new");
  await arrive(w, html, "hub:a1");
  check(w.q("SELECT COUNT(*) n FROM trk_verdict")[0].n === 3 && (await (await w.call("/api/trackers?since=" + s0.seq)).json()).rows.length === 0, "the same mail again adds no row and moves no seq");
  const key = (await (await w.call("/api/me")).json()).img_key; upstream = [];
  const r = await w.call("/api/img?u=" + encodeURIComponent("https://adserver.example/other.png") + "&k=" + key);
  check(r.status === 204 && r.headers.get("x-tracker") === "adserver.example" && upstream.length === 0, `/api/img refuses a listed picture it does not hold without asking the sender (${r.status}, ${r.headers.get("x-tracker")}, ${upstream.length} upstream)`);
  const st = await (await w.call("/api/trackers/status")).json();
  check(st.lists.length === 2 && st.lists.every((l) => l.version === "202611100001") && st.recent.length === 3 && st.day.blocked === 3, `GET /api/trackers/status: both lists, the recent blocks, the day's count (${JSON.stringify({ lists: st.lists.map((l) => [l.name, l.version, l.refused]), recent: st.recent.length, day: st.day })})`);
}

// ---------- 4. the shared block: an ad goes with its link, a pixel keeps its box ----------
{
  const W = readFileSync(HUB + "src/index.js", "utf8");
  const a = W.indexOf('const PIXEL_GIF = "data:image/gif'), b = W.indexOf("\nfunction blockSpyTrackers(h, found) {"), e = W.indexOf("\n}\n", b) + 3;
  const table = W.match(/const SPY_TRACKERS = \[[\s\S]*?\n\];/)[0];
  const esc = 'const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c]));';
  const lib = new Function(table + "\n" + esc + "\n" + W.slice(a, e) + "\nreturn { block: blockSpyTrackers, set: (f) => { trackerVerdict = f; } };")();
  lib.set((u) => (/adserver\.example/.test(u) ? { name: "adserver.example", cls: "ad" } : /pixel\.track\.example/.test(u) ? { name: "track.example", cls: "tracker" } : null));
  const found = [];
  const out = lib.block('<a href="https://adserver.example/click"> <img src="https://adserver.example/ad.png" width="300" height="250"> </a><p>Story</p><img src="https://pixel.track.example/o/a.gif" width="1" height="1"><a href="https://shop.example/x">Shop <img src="https://adserver.example/ad2.png" width="300" height="250"></a><img src="https://cdn.example/photo.jpg" width="600" height="400">', found);
  check(!out.includes("adserver.example/click") && /<mh-gone data-mh-tracker="adserver.example"><\/mh-gone> ?<p>Story/.test(out), `a blocked ad with a real box is removed, and so is the link that held only it (${out.slice(0, 120)})`);
  check(/<img src="data:image\/gif;base64,[^"]+" data-mh-tracker="track.example"/.test(out) && out.includes('width="1"'), "a blocked pixel stays as the transparent GIF with its own box");
  check(out.includes('<a href="https://shop.example/x">Shop <mh-gone') && out.includes("https://cdn.example/photo.jpg"), "a link with text keeps its text; an unblocked picture is untouched");
  check(found.filter((f) => f.cls === "ad").length === 2 && found.filter((f) => f.cls === "tracker").length === 1, `found carries each block's class (${JSON.stringify(found)})`);
}

// ---------- 5. learning: watched, contradicted, blocking, and turning itself off ----------
const T1 = "https://px.mailer.example/o/AAAA1111bbbb2222.gif", T2 = "https://px.mailer.example/o/CCCC3333dddd4444.gif", T3 = "https://px.mailer.example/o/EEEE5555ffff6666.gif",
  T4 = "https://px.mailer.example/o/GGGG7777hhhh8888.gif", T5 = "https://px.mailer.example/o/IIII9999jjjj0000.gif", PAT = "px.mailer.example/o/*";
for (const u of [T1, T2, T3, T4, T5]) IMGS.set(u, gif(1, 1));
const rule = (w, p = PAT) => w.q("SELECT kind, state, tiny, mails, note FROM trk_rules WHERE pattern = ?", p)[0];
{
  // contradicted while watched: the same tiny picture in a third mail
  const w = world(); const C1 = "https://img.other.example/p/KKKK1111llll2222.gif", C2 = "https://img.other.example/p/MMMM3333nnnn4444.gif"; IMGS.set(C1, gif(1, 1)); IMGS.set(C2, gif(1, 1));
  await arrive(w, `<img src="${C1}">`, "hub:c1"); await arrive(w, `<img src="${C2}">`, "hub:c2");
  await mod.trkLearn(w.env);
  check(rule(w, "img.other.example/p/*")?.state === "watch", `two tiny pictures under one pattern in two mails: a watched pattern (${JSON.stringify(rule(w, "img.other.example/p/*"))})`);
  await arrive(w, `<img src="${C1}">`, "hub:c3"); await mod.trkLearn(w.env);
  check(rule(w, "img.other.example/p/*")?.state === "wrong", `the same tiny picture in another mail contradicts it, for good (${rule(w, "img.other.example/p/*")?.note})`);
  w.sq.prepare("UPDATE trk_meta SET v = ? WHERE k = 'learner'").run(JSON.stringify({ mode: "watch", since: new Date(Date.now() - 15 * 86400e3).toISOString() }));
  const r = await mod.trkLearn(w.env), m = JSON.parse(w.q("SELECT v FROM trk_meta WHERE k = 'learner'")[0].v);
  check(r.again === 1 && m.mode === "watch" && Date.now() - Date.parse(m.since) < 60e3, `with a contradiction in its 14 days the watch starts again and nothing blocks (${JSON.stringify(m)})`);
}
{
  const w = world(); upstream = [];
  await arrive(w, `<img src="${T1}">`, "hub:m1"); await arrive(w, `<img src="${T2}">`, "hub:m2");
  await mod.trkLearn(w.env);
  check(rule(w)?.state === "watch" && rule(w).tiny === 2 && rule(w).mails === 2, `a watched pattern from two mails (${JSON.stringify(rule(w))})`);
  mod.trkForget(); upstream = []; await arrive(w, `<img src="${T3}">`, "hub:m3");
  check(upstream.includes(T3) && w.q("SELECT COUNT(*) n FROM trk_verdict")[0].n === 0, "while watched it blocks nothing: the next pixel is fetched and measured");
  w.sq.prepare("UPDATE trk_meta SET v = ? WHERE k = 'learner'").run(JSON.stringify({ mode: "watch", since: new Date(Date.now() - 15 * 86400e3).toISOString() }));
  const r = await mod.trkLearn(w.env);
  check(r.on === true && rule(w)?.state === "on" && JSON.parse(w.q("SELECT v FROM trk_meta WHERE k = 'learner'")[0].v).mode === "on", `14 days with nothing contradicted: learning blocks by itself (${JSON.stringify(rule(w))})`);
  mod.trkForget(); upstream = []; await arrive(w, `<img src="${T4}">`, "hub:m4");
  const v4 = w.q("SELECT url, rule, cls, gone FROM trk_verdict");
  check(!upstream.includes(T4) && v4.length === 1 && v4[0].url === T4 && v4[0].rule === "learned:" + PAT && v4[0].cls === "tracker", `then a new pixel under it is not fetched, and its block goes to the apps (${JSON.stringify(v4)})`);
  const seq4 = w.q("SELECT MAX(seq) s FROM trk_verdict")[0].s;
  // a picture under it that declares a real box is let through, measured, and turns the pattern off
  const REAL = "https://px.mailer.example/o/RRRR1234ssss5678.png"; IMGS.set(REAL, png(600, 300)); upstream = [];
  await arrive(w, `<img src="${REAL}" width="600" height="300">`, "hub:m5");
  check(upstream.includes(REAL), "a picture under the pattern that declares 600 x 300 is let through and fetched");
  await mod.trkLearn(w.env);
  const after = w.q("SELECT url, gone FROM trk_verdict WHERE url = ?", T4)[0], queued = w.q("SELECT url, state FROM img_queue WHERE url = ?", T4)[0];
  check(rule(w)?.state === "off" && after?.gone === 1 && queued?.state === "pending", `its real size turns the pattern off, withdraws its block and queues the picture it blocked (${JSON.stringify({ rule: rule(w), after, queued })})`);
  const sync = await (await w.call("/api/trackers?since=" + seq4)).json();
  check(sync.rows.length === 1 && sync.rows[0][3] === 1, `the apps get the withdrawal as a gone row (${JSON.stringify(sync.rows)})`);
}
{
  // a sample that measures a real picture turns a blocking pattern off
  const w = world();
  w.sq.prepare("INSERT INTO trk_meta (k, v, at) VALUES ('learner', ?, ?)").run(JSON.stringify({ mode: "on", since: new Date().toISOString() }), new Date().toISOString());
  await arrive(w, `<img src="${T1}">`, "hub:n1"); await arrive(w, `<img src="${T2}">`, "hub:n2");
  await mod.trkLearn(w.env); mod.trkForget();
  check(rule(w)?.state === "on", "with learning on, a new pattern blocks at once");
  await arrive(w, `<img src="${T3}">`, "hub:n3");
  check(w.q("SELECT COUNT(*) n FROM trk_verdict WHERE gone = 0")[0].n === 1, "and blocks the next pixel");
  IMGS.set(T3, png(640, 480)); upstream = [];
  const c = await mod.trkCanaries(w.env);
  check(c.looked === 1 && c.off === 1 && upstream.includes(T3) && rule(w)?.state === "off" && w.q("SELECT gone FROM trk_verdict WHERE url = ?", T3)[0].gone === 1, `the daily sample fetched what it blocked, found 640 x 480, and turned it off (${JSON.stringify({ c, rule: rule(w) })})`);
  const c2 = await mod.trkCanaries(w.env);
  check(c2.looked === 0, "a pattern that is off is not sampled again");
  IMGS.set(T3, gif(1, 1));
}
{
  // Undo
  const w = world();
  w.sq.prepare("INSERT INTO trk_meta (k, v, at) VALUES ('learner', ?, ?)").run(JSON.stringify({ mode: "on", since: new Date().toISOString() }), new Date().toISOString());
  await arrive(w, `<img src="${T1}">`, "hub:v1"); await arrive(w, `<img src="${T2}">`, "hub:v2"); await mod.trkLearn(w.env); mod.trkForget();
  await arrive(w, `<img src="${T3}">`, "hub:v3");
  const res = await (await w.call("/api/trackers/veto", { method: "POST", body: { pattern: PAT } })).json();
  check(res.ok && res.withdrawn === 1 && rule(w)?.kind === "veto" && w.q("SELECT gone FROM trk_verdict WHERE url = ?", T3)[0].gone === 1 && w.q("SELECT state FROM img_queue WHERE url = ?", T3)[0]?.state === "pending",
    `Undo: a veto withdraws the block under the pattern and queues its picture (${JSON.stringify(res)})`);
  mod.trkForget(); upstream = []; await arrive(w, `<img src="${T4}">`, "hub:v4");
  check(upstream.includes(T4) && w.q("SELECT COUNT(*) n FROM trk_verdict WHERE gone = 0")[0].n === 0, "a vetoed pattern blocks nothing new");
  await mod.trkLearn(w.env);
  check(rule(w)?.kind === "veto", "and the learner does not learn it again");
  const del = await w.call("/api/trackers/veto?pattern=" + encodeURIComponent(PAT), { method: "DELETE" });
  await mod.trkLearn(w.env);
  check(del.status === 200 && rule(w)?.kind === "learned" && rule(w)?.state === "on", `taking the Undo back lets the pattern be learned and block again (${JSON.stringify(rule(w))})`);
  const bad = await w.call("/api/trackers/veto", { method: "POST", body: { pattern: "not a pattern" } });
  check(bad.status === 400, "a veto must be a host and a path");
}
{
  // without a session the routes answer nothing
  const w = world();
  const r = await mod.default.fetch(new Request("https://hub.example/api/trackers?since=0"), w.env, { waitUntil: () => {} });
  check(r.status === 401, "GET /api/trackers needs a session");
}

// ---------- review fixes ----------
{
  const urlHash = new Function(readFileSync(new URL("../src/index.js", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("function urlHash(s)")) + "\nreturn urlHash;")();
  const w = world(); await w.env.STORE.put("trk/corpus.jsonl", CORPUS); await mod.trkRefreshLists(w.env); mod.trkForget();
  // finding 4: a blocked URL of exactly 2,048 characters is whole: Undo withdraws it AND queues it, on the shared "+requeue" share (findings 1, M2)
  const base = "https://pixel.track.example/o/", exact = base + "e".repeat(2048 - base.length - 4) + ".gif";
  await arrive(w, `<img src="${exact}" width="1" height="1">`, "hub:c4");
  const pat = mod.trkPattern(exact), r4 = await (await w.call("/api/trackers/veto", { method: "POST", body: { pattern: pat } })).json();
  const q4 = w.q("SELECT dom FROM img_queue WHERE url = ?", exact)[0];
  check(exact.length === 2048 && r4.withdrawn === 1 && q4?.dom === "+requeue", `a blocked URL of exactly 2,048 characters is withdrawn and queued again, on the "+requeue" share (${r4.withdrawn}, ${q4?.dom})`);
  // finding 3: a withdrawal takes every live block under the pattern, not the first 500
  const P = "many.example/p", ins = w.sq.prepare("INSERT INTO trk_verdict (hk, url, name, cls, rule, gone, at, pat) VALUES (?, ?, 'many', 'tracker', 'learned:many.example/p', 0, ?, ?)");
  for (let i = 0; i < 501; i++) ins.run(2e9 + i, "https://many.example/p?" + i, new Date().toISOString(), P);
  const r3 = await (await w.call("/api/trackers/veto", { method: "POST", body: { pattern: P } })).json();
  const live = w.q("SELECT COUNT(*) n FROM trk_verdict WHERE pat = ? AND gone = 0", P)[0].n;
  check(r3.withdrawn === 501 && live === 0, `Undo withdraws all 501 blocks under a pattern, none left live in the apps (${r3.withdrawn} withdrawn, ${live} live)`);
  // finding 5: a host longer than any DNS name gets no verdict, so no pattern as long as itself
  const longHost = "x".repeat(60) + "." + "a.".repeat(120) + "example.net", jeeng = `https://${longHost}/stripe/image?cs_1`;
  const n0 = w.q("SELECT COUNT(*) n FROM trk_verdict")[0].n;
  await arrive(w, `<img src="${jeeng}" width="300" height="250">`, "hub:c5");
  const maxPat = w.q("SELECT MAX(LENGTH(pat)) m FROM trk_verdict")[0].m;
  check(longHost.length > 253 && w.q("SELECT COUNT(*) n FROM trk_verdict")[0].n === n0 && maxPat <= 512, `a Jeeng-shaped picture on a ${longHost.length}-character host gets no verdict; no kept pattern passes 512 characters (${maxPat})`);
}
// ---------- N1, N3, N5 ----------
{
  // N1: a host longer than any DNS name is not walked suffix by suffix (40,000 labels took 8 s a list on every arriving mail)
  const one = mod.abpCompile("||ads.example^"), host = "a.".repeat(30000) + "example.com";
  const t0 = performance.now(), hv = mod.abpVerdict(one, "https://" + host + "/x.png"), ms = performance.now() - t0;
  check(hv === null && ms < 50 && !!mod.abpVerdict(one, "https://ads.example/x.png"), `a 60,000-character host costs ${ms.toFixed(1)} ms, not seconds; a real one is still matched`);
  // N3: a blocked picture's URL is kept to 2,048 characters, with the full URL's hash and its pattern; Undo finds it by the pattern behind
  // thousands of newer blocks, withdraws it under that hash, and queues no cut URL
  const urlHash = new Function(readFileSync(new URL("../src/index.js", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("function urlHash(s)")) + "\nreturn urlHash;")();
  const w = world(); await w.env.STORE.put("trk/corpus.jsonl", CORPUS); await mod.trkRefreshLists(w.env); mod.trkForget();
  const long = "https://pixel.track.example/o/" + "z".repeat(60000) + ".gif";
  await arrive(w, `<img src="${long}" width="1" height="1">`, "hub:n3");
  const row = w.q("SELECT hk, url, pat, gone FROM trk_verdict WHERE hk = ?", urlHash(long))[0];
  check(row && row.url.length === 2049 && row.pat === mod.trkPattern(long) && row.gone === 0, `a 60 KB blocked URL is kept as its first 2,049 characters (one past the longest the hub fetches, so it reads as cut), under the full URL's hash, with its pattern (${row && [row.url.length, row.pat]})`);
  const ins = w.sq.prepare("INSERT INTO trk_verdict (hk, url, name, cls, rule, gone, at, pat) VALUES (?, ?, 'flood', 'tracker', 'easyprivacy:||flood.example^', 0, ?, 'flood.example/p')");
  for (let i = 0; i < 5100; i++) ins.run(1e9 + i, "https://flood.example/p?" + i, new Date().toISOString());
  const res = await (await w.call("/api/trackers/veto", { method: "POST", body: { pattern: mod.trkPattern(long) } })).json();
  const after = w.q("SELECT gone FROM trk_verdict WHERE hk = ?", urlHash(long));
  check(res.ok && res.withdrawn === 1 && after.length === 1 && after[0].gone === 1 && !w.q("SELECT 1 FROM img_queue WHERE url LIKE 'https://pixel.track.example/o/zzz%'").length,
    `Undo finds it behind 5,100 newer blocks, withdraws that very row (not a second one under the cut URL's hash) and queues nothing (${JSON.stringify(res)}, rows ${after.length})`);
  // N5: a watched pattern whose sightings have aged out is forgotten; a blocking one is kept
  const old = new Date(Date.now() - 61 * 86400e3).toISOString(), add = w.sq.prepare("INSERT INTO trk_rules (pattern, kind, state, created_at, changed_at) VALUES (?, 'learned', ?, ?, ?)");
  add.run("stale.example/x", "watch", old, old); add.run("stale-on.example/x", "on", old, old); add.run("fresh.example/x", "watch", new Date().toISOString(), new Date().toISOString());
  await mod.trkPrune(w.env);
  const left = w.q("SELECT pattern FROM trk_rules WHERE pattern LIKE '%.example/x' ORDER BY pattern").map((x) => x.pattern);
  check(JSON.stringify(left) === JSON.stringify(["fresh.example/x"]), `a watched or blocking pattern with no sighting in 60 days goes; a new one stays (${left.join(", ")})`);
}

if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall tracker checks passed");
