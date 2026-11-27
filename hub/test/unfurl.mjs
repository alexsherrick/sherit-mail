#!/usr/bin/env node
// A link on a line of its own gets a preview: the hub reads the page's head (Open Graph, then Twitter's tags, then
// <title> and the description), resolves its picture against the page, keeps only an https picture, decodes entities, and keeps the
// answer 7 days. A page that is not HTML, names no title, sits on a private address or is not a web address has no preview.
// The real Worker on real migrations and SQLite; the network is a fake.
// Usage: node test/unfurl.mjs (exit 1 on any failed check)
// CONTROL: UNFURL_SRC=<an index.js from before the change> node test/unfurl.mjs must fail.
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
// ---------- the fake network ----------
const SITES = {
  "https://news.example/story": { ct: "text/html; charset=utf-8", body: '<html><head><title>Ignored</title><meta property="og:title" content="Rates &amp; the grid: what changed"><meta property="og:description" content="A look at &quot;peak&quot; pricing."><meta property="og:image" content="/img/hero.jpg"><meta property="og:site_name" content="The News"></head><body>' + "x".repeat(1000) + "</body></html>" },
  "https://tw.example/p": { ct: "text/html", body: '<head><meta name="twitter:title" content="Tweet title"><meta name="twitter:image" content="http://tw.example/i.png"><meta name="description" content="Plain description"></head>' },
  "https://inner.example/p": { ct: "text/html", body: '<head><meta property="og:title" content="Inner"><meta property="og:image" content="https://intranet.example/cam.jpg"></head>' },
  "https://ip.example/p": { ct: "text/html", body: '<head><meta property="og:title" content="IP"><meta property="og:image" content="https://10.0.0.9/x.jpg"></head>' },
  "https://dollar.example/p": { ct: "text/html", body: '<head><meta property="og:title" content="Save $& more $\' now"></head>' },
  "https://plain.example/": { ct: "text/html", body: "<html><head><title>  Just a title \n</title></head></html>" },
  "https://notitle.example/": { ct: "text/html", body: "<html><head></head><body>hi</body></html>" },
  "https://files.example/a.pdf": { ct: "application/pdf", body: "%PDF-1.4" },
  "https://short.example/x": { status: 301, location: "https://news.example/story" },
};
const PRIVATE = new Set(["intranet.example"]);
const fetched = [];
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "cloudflare-dns.com") { const name = u.searchParams.get("name"), type = u.searchParams.get("type"); return new Response(JSON.stringify({ Answer: type === "A" ? [{ type: 1, data: PRIVATE.has(name) ? "10.1.2.3" : "203.0.113.30" }] : [] })); }
  fetched.push(u.href); const s = SITES[u.href]; if (!s) return new Response("nope", { status: 404 });
  if (s.status) return new Response(null, { status: s.status, headers: { location: s.location } });
  return new Response(s.body, { status: 200, headers: { "content-type": s.ct } });
};
const SRC = readFileSync(process.env.UNFURL_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_unfurl_worker.mjs`; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const sq = buildDb(); const objs = new Map(); const meta = new Map();
const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "hub.example", EMAIL: { send: async () => ({ messageId: "<x@hub.test>" }) },
  STORE: { put: async (k, v, o = {}) => { objs.set(k, new Uint8Array(await new Response(v).arrayBuffer())); meta.set(k, o); return { key: k }; },
    get: async (k) => { if (!objs.has(k)) return null; const b = objs.get(k), o = meta.get(k) || {}; return { body: new Response(b).body, size: b.length, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(0), httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }; },
    head: async (k) => (objs.has(k) ? { size: objs.get(k).length, customMetadata: (meta.get(k) || {}).customMetadata || {} } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const pv = async (u) => { const r = await mod.default.fetch(new Request("https://hub.example/api/unfurl?u=" + encodeURIComponent(u), { headers: { Authorization: "Bearer cli-token" } }), env, ctx); const j = await r.json().catch(() => ({})); return { status: r.status, p: j.preview }; };
try {
  const a = await pv("https://news.example/story");
  check(a.status === 200 && a.p && a.p.title === "Rates & the grid: what changed" && a.p.description === 'A look at "peak" pricing.' && a.p.image === "https://news.example/img/hero.jpg" && a.p.site === "The News", `Open Graph read, entities decoded, the picture resolved against the page (${JSON.stringify(a.p)})`);
  const b = await pv("https://tw.example/p");
  check(b.p && b.p.title === "Tweet title" && b.p.description === "Plain description" && b.p.image === "" && b.p.site === "tw.example", `Twitter's tags and the description meta; an http picture is dropped (${JSON.stringify(b.p)})`);
  const c = await pv("https://plain.example/");
  check(c.p && c.p.title === "Just a title" && c.p.site === "plain.example", `a page with only a <title> (${JSON.stringify(c.p)})`);
  const r = await pv("https://short.example/x");
  check(r.p && r.p.title === "Rates & the grid: what changed" && r.p.url === "https://short.example/x", `a link that redirects previews the page it lands on, under its own address (${r.p && r.p.url})`);
  const inner = await pv("https://inner.example/p"), ip = await pv("https://ip.example/p");
  check(inner.p && inner.p.image === "" && ip.p && ip.p.image === "", `a picture on a private host or an IP address is dropped (the recipients' apps would ask it) (${inner.p && inner.p.image} / ${ip.p && ip.p.image})`);
  const n0 = fetched.length; const again = await pv("https://news.example/story");
  check(again.p && again.p.title === a.p.title && fetched.length === n0, `asked again: the kept answer, nothing fetched (${fetched.length - n0})`);
  const none = await Promise.all(["https://notitle.example/", "https://files.example/a.pdf", "https://intranet.example/", "ftp://x.example/", "not a url"].map(pv));
  check(none.every((x) => x.status === 200 && x.p === null) && !fetched.some((x) => x.includes("intranet.example")), `no title, not HTML, a private address, not a web address: no preview, and the private host never asked (${none.map((x) => JSON.stringify(x.p)).join(" ")})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall link-preview checks passed");
process.exit(fails.length ? 1 : 0);
