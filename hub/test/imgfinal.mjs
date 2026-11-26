#!/usr/bin/env node
// A sender's share counts each picture at the size the hub keeps. A newsletter's four PNGs (two of
// 2985 x 4096) were 13.8 MB fetched and 0.71 MB once shrunk 23 seconds later; counted at 13.8 MB against the sender's 15 MB, its last two
// pictures were withheld for a day, and each hourly retry downloaded them again (7 MB) to find they still did not fit.
// The real Worker's arrival prefetch and the cron's drain on real migrations and SQLite, a fake picture host and R2 in memory; the
// shrinker's part (what it keeps, waking the sender's waiting pictures) is test/imgwork.mjs.
//  - six 4 MB pictures from one sender: three kept, the rest wait for room, each with its size; not one asked of the sender twice;
//  - the drain does not download a picture it knows will not fit;
//  - once the shrinker has written what it kept (and woken them), the drain fetches the rest within the same share;
//  - the day's allowance counts the kept size too; a picture whose original stays counts in full.
// Usage: node test/imgfinal.mjs (exit 1 on any failed check)
// CONTROL: IMGFINAL_SRC=<an index.js from before the change> node test/imgfinal.mjs must fail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) {
  const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
}
const tick = () => new Promise((r) => setImmediate(r));
const db = {
  prepare(sql) { const mk = (p) => ({ _sql: sql, _p: p, bind: (...a) => mk(a), all: async () => { await tick(); return { results: sq.prepare(sql).all(...p) }; }, first: async () => { await tick(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { await tick(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); },
  batch: async (xs) => { await tick(); sq.exec("SAVEPOINT b"); try { const out = xs.map((x) => ({ meta: { changes: Number(sq.prepare(x._sql).run(...x._p).changes) } })); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } },
};
const SRC = readFileSync(process.env.IMGFINAL_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}src/_imgfinal_test.mjs`; writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));

const MB = 1024 * 1024, BIG = 4 * MB;
const png = (n, w = 2985, h = 4096) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255, (h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255]); return b; };
const host = { asked: [] };
globalThis.fetch = async (input) => {
  const u = String(typeof input === "string" ? input : input.url), json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  if (u.startsWith("https://cloudflare-dns.com/")) return json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
  if (/\.big\.example\//.test(u)) { host.asked.push(u); return new Response(png(BIG), { headers: { "content-type": "image/png", "content-length": String(BIG) } }); }
  return new Response("{}", { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const r2 = new Map();
const STORE = { head: async (k) => (r2.has(k) ? { key: k } : null), get: async (k) => (r2.has(k) ? { body: new Response(r2.get(k)).body, arrayBuffer: async () => r2.get(k).buffer, httpMetadata: { contentType: "image/png" }, customMetadata: {} } : null),
  put: async (k, buf) => { r2.set(k, new Uint8Array(buf instanceof ArrayBuffer ? buf : await new Response(buf).arrayBuffer())); return {}; }, delete: async (k) => { for (const x of [].concat(k)) r2.delete(x); }, list: async () => ({ objects: [], truncated: false }) };
const env = { DB: db, STORE, FORWARD_TO: "me@gmail.com", DOMAINS: "hub.example", CLI_TOKEN: "t", SESSION_SECRET: "s", EMAIL: { send: async () => {} } };
const pics = Array.from({ length: 6 }, (_, i) => `https://img.big.example/news/${i + 1}.png`);
const html = pics.map((u) => `<img src="${u}" width="600">`).join("");
const q = () => sq.prepare("SELECT url, state, kind, size, next_at FROM img_queue ORDER BY url").all();
const kept = () => pics.filter((u) => sq.prepare("SELECT 1 FROM img_queue WHERE url = ?").get(u) === undefined);

try {
  // 1. the arrival: 15 MB of share, 4 MB pictures
  const a = await mod.prefetchImages(env, html, "hub:news-1", { from: "news@big.example" });
  const waiting = q().filter((r) => r.state === "pending" && r.kind === "over");
  check(a.stored === 3 && waiting.length === 3, `the arrival keeps three 4 MB pictures inside the 15 MB share and the rest wait (${JSON.stringify({ stored: a.stored, over: a.over })})`);
  check(waiting.every((r) => r.size === BIG), `each waiting picture keeps its size (${waiting.map((r) => r.size).join(", ")})`);
  // 2. the drain, the shares as they stand: nothing downloaded again
  sq.prepare("UPDATE img_queue SET next_at = ?").run(new Date(Date.now() - 1000).toISOString());
  const n0 = host.asked.length, d1 = await mod.drainImgQueue(env);
  check(host.asked.length === n0 && d1.stored === 0 && d1.over === 3, `the drain does not download a picture it knows will not fit (${host.asked.length - n0} downloads, ${JSON.stringify({ stored: d1.stored, over: d1.over })})`);
  check(new Set(host.asked).size === host.asked.length, `so far no picture was asked of the sender twice (${host.asked.length} requests for ${new Set(host.asked).size} pictures)`);
  // 3. the shrinker has kept 300 KB of each stored one (what mailhub-img writes, test/imgwork.mjs) and woken the sender's waiting pictures
  const work = sq.prepare("SELECT key, bytes, dom FROM img_work").all();
  check(work.length === 3 && work.every((w) => w.dom === "big.example" && w.bytes === BIG), `each stored picture's shrink row names its sender (${work.map((w) => w.dom).join(", ")})`);
  sq.prepare("UPDATE img_work SET state = 'done', out_bytes = 300000, kept = 300000, done_at = ?").run(new Date().toISOString());
  sq.prepare("UPDATE img_queue SET next_at = ?").run(new Date(Date.now() - 1000).toISOString());
  const d2 = await mod.drainImgQueue(env);
  check(d2.stored === 3 && kept().length === 6, `counted at what is kept (0.9 MB of 12), the share has room and the drain keeps the other three (${JSON.stringify({ stored: d2.stored, over: d2.over })}, ${kept().length} of 6)`);
  // 4. the day's allowance counts the kept size too; a picture whose original stays counts in full
  const left0 = await mod.prefetchAllowance(env);
  sq.prepare("UPDATE img_work SET kept = bytes + 50000 WHERE rowid = (SELECT MIN(rowid) FROM img_work)").run();
  const left1 = await mod.prefetchAllowance(env);
  const spent0 = 250 * MB - left0.bytes;
  check(spent0 === 6 * BIG - 3 * (BIG - 300000), `the day's allowance counts the three shrunk pictures at what is kept (${spent0} spent, ${6 * BIG - 3 * (BIG - 300000)} expected)`);
  check(left0.bytes - left1.bytes === BIG - 300000, `and one whose original stays at its full size (${left0.bytes - left1.bytes})`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall final-size checks passed");
process.exit(fails.length ? 1 : 0);
