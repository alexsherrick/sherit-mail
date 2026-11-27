#!/usr/bin/env node
// A mail's own fonts are kept like its pictures. 94 of one account's 282 HTML mails in 21 days declared
// fonts in their own <style>, 42 linked a stylesheet for them and 17 imported one, and the viewer showed every one of them in its
// fallback font: the frame allowed only data: fonts, and the hub read each font as a picture, found it was not one and gave it up
// (490 of the queue's 548 given-up rows), again with every mail that named it.
// The real Worker (arrival prefetch, the minute cron's drain, GET /api/img and /api/fontcss) on real migrations and SQLite, a fake font
// host and R2 in memory:
//  1. what a mail's fonts need: its linked and imported stylesheets (not one inside an Outlook-only comment), its own faces;
//  2. the arrival keeps the faces the mail can use, one file each (the first format the browser takes), and nothing else: not another
//  family, not the cyrillic subset of a Latin mail, not the.eot or.woff behind the woff2, not a Typekit-style kit's usage ping;
//  a stylesheet is kept as those faces alone, absolute and with font-display: fallback; one that only imports another is read one
//  level down; a font is a font by its bytes (an HTML page at a.woff2 is given up); fonts are not pictures (no size, no shrink row)
//  but keep the 90-day row; a font row given up as "not an image" before this is fetched as a font now;
//  3. GET /api/fontcss answers the kept stylesheet with each font made an /api/img address carrying the key and the day, and nothing
//  for one not kept; /api/img answers a font a year and never answers a stylesheet; both need the image key, and so does a font or
//  stylesheet load of any other hub address;
//  4. an open never fetches a font from its sender;
//  5. the cron's retry of a stylesheet keeps its faces for English text and queues their fonts, which the next minute fetches.
// Usage: node test/fonts.mjs (exit 1 on any failed check)
// CONTROL: FONTS_SRC=<an index.js from before the change> node test/fonts.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
}
const db = {
  prepare(sql) { const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }) }); return mk([]); },
  batch: async (xs) => xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })),
};
const SRC = readFileSync(process.env.FONTS_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_fonts_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

// ---------- the fake senders ----------
const FONT = (tag, n = 3000) => { const b = new Uint8Array(n); b.set([0x77, 0x4f, 0x46, 0x32]); b.set(new TextEncoder().encode(tag), 8); return b; };   // "wOF2"…
const PNG = () => { const b = new Uint8Array(2000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30]); return b; };
const SHEET = `/* the brand's fonts */
@font-face { font-family: 'Brand Sans'; font-style: normal; font-weight: 400; src: url(/s/brand-latin.woff2) format('woff2'); unicode-range: U+0000-00FF, U+2000-206F; }
@font-face { font-family: 'Brand Sans'; font-style: normal; font-weight: 400; src: url(/s/brand-cyr.woff2) format('woff2'); unicode-range: U+0400-045F; }
@font-face { font-family: 'Brand Sans'; font-style: normal; font-weight: 700; src: url(/s/brand-bold.woff2) format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: 'Never Named'; src: url(/s/unused.woff2) format('woff2'); }
body { background: url(https://track.font.example/px.gif); }`;
const KIT = `@import url("https://ping.kit.example/p.css?k=abc");
@font-face { font-family: "kit-face"; src: url("https://kit.font.example/af/1/l?fvd=n4") format("woff2"), url("https://kit.font.example/af/1/d?fvd=n4") format("woff"); font-display: auto; font-weight: 400; }`;
const host = { asked: [] };
globalThis.fetch = async (input) => {
  const u = new URL(String(typeof input === "string" ? input : input.url));
  if (u.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/json" } });
  host.asked.push(u.href);
  const css = (t) => new Response(t, { headers: { "content-type": "text/css; charset=utf-8" } }), font = (t) => new Response(FONT(t), { headers: { "content-type": "font/woff2" } });
  if (u.hostname === "fonts.font.example" && u.pathname === "/css2") return css(SHEET);
  if (u.hostname === "fonts.font.example" && u.pathname.startsWith("/s/")) return font(u.pathname);
  if (u.hostname === "kit.font.example" && u.pathname === "/kit.css") return css(KIT);
  if (u.hostname === "kit.font.example") return font(u.pathname);
  if (u.hostname === "brand.font.example" && u.pathname === "/latest.css") return css(`@import url('/v2/font.css');`);
  if (u.hostname === "brand.font.example" && u.pathname === "/v2/font.css") return css(`@font-face { font-family: "Nested Face"; src: url("woff/nested.woff2") format("woff2"), url("woff/nested.woff") format("woff"); }`);
  if (u.hostname === "brand.font.example" && u.pathname.startsWith("/v2/woff/")) return font(u.pathname);
  if (u.hostname === "cdn.font.example" && u.pathname === "/fake.woff2") return new Response("<html>not found</html>", { headers: { "content-type": "font/woff2" } });
  if (u.hostname === "cdn.font.example") return font(u.pathname);   // the octet-stream case: a font is a font by its bytes
  if (u.hostname === "img.font.example") return new Response(PNG(), { headers: { "content-type": "image/png" } });
  return new Response("nope", { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const r2 = new Map();
const STORE = {
  head: async (k) => (r2.has(k) ? { key: k } : null),
  get: async (k) => { const x = r2.get(k); if (!x) return null; return { body: new Response(x.buf).body, text: async () => new TextDecoder().decode(x.buf), arrayBuffer: async () => x.buf.buffer, httpMetadata: { contentType: x.ct }, customMetadata: x.meta || {} }; },
  put: async (k, buf, o) => { r2.set(k, { buf: new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer ? buf : await new Response(buf).arrayBuffer()), ct: o?.httpMetadata?.contentType, meta: o?.customMetadata }); return {}; },
  delete: async (k) => { for (const x of [].concat(k)) r2.delete(x); }, list: async () => ({ objects: [], truncated: false }),
};
const SECRET = "test-session-secret";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const hmac = async (data) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))); };
const exp = Date.now() + 86400000, COOKIE = `mh=${exp}.0.${await hmac(`${exp}.0`)}`;
const env = { DB: db, STORE, SESSION_SECRET: SECRET, DOMAINS: "hub.example", FORWARD_TO: "me@gmail.com", GMAIL_TOKEN_KEY: "x" };
const call = (path, headers = {}) => mod.default.fetch(new Request("https://hub.example" + path, { headers: { Cookie: COOKIE, ...headers } }), env, { waitUntil: () => {} });
const keyOf = async (href) => "img/" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(href)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const held = async (href) => r2.get(await keyOf(href));
const row = (href) => sq.prepare("SELECT * FROM img_queue WHERE url = ?").get(href) || null;
const due = () => sq.prepare("UPDATE img_queue SET next_at = ?").run(new Date(Date.now() - 1000).toISOString());
// The queue's key for a URL: index.js urlHash (cyrb53), the same character for character (test/imgdims.mjs keeps the app's copy honest)
function urlHash(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); }

const S1 = "https://fonts.font.example/css2?family=Brand+Sans:wght@400;700", KITCSS = "https://kit.font.example/kit.css", NEST = "https://brand.font.example/latest.css";
const MAIL = `<html><head>
<link href="${S1.replace(/&/g, "&amp;")}" rel="stylesheet">
<!--[if mso]><link rel="stylesheet" href="https://mso.font.example/outlook.css"><![endif]-->
<link rel="alternate stylesheet" href="https://alt.font.example/alt.css">
<style>
@import url("${KITCSS}");
@import url('${NEST}');
/* @font-face { font-family: 'Commented'; src: url(https://cdn.font.example/commented.woff2); } */
@font-face { font-family: "Inline Display"; src: url("https://cdn.font.example/inline.eot?#iefix") format("embedded-opentype"), url("https://cdn.font.example/inline.woff2") format("woff2"), url("https://cdn.font.example/inline.woff") format("woff"); }
@font-face { font-family: "Fake Face"; src: url(https://cdn.font.example/fake.woff2) format("woff2"); }
@font-face { font-family: "Plain"; src: url(https://cdn.font.example/plain.bin); }
h1 { font: 700 28px/1.2 "Inline Display", Georgia, serif; }
.k { font-family: kit-face, Arial !important; }
</style></head><body style="font-family:'Brand Sans', Helvetica, Arial, sans-serif">
<h1>Our autumn line</h1><p class="k">Hello from the brand</p><p style="font-family: 'Nested Face'">Nested</p><font face="Fake Face, Plain">x</font>
<img src="https://img.font.example/hero.png" width="40" height="30"></body></html>`;

try {
  // ---------- 1. the plan ----------
  if (typeof mod.fontPlan !== "function") check(false, "the hub reads no font plan (fontPlan is not exported)");
  else {
  const p = mod.fontPlan(MAIL);
  check(JSON.stringify(p.sheets) === JSON.stringify([S1, KITCSS, NEST]), `the stylesheets the mail links and imports, not one inside an Outlook-only comment nor an alternate one (${JSON.stringify(p.sheets)})`);
  const own = p.faces.filter((f) => f.src).map((f) => f.src);
  check(JSON.stringify(own) === JSON.stringify(["https://cdn.font.example/inline.woff2", "https://cdn.font.example/fake.woff2", "https://cdn.font.example/plain.bin"]), `its own faces, one file each: the woff2 the browser takes, not the .eot before it or the .woff after, nothing from a comment (${JSON.stringify(own)})`);
  check(["brand sans", "inline display", "kit-face", "nested face", "fake face", "plain", "georgia"].every((f) => p.use.families.has(f)) && !p.use.families.has("never named"), `the families the mail names, from font-family, the font shorthand and <font face> (${[...p.use.families].join(", ")})`);
  }
  const pics = mod.prefetchImageUrls(MAIL);
  check(JSON.stringify(pics) === JSON.stringify(["https://img.font.example/hero.png"]), `a font or a stylesheet is not a picture (${JSON.stringify(pics)})`);

  // ---------- 2. the arrival ----------
  // A font row given up as "not an image" before fonts were kept, as 482 were on 2026-11-25
  sq.prepare("INSERT INTO img_queue (hk, url, state, kind, tries, next_at, note, at, dom) VALUES (?, ?, 'dead', 'fail', 1, ?, 'not an image', ?, 'font.example')").run(urlHash("https://cdn.font.example/inline.woff2"), "https://cdn.font.example/inline.woff2", new Date().toISOString(), new Date().toISOString());
  const a = await mod.prefetchImages(env, MAIL, "hub:fonts-1", { from: "news@font.example" });
  const asked = new Set(host.asked);
  const want = ["https://fonts.font.example/s/brand-latin.woff2", "https://fonts.font.example/s/brand-bold.woff2", "https://kit.font.example/af/1/l?fvd=n4", "https://brand.font.example/v2/woff/nested.woff2", "https://cdn.font.example/inline.woff2"];
  const never = ["https://fonts.font.example/s/brand-cyr.woff2", "https://fonts.font.example/s/unused.woff2", "https://kit.font.example/af/1/d?fvd=n4", "https://ping.kit.example/p.css?k=abc", "https://cdn.font.example/inline.eot?#iefix", "https://cdn.font.example/inline.woff", "https://mso.font.example/outlook.css", "https://alt.font.example/alt.css", "https://track.font.example/px.gif", "https://cdn.font.example/commented.woff2", "https://brand.font.example/v2/woff/nested.woff"];
  check(want.every((u) => asked.has(u)), `the arrival fetches each face the mail can use (${want.filter((u) => !asked.has(u)).join(", ") || "all"} missing)`);
  check(never.every((u) => !asked.has(u)), `and nothing else: no other family, no cyrillic subset for Latin text, nothing behind the first format, no kit usage ping, nothing commented out or Outlook-only (${never.filter((u) => asked.has(u)).join(", ") || "none"} asked)`);
  check(host.asked.length === new Set(host.asked).size, `nothing asked twice (${host.asked.length} requests for ${new Set(host.asked).size} addresses)`);
  const fonts = await Promise.all(want.map(held));
  check(fonts.every((f) => f && f.ct === "font/woff2"), `each is kept as a font, by its bytes (${fonts.map((f) => f?.ct).join(", ")})`);
  const plain = await held("https://cdn.font.example/plain.bin");
  check(plain?.ct === "font/woff2", `one with no format named and a host type of octet-stream is a font by its bytes (${plain?.ct})`);
  const fake = row("https://cdn.font.example/fake.woff2");
  check(fake && fake.state === "dead" && fake.note === "not a font" && !(await held("https://cdn.font.example/fake.woff2")), `an HTML page at a .woff2 address is given up as not a font (${fake && fake.state + " / " + fake.note})`);
  check(!row("https://cdn.font.example/inline.woff2"), `a font row given up as a picture before is fetched as a font now, and its row goes (${JSON.stringify(row("https://cdn.font.example/inline.woff2"))})`);
  const sheet = await held(S1), css = sheet && new TextDecoder().decode(sheet.buf);
  check(sheet?.ct === "text/css" && (css.match(/@font-face/g) || []).length === 2 && css.includes('src:url("https://fonts.font.example/s/brand-latin.woff2") format("woff2")') && !/brand-cyr|unused|px\.gif|body/.test(css) && (css.match(/font-display:fallback/g) || []).length === 2,
    `the stylesheet is kept as its two usable faces, absolute, font-display: fallback, nothing else (${css && css.replace(/\s+/g, " ").slice(0, 160)})`);
  const kit = await held(KITCSS), kcss = kit && new TextDecoder().decode(kit.buf);
  check(kcss && !kcss.includes("@import") && !kcss.includes("font-display:auto") && kcss.includes("font-weight:400"), `a kit's own @import is never kept, its font-display becomes fallback, its other descriptors stay (${kcss && kcss.slice(0, 140)})`);
  const nest = await held(NEST), ncss = nest && new TextDecoder().decode(nest.buf);
  check(ncss && ncss.includes('src:url("https://brand.font.example/v2/woff/nested.woff2")'), `a stylesheet that only imports another is read one level down, its url()s resolved against the one they are in (${ncss && ncss.slice(0, 120)})`);
  const kept = await held("https://img.font.example/hero.png");
  check(kept?.ct === "image/png", `the mail's picture is kept as before (${kept?.ct})`);
  const fontKeys = await Promise.all(want.map(keyOf));
  const dims = sq.prepare("SELECT COUNT(*) n FROM img_dims").get().n, work = sq.prepare("SELECT COUNT(*) n FROM img_work").get().n;
  const seen = fontKeys.filter((k) => sq.prepare("SELECT 1 FROM img_seen WHERE sha = ?").get(k.slice(4))).length;
  check(dims === 1 && work === 0 && seen === want.length, `a font is not a picture: no size row, no shrink row, but its 90-day row (${dims} size rows, ${work} shrink rows, ${seen} of ${want.length} 90-day rows)`);
  const ev = sq.prepare("SELECT detail FROM events WHERE kind = 'img_prefetch' ORDER BY id DESC LIMIT 1").get()?.detail || "";
  check(/ fonts=6 /.test(ev) && / stored=10 /.test(ev), `the arrival is logged with its fonts, counted in the day's allowance with its stylesheets and picture (${ev})`);

  // ---------- 3. serving ----------
  const meRes = await call("/api/me"); const K = (await meRes.json()).img_key;
  const T = 1764000000000;
  const fc = await call(`/api/fontcss?u=${encodeURIComponent(S1)}&k=${K}&t=${T}`), fctext = await fc.text();
  const fontAt = `src:url("/api/img?u=${encodeURIComponent("https://fonts.font.example/s/brand-latin.woff2")}&k=${encodeURIComponent(K)}&t=${T}")`;
  check(fc.status === 200 && /^text\/css/.test(fc.headers.get("content-type")) && fctext.includes(fontAt) && !fctext.includes("https://fonts.font.example/s/brand-latin.woff2\")") && /immutable/.test(fc.headers.get("cache-control") || ""),
    `/api/fontcss answers the kept stylesheet, each font an /api/img address with the key and the day, kept a year (${fc.status} ${fc.headers.get("cache-control")} ${fctext.slice(0, 120)})`);
  const none = await call(`/api/fontcss?u=${encodeURIComponent("https://fonts.font.example/css2?family=Other")}&k=${K}`), nt = await none.text();
  check(none.status === 200 && !nt.includes("@font-face") && none.headers.get("cache-control") === "no-store", `a stylesheet not kept is answered empty and not cached (${none.status} ${nt})`);
  const fi = await call(`/api/img?u=${encodeURIComponent(want[0])}&k=${K}&t=${T}`), fb = new Uint8Array(await fi.arrayBuffer());
  check(fi.status === 200 && fi.headers.get("content-type") === "font/woff2" && fb[0] === 0x77 && /max-age=31536000/.test(fi.headers.get("cache-control") || ""), `/api/img answers a kept font as a font, kept a year (${fi.status} ${fi.headers.get("content-type")} ${fi.headers.get("cache-control")})`);
  const si = await call(`/api/img?u=${encodeURIComponent(S1)}&k=${K}`);
  check(si.status === 404 && si.headers.get("x-img-source") === "not-a-picture", `/api/img never answers a kept stylesheet (${si.status} ${si.headers.get("x-img-source")})`);
  const nok = await call(`/api/fontcss?u=${encodeURIComponent(S1)}`), nokf = await call("/api/drafts", { "Sec-Fetch-Dest": "font" }), noks = await call("/api/drafts", { "Sec-Fetch-Dest": "style" });
  check(nok.status === 403 && nokf.status === 403 && noks.status === 403, `the image key is needed for /api/fontcss and for a font or stylesheet load of any hub address (${nok.status}, ${nokf.status}, ${noks.status})`);

  // ---------- 4. an open never fetches a font from its sender ----------
  const n0 = host.asked.length, cyr = "https://fonts.font.example/s/brand-cyr.woff2";
  // recent mail; old mail as the frame asks (Sec-Fetch-Dest: font); old mail with no such header, by the font file's own name
  const kitless = "https://kit.font.example/af/9/l?fvd=n4";
  const o1 = await call(`/api/img?u=${encodeURIComponent(cyr)}&k=${K}&t=${Date.now()}`), o2 = await call(`/api/img?u=${encodeURIComponent(kitless)}&k=${K}`, { "Sec-Fetch-Dest": "font" }), o3 = await call(`/api/img?u=${encodeURIComponent(cyr)}&k=${K}`);
  check(host.asked.length === n0 && [o1, o2, o3].every((o) => o.status === 404), `a font the hub did not keep is never fetched at an open: recent mail, old mail's font load, a font file by name (${[o1, o2, o3].map((o) => o.status + " " + o.headers.get("x-img-source")).join(", ")}; ${host.asked.slice(n0).join(", ") || "nothing asked"})`);
  check(!(await held(cyr)), `and nothing is kept for it (${!!(await held(cyr))})`);

  // ---------- 5. the cron's retry of a stylesheet ----------
  const S2 = "https://fonts.font.example/css2?family=Brand+Sans:wght@400;700&display=swap";
  await mod.prefetchImages(env, `<link rel="stylesheet" href="${S2.replace(/&/g, "&amp;")}"><p style="font-family:'Brand Sans'">Привет</p>`, "gmail:a@gmail.com:fill1", { from: "news@font.example", queueOnly: true });
  check(row(S2)?.what === "css" && row(S2)?.fill === 1, `a mail's stylesheet can be queued for the cron (${JSON.stringify(row(S2) && { what: row(S2).what, fill: row(S2).fill })})`);
  for (const w of want) r2.delete(await keyOf(w));   // as if swept: the cron's fonts are its own
  const n1 = host.asked.length; due(); const d1 = await mod.drainImgQueue(env);
  const s2 = await held(S2), s2css = s2 && new TextDecoder().decode(s2.buf);
  check(s2?.ct === "text/css" && /brand-latin/.test(s2css) && /brand-bold/.test(s2css) && /unused/.test(s2css) && !/brand-cyr/.test(s2css), `the cron keeps it for English text, every family (it has no mail at hand), no cyrillic (${s2css && s2css.match(/s\/[\w-]+\.woff2/g)})`);
  const queued = ["brand-latin", "brand-bold", "unused"].map((n) => row(`https://fonts.font.example/s/${n}.woff2`));
  check(queued.every((q) => q && q.what === "font" && q.state === "pending" && q.fill === 1), `and queues its fonts, due now, as catch-up (${queued.map((q) => q && q.what + "/" + q.fill).join(", ")})`);
  due(); const d2 = await mod.drainImgQueue(env);
  const got2 = await Promise.all(["brand-latin", "brand-bold", "unused"].map((n) => held(`https://fonts.font.example/s/${n}.woff2`)));
  check(got2.every((f) => f && f.ct === "font/woff2") && !host.asked.slice(n1).includes("https://fonts.font.example/s/brand-cyr.woff2"), `the next minute fetches them, as fonts (${JSON.stringify({ d1: d1.stored, d2: d2.stored })})`);
  // ---------- the old IE pattern: two src declarations, the browser using the last ----------
  const ie = mod.fontFaces(`@font-face{font-family:'Fin Display';src:url('https://cdn.font.example/fin.eot');src:url('https://cdn.font.example/fin.eot?#iefix') format('embedded-opentype'),url('https://cdn.font.example/fin.woff2') format('woff2'),url('https://cdn.font.example/fin.woff') format('woff');font-weight:300}`);
  check(ie.length === 1 && ie[0].src === "https://cdn.font.example/fin.woff2" && ie[0].family === "fin display", `a face with two src declarations takes its font from the last, as the browser does (${JSON.stringify(ie.map((f) => f.src))})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall font checks passed");
process.exit(fails.length ? 1 : 0);
