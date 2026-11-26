/* search.js - page-side client of the FTS5 search worker. Feeds the index from the local store and answers
   as-you-type queries; falls back to a substring scan while the worker is unavailable (e.g. jsdom, or a browser
   without module workers). */
// `<(x)\b[\s\S]*?<\/\1>` is quadratic on an opener with no closer (every start rescans to the end), and mail decides the input:
//  the same blocks dropped in one pass with indexOf; a block with no closer stays, as the regex left it.
function dropTagBlocks(s, names) {
  s = String(s ?? ""); const lower = s.toLowerCase(), re = new RegExp("<(" + names + ")\\b", "gi"), dead = new Set(); let out = "", at = 0, m;
  while ((m = re.exec(s))) { const n = m[1].toLowerCase(); if (dead.has(n)) continue; const k = lower.indexOf("</" + n + ">", m.index + m[0].length); if (k < 0) { dead.add(n); continue; } out += s.slice(at, m.index) + " "; at = k + n.length + 3; re.lastIndex = at; }
  return at ? out + s.slice(at) : s;
}
// The words of a mail's HTML as the search index keeps them, and as a search's preview line shows them. The tags went
// but their entities stayed and its comments' contents were read as words: a newsletter built for Outlook opens with
// <!--[if mso]>... <o:PixelsPerInch>96</o:PixelsPerInch>... <![endif]--> and <!--<![endif]-->, which a search for it previewed as
// "&lt;!-- 96 &lt;!-- Join us at...". The page has dropped the comments already (tagSafeMsg); what is left is decoded.
const INDEX_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const indexText = (html) => dropTagBlocks(html || "", "style|script|head|title").replace(/<[^<>]+>/g, " ")
  .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m0, e) => { if (e[0] !== "#") return INDEX_ENT[e.toLowerCase()] ?? m0; const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m0; });
const searchIndex = {
  worker: null, seq: 0, waiting: new Map(), status: { mode: "none", indexed: 0, ready: false, error: null }, lastIndexedAt: 0, pendingRows: new Map(), flushTimer: null,
  start() {
    if (this.worker || typeof Worker === "undefined") return;
    try {
      this.worker = new Worker("/search.worker.js", { type: "module" });
      this.worker.onmessage = (e) => { const { id, ok, result, error } = e.data || {}; const w = this.waiting.get(id); if (!w) return; this.waiting.delete(id); ok ? w.res(result) : w.rej(new Error(error)); };
      this.worker.onerror = (e) => { this.status.error = e.message || "worker error"; this.status.ready = false; };
      this.call("status").then((s) => { Object.assign(this.status, s, { ready: true, error: null }); }).catch((e) => { this.status.error = e.message; this.status.ready = false; });
    } catch (e) { this.status.error = e.message; }
  },
  call(type, payload = {}, timeoutMs = 20000) {
    if (!this.worker) return Promise.reject(new Error("no search worker"));
    const id = ++this.seq;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.worker.postMessage({ id, type, ...payload }); setTimeout(() => { if (this.waiting.delete(id)) rej(new Error("search timeout")); }, timeoutMs); });
  },
  rowFor(t, bodyText) { return { key: t.key, account: t.account === "hub" ? (t.identity || "hub") : t.account, subject: t.subject || "", sender: [t.fromName, t.fromAddr].filter(Boolean).join(" "), recipients: t.to || "", snippet: t.snippet || "", body: bodyText || "", date: t.date || 0 }; },
  queue(rows) { for (const r of rows) this.pendingRows.set(r.key, r); clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flush(), 300); },
  async flush() {
    if (!this.worker || !this.pendingRows.size) return;
    const rows = [...this.pendingRows.values()]; this.pendingRows.clear();
    for (let i = 0; i < rows.length; i += 400) { try { const r = await this.call("upsert", { rows: rows.slice(i, i + 400) }, 60000); this.status.indexed = r.indexed; } catch (e) { this.status.error = e.message; } }
    this.status.ready = !this.status.error;
  },
  indexThreads(threads) { if (!this.worker) return; this.queue(threads.map((t) => this.rowFor(t))); },
  indexBodies(t, messages) { if (!this.worker) return; const text = messages.map((m) => (m.text || indexText(m.html)).replace(/\s+/g, " ")).join("\n").slice(0, 200000); this.queue([this.rowFor(t, text)]); },
  remove(keys) { if (this.worker && keys.length) this.call("remove", { keys }).catch(() => {}); },
  async query(q, opts = {}) { if (!this.worker || !this.status.ready) return null; try { const r = await this.call("search", { q, limit: opts.limit || 200, opts }); return r.rows; } catch (e) { this.status.error = e.message; return null; } },
  async rebuild(threads) { if (!this.worker) return; try { await this.call("clear"); } catch (_) {} this.lastIndexedAt = 0; this.indexThreads(threads); await this.flush(); },
};
