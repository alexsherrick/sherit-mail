// Runs the search worker's real code under Node against the Node build of SQLite WASM: proves FTS5, the query builder,
// ranking and snippets. Usage: node test/fts.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const src = readFileSync(new URL("../public/search.worker.js", import.meta.url), "utf8") // moved out of the Worker script in 7e0e29a; this path went stale with it
  .replace('import sqlite3InitModule from "/sqlite3.mjs";', 'import sqlite3InitModule from "' + new URL("../node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs", import.meta.url).href + '";')
  .replace("sqlite3.installOpfsSAHPoolVfs", "(() => { throw new Error('no opfs in node'); })");
const dir = mkdtempSync(join(tmpdir(), "fts-")); const file = join(dir, "worker.mjs"); writeFileSync(file, src);
const inbox = []; globalThis.self = { postMessage: (m) => inbox.push(m), onmessage: null }; globalThis.performance ??= { now: () => Date.now() };
await import("file://" + file);
const ask = (msg) => new Promise((res) => { const id = Math.random(); const before = inbox.length; self.onmessage({ data: { id, ...msg } }); const tick = () => { const m = inbox.find((x) => x.id === id); m ? res(m) : setTimeout(tick, 5); }; tick(); });
const st = await ask({ type: "status" }); console.log("status:", st.result, st.error || "");
const rows = [];
for (let i = 0; i < 3000; i++) rows.push({ key: "acct|t" + i, account: "a@b.c", subject: i % 7 === 0 ? "Invoice " + i + " from Acme Metals" : "Weekly digest " + i, sender: i % 7 === 0 ? "Bob Accounts bob@acme.example" : "News Desk news@list.example", recipients: "sam@yourdomain.example", snippet: "hello there number " + i, body: i % 7 === 0 ? "Please find attached the quotation for titanium bolts, net 30 terms." : "This week in electronics: a new GaN driver, and a note on ESD series resistors.", date: 1700000000000 + i * 60000 });
let t0 = Date.now(); const up = await ask({ type: "upsert", rows }); console.log("indexed", up.result, "in", Date.now() - t0, "ms");
for (const q of ["titan", "invoice acme", "from:bob", '"ESD series"', "gan -digest", "subject:invoice 14", "bolts to:sam"]) { const r = await ask({ type: "search", q, limit: 5 }); console.log(JSON.stringify(q).padEnd(20), r.ok ? `${r.result.rows.length} hits in ${r.result.ms} ms; top: ${(r.result.rows[0] || {}).key} | ${(r.result.rows[0] || {}).snip}` : "ERROR " + r.error); }
const again = await ask({ type: "upsert", rows: rows.slice(0, 100) }); console.log("re-upsert unchanged rows wrote:", again.result.n);
