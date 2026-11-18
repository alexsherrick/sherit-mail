/* sync.js: fills and keeps the local store current (and 4).
   Gmail: a one-time throttled fill of the sync window (messages.list newer_than + messages.get format=metadata in batches),
   then history.list deltas from a stored historyId. Hub: the thread list (all boxes). Nothing here fetches bodies. */
const SYNC = { hubMax: 5000, windowDays: 90, batch: 20, perMinute: 120, listPage: 500, hubFullMs: 24 * 60 * 60_000, hubFullDeferMs: 30_000, mirrorPage: 1000, META: "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence&metadataHeaders=Auto-Submitted&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=List-Unsubscribe-Post" };
const syncState = { running: new Set(), progress: {} };            // progress[email] = { phase, done, total, note }
// Gmail's snippet is HTML-escaped. &lt; and &gt; were left in until 2026-10-05, so a preview read "Q&A &lt;&gt; Exampleco Space";
// &amp; goes last, so an escaped "&amp;lt;" (a literal "&lt;" in the mail) is decoded once, not twice.
const gmailSnippet = (s) => String(s || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function msgMetaFromGmail(email, m) {
  const h = hmap(m); const from = h.from || ""; const labels = m.labelIds || []; const out = labels.includes("SENT");
  const hasAtt = !!(m.payload && (m.payload.parts || []).some((p) => p.filename)) || /multipart\/mixed/i.test(m.payload?.mimeType || "");
  return { key: `${email}|${m.id}`, threadKey: `${email}|${m.threadId}`, account: email, id: m.id, threadId: m.threadId, from, fromAddr: out ? email : addrOf(from), fromName: out ? "You" : nameOf(from), to: h.to || "", cc: h.cc || "", subject: h.subject || "", date: Number(m.internalDate) || Date.parse(h.date) || 0, snippet: gmailSnippet(m.snippet), labels, cat: categorize({ headers: h, from, labels }), msgIdHdr: (h["message-id"] || "").replace(/^<|>$/g, ""), inReplyTo: h["in-reply-to"] || "", refs: h.references || "", hasAtt, size: m.sizeEstimate || 0, unsub: h["list-unsubscribe"] || "", unsubPost: h["list-unsubscribe-post"] || "" };
}
const cooldownWait = async (email) => { for (let i = 0; i < 40 && cooldownLeft(email); i++) await sleep(Math.min(cooldownLeft(email), 5000)); };
// Fetch a chunk, apply what arrived, and FAIL (retryably) if anything is missing: progress markers must never advance past a hole.
// fetchChunk wraps it: a message that is gone for good (404 on its own) is dropped and its thread rebuilt; anything else still fails
// the chunk so it is retried. Without this one vanished message poisoned every later sync (the cursor never advanced): 2026-09-10.
async function fetchChunk(email, chunk, threadOf = new Map(), touched = new Set()) {
  try { return await applyBatch(email, chunk, SYNC.META); }
  catch (e) {
    if (!e.partial) throw e;
    for (const id of e.missing) {
      try { const m = await gapi(email, `messages/${id}?${SYNC.META}`); await applyGmailMessages(email, [m]); }
      catch (e2) { if (e2?.status !== 404) throw e2; await idb.del("messages", `${email}|${id}`); const th = threadOf.get(id); if (th) touched.add(`${email}|${th}`); await logSync(email, `message ${id} is gone (404); dropped`); }
    }
    return [];
  }
}
async function applyBatch(email, chunk, fields) {
  const msgs = await gmailBatchGet(email, chunk, fields); await applyGmailMessages(email, msgs);
  const got = new Set(msgs.map((m) => m.id)); const missing = chunk.filter((id) => !got.has(id));
  if (missing.length) throw Object.assign(new Error(`${missing.length} of ${chunk.length} messages could not be fetched; the sync retries from here`), { partial: true, missing });
  return msgs;
}
async function gmailBatchGet(email, ids, fields) { // batch calls are reads, however they are posted: they take the GET deadline (netSignal)
  // Gmail batch endpoint: one HTTP call, N sub-requests (quota is charged per sub-request). Falls back to parallel singles.
  if (!ids.length) return []; await cooldownWait(email);
  const at = await gtoken(email); const boundary = "mh_batch_" + Math.random().toString(36).slice(2);
  const body = ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${fields}\r\n\r\n`).join("") + `--${boundary}--\r\n`;
  try {
    const r = await fetch("https://gmail.googleapis.com/batch/gmail/v1", { method: "POST", signal: netSignal({ method: "GET" }), headers: { authorization: "Bearer " + at, "content-type": `multipart/mixed; boundary=${boundary}` }, body });
    perf.netCall("gmail batch", 0);
    if (!r.ok) throw new Error("batch http " + r.status);
    const ct = r.headers.get("content-type") || ""; const bm = ct.match(/boundary=([^;]+)/); const text = await r.text();
    const parts = text.split("--" + (bm ? bm[1].replace(/"/g, "") : boundary)).slice(1, -1);
    const out = []; let throttled = 0;
    for (const p of parts) { const j = p.indexOf("{"); if (j < 0) continue; try { const obj = JSON.parse(p.slice(j, p.lastIndexOf("}") + 1)); if (obj.id) out.push(obj); else if (obj.error?.code === 429) throttled++; } catch (_) {} }
    if (!out.length && !throttled) throw new Error("batch parse");
    const got = new Set(out.map((m) => m.id)); const missing = ids.filter((id) => !got.has(id));
    if (missing.length) { // Google rejects some sub-requests with "Too many concurrent requests"; wait, then fetch the rest in a smaller batch
      await sleep(1200); const again = await gmailBatchGetRetry(email, missing, fields); out.push(...again);
    }
    return out;
  } catch (e) {
    const out = []; for (let i = 0; i < ids.length; i += 8) { await cooldownWait(email); out.push(...(await Promise.all(ids.slice(i, i + 8).map((id) => gapi(email, `messages/${id}?${fields}`).catch(() => null)))).filter(Boolean)); }
    return out;
  }
}
async function gmailBatchGetRetry(email, ids, fields) {
  const out = []; for (let i = 0; i < ids.length; i += 10) { const chunk = ids.slice(i, i + 10); const at = await gtoken(email); const boundary = "mh_retry_" + Math.random().toString(36).slice(2);
    const body = chunk.map((id, k) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${k}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${fields}\r\n\r\n`).join("") + `--${boundary}--\r\n`;
    let got = [];
    try { const r = await fetch("https://gmail.googleapis.com/batch/gmail/v1", { method: "POST", signal: netSignal({ method: "GET" }), headers: { authorization: "Bearer " + at, "content-type": `multipart/mixed; boundary=${boundary}` }, body }); perf.netCall("gmail batch", 0); const text = await r.text(); const bm = (r.headers.get("content-type") || "").match(/boundary=([^;]+)/); for (const p of text.split("--" + (bm ? bm[1].replace(/"/g, "") : boundary)).slice(1, -1)) { const j = p.indexOf("{"); if (j < 0) continue; try { const obj = JSON.parse(p.slice(j, p.lastIndexOf("}") + 1)); if (obj.id) got.push(obj); } catch (_) {} } } catch (_) {}
    const have = new Set(got.map((m) => m.id)); const still = chunk.filter((id) => !have.has(id));
    for (const id of still) { await sleep(150); await cooldownWait(email); const m = await gapi(email, `messages/${id}?${fields}`).catch(() => null); if (m) got.push(m); }
    out.push(...got);
  }
  return out;
}
async function applyGmailMessages(email, msgs, { fromDelta = false } = {}) {
  if (!msgs.length) return;
  const metas = msgs.map((m) => msgMetaFromGmail(email, m));
  await idb.putAll("messages", metas);
  const threadKeys = new Set(metas.map((m) => m.threadKey));
  await rebuildGmailThreads(email, [...threadKeys]);
}
async function rebuildGmailThreads(email, threadKeys) {
  const rows = [];
  for (const tk of threadKeys) {
    const msgs = await idb.getByIndex("messages", "threadKey", tk);
    if (!msgs.length) { state.threads.delete(tk); await idb.del("threads", tk); continue; }
    const t = deriveGmailThread(email, tk.split("|")[1], msgs, { snoozed: state.snoozedGmail.has(tk) });
    const cur = state.threads.get(tk);
    if (cur && pendingKeysNow().has(tk)) Object.assign(t, { state: cur.state, unread: cur.unread, starred: cur.starred }); // an unsent local action wins over the server's view
    if (cur && !t.unsub && cur.unsub) { t.unsub = cur.unsub; t.unsubPost = cur.unsubPost || ""; } if (cur && cur.unsubKnown) t.unsubKnown = true; // a header the row already learned (open/prefetch/backfill) survives a rebuild from records that lack it
    if (cur) { Object.assign(cur, t); rows.push(cur); } else { state.threads.set(tk, t); rows.push(t); } // merge in place: references held by rows/pane stay live
  }
  await idb.putAll("threads", rows);
}
function pace(email) { const s = syncState.progress[email] ||= {}; const now = Date.now(); s.window ||= { start: now, n: 0 }; if (now - s.window.start > 60_000) s.window = { start: now, n: 0 }; return s; }
const gmailCooldown = new Map(); // email -> instant until which no background Gmail call is made (set on any 429; the user's own actions get the quota)
const cooldownLeft = (email) => Math.max(0, (gmailCooldown.get(email) || 0) - Date.now());
async function throttleGets(email, n) {
  const s = pace(email);
  for (let i = 0; i < 40; i++) { const cd = cooldownLeft(email); const busy = (typeof queue !== "undefined" && queue.pending && queue.pending().some((r) => r.account === email || r.op === "bulk")); if (!cd && !busy) break; s.note = cd ? `Gmail quota cooldown ${Math.ceil(cd / 1000)} s` : "waiting for your actions to finish"; await sleep(cd ? Math.min(cd, 5000) : 1500); if (cd) s.window = { start: Date.now(), n: 0 }; }
  s.note = ""; if (Date.now() - s.window.start >= 60_000) s.window = { start: Date.now(), n: 0 };
  if (s.window.n + n > SYNC.perMinute) { const wait = 60_000 - (Date.now() - s.window.start) + 500; s.note = `throttled ${Math.round(wait / 1000)} s`; await sleep(Math.max(0, wait)); s.window = { start: Date.now(), n: 0 }; s.note = ""; }
  s.window.n += n; } // the count is checked before the requests go out, so a window never exceeds SYNC.perMinute gets
async function fillGmail(email) {
  const key = `state|${email}`; const st = (await idb.get("state", key)) || { key, account: email };
  const prog = syncState.progress[email] ||= {};
  if (!st.fillStartHistoryId) { const prof = await gapi(email, "profile"); st.fillStartHistoryId = prof.historyId; st.messagesTotal = prof.messagesTotal; await idb.putAll("state", [st]); }
  const q = st.fillAfter ? `after:${Math.floor(st.fillAfter / 1000)}` : `newer_than:${SYNC.windowDays}d`;
  let page = st.fillPageToken || null, listed = st.fillListed || 0;
  prog.phase = "fill"; prog.done = listed; prog.total = st.fillEstimate || null;
  do {
    const l = await gapi(email, `messages?maxResults=${SYNC.listPage}&q=${encodeURIComponent(q)}${page ? "&pageToken=" + page : ""}`);
    const ids = (l.messages || []).map((m) => m.id); if (!prog.total) prog.total = l.resultSizeEstimate || null;
    const known = new Set((await idb.getMany("messages", ids.map((id) => `${email}|${id}`))).filter(Boolean).map((m) => m.id));
    const todo = ids.filter((id) => !known.has(id));
    for (let i = 0; i < todo.length; i += SYNC.batch) {
      const chunk = todo.slice(i, i + SYNC.batch); await throttleGets(email, chunk.length);
      await fetchChunk(email, chunk);
      listed += chunk.length; prog.done = listed; st.fillListed = listed; await idb.putAll("state", [st]);
      if (i % (SYNC.batch * 4) === 0) { render(); snapshot.write([...state.threads.values()]); }
    }
    page = l.nextPageToken || null; st.fillPageToken = page; await idb.putAll("state", [st]);
  } while (page);
  st.filled = true; st.historyId = st.fillStartHistoryId; st.filledAt = Date.now(); st.fillPageToken = null; await idb.putAll("state", [st]);
  prog.phase = "idle"; prog.note = ""; await logSync(email, `filled ${listed} messages`);
}
// A device closed for days used to replay history a page at a time, downloading each page's unknown messages before rebuilding anything,
// and repainted only after the last page (my browser: 188 unread shown against Gmail's 1, three days of changes
// behind the download throttle). Now two passes:
//  1. Every history page is read (2 quota units a page) and applied to the messages this device holds, straight from the records, which
//  carry each message's labels. What it lacks goes on a durable owed list, written with the cursor in one put. Then repaint.
//  2. The owed list is downloaded inbox first, OWED_SLICE per sync so a sync never sleeps on the throttle, repainting per chunk. The
//  caller asks for the next slice a minute later while anything is still owed (app.js scheduleCatchup).
// A message never held that is only leaving (no add record, no INBOX in its latest labels) and is older than the window is not owed:
// the window would not hold it anyway. Its date is read from its id (id >> 20 is never earlier than internalDate: 30 samples, 2015-2026).
const OWED_SLICE = 100;
const gmailIdMs = (id) => parseInt(String(id || "").slice(0, -5), 16) || 0;
async function deltaGmail(email, { onApplied = null } = {}) {
  const key = `state|${email}`; const st = await idb.get("state", key);
  if (!st?.filled || !st.historyId) return fillGmail(email);
  await refreshPending(); // every window's queued actions, so the rebuild guard below protects them all
  const prog = syncState.progress[email] ||= {}; prog.phase = "delta";
  const paint = () => { if (onApplied) { try { onApplied(); } catch (_) {} } };
  const owed = new Map((st.owed || []).map((o) => [o.id, o]));
  const cutoff = Date.now() - SYNC.windowDays * 864e5;
  const notOwed = (o) => !o.a && !(o.l || []).includes("INBOX") && gmailIdMs(o.id) > 0 && gmailIdMs(o.id) < cutoff;
  // One history page at a time, and the cursor is committed after each page: a run that dies mid-way resumes from the last page it
  // finished instead of replaying everything from the old cursor (which re-fetched the same messages every sync): 2026-09-10.
  const startId = st.historyId; let page = null, pages = 0; const totals = { added: 0, removed: 0, touched: 0, owed: 0 };
  try {
    do {
      const r = await gapi(email, `history?startHistoryId=${startId}&maxResults=500${page ? "&pageToken=" + page : ""}`);
      const removed = new Set(), touched = new Set(); let last = null;
      // Every message a label change names is read up front in one transaction and written back in one, instead of a get and a put
      // per change in turn; the loop below still runs in history order over the same records.
      const relabel = new Map(), relabelled = new Set();
      { const keys = [...new Set((r.history || []).flatMap((h) => [...(h.labelsAdded || []), ...(h.labelsRemoved || [])].map((x) => `${email}|${x.message.id}`)))]; const got = await idb.getMany("messages", keys); keys.forEach((k, i) => { if (got[i]) relabel.set(k, got[i]); }); }
      for (const h of r.history || []) {
        last = h.id || last;
        // An added message is always downloaded, as before. Its labels here only order the downloads; they are never applied as state.
        for (const x of h.messagesAdded || []) { const o = owed.get(x.message.id); owed.set(x.message.id, { id: x.message.id, t: x.message.threadId, l: x.message.labelIds || o?.l || [], a: 1 }); }
        for (const x of h.messagesDeleted || []) { removed.add(x.message.id); owed.delete(x.message.id); touched.add(`${email}|${x.message.threadId}`); } // added and deleted anywhere in the range: never downloaded
        for (const x of [...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) {
          const m = relabel.get(`${email}|${x.message.id}`);
          if (m) { m.labels = x.message.labelIds || m.labels; relabelled.add(m); touched.add(m.threadKey); }
          else { const o = owed.get(x.message.id); owed.set(x.message.id, { id: x.message.id, t: x.message.threadId, l: x.message.labelIds || o?.l || [], a: o?.a || 0 }); }
        }
      }
      for (const o of owed.values()) if (notOwed(o)) owed.delete(o.id);
      if (relabelled.size) await idb.putAll("messages", [...relabelled]);   // before the deletions, as each put used to be
      if (removed.size) await idb.delAll("messages", [...removed].map((id) => `${email}|${id}`));
      if (touched.size) await rebuildGmailThreads(email, [...touched]);
      page = r.nextPageToken || null; pages++;
      st.historyId = page ? (last || st.historyId) : (r.historyId || last || st.historyId); st.owed = [...owed.values()]; st.lastSyncAt = Date.now();
      await idb.putAll("state", [st]); // this page is fully applied; the cursor and what it still owes are written together
      totals.removed += removed.size; totals.touched += touched.size;
      // More than one page is a real gap: the account says it is updating until it is current, and a very long gap repaints as it goes.
      if (page && (pages === 1 || pages % 10 === 0)) { prog.behind = true; paint(); }
    } while (page);
  } catch (e) {
    if (/404|not found|Invalid startHistoryId/i.test(e.message)) { await logSync(email, "history expired; dropping the cached window and refilling"); await dropGmailWindow(email); await idb.meta(gmailEdgeKey(email), null); st.filled = false; st.historyId = null; st.fillStartHistoryId = null; st.fillPageToken = null; st.fillListed = 0; st.unreadDone = false; st.owed = null; prog.behind = false; await idb.putAll("state", [st]); return fillGmail(email); }
    throw e;
  }
  // What history reported is applied and durable, so it goes on screen NOW, before any download (New mail should already
  // be on screen at open; 2026-10-07: 188 unread shown for minutes after Gmail had 1).
  const wasBehind = !!prog.behind; prog.behind = owed.size > 0; prog.owed = owed.size; if (totals.touched || wasBehind !== prog.behind) paint();
  if (owed.size) {
    prog.phase = "download";
    const rank = (o) => (o.l || []).includes("INBOX") ? ((o.l || []).includes("UNREAD") ? 0 : 1) : 2;
    const slice = [...owed.values()].sort((x, y) => rank(x) - rank(y) || gmailIdMs(y.id) - gmailIdMs(x.id)).slice(0, OWED_SLICE);
    for (let i = 0; i < slice.length; i += SYNC.batch) {
      const chunk = slice.slice(i, i + SYNC.batch), threadOf = new Map(chunk.map((o) => [o.id, o.t])), touched = new Set();
      await throttleGets(email, chunk.length);
      await fetchChunk(email, chunk.map((o) => o.id), threadOf, touched); // written (or found gone) before the list shrinks
      if (touched.size) await rebuildGmailThreads(email, [...touched]);
      for (const o of chunk) owed.delete(o.id);
      st.owed = [...owed.values()]; await idb.putAll("state", [st]);
      totals.added += chunk.length; totals.touched += chunk.length; prog.owed = owed.size; prog.behind = owed.size > 0; paint();
    }
    if (owed.size) await logSync(email, `catching up: ${owed.size} message(s) still to download`);
  }
  totals.owed = owed.size;
  // The backstops below download what history missed. While anything is owed they wait, so the same messages are not fetched twice. Once
  // the owed list is empty they run as before, in the same sync: they fetch only what the cache lacks, which the drain just filled.
  if (!owed.size) {
    // Gmail's history omits some arrivals (two of 2026-09-10's messages have no history record at all), so every ten
    // minutes the last two days are listed (5 units) and anything the cache lacks is fetched.
    if (Date.now() - (st.reconciledAt || 0) > 10 * 60_000) { try { const r = await reconcileGmail(email); st.reconciledAt = Date.now(); await idb.putAll("state", [st]); if (r.fetched) await logSync(email, `reconcile: ${r.fetched} message(s) history never reported`); } catch (_) {} }
    // Every unread message in the inbox, however old (Every unread message must be loaded into Sherit). The window
    // above is 90 days, and 489 of the 491 unread conversations in sam.owner@gmail.com's inbox were older than that, so Sherit never had
    // them. A slice per sync until none is missing, then a daily re-check; once a message is here, history keeps its labels current.
    if (!st.unreadDone || Date.now() - (st.unreadCheckedAt || 0) > 24 * 3600e3) {
      try { const r = await fillUnread(email); st.unreadDone = r.left === 0; st.unreadCheckedAt = Date.now(); await idb.putAll("state", [st]); if (r.fetched) { totals.touched += r.fetched; await logSync(email, `unread: ${r.fetched} older unread message(s) loaded, ${r.left} to go`); } } catch (_) {}
    }
  }
  prog.phase = "idle";
  return totals;
}
const UNREAD_SLICE = 100; // messages fetched per sync: five batch calls, under SYNC.perMinute, so a refresh never waits on the throttle for this
async function fillUnread(email) {
  const listed = []; let page = null;
  do { const l = await gapi(email, `messages?maxResults=500&q=${encodeURIComponent("in:inbox is:unread")}${page ? "&pageToken=" + encodeURIComponent(page) : ""}`); listed.push(...(l.messages || [])); page = l.nextPageToken || null; } while (page && listed.length < 5000);
  const ids = listed.map((m) => m.id);
  const known = new Set((await idb.getMany("messages", ids.map((id) => `${email}|${id}`))).filter(Boolean).map((m) => m.id));
  const todo = ids.filter((id) => !known.has(id)); const slice = todo.slice(0, UNREAD_SLICE);
  const threadOf = new Map(listed.map((m) => [m.id, m.threadId])); const touched = new Set();
  for (let i = 0; i < slice.length; i += SYNC.batch) { const chunk = slice.slice(i, i + SYNC.batch); await throttleGets(email, chunk.length); await fetchChunk(email, chunk, threadOf, touched); }
  if (touched.size) await rebuildGmailThreads(email, [...touched]);
  return { listed: ids.length, fetched: slice.length, left: todo.length - slice.length };
}
async function reconcileGmail(email) {
  const listed = []; let page = null; for (let i = 0; i < 5; i++) { const l = await gapi(email, `messages?maxResults=200&q=${encodeURIComponent("newer_than:2d")}${page ? "&pageToken=" + encodeURIComponent(page) : ""}`); listed.push(...(l.messages || [])); page = l.nextPageToken || null; if (!page) break; } // up to 1,000 messages (5 units a page)
  const ids = listed.map((m) => m.id);
  const known = new Set((await idb.getMany("messages", ids.map((id) => `${email}|${id}`))).filter(Boolean).map((m) => m.id));
  const todo = ids.filter((id) => !known.has(id)); const threadOf = new Map(listed.map((m) => [m.id, m.threadId])); const touched = new Set();
  for (let i = 0; i < todo.length; i += SYNC.batch) { const chunk = todo.slice(i, i + SYNC.batch); await throttleGets(email, chunk.length); await fetchChunk(email, chunk, threadOf, touched); }
  if (touched.size) await rebuildGmailThreads(email, [...touched]);
  return { listed: ids.length, fetched: todo.length };
}
// How far back this device has listed an account's mail in full: "load older mail" steps back from here. It used to
// step back from the OLDEST conversation the device held, so one old message loaded for any other reason sent it years back: a 2014
// promo loaded on 2026-10-04 while it sat unread in the sxsw inbox made a scroll on 11-10 list September 2014, 369 conversations, 189
// of them never opened. The edge is its own record (meta), so a sync writing the account's state never rolls it back, nor it the
// sync's cursor. Until the first step back it is where the window starts: the fill's time less the window.
const gmailEdgeKey = (email) => "gmailEdge|" + email;
async function gmailEdge(email, st) { const e = await idb.meta(gmailEdgeKey(email)); return Number.isFinite(e) ? e : (st?.filledAt || Date.now()) - SYNC.windowDays * 864e5; }
const EXTEND_STEPS = 12;   // a step that finds only mail this device holds goes on to the next, up to a year of 30-day steps a call
async function extendGmailWindow(email, days = 30) {
  const st = await idb.get("state", `state|${email}`); if (!st?.filled) return;
  const prog = syncState.progress[email] ||= {}; prog.phase = "extend";
  let edge = await gmailEdge(email, st), n = 0;
  try {
    for (let step = 0; step < EXTEND_STEPS && !n; step++) {
      const before = Math.floor(edge / 1000), after = before - days * 86400; let page = null;
      do {
        const l = await gapi(email, `messages?maxResults=${SYNC.listPage}&q=${encodeURIComponent(`after:${after} before:${before}`)}${page ? "&pageToken=" + page : ""}`);
        const ids = (l.messages || []).map((m) => m.id);
        const known = new Set((await idb.getMany("messages", ids.map((id) => `${email}|${id}`))).filter(Boolean).map((m) => m.id));
        const todo = ids.filter((id) => !known.has(id));
        for (let i = 0; i < todo.length; i += SYNC.batch) { const chunk = todo.slice(i, i + SYNC.batch); await throttleGets(email, chunk.length); await applyBatch(email, chunk, SYNC.META); n += chunk.length; }
        page = l.nextPageToken || null;
      } while (page);
      edge = after * 1000; await idb.meta(gmailEdgeKey(email), edge);   // this step is listed to its end: only now does the edge move
    }
  } finally { prog.phase = "idle"; }
  return n;
}
// The hub half of a sync. It used to mirror the WHOLE store on every tick: two paged queries reading 703 D1 rows a minute per open
// window, which was essentially all of this account's database traffic. Now it asks
// only for what changed since its cursor (1 row read when nothing has) and re-mirrors in full every SYNC.hubFullMs, which is what
// not as the repair path: the change feed is exact, so the mirror only has to catch something the feed itself got wrong.
// hubFullMs was one hour, so every hour this abandoned the delta and re-fetched the ENTIRE store: boxes "all" and "trash",
// 500 rows a page, up to hubMax 5,000, which is the refresh:total p95 of 2,848 ms measured on the phone, and three of the
// GET /api/threads?limit=500 calls in that session. The comment two lines above already said the change feed is exact and this
// mirror is "not the repair path": a safety net that runs twenty-four times a day is not a safety net, it is the path. Daily.
// The daily pass is never what a start waits for (A Mac closed overnight held its first paint 3,392 ms for it, against
// ~200 ms for the delta). When its timer is ALL that makes it due (a cursor, no reset_required, no one-time pass below) the refresh
// path (`defer`, from syncHubShared) runs the delta, answers, and leaves the pass to scheduleHubFull, ~30 s later in the background through
// the same shared promise and lock. Its timestamp is written only when it completes, so a page closed first finds it due at the next start
// and defers it again. A reset, a missing cursor, a one-time pass and an account switch (gmailHubSwitch, after the delta) run at once.
// Called with no options (tests, the console) it runs whatever is due inline, as it always did. Each run reports its kind to perf.hubSync.
async function syncHub(opts = {}) {
  const t0 = performance.now(), note = { kind: "delta" };
  try { const n = await syncHubRun(opts, note); perf.hubSync?.({ ...note, ms: performance.now() - t0, rows: n }); return n; }
  catch (e) { perf.hubSync?.({ ...note, ms: performance.now() - t0, error: String(e?.message || e).slice(0, 120) }); throw e; }
}
async function syncHubRun({ defer = false, deferred = false } = {}, note) {
  await refreshPending(); await gmailHubLoad();
  // Rows cached before the hub sent has_att say "no file" until their thread changes. The daily full pass below refreshes every row;
  // run it once now rather than within a day. It is the ordinary merge pass, so nothing is dropped or reordered.
  let once = false;
  if (!(await idb.meta("attflag1"))) { await idb.meta("hubFullAt", 0); await idb.meta("attflag1", 1); once = true; }
  // The same once for has_out: a conversation answered after the user wrote in it is in Sent from the first sync.
  if (!(await idb.meta("hasout1"))) { await idb.meta("hubFullAt", 0); await idb.meta("hasout1", 1); once = true; }
  const cursor = await idb.meta("hubSeq"), fullAt = (await idb.meta("hubFullAt")) || 0;
  const due = Date.now() - fullAt >= SYNC.hubFullMs;
  let reset = false;
  if (Number.isFinite(cursor) && (!due || (defer && !once))) {
    const n = await syncHubDelta(cursor);
    if (n !== "reset") {
      if (due) { note.deferred = "full:daily"; note.lastFullH = fullAt ? Math.round((Date.now() - fullAt) / 36e5) : null; scheduleHubFull(); }   // past ~48: skipped at start after start
      const switches = syncState.switches || 0, sw = await gmailHubSwitch();
      if ((syncState.switches || 0) > switches) note.kind = "full:switch";
      return n + sw;
    }
    reset = true;
  }
  note.kind = reset ? "full:reset" : !Number.isFinite(cursor) ? "full:nocursor" : once ? "full:once" : deferred ? "full:deferred" : "full:daily";
  // Page through the hub (the Worker caps a page at 500); the local copy mirrors the whole store up to SYNC.hubMax rows.
  let stamp = -1, gst = null; // the newest change-feed position the hub reports for what we just mirrored; the next sync asks for anything after it
  const page = async (box) => { const out = []; let before = null; while (out.length < SYNC.hubMax) { const r = await api(`/api/threads?limit=500&box=${box}${before ? "&before=" + encodeURIComponent(before) : ""}`); const rows = r.threads || []; if (Number.isFinite(r.cursor) && r.cursor > stamp) stamp = r.cursor; if (r.gmail_status) gst = r.gmail_status; out.push(...rows); if (rows.length < 500) break; before = rows[rows.length - 1].last_message_at; } return out; };
  const [a, tr] = await Promise.all([page("all"), page("trash")]);
  const syncedAt = Date.now(); const rows = [...a, ...tr].map((t) => ({ ...hub.norm(t), syncedAt })); // syncedAt: see adoptPushStashes
  const keep = new Set(rows.map((t) => t.key)); const oldest = rows.length ? Math.min(...rows.map((t) => t.date || 0)) : 0;
  for (const [k, t] of state.threads) if (t.kind === "hub" && !keep.has(k) && (t.date || 0) >= oldest) state.threads.delete(k);
  const pend = pendingKeysNow(); for (let i = 0; i < rows.length; i++) { const t = rows[i]; const cur = state.threads.get(t.key); if (cur && pend.has(t.key)) Object.assign(t, { state: cur.state, unread: cur.unread, starred: cur.starred }); if (cur) { Object.assign(cur, t); rows[i] = cur; } else state.threads.set(t.key, t); }
  await idb.putAll("threads", rows);
  rebuildHubMsgIds();
  // Gmail accounts already synced through the hub are mirrored in full with it. A device with no cursor, or one the feed had forgotten,
  // REPLACES its copy from a complete mirror; the daily full pass only merges. The cursor kept is the earliest read, so
  // nothing between the two reads is skipped.
  // The accounts are read at once, not one after another, and every read is waited for (allSettled, so none is still writing after this
  // returns): if any failed, the whole pass fails as it did when the loop threw, and neither the cursor nor the timestamp moves.
  noteGmailStatus(gst); let n = rows.length;
  const reads = await Promise.allSettled(Object.keys(gmailHub.switched).map((email) => gmailHubMirror(email, { replace: reset || !Number.isFinite(cursor) ? "reset" : false })));
  const failed = reads.find((x) => x.status === "rejected"); if (failed) throw failed.reason;
  for (const { value: m } of reads) if (m) { n += m.rows; if (stamp < 0 || m.cursor < stamp) stamp = m.cursor; }
  // A pass over a live cursor (the daily one, now run after a delta) never moves it forward: that cursor is the earliest read of all. A
  // merge pass deletes no Gmail message and the box list reads its cursor after its rows (index.js /api/threads), so jumping to `stamp`
  // would skip whatever the feed recorded in between; the next delta replays it instead, and replayed rows are absolute.
  if (!reset && Number.isFinite(cursor) && cursor < stamp) stamp = cursor;
  if (stamp >= 0) await idb.meta("hubSeq", stamp);
  await idb.meta("hubFullAt", Date.now());
  return n + (await gmailHubSwitch());
}
// The daily pass a refresh deferred: one timer per window. When it fires it waits out any hub sync in flight and runs through
// syncHubShared, so a refresh that starts meanwhile waits on it, and the "sync:hub" lock keeps other windows out. syncHub checks it is
// still due (another window may have run it); if the run fails, or the lock is busy, the next refresh finds it due and schedules it again.
function scheduleHubFull() { if (!syncState.hubFullTimer) syncState.hubFullTimer = setTimeout(runDeferredHubFull, SYNC.hubFullDeferMs); }
async function runDeferredHubFull() {
  syncState.hubFullTimer = null;
  try { while (syncState.hubShared) await syncState.hubShared.catch(() => {}); await syncHubShared({ deferred: true }); } catch (_) {}
}
// Only what the hub's change feed recorded after our cursor: one ordered page carrying both changed rows and deletions, so neither can
// overtake the other. Rows arrive whatever their state, so a thread trashed or archived on another device is applied here too; an unsent
// local action still wins until it is persisted, and a deletion that collides with one is deferred rather than dropped on the floor.
async function syncHubDelta(seq) {
  let cur = seq, n = 0;
  for (let page = 0; page < 10; page++) {
    const r = await api(`/api/threads?limit=500&since_seq=${encodeURIComponent(cur)}`);
    if (r.reset_required) { if (r.gmail_status) noteGmailStatus(r.gmail_status); await idb.meta("hubSeq", null); return "reset"; } // our cursor is older than the hub kept: mirror in full
    const raw = r.threads || [];
    if (raw.length) {
      const pend = pendingKeysNow(); const syncedAt = Date.now(); const rows = raw.map((t) => ({ ...hub.norm(t), syncedAt })); // syncedAt: see adoptPushStashes
      for (const t of rows) { const old = state.threads.get(t.key); if (old && pend.has(t.key)) Object.assign(t, { state: old.state, unread: old.unread, starred: old.starred }); if (old) Object.assign(old, t); else state.threads.set(t.key, t); }
      await idb.putAll("threads", rows.map((t) => state.threads.get(t.key) || t));
      n += rows.length;
    }
    if ((r.deleted || []).length) n += await applyHubDeletions(r.deleted);
    if ((r.gmail || []).length || (r.gmail_deleted || []).length) n += await applyGmailFeed(r.gmail || [], r.gmail_deleted || []);
    noteGmailStatus(r.gmail_status);
    if (Number.isFinite(r.cursor)) cur = r.cursor;
    if (!r.more) break;
  }
  if (cur !== seq) await idb.meta("hubSeq", cur);
  rebuildHubMsgIds(); // ALWAYS, not only when rows changed: this set is what hides a Gmail copy of domain mail, and a quiet delta used
  return n;           // to leave it empty, so every duplicate reappeared in the inbox (A deleted test mail came back)
}
// A thread purged on the hub is removed here, unless this device still owes the server an action on it, in which case the removal is
// remembered durably and retried after the queue drains.
async function applyHubDeletions(ids) {
  const pend = pendingKeysNow(); let n = 0; const deferred = new Set((await idb.meta("hubDeferredDeletes")) || []);
  for (const id of ids) {
    const k = `hub|${id}`;
    if (pend.has(k)) { deferred.add(id); continue; }
    deferred.delete(id);
    if (state.threads.delete(k)) { await idb.del("threads", k); n++; } else await idb.del("threads", k);
  }
  await idb.meta("hubDeferredDeletes", [...deferred]);
  return n;
}
// Called after the queue drains: whatever the hub deleted while we still owed it an action is removed now.
async function flushDeferredDeletes() {
  const ids = (await idb.meta("hubDeferredDeletes")) || []; if (!ids.length) return 0;
  const n = await applyHubDeletions(ids);
  if (n) { rebuildHubMsgIds(); if (typeof render === "function") render(); }
  return n;
}
// Built from every hub thread this device knows, not from the rows of one page, so a delta keeps the Gmail-copy dedupe set complete.
// Must run on every boot and every sync: it is derived state with no durable copy, so skipping it silently unhides duplicates.
// The map beside it says WHICH hub conversation holds each Message-ID, so the hidden Gmail copy can follow it (mirrorHubCopies).
function rebuildHubMsgIds() {
  const out = new Set(), owner = new Map();
  for (const t of state.threads.values()) if (t.kind === "hub") { if (t.msgIdHdr) { out.add(t.msgIdHdr); owner.set(t.msgIdHdr, t.key); } for (const id of t.msgIds || []) if (id) { out.add(id); owner.set(id, t.key); } }
  state.hubMsgIds = out; state.hubMsgThread = owner;
}
async function dropGmailWindow(email) { try { const ms = await idb.getByIndex("messages", "account", email); await idb.delAll("messages", ms.map((m) => m.key)); const keys = []; for (const [k, t] of state.threads) if (t.kind === "gmail" && t.account === email) { keys.push(k); state.threads.delete(k); } await idb.delAll("threads", keys); if (typeof searchIndex !== "undefined") searchIndex.remove(keys); } catch (_) {} }
const refreshPending = async () => { try { if (typeof queue !== "undefined" && queue.load) await queue.load(); } catch (_) {} };
const pendingKeysNow = () => { try { return (typeof queue !== "undefined" && queue.pendingKeys) ? queue.pendingKeys() : new Set(); } catch (_) { return new Set(); } };
async function withLock(name, fn) { if (navigator.locks?.request) return navigator.locks.request(name, { ifAvailable: true }, async (lock) => lock ? fn() : "busy"); return fn(); }
async function syncAccount(a, opts = {}) {
  await gmailHubLoad();
  if (a.id === "hub" || gmailViaHub(a.id)) return syncHubShared();   // Gmail through the hub comes in the hub's own request
  // Not switched yet. Until the hub has answered once this session its answer may switch this account, and a new device would otherwise
  // start filling 90 days from Gmail for nothing; after that, an account the hub does not mirror goes straight to Gmail, as before.
  if (!gmailHub.answered) { const viaHub = await syncHubShared().catch(() => null); if (gmailViaHub(a.id)) return viaHub; }
  if (syncState.running.has(a.id)) return "running"; syncState.running.add(a.id);
  try {
    const r = await withLock("sync:" + a.id, async () => deltaGmail(a.id, opts));
    // The hub switched this account while the direct sync was running, and the direct sync may have written after the switch: the
    // hub's mirror is read again and wins. Once per account, at the switch.
    if (gmailViaHub(a.id)) { await gmailHubMirror(a.id, { replace: "switch" }).catch(() => null); }
    return r;
  }
  finally { syncState.running.delete(a.id); if (typeof backfillUnsub === "function") scheduleIdle(backfillUnsub); } // rows that predate the header capture learn List-Unsubscribe in the background
}
// One hub sync at a time in this window, shared by every account that rides it: the hub itself and each Gmail account it mirrors.
// A refresh defers a daily pass that only its timer made due; the deferred run (runDeferredHubFull) is the one that does it.
function syncHubShared({ deferred = false } = {}) {
  if (syncState.hubShared) return syncState.hubShared;
  const p = (async () => {
    syncState.running.add("hub");
    try { return await withLock("sync:hub", () => syncHub({ defer: !deferred, deferred })); }
    finally { syncState.running.delete("hub"); if (typeof backfillUnsub === "function") scheduleIdle(backfillUnsub); }
  })();
  syncState.hubShared = p; p.finally(() => { if (syncState.hubShared === p) syncState.hubShared = null; }).catch(() => {});
  return p;
}
// ---- Gmail through the hub ----
// The hub follows Gmail and keeps each message's metadata; its changes arrive in the hub feed beside domain mail, so a device closed for
// days catches up in the same single request, with no Gmail history replay and no per-device downloads. An account switches over once
// the hub says its mirror is ready. Until then, and again if the hub ever stops mirroring it, the direct path above (deltaGmail) runs.
// Bodies, actions and search still talk to Gmail directly.
const gmailHub = { switched: null, status: {} };
async function gmailHubLoad() { if (!gmailHub.switched) { try { gmailHub.switched = (await idb.meta("gmailHub")) || {}; } catch (_) { gmailHub.switched = {}; } } return gmailHub.switched; }
const gmailViaHub = (email) => !!(gmailHub.switched && gmailHub.switched[email]);
function gmailHubRowMsg(row) { const m = JSON.parse(row.meta); m.labelIds = JSON.parse(row.labels || "[]"); m.threadId = row.thread_id || m.threadId; return m; }
// Rows with metadata are stored as Gmail would have returned them, with the hub's current labels. A stub (no metadata) only updates a
// message this device holds. A deletion removes the message. Threads are rebuilt, so an unsent local action still wins (rebuildGmailThreads).
async function applyGmailHubRows(email, rows, deletedIds) {
  const touched = new Set(), full = rows.filter((r) => r.meta), stubs = rows.filter((r) => !r.meta);
  if (full.length) { const metas = []; for (const r of full) { try { metas.push(msgMetaFromGmail(email, gmailHubRowMsg(r))); } catch (_) {} } if (metas.length) { await idb.putAll("messages", metas); for (const m of metas) touched.add(m.threadKey); } }
  if (stubs.length) {
    const got = await idb.getMany("messages", stubs.map((r) => `${email}|${r.id}`)), upd = [];
    got.forEach((m, i) => { if (!m) return; try { m.labels = JSON.parse(stubs[i].labels || "[]"); } catch (_) { return; } upd.push(m); touched.add(m.threadKey); });
    if (upd.length) await idb.putAll("messages", upd);
  }
  if (deletedIds.length) {
    const keys = deletedIds.map((id) => `${email}|${id}`), got = await idb.getMany("messages", keys), del = [];
    got.forEach((m, i) => { if (m) { del.push(keys[i]); touched.add(m.threadKey); } });
    if (del.length) await idb.delAll("messages", del);
  }
  if (touched.size) await rebuildGmailThreads(email, [...touched]);
  return touched.size;
}
async function applyGmailFeed(rows, deleted) {
  const by = new Map(), slot = (e) => by.get(e) || by.set(e, { rows: [], del: [] }).get(e);
  for (const r of rows) if (gmailViaHub(r.account)) slot(r.account).rows.push(r);   // an account not switched yet gets the whole mirror when it switches
  for (const d of deleted) if (gmailViaHub(d.account)) slot(d.account).del.push(d.id);
  let n = 0; for (const [email, x] of by) n += await applyGmailHubRows(email, x.rows, x.del);
  return n;
}
// The whole mirror of one account. Its cursor was read before any row, so the caller keeps the earlier of it and its own.
// replace "switch" (an up-to-date device moving over) drops a held message the mirror lacks only where the mirror is authoritative: inside
// the 90-day window, or unread in the inbox. Old read mail the mirror never lists stays and is kept current by stubs.
// replace "reset" (a device the feed had forgotten) drops everything the mirror lacks, as the old 404 refill dropped the window.
// Either way: only from a complete mirror read to its end, and never a message still owed, one on a thread with
// an unsent action, or one newer than ten minutes before the mirror was read (it may simply not be fetched yet).
async function gmailHubMirror(email, { replace = false } = {}) {
  let after = "", first = null; const rows = [];
  for (let i = 0; i < 100; i++) {
    const r = await api(`/api/gmail/mirror?account=${encodeURIComponent(email)}&limit=${SYNC.mirrorPage}${after ? "&after=" + encodeURIComponent(after) : ""}`);   // the hub's cap is 1,000
    if (!first) first = r; rows.push(...(r.rows || [])); after = r.next || ""; if (!after) break;
  }
  if (!first || !Number.isFinite(first.cursor)) return null;
  await applyGmailHubRows(email, rows, []);
  const complete = !!first.complete && !after;
  if (replace && complete) {
    const keep = new Set(rows.map((r) => r.id)), owed = new Set(first.owed || []), pend = pendingKeysNow();
    const at = Date.parse(first.at || "") || Date.now(), recent = at - 10 * 60_000, windowStart = at - SYNC.windowDays * 864e5;
    const authoritative = (m) => gmailIdMs(m.id) >= windowStart || ((m.labels || []).includes("INBOX") && (m.labels || []).includes("UNREAD"));
    const drop = (await idb.getByIndex("messages", "account", email)).filter((m) => !keep.has(m.id) && !owed.has(m.id) && !pend.has(m.threadKey) && gmailIdMs(m.id) < recent && (replace === "reset" || authoritative(m)));
    if (drop.length) { await idb.delAll("messages", drop.map((m) => m.key)); await rebuildGmailThreads(email, [...new Set(drop.map((m) => m.threadKey))]); }
    if (replace === "reset") await idb.meta(gmailEdgeKey(email), windowStart);   // older mail was just dropped: load older starts at the mirror's window again
  }
  return { cursor: first.cursor, rows: rows.length, complete };
}
// The hub's word on each Gmail account: switch the ones whose mirror is ready, fall back for any it no longer mirrors, and say on the
// account when it is behind (still filling, messages owed, or no complete read of Gmail for 15 minutes).
function noteGmailStatus(st) {
  gmailHub.answered = true;   // the hub answered this session (an older hub says nothing about Gmail: then nothing is mirrored)
  if (!st || typeof st !== "object") return;
  gmailHub.status = st;
  for (const [email, s] of Object.entries(st)) {
    if (!gmailViaHub(email)) continue;
    const prog = syncState.progress[email] ||= {}, stale = !s.synced_at || Date.now() - Date.parse(s.synced_at) > 15 * 60_000;
    prog.behind = s.state !== "ready" || s.owed > 0 || stale; prog.owed = s.owed || 0; prog.phase = "idle";
  }
}
async function gmailHubSwitch() {
  const sw = await gmailHubLoad(); let changed = false, rewind = null, n = 0;
  for (const [email, s] of Object.entries(gmailHub.status || {})) {
    if (s.state === "ready" && !s.owed && !sw[email]) {   // ready AND owing nothing: never switch onto a mirror that is still catching up
      const m = await gmailHubMirror(email, { replace: "switch" }); if (!m) continue;
      sw[email] = { at: Date.now() }; changed = true; n += m.rows; rewind = rewind === null ? m.cursor : Math.min(rewind, m.cursor); syncState.switches = (syncState.switches || 0) + 1;   // perf: this sync took a switch's mirror
      await logSync(email, `syncing through the hub now (${m.rows} messages from its mirror)`);
    } else if (!s.state && sw[email]) { delete sw[email]; changed = true; await logSync(email, "the hub stopped mirroring this account; syncing with Gmail directly again"); }
  }
  if (changed) { await idb.meta("gmailHub", sw); noteGmailStatus(gmailHub.status); }
  // From the switch on, Gmail changes come in the feed: rewind to the mirror's cursor so none between the two reads is skipped. Hub rows
  // replayed from there are absolute and land the same way twice.
  if (rewind !== null) { const cur = await idb.meta("hubSeq"); if (Number.isFinite(cur) && cur > rewind) await idb.meta("hubSeq", rewind); }
  return n;
}
async function logSync(email, note) { try { await idb.meta("synclog", [...((await idb.meta("synclog")) || []).slice(-49), { at: Date.now(), email, note }]); } catch (_) {} }
