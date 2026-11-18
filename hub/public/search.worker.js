/* search.worker.js - local full-text search. SQLite + FTS5 compiled to WebAssembly, running in a
   module worker, persisted in the Origin Private File System (opfs-sahpool VFS; no COOP/COEP needed; in-memory fallback).
   The page pushes thread metadata and cached bodies; queries return thread keys ranked by bm25 with highlighted snippets. */
import sqlite3InitModule from "/sqlite3.mjs";
let db = null, pool = null, mode = "none", ready = null, indexed = 0;
const SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS mail USING fts5(key UNINDEXED, account UNINDEXED, subject, sender, recipients, snippet, body, date UNINDEXED, tokenize='unicode61 remove_diacritics 2'); CREATE TABLE IF NOT EXISTS docs(key TEXT PRIMARY KEY, sig TEXT, has_body INTEGER DEFAULT 0);";
async function init() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "mail-search", initialCapacity: 6 });
    db = new pool.OpfsSAHPoolDb("/mail-search.db"); mode = "opfs";
  } catch (e) { db = new sqlite3.oo1.DB(":memory:"); mode = "memory"; }
  db.exec(SCHEMA);
  indexed = db.selectValue("SELECT COUNT(*) FROM docs") || 0;
  return { mode, indexed };
}
ready = init().catch((e) => ({ error: String((e && e.message) || e) }));
function upsert(rows) {
  let n = 0;
  db.transaction(() => {
    const sel = db.prepare("SELECT sig, has_body FROM docs WHERE key = ?");
    const del = db.prepare("DELETE FROM mail WHERE key = ?");
    const ins = db.prepare("INSERT INTO mail(key, account, subject, sender, recipients, snippet, body, date) VALUES (?,?,?,?,?,?,?,?)");
    const doc = db.prepare("INSERT INTO docs(key, sig, has_body) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET sig = excluded.sig, has_body = excluded.has_body");
    try {
      for (const r of rows) {
        const sig = r.date + "|" + (r.subject || "").length + "|" + (r.snippet || "").length + "|" + (r.body ? r.body.length : 0);
        let prev = null; sel.bind([r.key]); if (sel.step()) prev = { sig: sel.get(0), has_body: sel.get(1) }; sel.reset();
        if (prev && prev.sig === sig) continue;
        if (prev && prev.has_body && !r.body) continue; // never replace an indexed body with a metadata-only row
        del.bind([r.key]).stepReset();
        ins.bind([r.key, r.account || "", r.subject || "", r.sender || "", r.recipients || "", r.snippet || "", r.body || "", r.date || 0]).stepReset();
        doc.bind([r.key, sig, r.body ? 1 : 0]).stepReset(); n++;
      }
    } finally { sel.finalize(); del.finalize(); ins.finalize(); doc.finalize(); }
  });
  indexed = db.selectValue("SELECT COUNT(*) FROM docs") || 0;
  return n;
}
function remove(keys) {
  db.transaction(() => { for (const k of keys) { db.exec({ sql: "DELETE FROM mail WHERE key = ?", bind: [k] }); db.exec({ sql: "DELETE FROM docs WHERE key = ?", bind: [k] }); } });
  indexed = db.selectValue("SELECT COUNT(*) FROM docs") || 0;
}
// Query language: plain words (prefix-matched, AND), "quoted phrases", from:/to:/subject:/body: column filters, -word excludes, account:x
function buildMatch(q) {
  const terms = q.match(/(?:[a-z]+:)?"[^"]*"|\S+/g) || []; const pos = [], neg = []; let account = null;
  for (let t of terms) {
    let isNeg = false; if (t.startsWith("-") && t.length > 1) { isNeg = true; t = t.slice(1); }
    let col = null; const m = t.match(/^(from|to|subject|body|account):(.+)$/i); if (m) { col = m[1].toLowerCase(); t = m[2]; }
    if (col === "account") { account = t.replace(/"/g, ""); continue; }
    const quoted = /^".*"$/.test(t); const raw = t.replace(/"/g, "").replace(/[^\p{L}\p{N}@._'-]+/gu, " ").trim(); if (!raw) continue;
    const tok = quoted ? '"' + raw.replace(/"/g, "") + '"' : raw.split(/\s+/).map((w) => '"' + w + '"*').join(" ");
    const colmap = { from: "sender", to: "recipients", subject: "subject", body: "body" };
    (isNeg ? neg : pos).push(col ? colmap[col] + ":(" + tok + ")" : "(" + tok + ")");
  }
  if (!pos.length) return { expr: null, account }; // FTS5 has no match-all; a negatives-only query falls back to the page's scan
  let expr = pos.join(" AND "); for (const n of neg) expr += " NOT " + n;   // explicit AND: implicit AND is not allowed between groups
  return { expr, account };
}
function search(q, limit, opts) {
  limit = limit || 60; opts = opts || {};
  const built = buildMatch(q); if (!built.expr) return [];
  const sql = "SELECT key, account, date, bm25(mail, 0, 0, 8.0, 6.0, 3.0, 2.0, 1.0, 0) AS score, snippet(mail, 6, '', '', '...', 14) AS snip, snippet(mail, 2, '', '', '', 20) AS subj FROM mail WHERE mail MATCH ?" + (built.account ? " AND account = ?" : "") + " ORDER BY " + (opts.order === "date" ? "date DESC" : "score, date DESC") + " LIMIT ?";
  const rows = []; const st = db.prepare(sql);
  try { st.bind(built.account ? [built.expr, built.account, limit] : [built.expr, limit]); while (st.step()) rows.push({ key: st.get(0), account: st.get(1), date: st.get(2), score: st.get(3), snip: st.get(4), subj: st.get(5) }); }
  finally { st.finalize(); }
  return rows;
}
self.onmessage = async (e) => {
  const d = e.data || {}; const id = d.id, type = d.type; const t0 = performance.now();
  try {
    const r = await ready; if (r && r.error) throw new Error(r.error);
    let result;
    if (type === "status") result = { mode, indexed };
    else if (type === "upsert") result = { n: upsert(d.rows || []), indexed };
    else if (type === "remove") { remove(d.keys || []); result = { indexed }; }
    else if (type === "search") result = { rows: search(d.q, d.limit, d.opts), ms: Math.round(performance.now() - t0) };
    else if (type === "clear") { // wipe the files themselves (deleted rows would otherwise linger in free pages on disk)
      if (pool) { try { db.close(); } catch (_) {} await pool.wipeFiles(); db = new pool.OpfsSAHPoolDb("/mail-search.db"); db.exec(SCHEMA); }
      else { db.exec("DELETE FROM mail; DELETE FROM docs;"); }
      indexed = 0; result = { indexed, wiped: !!pool }; }
    else throw new Error("unknown " + type);
    self.postMessage({ id, ok: true, result, ms: Math.round(performance.now() - t0) });
  } catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
};
