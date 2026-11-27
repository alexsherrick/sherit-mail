// A logo's fingerprint, for the hub's copied-logo check: is a new sender's logo the picture of a brand it is not?
// The logo is drawn on white at 256 px, cropped to what is not near-white, fitted into a square, and read two ways: greyed to 32 x 32 and
// transformed (DCT), its 63 low frequencies above or below their median (a perceptual hash, `ph`); and its colours, the mean of 4 x 4
// cells (`sig`). Two logos match when the hashes differ in at most 8 bits and the colours by at most 24 (hub index.js LOGO_COPY).
// Measured 2026-11-26 on 1,493 logos (the 355 of the user's senders that draw, and 1,138 variants of Tranco's top 1,000):
//  - copies a copier would serve: the file re-saved as JPEG matched 94 %, as WebP 86 %, shrunk to half and padded 81 % (exact 100 %);
//  - each sender's logo taken as a stranger's, against every other name's: 20 of 355 matched, 19 of them the same company's other
//  domain (apple / icloud-content, costco / costcotravel, square / squareup, x / twitter...), 1 two sites on a builder's default icon.
// Cropping is what lets a shrunk or padded copy match; drawing at 64 px instead of 256 halved the padded copies caught. `sd`, the spread
// of the grey grid: a flat picture (blank, one colour, under 12) matches anything and is never used.
// SVG, PNG, JPEG and GIF are drawn by resvg (MPL-2.0, a raster inside an <svg><image>); WebP by logodec.wasm (libwebp); an ICO's
// largest entry, a PNG or a BMP (decoded here).
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import RESVG_WASM from "@resvg/resvg-wasm/index_bg.wasm";
import LOGODEC_WASM from "../wasm/logodec.wasm";

const S = 256, N = 32, BG = 230;
let ready = null, LD = null;
function init() {
  return (ready ??= (async () => {
    await initWasm(RESVG_WASM);
    const nop = () => 0;
    LD = new WebAssembly.Instance(LOGODEC_WASM, { wasi_snapshot_preview1: { clock_time_get: nop, fd_close: nop, fd_seek: nop, fd_write: nop } }).exports;
    LD._initialize();
  })().catch((e) => { ready = null; throw e; }));
}
function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return "ico";
  const head = new TextDecoder().decode(b.subarray(0, 1024)).toLowerCase();
  return head.includes("<svg") ? "svg" : null;
}
function icoPick(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint16(4, true); let best = null;
  for (let i = 0; i < Math.min(n, 64) && 6 + 16 * i + 16 <= b.length; i++) {
    const o = 6 + 16 * i, w = b[o] || 256, h = b[o + 1] || 256, size = dv.getUint32(o + 8, true), off = dv.getUint32(o + 12, true);
    if (!size || off + size > b.length) continue;
    if (!best || w * h > best.w * best.h) best = { w, h, off, size };
  }
  if (!best) return null;
  const e = b.subarray(best.off, best.off + best.size);
  if (e[0] === 0x89 && e[1] === 0x50) return { png: e };
  if (e.length < 40) return null;
  const edv = new DataView(e.buffer, e.byteOffset, e.byteLength), hs = edv.getUint32(0, true), w = edv.getInt32(4, true), h = Math.abs(edv.getInt32(8, true)) / 2, bpp = edv.getUint16(14, true);
  if ((bpp !== 32 && bpp !== 24) || w <= 0 || h <= 0 || w > 512 || h > 512) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4, maskStride = Math.ceil(w / 32) * 4, maskOff = hs + stride * h;
  if (hs + stride * h > e.length) return null;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = hs + (h - 1 - y) * stride + x * (bpp / 8), d = (y * w + x) * 4;
    px[d] = e[s + 2]; px[d + 1] = e[s + 1]; px[d + 2] = e[s];
    let a = bpp === 32 ? e[s + 3] : 255;
    if (bpp === 24 && maskOff + maskStride * h <= e.length && (e[maskOff + (h - 1 - y) * maskStride + (x >> 3)] & (0x80 >> (x & 7)))) a = 0;
    px[d + 3] = a;
  }
  return { w, h, px };
}
function draw(svg) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: S }, background: "white", font: { loadSystemFonts: false } });
  try { const img = r.render(); const out = { w: img.width, h: img.height, px: img.pixels.slice() }; img.free(); return out; } finally { r.free(); }
}
const wrap = (mime, u8) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><image width="${S}" height="${S}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${b64(u8)}"/></svg>`;
function webp(b) {
  const p = LD.ld_alloc(b.length); if (!p) return null;
  new Uint8Array(LD.memory.buffer, p, b.length).set(b); const ok = LD.ld_webp(p, b.length); LD.ld_free(p);
  if (!ok) return null;
  const w = LD.ld_w(), h = LD.ld_h(), px = new Uint8Array(LD.memory.buffer, LD.ld_ptr(), w * h * 4).slice(); LD.ld_release();
  return { w, h, px };
}
function pixels(b) {
  const k = sniff(b);
  if (k === "svg") return draw(new TextDecoder().decode(b));
  if (k === "webp") return webp(b);
  if (k === "png" || k === "jpeg" || k === "gif") return draw(wrap("image/" + k, b));
  if (k === "ico") { const e = icoPick(b); return !e ? null : e.png ? draw(wrap("image/png", e.png)) : e; }
  return null;
}
function grey(p) {
  const { w, h, px } = p, L = new Float64Array(w * h); let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, a = px[i + 3] / 255, l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * a + 255 * (1 - a); L[y * w + x] = l;
    if (l < BG) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const g = new Float64Array(N * N).fill(255); if (x1 < 0) return { g, ink: 0 };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, side = Math.max(cw, ch), ox = (side - cw) / 2, oy = (side - ch) / 2, c = new Float64Array(N * N), sum = new Float64Array(N * N);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const gx = Math.min(N - 1, Math.floor(((x - x0 + ox) / side) * N)), gy = Math.min(N - 1, Math.floor(((y - y0 + oy) / side) * N));
    sum[gy * N + gx] += L[y * w + x]; c[gy * N + gx]++;
  }
  let ink = 0; for (let i = 0; i < N * N; i++) { if (c[i]) g[i] = sum[i] / c[i]; if (g[i] < BG - 10) ink++; }
  return { g, ink: ink / (N * N) };
}
const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));
function colours(p) {
  const { w, h, px } = p, on = (i) => { const a = px[i + 3] / 255; return [px[i] * a + 255 * (1 - a), px[i + 1] * a + 255 * (1 - a), px[i + 2] * a + 255 * (1 - a)]; };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = on((y * w + x) * 4); if (0.299 * r + 0.587 * g + 0.114 * b < BG) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  const sig = new Uint8Array(48).fill(255); if (x1 < 0) return sig;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, side = Math.max(cw, ch), ox = (side - cw) / 2, oy = (side - ch) / 2, sum = new Float64Array(48), n = new Float64Array(16);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cx = Math.min(3, Math.floor(((x - x0 + ox) / side) * 4)), cy = Math.min(3, Math.floor(((y - y0 + oy) / side) * 4)), k = cy * 4 + cx, [r, g, b] = on((y * w + x) * 4);
    sum[k * 3] += r; sum[k * 3 + 1] += g; sum[k * 3 + 2] += b; n[k]++;
  }
  for (let k = 0; k < 16; k++) if (n[k]) for (let c = 0; c < 3; c++) sig[k * 3 + c] = Math.round(sum[k * 3 + c] / n[k]);
  return sig;
}
const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, "0")).join("");
// { ph: 16 hex digits, sig: 96 hex digits, sd, ink, w, h } or null when the bytes are no picture this reads
export async function logoMark(bytes) {
  await init();
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), p = pixels(b);
  if (!p || !p.w || !p.h) return null;
  const { g, ink } = grey(p), d = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let s = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += g[y * N + x] * COS[u][x] * COS[v][y]; d.push(s); }
  const ac = d.slice(1), med = [...ac].sort((a, b) => a - b)[31];
  let hi = 0, lo = 0; ac.forEach((x, i) => { if (x > med) { if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32); } });
  let m = 0; for (const x of g) m += x; m /= g.length; let v2 = 0; for (const x of g) v2 += (x - m) ** 2;
  return { ph: (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0"), sig: hex(colours(p)), sd: Math.round(Math.sqrt(v2 / g.length) * 10) / 10, ink: Math.round(ink * 1000) / 1000, w: p.w, h: p.h };
}
