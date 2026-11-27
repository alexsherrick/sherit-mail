#!/usr/bin/env node
// A file too big for its message goes as a link: the app uploads it to the hub in 8 MiB parts (an R2 multipart
// upload), and whoever has the link gets a page with its name, size and date at /f/<token>, and the file at /f/<token>/file (ranges
// too), without signing in. A part of the wrong size, a file over 2 GiB, more than 8 GiB kept, and a request without a session are
// refused; an unknown or expired link is a page saying so; the daily sweep deletes expired files and uploads left unfinished.
// The real Worker on real migrations and SQLite; R2 is a fake that keeps multipart uploads as R2 does.
// Usage: node test/drops.mjs (exit 1 on any failed check)
// CONTROL: DROPS_SRC=<an index.js from before the change> node test/drops.mjs must fail.
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
const SRC = readFileSync(process.env.DROPS_SRC || HUB + "src/index.js", "utf8")
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.from = f; this.to = t; this.raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_drops_worker.mjs`; writeFileSync(tmp, SRC + "\nexport const __drops = typeof sweepDrops === \"function\" ? { sweepDrops } : null;\n");
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const sq = buildDb(); const objs = new Map(); const meta = new Map(); const uploads = new Map(); let upN = 0;
const bytesOf = async (v) => new Uint8Array(await new Response(v instanceof Uint8Array ? v.slice() : v).arrayBuffer());
const objOf = (k, range) => { const all = objs.get(k), o = meta.get(k) || {}; const b = range ? all.slice(range.offset, range.offset + range.length) : all; return { body: new Response(b).body, size: all.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }; };
const mp = (key, id) => ({ uploadId: id, key,
  uploadPart: async (n, v) => { const u = uploads.get(id); if (!u) throw new Error("no such upload"); u.parts.set(n, await bytesOf(v)); return { partNumber: n, etag: `e${n}-${id}` }; },
  complete: async (parts) => { const u = uploads.get(id); const chunks = parts.map((p) => { if (p.etag !== `e${p.partNumber}-${id}`) throw new Error("bad etag"); return u.parts.get(p.partNumber); }); const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } objs.set(key, all); meta.set(key, { httpMetadata: u.httpMetadata }); uploads.delete(id); return { key, size: all.length }; },
  abort: async () => { uploads.delete(id); } });
const env = { DB: d1(sq), CLI_TOKEN: "cli-token", DOMAINS: "hub.example", EMAIL: { send: async () => ({ messageId: "<x@hub.test>" }) },
  STORE: { put: async (k, v, o = {}) => { objs.set(k, await bytesOf(v)); meta.set(k, o); return { key: k }; }, get: async (k, o = {}) => (objs.has(k) ? objOf(k, o.range) : null),
    head: async (k) => (objs.has(k) ? { size: objs.get(k).length } : null), list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); },
    createMultipartUpload: async (key, o = {}) => { const id = "up" + ++upN; uploads.set(id, { key, parts: new Map(), httpMetadata: o.httpMetadata }); return mp(key, id); },
    resumeMultipartUpload: (key, id) => mp(key, id) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const req = async (method, path, { body, auth = true, headers = {} } = {}) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers: { ...(auth ? { Authorization: "Bearer cli-token" } : {}), ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...headers }, body }), env, ctx); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, h: r.headers, b, j: (() => { try { return JSON.parse(new TextDecoder().decode(b)); } catch (_) { return {}; } })() }; };
const MiB = 1048576, SIZE = 20 * MiB + 12345;
const file = new Uint8Array(SIZE); for (let i = 0; i < SIZE; i++) file[i] = (i * 31 + 7) & 255;
try {
  const c = await req("POST", "/api/drops", { body: JSON.stringify({ name: "Site walk – July.mov", type: "video/quicktime", size: SIZE }) });
  check(c.status === 200 && c.j.part === 8 * MiB && c.j.parts === 3, `an upload is opened in 8 MiB parts (${c.status} ${JSON.stringify(c.j)})`);
  const id = c.j.id, P = c.j.part, parts = [];
  const big = await req("PUT", `/api/drops/${id}/parts/1`, { body: new Uint8Array(P + 1), headers: { "content-length": String(P + 1) } });
  check(big.status === 413, `a part over 8 MiB is refused on its declared size (${big.status})`);
  const chunked = new ReadableStream({ start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1048576)); c.close(); } });
  const r0 = await mod.default.fetch(new Request(`https://hub.example/api/drops/${id}/parts/1`, { method: "PUT", headers: { Authorization: "Bearer cli-token" }, body: chunked, duplex: "half" }), env, ctx);
  check(r0.status === 413, `a part sent with no length at all is cut off past 8 MiB, not read whole (${r0.status})`);
  const wrong = await req("PUT", `/api/drops/${id}/parts/1`, { body: file.slice(0, P - 1) });
  check(wrong.status === 400, `a part of the wrong size is refused (${wrong.status})`);
  for (let n = 1; n <= 3; n++) { const r = await req("PUT", `/api/drops/${id}/parts/${n}`, { body: file.slice((n - 1) * P, Math.min(SIZE, n * P)) }); parts.push(r.j); }
  const done = await req("POST", `/api/drops/${id}/complete`, { body: JSON.stringify({ parts }) });
  const token = (/\/f\/([A-Za-z0-9_-]{32})$/.exec(done.j.url || "") || [])[1];
  check(done.status === 200 && token && done.j.size === SIZE && Date.parse(done.j.expires_at) - Date.now() > 29 * 864e5, `completed: a link with a 32-character token, kept 30 days (${done.j.url})`);
  // finished in R2 while its row missed the news: completing it then is answered by the object itself
  const c4 = await req("POST", "/api/drops", { body: JSON.stringify({ name: "lost.bin", size: 100 }) });
  const p4 = (await req("PUT", `/api/drops/${c4.j.id}/parts/1`, { body: new Uint8Array(100) })).j; const r4 = sq.prepare("SELECT r2_key, upload_id FROM drops WHERE id = ?").get(c4.j.id);
  await env.STORE.resumeMultipartUpload(r4.r2_key, r4.upload_id).complete([p4]);
  const done4 = await req("POST", `/api/drops/${c4.j.id}/complete`, { body: JSON.stringify({ parts: [p4] }) });
  check(done4.status === 200 && /\/f\/[A-Za-z0-9_-]{32}$/.test(done4.j.url || "") && sq.prepare("SELECT state FROM drops WHERE id = ?").get(c4.j.id).state === "ready", `an upload R2 finished while its row missed it completes on a retry (${done4.status})`);
  await req("DELETE", `/api/drops/${c4.j.id}`);
  const again = await req("POST", `/api/drops/${id}/complete`, { body: JSON.stringify({ parts }) });
  check(again.status === 200 && again.j.url === done.j.url, `completing again (its answer lost) gives the same link (${again.status})`);
  const page = await req("GET", `/f/${token}`, { auth: false }); const html = new TextDecoder().decode(page.b);
  check(page.status === 200 && html.includes("Site walk – July.mov") && html.includes("20.0 MB") && html.includes(`/f/${token}/file`) && /default-src 'none'/.test(page.h.get("content-security-policy") || "") && !/<script/i.test(html), `the link's page, without signing in: name, size, a Download button, no script (${page.status})`);
  const dl = await req("GET", `/f/${token}/file`, { auth: false });
  check(dl.status === 200 && dl.b.length === SIZE && dl.b.every((v, i) => v === file[i]) && /attachment;/.test(dl.h.get("content-disposition") || "") && /filename\*=UTF-8''Site%20walk%20%E2%80%93%20July\.mov/.test(dl.h.get("content-disposition") || ""), `the file comes back whole, as a download under its own name (${dl.status}, ${dl.b.length} bytes)`);
  const rg = await req("GET", `/f/${token}/file`, { auth: false, headers: { range: "bytes=8388600-8388699" } });
  check(rg.status === 206 && rg.b.length === 100 && rg.b.every((v, i) => v === file[8388600 + i]) && rg.h.get("content-range") === `bytes 8388600-8388699/${SIZE}`, `a range comes back as asked, so a big download can resume (${rg.status} ${rg.h.get("content-range")})`);
  const n0 = sq.prepare("SELECT downloads FROM drops WHERE id = ?").get(id).downloads;
  check(n0 === 1, `a whole download is counted, a range is not (${n0})`);
  const nope = await req("GET", "/f/" + "A".repeat(32), { auth: false });
  check(nope.status === 404 && new TextDecoder().decode(nope.b).includes("expired"), `an unknown link: a page saying it has expired (${nope.status})`);
  const huge = await req("POST", "/api/drops", { body: JSON.stringify({ name: "x", size: 2 * 1024 ** 3 + 1 }) });
  sq.prepare("INSERT INTO drops (id, token, filename, size, r2_key, state, created_at, expires_at) VALUES ('fill', 'f".concat("B".repeat(31), "', 'fill', ?, 'drop/fill', 'ready', ?, ?)")).run(8 * 1024 ** 3 - SIZE - 10, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  const full = await req("POST", "/api/drops", { body: JSON.stringify({ name: "y", size: 100 }) });
  const anon = await req("POST", "/api/drops", { auth: false, body: JSON.stringify({ name: "z", size: 100 }) });
  check(huge.status === 413 && full.status === 507 && anon.status === 401, `over 2 GiB, over 8 GiB kept in all, and without a session: refused (${huge.status} ${full.status} ${anon.status})`);
  sq.prepare("DELETE FROM drops WHERE id = 'fill'").run();
  // a link made for a send that did not go is deleted on request, its file with it
  const c3 = await req("POST", "/api/drops", { body: JSON.stringify({ name: "gone.bin", size: 100 }) });
  await req("PUT", `/api/drops/${c3.j.id}/parts/1`, { body: new Uint8Array(100) }); const p3 = (await req("PUT", `/api/drops/${c3.j.id}/parts/1`, { body: new Uint8Array(100) })).j;
  await req("POST", `/api/drops/${c3.j.id}/complete`, { body: JSON.stringify({ parts: [p3] }) });
  const del = await req("DELETE", `/api/drops/${c3.j.id}`);
  check(del.status === 200 && del.j.deleted === 1 && !sq.prepare("SELECT 1 FROM drops WHERE id = ?").get(c3.j.id) && ![...objs.keys()].some((k) => k.includes(c3.j.id)), `DELETE takes a link's row and file away (${del.status})`);
  // the daily sweep
  const c2 = await req("POST", "/api/drops", { body: JSON.stringify({ name: "half.bin", size: 9 * MiB }) });
  sq.prepare("UPDATE drops SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 864e5).toISOString(), c2.j.id);
  const young = mod.__drops ? (await mod.__drops.sweepDrops(env), sq.prepare("SELECT COUNT(*) n FROM drops WHERE id = ?").get(c2.j.id).n) : -1;
  check(young === 1, `an upload still going after two days is not swept from under its sender (${young})`);
  sq.prepare("UPDATE drops SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 9 * 864e5).toISOString(), c2.j.id);
  sq.prepare("UPDATE drops SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
  const gone = await req("GET", `/f/${token}`, { auth: false });
  const realDelete = env.STORE.delete; env.STORE.delete = async () => { throw new Error("R2 unavailable"); };
  const kept = mod.__drops ? await mod.__drops.sweepDrops(env) : -1; const rowsKept = sq.prepare("SELECT COUNT(*) n FROM drops").get().n;
  env.STORE.delete = realDelete;
  check(kept === 0 && rowsKept === 2, `a sweep that cannot delete a file keeps its row, to try again (${kept} swept, ${rowsKept} rows)`);
  const swept = mod.__drops ? await mod.__drops.sweepDrops(env) : 0;
  const left = sq.prepare("SELECT COUNT(*) n FROM drops").get().n;
  check(gone.status === 404 && swept === 2 && left === 0 && ![...objs.keys()].some((k) => k.startsWith("drop/")) && uploads.size === 0, `an expired link stops at once; the daily sweep deletes it and an upload left unfinished (${gone.status}, swept ${swept}, ${left} rows left)`);
} catch (e) { check(false, "threw: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
console.log(fails.length ? `\n${fails.length} failed` : "\nall large-file checks passed");
process.exit(fails.length ? 1 : 0);
