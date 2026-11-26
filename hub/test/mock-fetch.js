// Browser-side fake network shared by the jsdom smoke test (test/smoke.cjs) and the screenshot preview (test/preview.py).
// Installs window.fetch; every call is recorded in window.__mock.calls, every unmocked route in window.__mock.errors.
(function () {
  const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hubThreads = [{ id: "11111111-1111-1111-1111-111111111111", subject_norm: "hello", participants: "[]", last_message_at: "2026-09-10T03:00:00Z", message_count: 2, state: "inbox", starred: 0, unread: 1, labels: "[]", has_att: 1, last: { id: "m1", direction: "in", from_addr: "bob@example.com", from_name: "Bob", identity: "sam@yourdomain.example", subject: "Hello there", snippet: "hi", created_at: "2026-09-10T03:00:00Z", message_id: "<abc@example.com>", to_addrs: '[{"address":"sam@yourdomain.example"}]' } },
    { id: "22222222-2222-2222-2222-222222222222", subject_norm: "news", participants: "[]", last_message_at: "2026-09-09T03:00:00Z", message_count: 1, state: "inbox", starred: 0, unread: 0, labels: '["trademark-scam"]', last: { id: "m2", direction: "in", from_addr: "noreply@news.example", from_name: "News", identity: "sam@domain2.example", subject: "Weekly", snippet: "news", created_at: "2026-09-09T03:00:00Z", message_id: "<n1@news.example>", to_addrs: "[]" } },
    { id: "33333333-3333-3333-3333-333333333333", subject_norm: "quote", participants: "[]", last_message_at: "2026-09-08T15:20:00Z", message_count: 4, state: "inbox", starred: 1, unread: 0, labels: "[]", last: { id: "m3", direction: "out", from_addr: "sam@yourdomain.example", from_name: "Sam", identity: "sam@yourdomain.example", subject: "Re: FW: Powerparts Power Product Inquiry Submission - Sherit Labs LLC", snippet: "Hi Perry, thanks for getting back to me so quickly, and for confirming the PN-12028/A is the full SMD part.", created_at: "2026-09-08T15:20:00Z", message_id: "<q3@yourdomain.example>", to_addrs: '[{"address":"perry@powerparts.example"}]' } },
    { id: "44444444-4444-4444-4444-444444444444", subject_norm: "ti", participants: "[]", last_message_at: "2026-09-08T09:05:00Z", message_count: 1, state: "inbox", starred: 0, unread: 1, labels: "[]", last: { id: "m4", direction: "in", from_addr: "no-reply@e2e.ti.example", from_name: "TI E2E support forums", identity: "sam@yourdomain.example", subject: "Answer Suggested: PN-2040: test data at the rated voltage, and lead time for 50 pcs", snippet: "A message from the TI E2E design support forums. Dear E2E user: per the ongoing discussion, an answer was suggested.", created_at: "2026-09-08T09:05:00Z", message_id: "<t4@ti.example>", to_addrs: "[]", list_unsubscribe: "<https://e2e.ti.example/unsub/abc>", list_unsubscribe_post: "List-Unsubscribe=One-Click" } }];
  const gThread = (id, mid, from, subj, labels, extraHeaders = []) => ({ id, messages: [{ id: mid, threadId: id, labelIds: labels, internalDate: String(Date.now() - 3600e3), snippet: "snippet " + subj, payload: { headers: [{ name: "From", value: from }, { name: "To", value: "sam.owner.sxsw@gmail.com" }, { name: "Subject", value: subj }, { name: "Date", value: new Date().toUTCString() }, { name: "Message-ID", value: "<" + mid + "@mail.gmail.com>" }, ...extraHeaders], mimeType: "text/plain", body: { data: b64u("hello body") } } }] });
  const routes = {
    // One request answering what the seven below answer. The individual routes stay mocked because the client must still be
    // able to fall back to them per-field: the fallback is the whole reason this is safe to ship.
    "GET /api/bootstrap": {
      me: { identities: [{ email: "sam@yourdomain.example", display_name: "Sam", domain: "yourdomain.example" }], forward_to: "x" },
      gmail: { accounts: [{ email: "sam.owner.sxsw@gmail.com", status: "active", label: "SXSW", color: "#aa3366" }], configured: true },
      prefs: { prefs: {} },
      push: { configured: true, public_key: "BOi0zEjJUxy-FlaD-Tjvc9j-7WYOi24uyeNGz64r0xzaXthK_-R3ne-owXDQ16m3J5aT9fdEn92Ew0KqBZnJtsw" },
      rules: { rules: [{ id: "r1", pattern: "vip@example.com", action: "priority", scope: "*" }] },
      schedule: { actions: [] },
      senders: { senders: [], counts: {} },
      version: "test",
    },
    "GET /api/me": { identities: [{ email: "sam@yourdomain.example", display_name: "Sam", domain: "yourdomain.example" }], forward_to: "x" },
    "GET /api/imgdims?": { seq: 0, days: {}, more: false },
    "GET /api/img?": { __status: 204 },
    "GET /api/fontcss?": { __text: "/* not kept */" },   // a mail's font stylesheet as the hub kept it; __text: answered as written // the app's own warm-ups of pictures; a frame's <img> never comes through fetch // picture sizes; test/imgdims.py fills its own
    "GET /api/trackers?": { seq: 0, rows: [], more: false },   // the hub's blocks beyond the named list; test/trackers.mjs fills its own
    "GET /api/trackers/status": { learner: { mode: "watch", since: "2026-11-10T00:00:00.000Z" }, on_at: "2026-11-24T00:00:00.000Z", rules: [], recent: [], lists: [], day: { blocked: 0, slipped: 0 } },
    "GET /api/gmail/accounts": { accounts: [{ email: "sam.owner.sxsw@gmail.com", status: "active", label: "SXSW", color: "#aa3366" }], configured: true },
    "GET /api/prefs": { prefs: {} }, "GET /api/push/config": { configured: true, public_key: "BOi0zEjJUxy-FlaD-Tjvc9j-7WYOi24uyeNGz64r0xzaXthK_-R3ne-owXDQ16m3J5aT9fdEn92Ew0KqBZnJtsw" },
    "GET /api/sender-rules": { rules: [{ id: "r1", pattern: "vip@example.com", action: "priority", scope: "*" }] }, "GET /api/quiet-rules": { rules: [] }, "GET /api/trash-rules": { rules: [] }, "GET /api/mention-rules": { rules: [], recent: [] }, "POST /api/mention-rules/check": { results: [] }, "GET /api/locks": { locks: [] }, "GET /api/schedule?status=pending": { actions: [] },
    "GET /api/threads?limit=200&box=inbox": { threads: hubThreads }, "GET /api/threads?limit=500&box=all": { threads: hubThreads, cursor: 7 }, "GET /api/threads?limit=500&box=trash": { threads: [], cursor: 7 }, "GET /api/threads?limit=500&since_seq=7": { threads: [], cursor: 7, deleted: [], more: false }, "GET gmail:profile": { historyId: "100", messagesTotal: 3, emailAddress: "sam.owner.sxsw@gmail.com" }, "GET gmail:messages?": { messages: [{ id: "gm1", threadId: "g1" }, { id: "gm2", threadId: "g2" }, { id: "gm3", threadId: "g3" }], resultSizeEstimate: 3 }, "GET gmail:history?": { history: [], historyId: "100" }, "POST /api/perf": { ok: true, device: "web" }, "GET /api/version": { version: "test" },
    "GET /api/threads/22222222-2222-2222-2222-222222222222": { thread: { id: "2222", state: "inbox", starred: 0, unread: 0, labels: "[]" }, messages: [{ id: "m2", direction: "in", from_addr: "noreply@news.example", from_name: "News", identity: "sam@domain2.example", to_addrs: [], cc_addrs: [], subject: "Weekly", body_text: "news body", body_html: "", created_at: "2026-09-09T03:00:00Z", attachments: [], message_id: "<n1@news.example>", labels: "[]" }] },
    "GET /api/threads/11111111-1111-1111-1111-111111111111": { thread: { id: "1111", state: "inbox", starred: 0, unread: 1, labels: "[]" }, messages: [{ id: "m1", direction: "in", from_addr: "bob@example.com", from_name: "Bob", identity: "sam@yourdomain.example", to_addrs: [{ address: "sam@yourdomain.example" }], cc_addrs: [], subject: "Hello there", body_text: "hi there", body_html: "<p>hi <img src='https://x/y.png'></p>", created_at: "2026-09-10T03:00:00Z", attachments: [{ id: "a1", filename: "f.pdf", size_bytes: 1000 }], message_id: "<abc@example.com>", labels: "[]" }] },
    "GET /api/threads/33333333-3333-3333-3333-333333333333": { thread: { id: "3333", state: "inbox", starred: 1, unread: 0, labels: "[]" }, messages: [{ id: "m3a", direction: "in", from_addr: "perry@powerparts.example", from_name: "Perry", identity: "sam@yourdomain.example", to_addrs: [{ address: "sam@yourdomain.example" }], cc_addrs: [], subject: "FW: Powerparts Power Product Inquiry Submission - Sherit Labs LLC", body_text: "Hi Sam,\n\nConfirming the PN-12028/A is the full SMD part. Lead time is 16 weeks.\n\nPerry", body_html: "", created_at: "2026-09-08T14:00:00Z", attachments: [], message_id: "<q3a@powerparts.example>", labels: "[]" }, { id: "m3", direction: "out", from_addr: "sam@yourdomain.example", from_name: "Sam", identity: "sam@yourdomain.example", to_addrs: [{ address: "perry@powerparts.example" }], cc_addrs: [], subject: "Re: FW: Powerparts Power Product Inquiry Submission - Sherit Labs LLC", body_text: "Hi Perry,\n\nThanks for getting back to me so quickly. Please quote 50 pieces.\n\nSam", body_html: "", created_at: "2026-09-08T15:20:00Z", attachments: [], message_id: "<q3@yourdomain.example>", labels: "[]" }] },
    "GET /api/threads/44444444-4444-4444-4444-444444444444": { thread: { id: "4444", state: "inbox", starred: 0, unread: 1, labels: "[]" }, messages: [{ id: "m4", direction: "in", from_addr: "no-reply@e2e.ti.example", from_name: "TI E2E support forums", identity: "sam@yourdomain.example", to_addrs: [], cc_addrs: [], subject: "Answer Suggested: PN-2040", body_text: "", body_html: "<div style='font-family:Arial'><h2>An answer was suggested</h2><p>Per the ongoing discussion on E2E, an answer was suggested to your question about test data.</p><p><a href='https://e2e.ti.example/x'>View the thread</a></p></div>", created_at: "2026-09-08T09:05:00Z", attachments: [], message_id: "<t4@ti.example>", labels: "[]" }] },
    "POST /api/gmail/accounts/sam.owner.sxsw%40gmail.com/token": { access_token: "tok", expires_at: new Date(Date.now() + 3600e3).toISOString(), expires_in: 3600 },
    "GET gmail:threads?maxResults=60&labelIds=INBOX": { threads: [{ id: "g1" }, { id: "g2" }, { id: "g3" }] },
    "GET gmail:messages?maxResults=200&q=newer_than%3A2d": { messages: [{ id: "gm1", threadId: "g1" }, { id: "gm2", threadId: "g2" }, { id: "gm3", threadId: "g3" }, { id: "gmgap", threadId: "ggap" }], nextPageToken: "r2" }, "GET gmail:messages?maxResults=200&q=newer_than%3A2d&pageToken=r2": { messages: [{ id: "gmgap2", threadId: "ggap2" }] }, "GET gmail:messages/gmgap2?": gThread("ggap2", "gmgap2", "Second Page <p2@example.com>", "From the second page", ["INBOX"]).messages[0], "GET gmail:threads/ggap2?": gThread("ggap2", "gmgap2", "Second Page <p2@example.com>", "From the second page", ["INBOX"]), "POST gmail:threads/ggap2/modify": {}, "GET gmail:messages/gmgap?": gThread("ggap", "gmgap", "Gap Sender <gap@example.com>", "History never reported me", ["INBOX"]).messages[0], "GET gmail:threads/ggap?": gThread("ggap", "gmgap", "Gap Sender <gap@example.com>", "History never reported me", ["INBOX"]), "POST gmail:threads/ggap/modify": {},
    "GET gmail:messages?maxResults=40&q=hello": { messages: [{ id: "gm1", threadId: "g1" }, { id: "gm2", threadId: "g2" }, { id: "gm2b", threadId: "g2" }], nextPageToken: "p2" }, "GET gmail:messages?maxResults=60&q=hello&pageToken=p2": { messages: [{ id: "gm3", threadId: "g3" }, { id: "gm9", threadId: "g9" }, { id: "gm10", threadId: "g10" }] }, "GET gmail:messages/gm9?": gThread("g9", "gm9", "Old Friend <old@example.com>", "Hello from 2023", ["CATEGORY_PROMOTIONS"]).messages[0],
    // two threads the local window never synced: one is opened from the search results, one is selected and acted on there
    "GET gmail:threads/g9?": gThread("g9", "gm9", "Old Friend <old@example.com>", "Hello from 2023", ["CATEGORY_PROMOTIONS"]),
    "GET gmail:messages/gm10?": gThread("g10", "gm10", "Older Friend <older@example.com>", "Hello from 2022", ["CATEGORY_PROMOTIONS"]).messages[0],
    "GET gmail:threads/g10?": gThread("g10", "gm10", "Older Friend <older@example.com>", "Hello from 2022", ["CATEGORY_PROMOTIONS"]), "POST gmail:threads/g10/modify": {}, "POST gmail:threads/g9/modify": {}, "GET /api/threads?limit=200&box=all&q=hello": { threads: hubThreads.slice(0, 1) },
    "GET gmail:threads/g1?": gThread("g1", "gm1", "Alice <alice@example.com>", "Personal note", ["INBOX", "UNREAD"]),
    "GET gmail:threads/g2?": gThread("g2", "gm2", "Shop <noreply@shop.example>", "Your order", ["INBOX", "CATEGORY_UPDATES"]),
    "GET gmail:threads/g3?": gThread("g3", "gm3", "News <news@list.example>", "Weekly digest", ["INBOX", "CATEGORY_PROMOTIONS"], [{ name: "List-Unsubscribe", value: "<mailto:u@x>" }]),
    "GET gmail:messages/gm1?": gThread("g1", "gm1", "Alice <alice@example.com>", "Personal note", ["INBOX", "UNREAD"]).messages[0],
    "GET gmail:messages/gm2?": gThread("g2", "gm2", "Shop <noreply@shop.example>", "Your order", ["INBOX", "CATEGORY_UPDATES"]).messages[0],
    "GET gmail:messages/gm3?": gThread("g3", "gm3", "News <news@list.example>", "Weekly digest", ["INBOX", "CATEGORY_PROMOTIONS"], [{ name: "List-Unsubscribe", value: "<mailto:u@x>" }]).messages[0],
    "PATCH /api/threads/11111111-1111-1111-1111-111111111111": { thread: { id: "1111", state: "archived" } }, "PATCH /api/threads/33333333-3333-3333-3333-333333333333": { thread: { id: "3333" } }, "PATCH /api/threads/44444444-4444-4444-4444-444444444444": { thread: { id: "4444" } },
    "POST gmail:threads/g2/modify": {}, "POST gmail:threads/g1/modify": {}, "POST gmail:threads/g3/modify": {}, "POST gmail:threads/g1/trash": {}, "POST gmail:threads/g2/trash": {}, "POST gmail:threads/g3/trash": {}, "POST gmail:threads/g1/untrash": {}, "POST gmail:threads/g2/untrash": {}, "POST gmail:threads/g3/untrash": {}, "POST gmail:messages/send": { id: "sent1", threadId: "g1" }, "POST /api/send": { id: "h1", thread_id: "t1", message_id: "<x@y>" }, "POST /api/schedule": { ok: true, id: "s1" }, "POST /api/sender-rules": { ok: true, rule: { id: "r2", pattern: "x", action: "block", scope: "*" } },
    "GET /api/push/subscriptions": { subscriptions: [] }, "POST /api/push/subscribe": { ok: true, id: "sub-1" }, "DELETE /api/push/subscribe": { ok: true, removed: 1 }, "PUT /api/prefs": { ok: true }, "GET /api/senders?status=pending": { senders: [{ address: "alice@example.com", status: "pending" }] }, "POST /api/senders/bootstrap": { ok: true }, "POST /api/senders": { ok: true }, "GET gmail:labels": { labels: [] }, "POST gmail:labels": { id: "Label_1", name: "Snoozed (Mail)" }, "GET /api/revisit": { items: [] }, "POST gmail:messages/batchModify": {}, "POST /api/threads/bulk": { changed: 2, missing: [], imap_ops: 0 }, "GET /api/unsubscribes": { unsubscribes: [] }, "POST /api/unsubscribe/job": { ok: true },
  };
  // the domains that have written to the user, for the impostor banner
  routes["GET /api/senders/orgs"] = { orgs: ["example.com", "shop.example", "list.example"] };
  // recipient suggestions: the hub's address book, and Google's two contact searches (only reached for a token carrying the contacts scope)
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  routes["GET /api/contacts"] = { sent: [{ addr: "robin@family.example", name: "Robin Owner", n: 9, last: ago(2) }, { addr: "perry@powerparts.example", name: "Perry Mason", n: 3, last: ago(20) }],
    received: [{ addr: "no-reply@e2e.ti.example", name: "TI", n: 5, last: ago(1) }, { addr: "robert@old.example", name: "Robert Old", n: 1, last: ago(400) }] };
  const person = (name, addr) => ({ person: { names: [{ displayName: name }], emailAddresses: [{ value: addr }] } });
  routes["GET /v1/otherContacts:search?"] = { results: [person("Tom Taxfirm CPA", "tom@taxfirm.example")] };
  routes["GET /v1/people:searchContacts?"] = { results: [person("Tom Taxfirm CPA", "tom@taxfirm.example"), person("Diane Saved", "diane@saved.example")] };
  const calls = [], errors = [];
  const D = { rows: new Map(), seq: 0, files: new Map(), puts: [], fail: false };
  const res = (status, body) => ({ ok: status < 300, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body), headers: new Map() });
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
  D.put = (id, b) => { const cur = D.rows.get(id); const row = { id, rev: (cur ? cur.rev : 0) + 1, seq: ++D.seq, kind: b.kind || "new", thread_key: b.thread_key || null, from: b.from || "", to: b.to || "", subject: b.subject || "", snippet: b.snippet || "", n_files: b.n_files || 0, device: b.device || "", deleted: false, gone_hash: null, created_at: cur?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(), content: JSON.parse(JSON.stringify(b.content)) }; D.rows.set(id, row); return row; };
  async function mockDrafts(m, o) {
    const [, method, id, files, fid, qs] = m; const q = new URLSearchParams((qs || "").slice(1)); const since = q.get("since");
    if (D.fail) return res(503, { error: "the hub is unreachable (test)" });
    if (method === "GET" && !id) { const s = Number(since || 0); const rows = [...D.rows.values()].filter((r) => (s ? r.seq > s : !r.deleted)).sort((a, b) => a.seq - b.seq); return res(200, { drafts: rows, cursor: D.seq, full: !s, more: false }); }
    if (method === "PUT" && id && !files) {
      const b = JSON.parse(o.body || "{}"); D.puts.push({ id, base: b.base_rev, text: b.content?.text }); const cur = D.rows.get(id);
      if (cur ? cur.rev !== (b.base_rev || 0) : (b.base_rev || 0) !== 0) return res(409, { error: "conflict", current: cur || null });
      const row = D.put(id, b); if (Array.isArray(b.file_ids)) for (const [k, f] of D.files) if (f.draft === id && !b.file_ids.includes(k)) D.files.delete(k);
      return res(200, { id, rev: row.rev, seq: row.seq, updated_at: row.updated_at });
    }
    if (method === "DELETE" && id) {   // as the hub: ?rev=N deletes only revision N; the tombstone keeps the SHA-256 of the content it replaced
      const cur = D.rows.get(id); D.deletes = (D.deletes || 0) + 1;
      if (!cur || cur.deleted) return res(200, { ok: true, deleted: 0 });
      if (q.has("rev") && Number(q.get("rev")) !== cur.rev) return res(409, { error: "conflict", current: cur });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(cur.content))))].map((b) => b.toString(16).padStart(2, "0")).join("");
      Object.assign(cur, { deleted: true, rev: cur.rev + 1, seq: ++D.seq, content: null, snippet: null, n_files: 0, gone_hash: hash, updated_at: new Date().toISOString() }); for (const [k, f] of D.files) if (f.draft === id) D.files.delete(k); return res(200, { ok: true, deleted: 1 });
    }
    if (method === "POST" && files && !fid) { const blob = o.body; const name = decodeURIComponent((o.headers || {})["x-file-name"] || "file"); const f = { id: uid(), name, type: (o.headers || {})["content-type"] || "", size: blob.size }; D.files.set(f.id, { ...f, draft: id, blob }); return res(200, f); }
    if (method === "GET" && fid) { if (D.fileDelay) await new Promise((r) => setTimeout(r, D.fileDelay)); const f = D.files.get(fid); if (!f || f.draft !== id) return res(404, { error: "not found" }); return { ok: true, status: 200, blob: async () => f.blob, arrayBuffer: async () => f.blob.arrayBuffer(), headers: new Map() }; }
    return res(404, { error: "no such drafts route" });
  }
  window.__mock = { routes, calls, errors, hubThreads, failNext: null, drafts: D, hold: {} }; // failNext = { match: /regex on "METHOD key"/, status, body } consumed once; hold = { "METHOD key": a promise the answer waits for }
  if (typeof window.__mockSetup === "function") window.__mockSetup(window.__mock);   // a test adds its own threads and routes before the app boots
  const realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;   // static files pass through to the test server
  window.fetch = async (url, o = {}) => {
    if (realFetch && /^\/pdf(\.worker)?\.min\.mjs$/.test(String(url).replace(/^https?:\/\/[^/]+/, ""))) return realFetch(url, o);   // the PDF viewer's own code
    url = String(url); const method = (o.method || "GET").toUpperCase(); let key;
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/")) key = `${method} gmail:` + url.slice("https://gmail.googleapis.com/gmail/v1/users/me/".length);
    else key = `${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`;
    calls.push(key);
    const held = window.__mock.hold && window.__mock.hold[key]; if (held) await held;   // a test holding an answer back, to see what draws without it
    const fn = window.__mock.failNext; if (fn && fn.match.test(key)) { window.__mock.failNext = null; return { ok: false, status: fn.status, json: async () => fn.body || { error: "injected" }, text: async () => JSON.stringify(fn.body || { error: "injected" }), headers: new Map() }; }
    // Drafts: a small hub of their own, with the real one's rules; revisions, a 409 carrying the current draft, tombstones
    // on the cursor, files kept apart. window.__mock.drafts is that hub's table, for a test to read, or to change as another device would.
    const dm = /^(GET|PUT|DELETE|POST) \/api\/drafts(?:\/([0-9a-f-]{36}))?(\/files(?:\/([0-9a-f-]{36}))?)?(\?.*)?$/.exec(key);
    if (dm) return mockDrafts(dm, o);
    // Settings' one request, put together at the moment it is asked from the routes it stands for, as the hub does, so a
    // test that changes one of them sees it in Settings.
    if (key === "GET /api/settings") {
      const parts = { push: "/api/push/subscriptions", quiet: "/api/quiet-rules", trash: "/api/trash-rules", locks: "/api/locks", mention: "/api/mention-rules", trackers: "/api/trackers/status", unsubs: "/api/unsubscribes" }, out = {};
      for (const [k, p] of Object.entries(parts)) { const h = routes["GET " + p]; if (h === undefined) { errors.push("UNMOCKED GET " + p); out[k] = { __error: "unmocked" }; } else out[k] = h && h.__status ? { __error: String(h.__status) } : h; }
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(out)), text: async () => JSON.stringify(out), headers: new Map() };
    }
    let hit = routes[key]; if (!hit) { const k2 = Object.keys(routes).find((k) => k.endsWith("?") && key.startsWith(k)); if (k2) hit = routes[k2]; }
    if (!hit && /[?&]keep_unread=1$/.test(key)) hit = routes[key.replace(/[?&]keep_unread=1$/, "")];   // the client reads without marking read
    if (!hit) { if (!/batch\/gmail/.test(key)) errors.push("UNMOCKED " + key); return { ok: false, status: 404, json: async () => ({ error: "unmocked " + key }), text: async () => "", headers: new Map() }; }
    if (hit && hit.__b64 !== undefined) { const bin = atob(hit.__b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return { ok: true, status: 200, arrayBuffer: async () => u8.buffer.slice(0), text: async () => bin, json: async () => { throw new Error("not JSON"); }, headers: new Map() }; } // raw bytes (attachments)
    if (hit && hit.__status) return { ok: false, status: hit.__status, json: async () => JSON.parse(JSON.stringify(hit)), text: async () => JSON.stringify(hit), headers: new Map() }; // a route that answers with an error status
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(hit)), text: async () => (hit && typeof hit.__text === "string" ? hit.__text : JSON.stringify(hit)), headers: new Map(),
      arrayBuffer: async () => (hit && typeof hit.__b64 === "string" ? Uint8Array.from(atob(hit.__b64), (c) => c.charCodeAt(0)).buffer : new TextEncoder().encode(JSON.stringify(hit)).buffer) };   // __b64: a file's bytes
  };
})();
// Test-only: how a test waits until the page is quiet instead of for a fixed time. Counted here, before app.js
// runs: timers and when they are due, idle callbacks, requests in flight, open IndexedDB transactions, workers' traffic.
// window.__settle(ms) resolves once no timer is due inside the next ms, nothing else is pending, no finite animation is running and
// two frames have been drawn; or when ms has passed, whichever comes first. So a wait still means what it meant (everything due in
// that window has happened); it only ends sooner when the page goes quiet sooner. Callbacks are never wrapped (a test may tell its
// timers apart by the function, as bootsync.py does by name): a timer counts until it is due, plus a 50 ms grace for a busy thread.
(() => {
  const due = new Map(), st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window); let busy = 0; const workers = [];
  window.setTimeout = (fn, ms, ...a) => { const id = st(fn, ms, ...a); due.set(id, performance.now() + (+ms || 0)); return id; };
  window.clearTimeout = (id) => { due.delete(id); ct(id); };
  let idle = 0;
  if (window.requestIdleCallback) { const ric = window.requestIdleCallback.bind(window), cic = window.cancelIdleCallback.bind(window), live = new Set();
    window.requestIdleCallback = (fn, o) => { const id = ric((d) => { live.delete(id); idle = live.size; fn(d); }, o); live.add(id); idle = live.size; return id; };
    window.cancelIdleCallback = (id) => { live.delete(id); idle = live.size; cic(id); }; }
  const f = window.fetch; window.fetch = async (...a) => { busy++; try { return await f(...a); } finally { busy--; } };
  if (window.IDBDatabase) { const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...a) { const t = tx.apply(this, a); busy++; let done = false; const end = () => { if (!done) { done = true; busy--; } };
      t.addEventListener("complete", end); t.addEventListener("abort", end); t.addEventListener("error", end); return t; }; }
  if (window.Worker) { const W = window.Worker;   // a worker is busy while a message to it is unanswered, or for 60 ms after any traffic
    window.Worker = function (...a) { const w = new W(...a), s = { out: 0, last: performance.now() }; workers.push(s);
      const pm = w.postMessage.bind(w); w.postMessage = (...m) => { s.out++; s.last = performance.now(); return pm(...m); };
      w.addEventListener("message", () => { s.out = Math.max(0, s.out - 1); s.last = performance.now(); }); return w; };
    window.Worker.prototype = W.prototype; }
  const blocker = (end) => { const now = performance.now();
    if (busy > 0) return "request or IndexedDB"; if (idle > 0) return "idle callback";
    for (const [id, at] of due) { if (at + 50 < now) { due.delete(id); continue; } if (at <= end) return "timer due in " + Math.round(at - now) + " ms"; }
    for (const w of workers) if (w.out > 0 || now - w.last < 60) return "worker";
    if (document.getAnimations && document.getAnimations().some((x) => x.playState === "running" && x.effect && x.effect.getComputedTiming().endTime !== Infinity)) return "animation";
    return ""; };
  window.__quietWhy = (ms = 1000) => blocker(performance.now() + ms) || "quiet";
  window.__settle = (ms) => new Promise((resolve) => { const end = performance.now() + ms; let frames = 0, out = false, last = "";
    const fin = (why) => { if (!out) { out = true; resolve(why); } };
    st(() => fin("cap: " + (last || "frames")), ms);
    const tick = () => { if (out) return; if (performance.now() >= end) return fin("cap: " + (last || "frames")); const b = blocker(end); last = b || last; frames = b ? 0 : frames + 1;
      if (frames >= 2) return fin("quiet"); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); });
})();
