#!/usr/bin/env node
// EXECUTION test for drafts in the hub: the real Worker over the real migrations in SQLite, with an in-memory R2.
// Pinned: a draft saves and comes back opened; a device's cursor gets only what changed, tombstones included; a save over a newer
// revision is refused with the current draft and overwrites nothing; files go up once and are deleted with their draft; a draft's
// files stop at 25 MB; the content is sealed in D1; tombstones older than 30 days are pruned, and a device whose cursor is older is
// told to take the full list. Usage: node test/drafts.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

const HUB = new URL("../", import.meta.url).pathname; const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; const o = (buf.match(/\bBEGIN\b/gi) || []).length, c = (buf.match(/\bEND\b/gi) || []).length; if (o === c) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } return out; };
const sq = new DatabaseSync(":memory:");
for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n"))) { try { sq.exec(st); } catch (e) { if (!/duplicate column|already exists/i.test(e.message)) throw new Error(f + ": " + e.message); } }
const faults = { r2Delete: false, filesInsert: false };   // injected failures
const d1 = { prepare(sql) { const boom = () => { if (faults.filesInsert && /^INSERT INTO draft_files/.test(sql)) throw new Error("D1 insert failed (test)"); }; const mk = (p) => ({ sql, bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => { boom(); return sq.prepare(sql).get(...p) ?? null; }, run: async () => { boom(); return { meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }; } }); return mk([]); },
  batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; } };
const R2 = new Map();
const STORE = { put: async (k, v) => { R2.set(k, new Uint8Array(v instanceof ArrayBuffer ? v : (v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : new TextEncoder().encode(String(v))))); return {}; },
  get: async (k) => (R2.has(k) ? { body: R2.get(k), arrayBuffer: async () => R2.get(k).buffer } : null), delete: async (k) => { if (faults.r2Delete) throw new Error("R2 delete failed (test)"); R2.delete(k); }, list: async () => ({ objects: [], truncated: false }) };
globalThis.fetch = async () => new Response("{}");
const SRC = readFileSync(process.env.DRAFTS_SRC || HUB + "src/index.js", "utf8").replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};").replace(/^import \{ connect \} from "cloudflare:sockets";$/m, "const connect = () => { throw new Error('no sockets'); };").replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";').replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_drafts_worker.mjs`; writeFileSync(tmp, SRC); let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }
const env = { DB: d1, STORE, CLI_TOKEN: "cli", DOMAINS: "yourdomain.example", FORWARD_TO: "x@gmail.com", GMAIL_TOKEN_KEY: Buffer.from("k".repeat(32)).toString("base64") };
const call = async (method, path, body, headers = {}) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers: { Authorization: "Bearer cli", ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers }, body: body == null ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), env, { waitUntil: () => {} }); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: /json/.test(ct) ? await r.json() : new Uint8Array(await r.arrayBuffer()) }; };
const A = "aaaaaaaa-1111-4111-8111-000000000001", B = "aaaaaaaa-1111-4111-8111-000000000002";
const draft = (text, extra = {}) => ({ kind: "new", from: "sam@yourdomain.example", to: "jordan@vendor.example", subject: "Project plan", snippet: text.slice(0, 80), n_files: 0, device: "mac", content: { from: "sam@yourdomain.example", to: "jordan@vendor.example", subject: "Project plan", text, files: [] }, ...extra });

{ // a draft saves and comes back opened
  const p = await call("PUT", `/api/drafts/${A}`, { base_rev: 0, ...draft("First words") });
  check(p.status === 200 && p.body.rev === 1, `a new draft saves at revision 1 (${p.status} ${JSON.stringify(p.body)})`);
  const g = await call("GET", "/api/drafts");
  const d = (g.body.drafts || [])[0] || {};
  check(g.body.full === true && g.body.drafts.length === 1 && d.content?.text === "First words" && d.subject === "Project plan" && d.to === "jordan@vendor.example", `the full list has it, its content opened (${JSON.stringify({ full: g.body.full, n: g.body.drafts.length, text: d.content?.text })})`);
  const row = sq.prepare("SELECT enc FROM drafts WHERE id = ?").get(A);
  check(row.enc && !row.enc.includes("First") && !Buffer.from(row.enc, "base64").toString("latin1").includes("First words"), "the content is sealed in D1, not stored as text");
  globalThis.__cur = g.body.cursor;
}
{ // a device's cursor gets only what changed; an edit from the revision it read goes through
  const p2 = await call("PUT", `/api/drafts/${A}`, { base_rev: 1, ...draft("First words, then more") });
  const p3 = await call("PUT", `/api/drafts/${B}`, { base_rev: 0, ...draft("Another one", { kind: "reply", thread_key: "hub|t1" }) });
  const g = await call("GET", `/api/drafts?since=${globalThis.__cur}`);
  check(p2.body.rev === 2 && p3.body.rev === 1 && g.body.full === false && g.body.drafts.map((x) => x.id).join() === [A, B].join() && g.body.drafts[0].content.text === "First words, then more", `the delta after the cursor holds the edit and the new reply draft (${JSON.stringify(g.body.drafts.map((x) => [x.id.slice(-1), x.rev, x.kind]))})`);
  const quiet = await call("GET", `/api/drafts?since=${g.body.cursor}`);
  check(quiet.body.drafts.length === 0 && quiet.body.cursor === g.body.cursor, `nothing changed: nothing comes back, and the cursor stays (${quiet.body.cursor})`);
  globalThis.__cur = g.body.cursor;
}
{ // a save over a newer revision is refused with the current draft, and overwrites nothing
  const stale = await call("PUT", `/api/drafts/${A}`, { base_rev: 1, ...draft("Written on the phone, from revision 1") });
  const now = sq.prepare("SELECT rev FROM drafts WHERE id = ?").get(A).rev;
  const g = await call("GET", "/api/drafts"); const a = g.body.drafts.find((x) => x.id === A);
  check(stale.status === 409 && stale.body.current?.rev === 2 && stale.body.current?.content?.text === "First words, then more" && now === 2 && a.content.text === "First words, then more", `a save from an old revision is refused (409) with the current one, and the draft is unchanged (${stale.status}, rev ${now})`);
  const gone = await call("PUT", "/api/drafts/aaaaaaaa-1111-4111-8111-00000000000f", { base_rev: 3, ...draft("Edited from a revision of a draft the hub never had") });
  check(gone.status === 409 && gone.body.current === null, `a revision of a draft the hub does not hold is refused too, so the device knows (${gone.status})`);
}
{ // files go up once, come back, and are deleted with their draft
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]);
  const up = await call("POST", `/api/drafts/${B}/files`, bytes, { "content-type": "application/pdf", "x-file-name": encodeURIComponent("Status report (Q3).pdf") });
  const back = await call("GET", `/api/drafts/${B}/files/${up.body.id}`);
  check(up.status === 200 && up.body.name === "Status report (Q3).pdf" && up.body.size === 12 && back.status === 200 && Buffer.from(back.body).equals(Buffer.from(bytes)), `a file uploads under its own name and comes back byte for byte (${up.status}, ${up.body.size} B)`);
  const big = await call("POST", `/api/drafts/${B}/files`, new Uint8Array(18 * 1048576), { "content-type": "application/octet-stream", "x-file-name": "big.bin" });
  check(big.status === 413 && R2.size === 1, `a file that takes the draft over 18 MiB (24 MiB as MIME; the send limit is 25) is refused and not stored (${big.status}, ${R2.size} object in R2)`);
  const del = await call("DELETE", `/api/drafts/${B}`);
  const g = await call("GET", `/api/drafts?since=${globalThis.__cur}`); const t = g.body.drafts.find((x) => x.id === B);
  check(del.body.deleted === 1 && t && t.deleted === true && t.content === null && R2.size === 0 && !sq.prepare("SELECT 1 x FROM draft_files WHERE draft_id = ?").get(B), `a deleted draft reaches the cursor as a tombstone with no content, and its file is gone from R2 and D1 (${JSON.stringify({ deleted: t?.deleted, r2: R2.size })})`);
  const full = await call("GET", "/api/drafts");
  check(full.body.drafts.map((x) => x.id).join() === A, `the full list leaves the deleted one out (${full.body.drafts.length})`);
  const again = await call("PUT", `/api/drafts/${B}`, { base_rev: t.rev, ...draft("Undo send: back as a draft", { kind: "reply", thread_key: "hub|t1" }) });
  check(again.status === 200 && again.body.rev === t.rev + 1 && (await call("GET", "/api/drafts")).body.drafts.some((x) => x.id === B && x.content.text === "Undo send: back as a draft"), `a deleted draft saved again from its tombstone's revision comes back (undo send) (${again.status} rev ${again.body.rev})`);
}
{ // tombstones older than 30 days are pruned; a device whose cursor is older than the prune takes the full list
  await call("DELETE", `/api/drafts/${B}`);
  const oldCursor = 1;
  sq.prepare("UPDATE drafts SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(B);
  sq.prepare("INSERT INTO draft_files (id, draft_id, name, type, size, r2_key, created_at) VALUES ('f-stray', 'no-such-draft', 'x', 'text/plain', 1, 'drafts/no-such-draft/f-stray', '2026-09-01T00:00:00.000Z')").run(); R2.set("drafts/no-such-draft/f-stray", new Uint8Array([1]));
  await mod.purgeEvents(env);
  const g = await call("GET", `/api/drafts?since=${oldCursor}`);
  check(!sq.prepare("SELECT 1 x FROM drafts WHERE id = ?").get(B) && sq.prepare("SELECT 1 x FROM drafts WHERE id = ?").get(A), "the month-old tombstone is pruned; the live draft stays");
  check(g.body.full === true && g.body.drafts.map((x) => x.id).join() === A, `a device whose cursor is older than the prune is told full: true and given the live list (${JSON.stringify({ full: g.body.full, n: g.body.drafts.length })})`);
  check(!R2.has("drafts/no-such-draft/f-stray") && !sq.prepare("SELECT 1 x FROM draft_files WHERE id = 'f-stray'").get(), "a file whose draft never came is removed after a day");
}
// ---------- review fixes ----------
const sha = (s) => createHash("sha256").update(s).digest("hex");
{ // 62c97ffe06: a delete of an older revision keeps the newer one; the right revision's tombstone keeps the hash of what it replaced
  const C = "aaaaaaaa-1111-4111-8111-0000000000c1";
  await call("PUT", `/api/drafts/${C}`, { base_rev: 0, ...draft("Version one") }); await call("PUT", `/api/drafts/${C}`, { base_rev: 1, ...draft("Version two, from the phone") });
  const stale = await call("DELETE", `/api/drafts/${C}?rev=1`);
  const row = sq.prepare("SELECT rev, deleted FROM drafts WHERE id = ?").get(C);
  check(stale.status === 409 && stale.body.current?.content?.text === "Version two, from the phone" && row.deleted === 0 && row.rev === 2, `deleting revision 1 when the hub holds 2 is refused with revision 2, which stays (${stale.status}, rev ${row.rev}, deleted ${row.deleted})`);
  const ok = await call("DELETE", `/api/drafts/${C}?rev=2`); const tomb = sq.prepare("SELECT deleted, gone_hash FROM drafts WHERE id = ?").get(C);
  check(ok.body.deleted === 1 && tomb.deleted === 1 && tomb.gone_hash === sha(JSON.stringify(draft("Version two, from the phone").content)), `deleting revision 2 tombstones it, keeping the SHA-256 of the content it replaced (${String(tomb.gone_hash).slice(0, 12)})`);
  const tseq = sq.prepare("SELECT seq FROM drafts WHERE id = ?").get(C).seq;
  const out = (await call("GET", `/api/drafts?since=${tseq - 1}`)).body.drafts.find((x) => x.id === C);
  check(out && out.deleted && out.gone_hash === tomb.gone_hash, "and the cursor hands that hash to the other devices");
}
{ // 455a8df29d: a PUT answers the revision its own write made
  const E = "aaaaaaaa-1111-4111-8111-0000000000e1";
  const a = await call("PUT", `/api/drafts/${E}`, { base_rev: 0, ...draft("one") }); const b = await call("PUT", `/api/drafts/${E}`, { base_rev: 1, ...draft("two") });
  check(a.body.rev === 1 && b.body.rev === 2 && sq.prepare("SELECT rev FROM drafts WHERE id = ?").get(E).rev === 2, `each PUT answers its own revision (RETURNING): ${a.body.rev}, ${b.body.rev}`);
}
{ // 3acf00f1a3: a PUT naming its files drops the draft's other files (older than two minutes); the cap is 18 MiB
  const F = "aaaaaaaa-1111-4111-8111-0000000000f1";
  await call("PUT", `/api/drafts/${F}`, { base_rev: 0, ...draft("with files") });
  const f1 = (await call("POST", `/api/drafts/${F}/files`, new Uint8Array(10 * 1048576), { "x-file-name": "a.bin" })).body, f2 = (await call("POST", `/api/drafts/${F}/files`, new Uint8Array(7 * 1048576), { "x-file-name": "b.bin" })).body;
  sq.prepare("UPDATE draft_files SET created_at = '2026-11-01T00:00:00.000Z' WHERE draft_id = ?").run(F);
  const p = await call("PUT", `/api/drafts/${F}`, { base_rev: 1, ...draft("with files"), file_ids: [f2.id] });
  const left = sq.prepare("SELECT id FROM draft_files WHERE draft_id = ?").all(F).map((x) => x.id);
  check(p.status === 200 && left.join() === f2.id && !R2.has(`drafts/${F}/${f1.id}`) && R2.has(`drafts/${F}/${f2.id}`), `a file removed from the draft is deleted from D1 and R2 when the draft is saved without it (${left.length} left)`);
  const more = await call("POST", `/api/drafts/${F}/files`, new Uint8Array(10 * 1048576), { "x-file-name": "c.bin" });
  check(more.status === 200, `so it no longer counts: 7 + 10 MiB fits under 18 (${more.status})`);
  const young = (await call("POST", `/api/drafts/${F}/files`, new Uint8Array(10), { "x-file-name": "d.bin" })).body;
  await call("PUT", `/api/drafts/${F}`, { base_rev: 2, ...draft("with files"), file_ids: [f2.id] });
  check(!!sq.prepare("SELECT 1 x FROM draft_files WHERE id = ?").get(young.id), "a file uploaded in the last two minutes, whose save may still be on its way, is not dropped");
}
{ // 331c141cb8: an object whose delete failed keeps its row (and is retried); an object whose row could not be written is deleted
  const G = "aaaaaaaa-1111-4111-8111-0000000000a1";
  await call("PUT", `/api/drafts/${G}`, { base_rev: 0, ...draft("g") }); const g = (await call("POST", `/api/drafts/${G}/files`, new Uint8Array([1, 2, 3]), { "x-file-name": "g.bin" })).body;
  faults.r2Delete = true; await call("DELETE", `/api/drafts/${G}?rev=1`); faults.r2Delete = false;
  check(!!sq.prepare("SELECT 1 x FROM draft_files WHERE id = ?").get(g.id) && R2.has(`drafts/${G}/${g.id}`), "when R2 refuses the delete, the file's row stays, so the object is not lost track of");
  sq.prepare("UPDATE draft_files SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(g.id); await mod.purgeEvents(env);
  check(!sq.prepare("SELECT 1 x FROM draft_files WHERE id = ?").get(g.id) && !R2.has(`drafts/${G}/${g.id}`), "and the daily prune deletes it once R2 answers");
  const n0 = R2.size; faults.filesInsert = true; const bad = await call("POST", `/api/drafts/${G}/files`, new Uint8Array([4, 5]), { "x-file-name": "h.bin" }); faults.filesInsert = false;
  check(bad.status === 500 && R2.size === n0, `an upload whose row cannot be written leaves no object behind (${bad.status}, ${R2.size - n0} new objects)`);
}
{ // 89f293f12d: a pruned tombstone's seq is never handed out again; a full list past the prune floor pages forward and stops
  sq.exec("DELETE FROM drafts; DELETE FROM draft_files; DELETE FROM prefs WHERE key = 'drafts_pruned_seq'");
  const L = "aaaaaaaa-1111-4111-8111-0000000000b1", T = "aaaaaaaa-1111-4111-8111-0000000000b2", N = "aaaaaaaa-1111-4111-8111-0000000000b3";
  await call("PUT", `/api/drafts/${L}`, { base_rev: 0, ...draft("live") }); await call("PUT", `/api/drafts/${T}`, { base_rev: 0, ...draft("soon gone") }); await call("DELETE", `/api/drafts/${T}?rev=1`);
  const cur = (await call("GET", "/api/drafts?since=0")).body.cursor;
  sq.prepare("UPDATE drafts SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(T); await mod.purgeEvents(env);
  const p = await call("PUT", `/api/drafts/${N}`, { base_rev: 0, ...draft("new after the prune") });
  const d = (await call("GET", `/api/drafts?since=${cur}`)).body;
  check(p.body.seq > cur && d.drafts.some((x) => x.id === N), `after the prune the next draft gets seq ${p.body.seq}, above the cursor ${cur}, and the device at that cursor sees it`);
  sq.exec("DELETE FROM drafts");
  const ins = sq.prepare("INSERT INTO drafts (id, rev, seq, kind, subject, enc, iv, deleted, created_at, updated_at) VALUES (?, 1, ?, 'new', ?, NULL, NULL, 0, '2026-11-01', '2026-11-01')");
  for (let i = 1; i <= 600; i++) ins.run(`cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, i, `d${i}`);
  sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('drafts_pruned_seq', '1000', '2026-11-01') ON CONFLICT(key) DO UPDATE SET value = '1000'").run();
  const seen = new Set(); let url = "/api/drafts?since=5", pages = 0, full = false, last = null;
  while (pages < 6) { const r = (await call("GET", url)).body; pages++; full ||= r.full; for (const x of r.drafts) seen.add(x.id); last = r; if (!r.more) break; url = `/api/drafts?since=${r.cursor}${full ? "&full=1" : ""}`; }
  check(seen.size === 600 && pages === 2 && last.more === false && last.cursor === 600, `a device older than the prune floor reads all 600 live drafts in 2 pages, the second not repeating the first (${seen.size} seen, ${pages} pages, cursor ${last.cursor})`);
}
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall drafts checks passed");
