#!/usr/bin/env node
// The mailhub-img Worker: our own WebAssembly shrinker (hub/img/wasm/shrink.wasm) on real migrations and SQLite, R2 in
// memory, pictures made by sharp at the start:
//  - a 2400 px photo gets its 1600 and 1080 px WebP sizes under their own keys and its original is deleted; a 1300 px PNG the same;
//  - a WebP already small for the desktop keeps its original and gets only the phone size;
//  - an animated GIF keeps every frame, at encoder effort 2;
//  - a corrupt file and a missing one are skipped once, never retried; a store that fails is retried and gives up on the third try;
//  - two ticks at once take each picture once (the claim); a claim left by a crashed run is taken back after ten minutes;
//  - the instance is reused across pictures and gives the same bytes as a fresh one; every kept picture is noted in img_seen;
//  - the run is logged in events;
//  - a Display P3 PNG, a turned JPEG and a wide WebP keep their colour profile, drawn as sharp's converted WebP is; sRGB carries none;
//  - a picture with transparency that runs out of memory at the desktop size is tried again the next minute at effort 2, and if it
//  still does not fit, gets the phone size alone, the original staying for the desktop.
// Usage: node test/imgwork.mjs (exit 1 on any failed check)
// CONTROL: IMGWORK_SRC=<an img/src/index.js from before a change> node test/imgwork.mjs fails what that change added.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); return c; };
const sharp = createRequire(HUB + "shrink/container/package.json")("sharp");
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; const open = (buf.match(/\bBEGIN\b/gi) || []).length, close = (buf.match(/\bEND\b/gi) || []).length; if (open === close) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const stripComments = (sql) => sql.split("\n").map((l) => { let q = false; for (let i = 0; i < l.length; i++) { if (l[i] === "'") q = !q; if (!q && l[i] === "-" && l[i + 1] === "-") return l.slice(0, i); } return l; }).join("\n");
function buildDb() {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").filter((x) => x.endsWith(".sql")).sort()) for (const st of statements(stripComments(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (_) {} }
  return sq;
}
const d1 = (sq) => ({ prepare(sql) { const mk = (p) => ({ sql, bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) ?? null, run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...p).changes) } }) }); return mk([]); }, batch: async (xs) => Promise.all(xs.map((x) => x.run())) });
function r2() {
  const m = new Map(), store = { m, fail: 0,
    head: async (k) => (m.has(k) ? { key: k } : null),
    get: async (k) => { if (store.fail > 0) { store.fail--; throw new Error("R2 down (injected)"); } return m.has(k) ? { arrayBuffer: async () => m.get(k).buf.slice().buffer, httpMetadata: { contentType: m.get(k).ct } } : null; },
    put: async (k, v, o) => { m.set(k, { buf: new Uint8Array(v), ct: o?.httpMetadata?.contentType, meta: o?.customMetadata }); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); } };
  return store;
}
// the Worker, with its.wasm import turned into a module compiled here
const src = readFileSync(process.env.IMGWORK_SRC || HUB + "img/src/index.js", "utf8").replace('import SHRINK_WASM from "../wasm/shrink.wasm";', `const SHRINK_WASM = new WebAssembly.Module(${JSON.stringify("__WASM__")});`)
  .replace('import { logoMark } from "./logomark.js";', "const logoMark = async () => null;");   // the logo fingerprint has its own test (logomark.mjs)
const tmp = HUB + "test/_imgwork_worker.mjs";
writeFileSync(tmp, src.replace(`new WebAssembly.Module("__WASM__")`, `new WebAssembly.Module((await import("node:fs")).readFileSync(${JSON.stringify(HUB + "img/wasm/shrink.wasm")}))`));
const W = await import(tmp); unlinkSync(tmp);

const noise = (w, h, ch = 3) => { const b = Buffer.alloc(w * h * ch); for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761 >>> 24) ^ ((i / ch / w) | 0); return sharp(b, { raw: { width: w, height: h, channels: ch } }); };
const PHOTO = await noise(2400, 1500).blur(2).jpeg({ quality: 92 }).toBuffer();
const TEXTPNG = await sharp({ create: { width: 1300, height: 800, channels: 3, background: "#fff" } }).composite([{ input: Buffer.from(`<svg width="1300" height="800"><g font-size="28" font-family="Georgia">${Array.from({ length: 20 }, (_, i) => `<text x="20" y="${40 + i * 38}">Line ${i}: the quarter's numbers held steady across every region we track.</text>`).join("")}</g></svg>`) }]).png().toBuffer();
const SMALLWEBP = await noise(1400, 900).blur(3).webp({ quality: 40 }).toBuffer();
// an animation the way newsletters draw them: shapes and words moving over a gradient, each frame rendered and stacked into pages
const frames = 6, frameSvg = (f) => Buffer.from(`<svg width="600" height="400"><defs><linearGradient id="g"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><circle cx="${80 + f * 80}" cy="200" r="60" fill="#1d4ed8"/><text x="40" y="360" font-size="40" font-family="Georgia">Sale ends in ${6 - f} days</text></svg>`);
const rawFrames = Buffer.concat(await Promise.all(Array.from({ length: frames }, (_, f) => sharp(frameSvg(f)).ensureAlpha().raw().toBuffer())));
const GIF2 = await sharp(rawFrames, { raw: { width: 600, height: 400 * frames, channels: 4, pageHeight: 400 } }).gif({ delay: Array(frames).fill(80), loop: 0 }).toBuffer();
const CORRUPT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);

const sha = (n) => n.toString(16).padStart(64, "0");
async function setup() {
  const sq = buildDb(), STORE = r2(), env = { DB: d1(sq), STORE };
  const put = (n, buf, ct) => { const k = "img/" + sha(n); STORE.m.set(k, { buf: new Uint8Array(buf), ct }); sq.prepare("INSERT INTO img_work (key, bytes, ct, state, at) VALUES (?, ?, ?, 'pending', ?)").run(k, buf.length, ct, new Date(Date.now() - n * 1000).toISOString()); return k; };
  return { sq, STORE, env, put, row: (k) => sq.prepare("SELECT state, tries, out_bytes, kept, note FROM img_work WHERE key = ?").get(k) };
}

// 1. the pictures through one tick
{
  const s = await setup();
  const kPhoto = s.put(1, PHOTO, "image/jpeg"), kText = s.put(2, TEXTPNG, "image/png"), kWebp = s.put(3, SMALLWEBP, "image/webp"), kGif = s.put(4, GIF2, "image/gif"), kBad = s.put(5, CORRUPT, "image/jpeg");
  s.sq.prepare("INSERT INTO img_work (key, bytes, ct, state, at) VALUES (?, 10, 'image/png', 'pending', ?)").run("img/" + sha(6), new Date().toISOString());
  const r = await W.tick(s.env);
  const meta = async (k) => { const v = s.STORE.m.get(k); return v ? await sharp(Buffer.from(v.buf), { animated: true }).metadata() : null; };
  const p16 = await meta(`imgv/${sha(1)}-1600`), p10 = await meta(`imgv/${sha(1)}-1080`);
  check(p16?.width === 1600 && p10?.width === 1080 && p16.format === "webp" && !s.STORE.m.has(kPhoto) && s.row(kPhoto).state === "done",
    `a 2400 px photo gets its 1600 and 1080 px WebP sizes and its original goes (${p16?.width}, ${p10?.width}, original ${s.STORE.m.has(kPhoto) ? "kept" : "gone"}, ${s.row(kPhoto).state})`);
  check(s.row(kPhoto).out_bytes === s.STORE.m.get(`imgv/${sha(1)}-1600`).buf.length + s.STORE.m.get(`imgv/${sha(1)}-1080`).buf.length && s.row(kPhoto).out_bytes < PHOTO.length,
    `the row records both sizes' bytes, under the original's (${s.row(kPhoto).out_bytes} of ${PHOTO.length})`);
  const t16 = await meta(`imgv/${sha(2)}-1600`), t10 = await meta(`imgv/${sha(2)}-1080`);
  check(t16?.width === 1300 && t10?.width === 1080 && !s.STORE.m.has(kText), `a 1300 px PNG keeps its width on the desktop and is 1080 on the phone (${t16?.width}, ${t10?.width})`);
  const w16 = s.STORE.m.has(`imgv/${sha(3)}-1600`), w10 = await meta(`imgv/${sha(3)}-1080`);
  check(!w16 && w10?.width === 1080 && s.STORE.m.has(kWebp) && s.row(kWebp).state === "done", `a WebP already small for the desktop keeps its original and gets only the phone size (${w16}, ${w10?.width}, ${s.row(kWebp).note})`);
  const g = s.STORE.m.get(`imgv/${sha(4)}-1600`), gm = g ? await sharp(Buffer.from(g.buf), { animated: true }).metadata() : null;
  const inPages = (await sharp(GIF2, { animated: true }).metadata()).pages;
  check(inPages === frames && gm && gm.pages === frames && g.buf.length < GIF2.length, `an animated GIF becomes an animated WebP with every frame, smaller (${inPages} in, ${gm?.pages ?? "-"} out, ${GIF2.length} -> ${g?.buf.length ?? "-"} bytes; ${s.row(kGif).note || ""})`);
  check(s.row(kBad).state === "skipped" && s.row(kBad).tries === 0 && s.STORE.m.has(kBad), `a corrupt file is left as sent, not retried (${s.row(kBad).state}, ${s.row(kBad).tries} tries, ${s.row(kBad).note})`);
  check(s.row("img/" + sha(6)).state === "skipped" && /no stored copy/.test(s.row("img/" + sha(6)).note), "a row with nothing stored is skipped");
  const seen = s.sq.prepare("SELECT COUNT(*) n FROM img_seen").get().n;
  check(seen >= 4, `every picture it handled is noted as stored (${seen} rows)`);
  const ev = s.sq.prepare("SELECT detail FROM events WHERE kind = 'img_shrink'").get();
  check(r.n === 6 && ev && /n=6 /.test(ev.detail), `the run is logged (${ev?.detail})`);
  // What is kept, which its sender's share counts it at
  check(s.row(kPhoto).kept === s.row(kPhoto).out_bytes && s.row(kWebp).kept === SMALLWEBP.length + s.row(kWebp).out_bytes && s.row(kBad).kept === null,
    `each row records what is kept: both sizes once the original goes, the original and the phone size when it stays, nothing for a refusal (${s.row(kPhoto).kept}, ${s.row(kWebp).kept}, ${s.row(kBad).kept})`);
}
// 1b. the sender's pictures waiting for room are due once its share has some back
{
  const s = await setup();
  const k = s.put(1, PHOTO, "image/jpeg"); s.sq.prepare("UPDATE img_work SET dom = 'shop.example' WHERE key = ?").run(k);
  const later = new Date(Date.now() + 3600e3).toISOString(), q = s.sq.prepare("INSERT INTO img_queue (hk, url, state, kind, tries, next_at, at, dom, size) VALUES (?, ?, 'pending', 'over', 0, ?, ?, ?, ?)");
  q.run(1, "https://img.shop.example/a.png", later, new Date().toISOString(), "shop.example", 4000000);
  q.run(2, "https://img.other.example/b.png", later, new Date().toISOString(), "other.example", 4000000);
  await W.tick(s.env);
  const due = (hk) => Date.parse(s.sq.prepare("SELECT next_at FROM img_queue WHERE hk = ?").get(hk).next_at) <= Date.now() + 1000;
  check(due(1) && !due(2), `shrinking a sender's picture makes that sender's waiting pictures due, not another's (${due(1)}, ${due(2)})`);
}
// 2. claims: two ticks at once take each picture once; a crashed run's claim is taken back after ten minutes
{
  const s = await setup(); for (let i = 1; i <= 4; i++) s.put(i, PHOTO, "image/jpeg");
  let puts = 0; const put0 = s.STORE.put; s.STORE.put = async (...a) => { puts++; return put0(...a); };
  const [a, b] = await Promise.all([W.tick(s.env), W.tick(s.env)]);
  check(a.n + b.n === 4 && puts === 8, `two ticks at once take each of 4 pictures once (${a.n} + ${b.n}, ${puts} sizes written)`);
  const k = s.put(9, PHOTO, "image/jpeg"); s.sq.prepare("UPDATE img_work SET state = 'working', claimed_at = ? WHERE key = ?").run(new Date(Date.now() - 11 * 60e3).toISOString(), k);
  const c = await W.tick(s.env);
  check(c.n === 1 && s.row(k).state === "done", `a claim older than ten minutes is taken back and done (${s.row(k).state})`);
  const k2 = s.put(10, PHOTO, "image/jpeg"); s.sq.prepare("UPDATE img_work SET state = 'working', claimed_at = ? WHERE key = ?").run(new Date(Date.now() - 2 * 60e3).toISOString(), k2);
  await W.tick(s.env);
  check(s.row(k2).state === "working", "a fresh claim is left alone");
}
// 3. a store that fails is retried, and the third failure gives up
{
  const s = await setup(); const k = s.put(1, PHOTO, "image/jpeg");
  s.STORE.fail = 1; await W.tick(s.env);
  check(s.row(k).state === "pending" && s.row(k).tries === 1, `a failed read goes back to waiting (${s.row(k).state}, ${s.row(k).tries})`);
  s.STORE.fail = 2; await W.tick(s.env); await W.tick(s.env);
  check(s.row(k).state === "failed" && s.row(k).tries === 3, `the third failure gives up (${s.row(k).state}, ${s.row(k).tries})`);
}
// 3b. kills count as tries; a run whose claim was taken back writes nothing over the next one's
{
  const s = await setup(); const k = s.put(1, PHOTO, "image/jpeg");
  s.sq.prepare("UPDATE img_work SET state = 'working', tries = 2, claimed_at = ? WHERE key = ?").run(new Date(Date.now() - 11 * 60e3).toISOString(), k);
  await W.tick(s.env);
  check(s.row(k).state === "failed" && s.row(k).tries === 3, `a picture whose runs were killed three times gives up (${s.row(k).state}, ${s.row(k).tries} tries)`);
  const k2 = s.put(2, PHOTO, "image/jpeg"); await W.tick(s.env);
  const r = { n: 0, done: 0, skipped: 0, failed: 0, before: 0, after: 0 };
  await W.shrinkOne(s.env, { key: k2, bytes: PHOTO.length, tries: 0, claim: "2026-01-01T00:00:00.000Z#stale000" }, r);
  check(s.row(k2).state === "done", `a stale run's late result does not overwrite "done" (${s.row(k2).state}, ${s.row(k2).note || ""})`);
}
// 3c. hostile and unusual files
{
  const ssimOf = async (a, b) => { const A = await sharp(a).resize(400, 250, { fit: "fill" }).greyscale().raw().toBuffer(), B = await sharp(b).resize(400, 250, { fit: "fill" }).greyscale().raw().toBuffer();
    let s = 0, n = 0; for (let y = 0; y + 8 <= 250; y += 8) for (let x = 0; x + 8 <= 400; x += 8) { let ma = 0, mb = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const q = (y + j) * 400 + x + i; ma += A[q]; mb += B[q]; } ma /= 64; mb /= 64; let va = 0, vb = 0, cv = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const q = (y + j) * 400 + x + i, da = A[q] - ma, db = B[q] - mb; va += da * da; vb += db * db; cv += da * db; } va /= 63; vb /= 63; cv /= 63; s += ((2 * ma * mb + 6.5025) * (2 * cv + 58.5225)) / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225)); n++; } return s / n; };
  const colour = await sharp({ create: { width: 1800, height: 1100, channels: 3, background: "#2a6" } }).composite([{ input: Buffer.from('<svg width="1800" height="1100"><rect x="100" y="100" width="700" height="500" fill="#e33"/><circle cx="1300" cy="600" r="300" fill="#36c"/><text x="120" y="950" font-size="90">Spring colours</text></svg>') }]).jpeg().toBuffer();
  const cmyk = await sharp(colour).toColourspace("cmyk").jpeg({ quality: 92 }).toBuffer();
  const c = W.shrinkBytes(cmyk, 1600, 4);
  check((await sharp(cmyk).metadata()).space === "cmyk" && c.rc === "keep", `a CMYK JPEG is left as sent, so each app shows it its own way (${c.rc} ${c.note || ""})`);
  const inter = await sharp(TEXTPNG).png({ progressive: true }).toBuffer(), ip = W.shrinkBytes(inter, 1080, 4), iq = ip.rc === "ok" ? await ssimOf(Buffer.from(ip.out), inter) : 0;
  check(ip.rc === "ok" && iq > 0.95, `an interlaced PNG is read whole and shrunk (${ip.rc}, SSIM ${iq.toFixed(4)})`);
  // a frame placed past the canvas's right edge, disposed to background: the clear must stay on the canvas
  const off = Buffer.from(GIF2); let at = -1;
  for (let i = 13 + 3 * 256; i < off.length - 10; i++) if (off[i] === 0x21 && off[i + 1] === 0xf9) { off[i + 3] = (off[i + 3] & 0xe3) | (2 << 2); at = i; break; }
  for (let i = at; i < off.length - 10; i++) if (off[i] === 0x2c) { off.writeUInt16LE(5000, i + 1); break; }
  const g = W.shrinkBytes(off, 1600, 2);
  check(at > 0 && g.rc !== "threw", `a GIF frame placed past the canvas, disposed to background, does not write outside it (${g.rc}${g.note ? " " + g.note : ""})`);
  const cut = W.shrinkBytes(GIF2.subarray(0, Math.floor(GIF2.length * 0.6)), 1600, 2);
  check(cut.rc === "bad" && /broken before its end/.test(cut.note), `a GIF cut short is left as sent, not turned into a partial animation (${cut.rc} ${cut.note})`);
  const ns = GIF2.indexOf(Buffer.from("NETSCAPE2.0")), once = ns > 0 ? Buffer.concat([GIF2.subarray(0, ns - 3), GIF2.subarray(ns + 11 + 5)]) : GIF2;
  const lo = W.shrinkBytes(once, 1600, 2), lf = W.shrinkBytes(GIF2, 1600, 2);
  const lm = lo.rc === "ok" ? await sharp(Buffer.from(lo.out), { animated: true }).metadata() : {}, fm = lf.rc === "ok" ? await sharp(Buffer.from(lf.out), { animated: true }).metadata() : {};
  check(ns > 0 && lm.loop === 1 && fm.loop === 0, `a GIF with no loop block plays once, a looping one loops (${lm.loop}, ${fm.loop})`);
  const huge = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer()); huge.writeUInt32BE(65536, 16); huge.writeUInt32BE(65536, 20);
  const t0 = performance.now(), h = W.shrinkBytes(huge, 1600, 4);
  check(h.rc === "too big" && performance.now() - t0 < 200, `a PNG claiming 65,536 x 65,536 is refused before decoding (${h.rc}, ${Math.round(performance.now() - t0)} ms)`);
}
// 3d. colour profiles: a Display P3 picture keeps its profile in the WebP, so it is drawn as sharp's own (converted) WebP is; an sRGB
//  one carries none. "As drawn" is sharp's raw output, which converts through the embedded profile; the same WebP with its ICCP chunk
//  taken out shows what the shrinker gave before the profile was carried.
{
  const vivid = await sharp({ create: { width: 1800, height: 1100, channels: 3, background: "#ff0000" } }).composite([{ input: Buffer.from(
    '<svg width="1800" height="1100"><defs><linearGradient id="g"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ff00ff"/></linearGradient></defs>' +
    '<rect x="0" y="550" width="1800" height="550" fill="url(#g)"/><rect x="600" y="0" width="600" height="550" fill="#0000ff"/><circle cx="1500" cy="275" r="200" fill="#ffd700"/></svg>') }]).png().toBuffer();
  const drawn = async (b) => sharp(b).resize(400, 250, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const diff = (A, B) => { let s = 0; for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]); return s / A.length; };
  const chunks = (b) => { const out = []; for (let i = 12; i + 8 <= b.length;) { const n = b.readUInt32LE(i + 4); out.push([b.toString("latin1", i, i + 4), i, n]); i += 8 + n + (n & 1); } return out; };
  const stripIcc = (b) => { const keep = chunks(b).filter(([id]) => id !== "ICCP").map(([, i, n]) => b.subarray(i, i + 8 + n + (n & 1))), body = Buffer.concat(keep);
    const out = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), body]); out.writeUInt32LE(out.length - 8, 4);
    const v = out.indexOf("VP8X"); if (v > 0) out[v + 8] &= ~0x20; return out; };
  const p3png = await sharp(vivid).withIccProfile("p3").png().toBuffer(), srcIcc = (await sharp(p3png).metadata()).icc;
  const r = W.shrinkBytes(p3png, 1600, 4), out = r.rc === "ok" ? Buffer.from(r.out) : Buffer.alloc(0), outIcc = r.rc === "ok" ? (await sharp(out).metadata()).icc : null;
  check(!!srcIcc && !!outIcc && Buffer.compare(srcIcc, outIcc) === 0 && r.w === 1600, `a Display P3 PNG's profile is carried into its WebP, byte for byte (${srcIcc?.length} -> ${outIcc?.length} bytes)`);
  const want = await drawn(p3png), sharpOwn = await sharp(p3png).resize(1600).webp({ quality: 82, effort: 4 }).toBuffer();
  const dOurs = diff(want, await drawn(out)), dSharp = diff(want, await drawn(sharpOwn)), dBefore = diff(want, await drawn(stripIcc(out)));
  check(r.rc === "ok" && dOurs <= dSharp + 1 && dBefore > dOurs + 3, `and it is drawn as sharp's own WebP is (mean error ${dOurs.toFixed(2)} vs sharp's ${dSharp.toFixed(2)}; ${dBefore.toFixed(2)} without the profile)`);
  const srgb = await sharp(vivid).withIccProfile("srgb").png().toBuffer(), rs = W.shrinkBytes(srgb, 1600, 4);
  check(!!(await sharp(srgb).metadata()).icc && rs.rc === "ok" && !(await sharp(Buffer.from(rs.out)).metadata()).icc, "an sRGB profile is left out: a browser assumes sRGB with none");
  const turned = await sharp(vivid).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).withIccProfile("p3").toBuffer(), rj = W.shrinkBytes(turned, 1600, 4);
  const jm = rj.rc === "ok" ? await sharp(Buffer.from(rj.out)).metadata() : {};
  check(rj.rc === "ok" && rj.h > rj.w && !!jm.icc && Buffer.compare(jm.icc, (await sharp(turned).metadata()).icc) === 0, `a Display P3 JPEG turned by its EXIF keeps its profile too (${rj.w} x ${rj.h}, ${jm.icc?.length} bytes)`);
  const wide = await sharp(vivid).resize(2400).withIccProfile("p3").webp({ quality: 90 }).toBuffer(), rw = W.shrinkBytes(wide, 1600, 4);
  const wm = rw.rc === "ok" ? await sharp(Buffer.from(rw.out)).metadata() : {};
  check(rw.rc === "ok" && rw.w === 1600 && !!wm.icc && Buffer.compare(wm.icc, (await sharp(wide).metadata()).icc) === 0, `a Display P3 WebP wider than asked keeps its profile (${rw.w} px, ${wm.icc?.length} bytes)`);
}
// 3e. security review 2026-11-13
{
  const zlib = await import("node:zlib");
  const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const chunk = (type, data) => Buffer.concat([be32(data.length), Buffer.from(type), data, be32(zlib.crc32(Buffer.concat([Buffer.from(type), data])))]);
  // P1: an RGB profile whose every tag is a 'desc' over the whole 256 KB body (the old scan: 0.7 s at 128 KB, four times that each doubling)
  const n = 262144, prof = Buffer.alloc(n); prof.write("RGB ", 16); prof.write("acsp", 36);
  const cnt = Math.floor((n - 132) / 12); prof.writeUInt32BE(cnt, 128);
  for (let i = 0; i < cnt; i++) { const e = 132 + 12 * i; prof.write("desc", e); prof.writeUInt32BE(0, e + 4); prof.writeUInt32BE(n, e + 8); }
  const W0 = 1200, H0 = 8, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W0, 0); ihdr.writeUInt32BE(H0, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((W0 * 3 + 1) * H0, 0x55); for (let y = 0; y < H0; y++) raw[y * (W0 * 3 + 1)] = 0;
  const pngIcc = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("iCCP", Buffer.concat([Buffer.from("icc\0\0"), zlib.deflateSync(prof, { level: 9 })])), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const evil = Buffer.concat([pngIcc, Buffer.alloc(Math.max(0, n - pngIcc.length + 64))]);   // spng takes a chunk up to the file's length + 64
  let t0 = performance.now(); const ri = W.shrinkBytes(evil, 1600, 4), ms = performance.now() - t0;
  check(ri.rc === "ok" && ms < 300, `a 256 KB profile of 21,800 'desc' tags over its whole body is read once, not once a tag (${ri.rc}, ${ms.toFixed(0)} ms)`);
  // P1: a progressive JPEG repeating its last refinement scan 300 times is refused past its 100th scan; the file without them is shrunk
  const base = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#777" } }).toColourspace("b-w").jpeg({ progressive: true, quality: 80 }).toBuffer();
  const segs = []; for (let i = 2; i < base.length;) {
    const mk = base[i + 1]; if (mk === 0xd9) { segs.push({ mk, buf: base.subarray(i, i + 2) }); break; }
    let end = i + 2 + base.readUInt16BE(i + 2);
    if (mk === 0xda) while (!(base[end] === 0xff && base[end + 1] !== 0 && !(base[end + 1] >= 0xd0 && base[end + 1] <= 0xd7))) end++;
    segs.push({ mk, buf: base.subarray(i, end) }); i = end;
  }
  const sosAt = segs.map((x, j) => (x.mk === 0xda && x.buf[5 + 2 * x.buf[4]] > 0 ? j : -1)).filter((j) => j >= 0).at(-1);
  const dht = segs.slice(0, sosAt).filter((x) => x.mk === 0xc4).at(-1);
  const bomb = Buffer.concat([base.subarray(0, 2), ...segs.slice(0, -1).map((x) => x.buf), dht.buf, ...Array(300).fill(segs[sosAt].buf), Buffer.from([0xff, 0xd9])]);
  const rb = W.shrinkBytes(bomb, 1600, 4), rok = W.shrinkBytes(base, 1600, 4);
  check(rok.rc === "ok" && rb.rc === "threw" && /too big/.test(rb.note), `a progressive JPEG repeating a scan 300 times is refused past its 100th, the same file without them is shrunk (${rb.rc} ${rb.note}; ${rok.rc})`);
  // P5: an animated PNG is left as sent, not flattened to its default image
  const still = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#c33" } }).png().toBuffer();
  const actl = Buffer.alloc(8); actl.writeUInt32BE(2, 0);
  const apng = Buffer.concat([still.subarray(0, 33), chunk("acTL", actl), still.subarray(33)]);
  const ra = W.shrinkBytes(apng, 1600, 4);
  check(ra.rc === "keep" && /animated png/.test(ra.note) && W.shrinkBytes(still, 1600, 4).rc === "ok", `an animated PNG is left as sent, a still one shrunk (${ra.rc} ${ra.note})`);
  // P1: a picture whose run was killed waits behind the untried ones, so it cannot be claimed first by every tick
  const s = await setup(), batch0 = W.IMG.batch; W.IMG.batch = 1;
  const kKiller = s.put(1, PHOTO, "image/jpeg"), kOlder = s.put(2, PHOTO, "image/jpeg");
  s.sq.prepare("UPDATE img_work SET tries = 2 WHERE key = ?").run(kKiller);
  await W.tick(s.env); W.IMG.batch = batch0;
  check(s.row(kOlder).state === "done" && s.row(kKiller).state === "pending", `a picture that killed two runs waits behind an older one never tried (${s.row(kOlder).state}, ${s.row(kKiller).state})`);
  // P4: a run that drops an instance grown past 32 MiB takes no further picture (a 40,000 x 1,600 JPEG turned by its EXIF grows to 66 MiB)
  const tall = await sharp({ create: { width: 40000, height: 1600, channels: 3, background: "#468" } }).jpeg({ quality: 60 }).withMetadata({ orientation: 6 }).toBuffer();
  const s2 = await setup(), kTall = s2.put(1, tall, "image/jpeg"), kNext = s2.put(2, PHOTO, "image/jpeg");
  await W.tick(s2.env); const mid = s2.row(kNext).state; await W.tick(s2.env);
  check(s2.row(kTall).state === "skipped" && mid === "pending" && s2.row(kNext).state === "done", `after dropping an instance grown past 32 MiB the run takes no further picture; the next tick does (${s2.row(kTall).state} ${s2.row(kTall).note}, ${mid} then ${s2.row(kNext).state})`);
}
// 3f.
{
  // finding 10: a GIF's frames are charged their own area, not the canvas's: fifty 4000 x 4000 frames on a 1100 x 1 canvas are refused
  const big = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "#123" } }).gif().toBuffer();
  let at = 13 + ((big[10] & 0x80) ? 3 * (2 << (big[10] & 7)) : 0);
  while (big[at] === 0x21) { at += 2; while (big[at]) at += big[at] + 1; at++; }   // skip extensions
  const start = at; at += 10; if (big[start + 9] & 0x80) at += 3 * (2 << (big[start + 9] & 7)); at++;   // descriptor, local table, min code size
  while (big[at]) at += big[at] + 1; at++;
  const frame = big.subarray(start, at), lsd = Buffer.from(big.subarray(0, 13)); lsd.writeUInt16LE(1100, 6); lsd.writeUInt16LE(1, 8);
  const gct = big.subarray(13, 13 + ((big[10] & 0x80) ? 3 * (2 << (big[10] & 7)) : 0));
  const bomb = Buffer.concat([lsd, gct, ...Array(50).fill(frame), Buffer.from([0x3b])]);
  const t0 = performance.now(), rg = W.shrinkBytes(bomb, 1600, 2), ms = performance.now() - t0;
  check(rg.rc === "too big" && /frames past the limit/.test(rg.note || ""), `fifty 4000 x 4000 frames on a 1100 x 1 canvas (${(bomb.length / 1024).toFixed(0)} KB) are refused before they are decoded (${rg.rc} ${rg.note}, ${ms.toFixed(0)} ms)`);
  // finding 6: retiring an instance after IMG.reuse pictures counts as a big drop when it had grown past 32 MiB, and the run then takes no
  // phone width
  const tallPng = await sharp({ create: { width: 1200, height: 15000, channels: 3, background: "#456" } }).png().toBuffer();
  const s = await setup(), reuse0 = W.IMG.reuse; W.IMG.reuse = 1;
  const k = s.put(1, tallPng, "image/png"), d0 = W.bigDropCount();
  await W.tick(s.env); W.IMG.reuse = reuse0;
  check(W.bigDropCount() === d0 + 1 && s.row(k).state === "done" && /1080: skipped \(a big instance was dropped/.test(s.row(k).note || "") && s.STORE.m.has("imgv/" + k.slice(4) + "-1600"),
    `an instance past 32 MiB retired at its reuse limit counts as a big drop, and the run makes no phone size after it (${W.bigDropCount() - d0}, ${s.row(k).note})`);
}
// 3g. out of memory at the desktop size: 2,000 x 2,000 PNGs with transparency, the alpha plane what costs the memory
{
  let seed = 7; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 255;
  const rgba = (fa, fc) => { const b = Buffer.alloc(2000 * 2000 * 4); for (let y = 0, i = 0; y < 2000; y++) for (let x = 0; x < 2000; x++, i += 4) { const c = fc(x, y); b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = fa(x, y); } return sharp(b, { raw: { width: 2000, height: 2000, channels: 4 } }).png().toBuffer(); };
  // a soft radial shadow: too much for effort 4 at 1,600 px, fits at effort 2
  const SOFT = await rgba((x, y) => Math.max(0, Math.min(255, Math.round(255 - Math.hypot(x - 1000, y - 1000) / 5.5 + (rnd() % 13) - 6))), (x, y) => [(x * 255 / 2000) | 0, (y * 255 / 2000) | 0, 120]);
  // noise in the alpha: fits at no effort at 1,600 px, fits at 1,080
  const GRAIN = await rgba(() => rnd(), () => [200, 60, 40]);
  const s = await setup(), k = s.put(1, SOFT, "image/png");
  await W.tick(s.env); const r1 = s.row(k);
  await W.tick(s.env); const r2 = s.row(k), sizes = ["1600", "1080"].map((w) => s.STORE.m.has(`imgv/${k.slice(4)}-${w}`));
  check(r1.state === "pending" && r1.tries === 0 && /^lean: 1600: no memory at effort 4/.test(r1.note || "") && r2.state === "done" && sizes.every(Boolean) && !s.STORE.m.has(k),
    `a soft shadow out of memory at effort 4 waits a minute, not counted as a failure, then gets both sizes at effort 2 and its original goes (${r1.state} "${r1.note}", then ${r2.state}, sizes ${sizes})`);
  const g = await setup(), kg = g.put(1, GRAIN, "image/png");
  await W.tick(g.env); const g1 = g.row(kg); await W.tick(g.env); const g2 = g.row(kg); await W.tick(g.env); const g3 = g.row(kg);
  const p16 = g.STORE.m.has(`imgv/${kg.slice(4)}-1600`), p10 = g.STORE.m.get(`imgv/${kg.slice(4)}-1080`);
  check(g1.state === "pending" && /^lean: 1600/.test(g1.note || "") && g2.state === "pending" && /^lean: phone size only/.test(g2.note || "") && g3.state === "done" && !p16 && !!p10 && g.STORE.m.has(kg),
    `one that fits at no effort gets the phone size alone on the third minute, its original kept for the desktop (${g1.note} / ${g2.note} / ${g3.state} ${g3.note}; 1600 ${p16}, 1080 ${!!p10})`);
  check(g3.kept === GRAIN.length + (p10 ? p10.buf.length : 0) && g3.tries === 0, `and what is kept counts the original and the phone size (${g3.kept} = ${GRAIN.length} + ${p10 && p10.buf.length}, tries ${g3.tries})`);
}
// 4. the reused instance gives the same bytes as the first call, over more pictures than one instance lives for
{
  const first = W.shrinkBytes(PHOTO, 1080, 4); let same = first.rc === "ok";
  for (let i = 0; i < W.IMG.reuse + 5; i++) { const r = W.shrinkBytes(i % 2 ? TEXTPNG : PHOTO, 1080, 4); if (i % 2 === 0 && Buffer.compare(Buffer.from(r.out), Buffer.from(first.out)) !== 0) same = false; }
  const bad = W.shrinkBytes(CORRUPT, 1080, 4), after = W.shrinkBytes(PHOTO, 1080, 4);
  check(same && bad.rc !== "ok" && Buffer.compare(Buffer.from(after.out), Buffer.from(first.out)) === 0, `the same bytes every time, across instance reuse and after a corrupt file (${bad.rc})`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
