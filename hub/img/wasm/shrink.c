// shrink.c: the mail hub's streaming picture shrinker, run by the mailhub-img Worker.
//
// The point: memory follows the OUTPUT size, not the input. A picture is never held whole at its original size:
//  - JPEG decodes already shrunk (libjpeg-turbo's scaled IDCT, N/8) and a strip of rows at a time;
//  - PNG decodes one row at a time (libspng progressive);
//  - GIF decodes one frame at a time onto one canvas (giflib's line API), each frame shrunk and handed to libwebp's
//  animation encoder, which keeps only the previous canvas and the compressed frames;
//  - every row goes through an area-averaging downscaler (each output pixel = the exact average of the input area it
//  covers, alpha-weighted), so only one output row of floats is accumulated at a time.
// Only the finished, small picture exists whole, and then the WebP encoder runs on it.
// A JPEG's, PNG's or WebP's colour profile goes into the WebP (its ICCP chunk), unless it is sRGB, which a browser assumes anyway.
//
// Errors: libjpeg's error_exit, and anything else fatal, calls the imported env.sk_throw(), which throws in JavaScript
// and unwinds this instance; the caller drops the instance (one instance per picture), so nothing leaks between pictures.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "jpeglib.h"
#include "spng.h"
#include "gif_lib.h"
#include "webp/encode.h"
#include "webp/decode.h"
#include "webp/mux.h"

#define EXPORT(name) __attribute__((export_name(#name)))
__attribute__((import_module("env"), import_name("sk_throw"), noreturn)) void sk_throw(int code);

enum { F_UNKNOWN = 0, F_JPEG = 1, F_PNG = 2, F_GIF = 3, F_WEBP = 4 };
enum { R_OK = 0, R_KEEP = 1, R_UNSUPPORTED = 2, R_TOO_BIG = 3, R_BAD = 4, R_NOMEM = 5 };

static struct {
  uint8_t *out; size_t out_len; int out_w, out_h, in_w, in_h, frames, format, has_alpha;
  char err[160];
} R;

EXPORT(sk_alloc) void *sk_alloc(size_t n) { return malloc(n); }
EXPORT(sk_free) void sk_free(void *p) { free(p); }
EXPORT(sk_out_ptr) uint8_t *sk_out_ptr(void) { return R.out; }
EXPORT(sk_out_len) size_t sk_out_len(void) { return R.out_len; }
EXPORT(sk_out_w) int sk_out_w(void) { return R.out_w; }
EXPORT(sk_out_h) int sk_out_h(void) { return R.out_h; }
EXPORT(sk_in_w) int sk_in_w(void) { return R.in_w; }
EXPORT(sk_in_h) int sk_in_h(void) { return R.in_h; }
EXPORT(sk_frames) int sk_frames(void) { return R.frames; }
EXPORT(sk_format) int sk_format(void) { return R.format; }
EXPORT(sk_alpha) int sk_alpha(void) { return R.has_alpha; }
EXPORT(sk_err) const char *sk_err(void) { return R.err; }
// The caller has copied the result out: free it, so one instance can take the next picture.
EXPORT(sk_release) void sk_release(void) { if (R.out) WebPFree(R.out); R.out = NULL; R.out_len = 0; }

static int fail(int code, const char *msg) { snprintf(R.err, sizeof R.err, "%s", msg); return code; }

// ---------------------------------------------------------------- the colour profile
// An RGB ICC profile is carried into the WebP's ICCP chunk, so a browser draws the colours the original meant: a Display P3 picture
// shrunk without its profile came out duller (measured in November 2026 on received mail, as a colour-managed browser shows it: a mean error
// of 7.7 of 255 where sharp, which converts to sRGB, had 4.6). A profile that says sRGB is left out: with none a browser assumes sRGB,
// and it would cost 0.5-3 KB a picture. A grey or CMYK profile does not describe the RGB WebP and is left out too.
static uint8_t *g_icc; static size_t g_icc_len;
static void icc_clear(void) { free(g_icc); g_icc = NULL; g_icc_len = 0; }
static uint32_t icc32(const uint8_t *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
// Only the first 'desc' entry is read, and only its first 256 bytes (a description is a few dozen): a profile whose every tag pointed
// at the whole of a 1 MB body made this scan quadratic, 48 s for one size.
static int icc_is_srgb(const uint8_t *p, size_t n) {   // its description ('desc': ASCII in v2, UTF-16BE in v4) names sRGB
  uint32_t cnt = icc32(p + 128);
  for (uint32_t i = 0; i < cnt && 132 + 12 * ((size_t)i + 1) <= n; i++) {
    const uint8_t *e = p + 132 + 12 * (size_t)i; uint32_t off = icc32(e + 4), len = icc32(e + 8);
    if (memcmp(e, "desc", 4)) continue;
    if (off > n || len > n - off) return 0;
    if (len > 256) len = 256;
    for (uint32_t k = 0; k + 4 <= len; k++) if (!memcmp(p + off + k, "sRGB", 4)) return 1;
    for (uint32_t k = 0; k + 8 <= len; k++) if (!memcmp(p + off + k, "\0s\0R\0G\0B", 8)) return 1;
    return 0;
  }
  return 0;
}
static void icc_take(const uint8_t *p, size_t n) {   // a copy is kept when the WebP should carry it
  icc_clear();
  if (!p || n < 132 || memcmp(p + 36, "acsp", 4) || memcmp(p + 16, "RGB ", 4) || icc_is_srgb(p, n)) return;
  if (!(g_icc = malloc(n))) sk_throw(R_NOMEM);
  memcpy(g_icc, p, n); g_icc_len = n;
}
static int icc_attach(void) {   // the encoded still gains the kept profile (the mux writes the VP8X header that announces it)
  if (!g_icc || !R.out) return R_OK;
  WebPData img = { R.out, R.out_len }, icc = { g_icc, g_icc_len }, out; WebPDataInit(&out);
  WebPMux *mux = WebPMuxCreate(&img, 0);
  int ok = mux && WebPMuxSetChunk(mux, "ICCP", &icc, 0) == WEBP_MUX_OK && WebPMuxAssemble(mux, &out) == WEBP_MUX_OK;
  if (mux) WebPMuxDelete(mux);
  icc_clear();
  if (!ok) { WebPDataClear(&out); sk_release(); return fail(R_NOMEM, "colour profile"); }
  WebPFree(R.out); R.out = (uint8_t *)out.bytes; R.out_len = out.size; return R_OK;
}

// ---------------------------------------------------------------- the streaming area-averaging downscaler
// Rows of `ch` 8-bit channels (3 = RGB, 4 = RGBA) go in top to bottom; each finished output row is handed to `fn`.
// Weights are exact overlaps: output pixel x covers input [x*sx, (x+1)*sx). Alpha-weighted (premultiplied) when ch == 4.
typedef void (*RowFn)(void *ctx, int y, const uint8_t *row);
typedef struct {
  int iw, ih, ow, oh, ch;
  double sx, sy;
  int *xs, *xn; float *xw;  // per output column: first input column, count, weights (flattened, stride xmax)
  int xmax;
  float *hrow, *acc;         // one horizontally reduced row; the accumulating output row
  uint8_t *out;              // one finished 8-bit output row
  int y;                     // next output row to finish
  int r;                     // next input row expected
  double acc_w;              // input-row weight accumulated into acc
  RowFn fn; void *ctx;
} Scaler;

static void scaler_free(Scaler *s) { free(s->xs); free(s->xn); free(s->xw); free(s->hrow); free(s->acc); free(s->out); memset(s, 0, sizeof *s); }

static int scaler_init(Scaler *s, int iw, int ih, int ow, int oh, int ch, RowFn fn, void *ctx) {
  memset(s, 0, sizeof *s);
  s->iw = iw; s->ih = ih; s->ow = ow; s->oh = oh; s->ch = ch; s->fn = fn; s->ctx = ctx;
  s->sx = (double)iw / ow; s->sy = (double)ih / oh;
  s->xmax = (int)ceil(s->sx) + 2;
  s->xs = malloc(sizeof(int) * ow); s->xn = malloc(sizeof(int) * ow); s->xw = malloc(sizeof(float) * ow * s->xmax);
  s->hrow = malloc(sizeof(float) * ow * ch); s->acc = calloc((size_t)ow * ch, sizeof(float)); s->out = malloc((size_t)ow * ch);
  if (!s->xs || !s->xn || !s->xw || !s->hrow || !s->acc || !s->out) { scaler_free(s); return 0; }
  for (int x = 0; x < ow; x++) {
    double a = x * s->sx, b = (x + 1) * s->sx; int i0 = (int)floor(a), i1 = (int)ceil(b); if (i1 > iw) i1 = iw;
    s->xs[x] = i0; s->xn[x] = i1 - i0;
    for (int i = i0; i < i1; i++) { double lo = i > a ? i : a, hi = i + 1 < b ? i + 1 : b; s->xw[x * s->xmax + (i - i0)] = (float)((hi - lo) / s->sx); }
  }
  return 1;
}

static void scaler_emit(Scaler *s) {
  uint8_t *o = s->out; const float *a = s->acc; const float inv = (float)(1.0 / s->acc_w);
  if (s->ch == 4) {
    // acc holds sums of alpha*value (premultiplied) and of alpha; the colour is their ratio, the alpha their mean.
    for (int x = 0; x < s->ow; x++, a += 4, o += 4) {
      float al = a[3] * inv;
      if (al <= 0.0f) { o[0] = o[1] = o[2] = o[3] = 0; continue; }
      float k = inv / al;
      for (int c = 0; c < 3; c++) { float v = a[c] * k + 0.5f; o[c] = v >= 255.f ? 255 : v <= 0.f ? 0 : (uint8_t)v; }
      float v = al + 0.5f; o[3] = v >= 255.f ? 255 : (uint8_t)v;
    }
  } else {
    for (int x = 0; x < s->ow * s->ch; x++) { float v = a[x] * inv + 0.5f; o[x] = v >= 255.f ? 255 : v <= 0.f ? 0 : (uint8_t)v; }
  }
  s->fn(s->ctx, s->y, s->out);
  memset(s->acc, 0, sizeof(float) * s->ow * s->ch); s->acc_w = 0; s->y++;
}

static void scaler_row(Scaler *s, const uint8_t *in) {
  if (s->y >= s->oh) { s->r++; return; }
  // horizontal: weighted sums per output column (premultiplied by alpha when there is one)
  float *h = s->hrow; const int ch = s->ch;
  for (int x = 0; x < s->ow; x++) {
    const float *w = s->xw + x * s->xmax; const uint8_t *p = in + (size_t)s->xs[x] * ch; int n = s->xn[x];
    if (ch == 4) {
      float r = 0, g = 0, b = 0, al = 0;
      for (int i = 0; i < n; i++, p += 4) { float wa = w[i] * p[3]; r += wa * p[0]; g += wa * p[1]; b += wa * p[2]; al += w[i] * p[3]; }
      h[x * 4] = r; h[x * 4 + 1] = g; h[x * 4 + 2] = b; h[x * 4 + 3] = al;
    } else {
      float r = 0, g = 0, b = 0;
      for (int i = 0; i < n; i++, p += 3) { r += w[i] * p[0]; g += w[i] * p[1]; b += w[i] * p[2]; }
      h[x * 3] = r; h[x * 3 + 1] = g; h[x * 3 + 2] = b;
    }
  }
  // vertical: this input row [r, r+1) overlaps output rows by coverage
  double top = s->r, bot = s->r + 1.0; s->r++;
  while (s->y < s->oh) {
    double y0 = s->y * s->sy, y1 = (s->y + 1) * s->sy; if (s->y == s->oh - 1) y1 = s->ih;
    double lo = top > y0 ? top : y0, hi = bot < y1 ? bot : y1;
    if (hi > lo) { float w = (float)(hi - lo); float *a = s->acc; int n = s->ow * ch; for (int i = 0; i < n; i++) a[i] += w * h[i]; s->acc_w += hi - lo; }
    if (bot >= y1 - 1e-9) scaler_emit(s); else break;
    if (bot <= s->y * s->sy) break;
  }
}

// ---------------------------------------------------------------- Lanczos-3, streamed (the last, at most 2x, step)
// Separable: each input row is filtered horizontally into a ring of float rows; an output row is filtered vertically from the
// ring as soon as its last input row has arrived. The ring holds ~6 x scale + 2 rows, so memory stays with the output width.
// Premultiplied when ch == 4. Edges repeat the edge pixel. This is what libvips (sharp) does after its box shrink.
typedef struct {
  int iw, ih, ow, oh, ch;
  int *hx, *hn; float *hw; int hmax;   // horizontal taps per output column
  int *vy, *vn; float *vw; int vmax;   // vertical taps per output row
  float *ring; int ringN; uint8_t *out;
  int r, y; RowFn fn; void *ctx;
} Lz;
static double lanczos3(double x) { if (x == 0) return 1; if (x <= -3 || x >= 3) return 0; double px = M_PI * x; return 3 * sin(px) * sin(px / 3) / (px * px); }
static int taps(int in, int out, int **first, int **count, float **wts, int *maxn) {
  double sc = (double)in / out, fs = sc > 1 ? sc : 1, sup = 3 * fs; int mx = (int)ceil(2 * sup) + 2;
  *first = malloc(sizeof(int) * out); *count = malloc(sizeof(int) * out); *wts = calloc((size_t)out * mx, sizeof(float)); *maxn = mx;
  if (!*first || !*count || !*wts) return 0;
  for (int o = 0; o < out; o++) {
    double c = (o + 0.5) * sc - 0.5; int a = (int)ceil(c - sup), b = (int)floor(c + sup);
    int lo = a < 0 ? 0 : a, hi = b > in - 1 ? in - 1 : b; if (hi < lo) hi = lo;
    float *w = *wts + (size_t)o * mx; double sum = 0;
    for (int i = a; i <= b; i++) { int k = i < lo ? lo : i > hi ? hi : i; double v = lanczos3((i - c) / fs); w[k - lo] += (float)v; sum += v; }
    if (sum != 0) for (int k = 0; k <= hi - lo; k++) w[k] = (float)(w[k] / sum);
    (*first)[o] = lo; (*count)[o] = hi - lo + 1;
  }
  return 1;
}
static void lz_free(Lz *l) { free(l->hx); free(l->hn); free(l->hw); free(l->vy); free(l->vn); free(l->vw); free(l->ring); free(l->out); memset(l, 0, sizeof *l); }
static int lz_init(Lz *l, int iw, int ih, int ow, int oh, int ch, RowFn fn, void *ctx) {
  memset(l, 0, sizeof *l); l->iw = iw; l->ih = ih; l->ow = ow; l->oh = oh; l->ch = ch; l->fn = fn; l->ctx = ctx;
  if (!taps(iw, ow, &l->hx, &l->hn, &l->hw, &l->hmax) || !taps(ih, oh, &l->vy, &l->vn, &l->vw, &l->vmax)) { lz_free(l); return 0; }
  l->ringN = l->vmax + 1; l->ring = malloc(sizeof(float) * l->ringN * ow * ch); l->out = malloc((size_t)ow * ch);
  if (!l->ring || !l->out) { lz_free(l); return 0; }
  return 1;
}
static void lz_emit(Lz *l) {
  const int n = l->ow * l->ch, y = l->y; const float *w = l->vw + (size_t)y * l->vmax; uint8_t *o = l->out;
  static float acc[16384 * 4]; if (n > 16384 * 4) sk_throw(R_TOO_BIG);
  memset(acc, 0, sizeof(float) * n);
  for (int k = 0; k < l->vn[y]; k++) { const float *row = l->ring + (size_t)((l->vy[y] + k) % l->ringN) * n; float wk = w[k]; for (int i = 0; i < n; i++) acc[i] += wk * row[i]; }
  if (l->ch == 4) {
    for (int x = 0; x < l->ow; x++) {
      float A = acc[x * 4 + 3];
      if (A <= 0.5f) { o[x * 4] = o[x * 4 + 1] = o[x * 4 + 2] = o[x * 4 + 3] = 0; continue; }
      for (int c = 0; c < 3; c++) { float v = acc[x * 4 + c] / A + 0.5f; o[x * 4 + c] = v >= 255.f ? 255 : v <= 0.f ? 0 : (uint8_t)v; }
      float v = A + 0.5f; o[x * 4 + 3] = v >= 255.f ? 255 : (uint8_t)v;
    }
  } else for (int i = 0; i < n; i++) { float v = acc[i] + 0.5f; o[i] = v >= 255.f ? 255 : v <= 0.f ? 0 : (uint8_t)v; }
  l->fn(l->ctx, y, o); l->y++;
}
static void lz_row(Lz *l, const uint8_t *in) {
  const int ch = l->ch; float *h = l->ring + (size_t)(l->r % l->ringN) * l->ow * ch;
  for (int x = 0; x < l->ow; x++) {
    const float *w = l->hw + (size_t)x * l->hmax; const uint8_t *p = in + (size_t)l->hx[x] * ch; int n = l->hn[x];
    if (ch == 4) { float r = 0, g = 0, b = 0, a = 0; for (int i = 0; i < n; i++, p += 4) { float wa = w[i] * p[3]; r += wa * p[0]; g += wa * p[1]; b += wa * p[2]; a += wa; } h[x * 4] = r; h[x * 4 + 1] = g; h[x * 4 + 2] = b; h[x * 4 + 3] = a; }
    else { float r = 0, g = 0, b = 0; for (int i = 0; i < n; i++, p += 3) { r += w[i] * p[0]; g += w[i] * p[1]; b += w[i] * p[2]; } h[x * 3] = r; h[x * 3 + 1] = g; h[x * 3 + 2] = b; }
  }
  l->r++;
  while (l->y < l->oh && l->vy[l->y] + l->vn[l->y] <= l->r) lz_emit(l);
}

// ---------------------------------------------------------------- the resizer: box shrink to within 2x, then Lanczos-3
// (alpha in the Lanczos ring is premultiplied: colour sums carry alpha/255, the alpha sum carries 255)
typedef struct { Scaler a; Lz l; int useA, useL, pass, py; RowFn fn; void *ctx; int ch, ow; } Rs;
static void rs_mid(void *ctx, int y, const uint8_t *row) { Rs *r = ctx; (void)y; lz_row(&r->l, row); }
static void rs_free(Rs *r) { if (r->useA) scaler_free(&r->a); if (r->useL) lz_free(&r->l); memset(r, 0, sizeof *r); }
static int rs_init(Rs *r, int iw, int ih, int ow, int oh, int ch, RowFn fn, void *ctx) {
  memset(r, 0, sizeof *r); r->fn = fn; r->ctx = ctx; r->ch = ch; r->ow = ow;
  if (iw == ow && ih == oh) { r->pass = 1; return 1; }
  int kx = (double)iw / ow >= 2 ? (int)floor((double)iw / ow) : 1, ky = (double)ih / oh >= 2 ? (int)floor((double)ih / oh) : 1;
  int mw = kx > 1 ? (int)lround((double)iw / kx) : iw, mh = ky > 1 ? (int)lround((double)ih / ky) : ih;
  if (mw < ow) mw = ow; if (mh < oh) mh = oh;
  r->useA = mw != iw || mh != ih; r->useL = mw != ow || mh != oh;
  if (r->useL && !lz_init(&r->l, mw, mh, ow, oh, ch, fn, ctx)) return 0;
  if (r->useA && !scaler_init(&r->a, iw, ih, mw, mh, ch, r->useL ? rs_mid : fn, r->useL ? (void *)r : ctx)) { if (r->useL) lz_free(&r->l); return 0; }
  return 1;
}
static void rs_row(Rs *r, const uint8_t *in) {
  if (r->pass) { r->fn(r->ctx, r->py++, in); return; }   // no resize: rows straight through, numbered
  if (r->useA) scaler_row(&r->a, in); else lz_row(&r->l, in);
}

// A row target that is a whole buffer (for the GIF canvas and for a JPEG that has to be turned).
typedef struct { uint8_t *dst; int stride; } BufCtx;
static void to_buf(void *ctx, int y, const uint8_t *row) { BufCtx *b = ctx; memcpy(b->dst + (size_t)y * b->stride, row, b->stride); }

// ---------------------------------------------------------------- WebP output, straight into the encoder's own planes
// Finished rows are gathered 16 at a time, converted by libwebp's own RGB(A)->YUV(A) code on that band, and the band's planes
// copied into the one full-size picture. So the full-size picture exists only as YUV 4:2:0 (1.5 bytes a pixel, 2.5 with
// alpha), never also as RGB (3-4 bytes a pixel) or as a second copy made by the import.
#define BAND 16
typedef struct { WebPPicture pic; uint8_t *buf; int w, h, ch, rows, top; } Bands;
static int g_method = 4;
static void bands_free(Bands *b) { WebPPictureFree(&b->pic); free(b->buf); b->buf = NULL; }
static int bands_init(Bands *b, int w, int h, int ch) {
  memset(b, 0, sizeof *b);
  if (!WebPPictureInit(&b->pic)) return 0;
  b->pic.use_argb = 0; b->pic.width = w; b->pic.height = h; b->pic.colorspace = ch == 4 ? WEBP_YUV420A : WEBP_YUV420;
  if (!WebPPictureAlloc(&b->pic)) return 0;
  b->buf = malloc((size_t)w * ch * BAND); if (!b->buf) { WebPPictureFree(&b->pic); return 0; }
  b->w = w; b->h = h; b->ch = ch; return 1;
}
static void bands_flush(Bands *b) {
  if (!b->rows) return;
  WebPPicture t; WebPPictureInit(&t); t.use_argb = 0; t.width = b->w; t.height = b->rows;
  int ok = b->ch == 4 ? WebPPictureImportRGBA(&t, b->buf, b->w * 4) : WebPPictureImportRGB(&t, b->buf, b->w * 3);
  if (!ok) sk_throw(R_NOMEM);
  WebPPicture *P = &b->pic; int uvw = (b->w + 1) / 2, uvr = (b->rows + 1) / 2;
  for (int r = 0; r < b->rows; r++) memcpy(P->y + (size_t)(b->top + r) * P->y_stride, t.y + (size_t)r * t.y_stride, b->w);
  for (int r = 0; r < uvr; r++) {
    memcpy(P->u + (size_t)(b->top / 2 + r) * P->uv_stride, t.u + (size_t)r * t.uv_stride, uvw);
    memcpy(P->v + (size_t)(b->top / 2 + r) * P->uv_stride, t.v + (size_t)r * t.uv_stride, uvw);
  }
  if (P->a) for (int r = 0; r < b->rows; r++) {
    uint8_t *d = P->a + (size_t)(b->top + r) * P->a_stride;
    if (t.a) memcpy(d, t.a + (size_t)r * t.a_stride, b->w); else memset(d, 255, b->w);   // an opaque band has no alpha plane
  }
  WebPPictureFree(&t); b->top += b->rows; b->rows = 0;
}
static void to_bands(void *ctx, int y, const uint8_t *row) {
  Bands *b = ctx; (void)y; memcpy(b->buf + (size_t)b->rows * b->w * b->ch, row, (size_t)b->w * b->ch);
  if (++b->rows == BAND) bands_flush(b);
}
static int bands_encode(Bands *b, int quality) {
  bands_flush(b);
  WebPConfig cfg; WebPMemoryWriter wr;
  if (!WebPConfigInit(&cfg)) return fail(R_BAD, "webp init");
  cfg.quality = (float)quality; cfg.method = g_method;
  free(b->buf); b->buf = NULL;   // the band buffer is not needed while encoding
  WebPMemoryWriterInit(&wr); b->pic.writer = WebPMemoryWrite; b->pic.custom_ptr = &wr;
  int ok = WebPEncode(&cfg, &b->pic);
  if (!ok) { int e = b->pic.error_code; WebPMemoryWriterClear(&wr); return fail(e == VP8_ENC_ERROR_OUT_OF_MEMORY ? R_NOMEM : R_BAD, "webp encode"); }
  R.out = wr.mem; R.out_len = wr.size; R.out_w = b->w; R.out_h = b->h;
  return icc_attach();
}
// A whole RGB(A) buffer through the same bands (the turned JPEG).
static int encode_buffer(const uint8_t *px, int w, int h, int ch, int quality) {
  Bands b; if (!bands_init(&b, w, h, ch)) return fail(R_NOMEM, "webp alloc");
  for (int y = 0; y < h; y++) to_bands(&b, y, px + (size_t)y * w * ch);
  int rc = bands_encode(&b, quality); bands_free(&b); return rc;
}

// The output size: never wider than max_w, never more pixels than max_px, never upscaled.
static void fit(int w, int h, int max_w, long max_px, int *ow, int *oh) {
  double k = 1.0;
  if (w > max_w) k = (double)max_w / w;
  if ((double)w * k * h * k > (double)max_px) k = sqrt((double)max_px / ((double)w * h));
  *ow = (int)fmax(1, floor(w * k + 0.5)); *oh = (int)fmax(1, floor(h * k + 0.5));
  if (*ow > w) *ow = w; if (*oh > h) *oh = h;
}

// ---------------------------------------------------------------- JPEG
struct jerr { struct jpeg_error_mgr pub; };
static void jpeg_fail(j_common_ptr c) { (void)c; sk_throw(R_BAD); }
static void jpeg_quiet(j_common_ptr c, int lvl) { (void)c; (void)lvl; }
// A progressive JPEG's scans are decoded one after another, and nothing in libjpeg limits how many there are (libjpeg-turbo leaves it to
// the application: djpeg -maxscans, TJPARAM_SCANLIMIT). A 264 KB file repeating its last refinement scan 6,000 times took 178 s for both
// sizes, past the Worker's CPU limit on every try. Real ones have about ten.
#define JPEG_MAX_SCANS 100
static void jpeg_scans(j_common_ptr c) { if (c->is_decompressor && ((j_decompress_ptr)c)->input_scan_number > JPEG_MAX_SCANS) sk_throw(R_TOO_BIG); }

static int exif_orientation(j_decompress_ptr ci) {
  for (jpeg_saved_marker_ptr m = ci->marker_list; m; m = m->next) {
    if (m->marker != JPEG_APP0 + 1 || m->data_length < 14 || memcmp(m->data, "Exif\0\0", 6)) continue;
    const uint8_t *t = m->data + 6; size_t n = m->data_length - 6; int le = t[0] == 'I';
    #define U16(p) (le ? (p)[0] | (p)[1] << 8 : (p)[0] << 8 | (p)[1])
    #define U32(p) (le ? (uint32_t)((p)[0] | (p)[1] << 8 | (p)[2] << 16 | (uint32_t)(p)[3] << 24) : (uint32_t)((uint32_t)(p)[0] << 24 | (p)[1] << 16 | (p)[2] << 8 | (p)[3]))
    uint32_t ifd = U32(t + 4); if ((size_t)ifd > n || n - ifd < 2) return 1;   // no wrap past the end
    int cnt = U16(t + ifd);
    for (int i = 0; i < cnt; i++) { size_t e = ifd + 2 + 12 * i; if (e + 12 > n) break; if (U16(t + e) == 0x0112) { int v = U16(t + e + 8); return v >= 1 && v <= 8 ? v : 1; } }
    #undef U16
    #undef U32
  }
  return 1;
}

// Turn a w x h buffer of `ch` channels per EXIF orientation 2-8 into a new buffer; returns the new one (or the same).
static uint8_t *orient(uint8_t *src, int w, int h, int ch, int o, int *nw, int *nh) {
  *nw = w; *nh = h; if (o <= 1) return src;
  int swap = o >= 5; if (swap) { *nw = h; *nh = w; }
  uint8_t *dst = malloc((size_t)w * h * ch); if (!dst) sk_throw(R_NOMEM);
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    int dx, dy;
    switch (o) { case 2: dx = w - 1 - x; dy = y; break; case 3: dx = w - 1 - x; dy = h - 1 - y; break; case 4: dx = x; dy = h - 1 - y; break;
      case 5: dx = y; dy = x; break; case 6: dx = h - 1 - y; dy = x; break; case 7: dx = h - 1 - y; dy = w - 1 - x; break; default: dx = y; dy = w - 1 - x; }
    memcpy(dst + ((size_t)dy * *nw + dx) * ch, src + ((size_t)y * w + x) * ch, ch);
  }
  free(src); return dst;
}

static int do_jpeg(const uint8_t *in, size_t len, int max_w, long max_px, int quality) {
  struct jpeg_decompress_struct ci; struct jerr je; struct jpeg_progress_mgr pm = { 0 };
  ci.err = jpeg_std_error(&je.pub); je.pub.error_exit = jpeg_fail; je.pub.emit_message = jpeg_quiet;
  jpeg_create_decompress(&ci);
  pm.progress_monitor = jpeg_scans; ci.progress = &pm;
  jpeg_mem_src(&ci, in, (unsigned long)len);
  jpeg_save_markers(&ci, JPEG_APP0 + 1, 0xFFFF);
  jpeg_save_markers(&ci, JPEG_APP0 + 2, 0xFFFF);   // ICC_PROFILE, in as many APP2 segments as it takes
  jpeg_read_header(&ci, TRUE);
  R.in_w = ci.image_width; R.in_h = ci.image_height;
  // decoded shrunk (N/8) and in strips, a JPEG costs little memory, but its decode time follows its size: 150 MP and over is left as sent
  if ((double)ci.image_width * ci.image_height > 150e6) { jpeg_destroy_decompress(&ci); return fail(R_TOO_BIG, "jpeg over 150 MP"); }
  int o = exif_orientation(&ci), swap = o >= 5;
  int dw = swap ? ci.image_height : ci.image_width, dh = swap ? ci.image_width : ci.image_height, tw, th;
  fit(dw, dh, max_w, max_px, &tw, &th);
  int ow = swap ? th : tw, oh = swap ? tw : th;   // the size in the file's own orientation
  // Shrink while decoding: the smallest N/8 that still leaves at least twice the output (or full size), so the area
  // average does the last, clean step.
  int N = 8;
  for (int n = 1; n <= 8; n++) { if ((long)ci.image_width * n / 8 >= 2L * ow && (long)ci.image_height * n / 8 >= 2L * oh) { N = n; break; } }
  ci.scale_num = N; ci.scale_denom = 8;
  // A progressive JPEG keeps its whole coefficient table while it decodes (2 bytes a coefficient, every block of every
  // component), whatever size it is shrunk to. Past 48 MB of that it is left as it is.
  if (ci.progressive_mode) {
    double coef = 0; for (int i = 0; i < ci.num_components; i++) coef += (double)ci.comp_info[i].width_in_blocks * ci.comp_info[i].height_in_blocks * 64 * sizeof(JCOEF);
    if (coef > 48.0 * 1048576) { jpeg_destroy_decompress(&ci); return fail(R_TOO_BIG, "progressive JPEG over 48 MB of coefficients"); }
  }
  int cmyk = ci.jpeg_color_space == JCS_CMYK || ci.jpeg_color_space == JCS_YCCK;
  // A CMYK JPEG is left as sent: WebKit (the Mac app) turns it to RGB through a colour profile, Chromium (the phone, Windows) by the plain
  // formula below, so no one WebP shows what both did (measured in November 2026: background 62,173,107 in WebKit, 72,254,59 in Chromium).
  if (cmyk) { jpeg_destroy_decompress(&ci); return fail(R_KEEP, "cmyk jpeg kept as sent"); }
  ci.out_color_space = cmyk ? JCS_CMYK : JCS_RGB;
  ci.dct_method = JDCT_ISLOW;
  { JOCTET *icc = NULL; unsigned int n = 0; if (jpeg_read_icc_profile(&ci, &icc, &n)) { icc_take(icc, n); free(icc); } }
  jpeg_start_decompress(&ci);
  int iw = ci.output_width, ih = ci.output_height;
  if (ow > iw) ow = iw; if (oh > ih) oh = ih;
  Bands bd; BufCtx bc = { 0 }; uint8_t *dst = NULL; Rs s; int sok;
  if (o > 1) { dst = malloc((size_t)ow * oh * 3); if (!dst) sk_throw(R_NOMEM); bc.dst = dst; bc.stride = ow * 3; sok = rs_init(&s, iw, ih, ow, oh, 3, to_buf, &bc); }
  else { if (!bands_init(&bd, ow, oh, 3)) sk_throw(R_NOMEM); sok = rs_init(&s, iw, ih, ow, oh, 3, to_bands, &bd); }
  if (!sok) sk_throw(R_NOMEM);
  int strip = ci.rec_outbuf_height > 0 ? ci.rec_outbuf_height : 1; if (strip < 8) strip = 8; if (strip > 64) strip = 64;
  int rowb = iw * ci.output_components;
  uint8_t *buf = malloc((size_t)rowb * strip), *rgb = cmyk ? malloc((size_t)iw * 3) : NULL;
  if (!buf || (cmyk && !rgb)) sk_throw(R_NOMEM);
  JSAMPROW rows[64];
  for (int i = 0; i < strip; i++) rows[i] = buf + (size_t)i * rowb;
  int inverted = ci.saw_Adobe_marker;   // Adobe's CMYK is stored inverted; plain CMYK is not
  while (ci.output_scanline < ci.output_height) {
    int got = jpeg_read_scanlines(&ci, rows, strip);
    for (int i = 0; i < got; i++) {
      if (cmyk) {
        const uint8_t *p = rows[i];
        for (int x = 0; x < iw; x++, p += 4) {
          int c0 = p[0], c1 = p[1], c2 = p[2], k = p[3];
          if (!inverted) { c0 = 255 - c0; c1 = 255 - c1; c2 = 255 - c2; k = 255 - k; }
          rgb[x * 3] = c0 * k / 255; rgb[x * 3 + 1] = c1 * k / 255; rgb[x * 3 + 2] = c2 * k / 255;
        }
        rs_row(&s, rgb);
      } else rs_row(&s, rows[i]);
    }
  }
  jpeg_finish_decompress(&ci); jpeg_destroy_decompress(&ci); free(buf); free(rgb); rs_free(&s);
  R.frames = 1; R.has_alpha = 0;
  if (o > 1) { int fw, fh; dst = orient(dst, ow, oh, 3, o, &fw, &fh); int rc = encode_buffer(dst, fw, fh, 3, quality); free(dst); return rc; }
  int rc = bands_encode(&bd, quality); bands_free(&bd); return rc;
}

// ---------------------------------------------------------------- PNG
// An animated PNG (an acTL chunk before the image data) is left as sent: spng decodes only its default image, often a frame the browser
// never shows, and the WebP would have replaced the animation.
static int png_animated(const uint8_t *in, size_t len) {
  for (size_t at = 8; at + 8 <= len; ) {
    uint32_t n = (uint32_t)in[at] << 24 | (uint32_t)in[at + 1] << 16 | (uint32_t)in[at + 2] << 8 | in[at + 3];
    if (!memcmp(in + at + 4, "acTL", 4)) return 1;
    if (!memcmp(in + at + 4, "IDAT", 4) || n > len - at - 8) return 0;
    at += 12 + (size_t)n;
  }
  return 0;
}
static int do_png(const uint8_t *in, size_t len, int max_w, long max_px, int quality) {
  if (png_animated(in, len)) return fail(R_KEEP, "animated png kept as sent");
  spng_ctx *c = spng_ctx_new(0); if (!c) return fail(R_NOMEM, "spng ctx");
  spng_set_image_limits(c, 1 << 16, 1 << 16); spng_set_chunk_limits(c, len + 64, 4 << 20);
  spng_set_png_buffer(c, in, len);
  struct spng_ihdr ih; if (spng_get_ihdr(c, &ih)) { spng_ctx_free(c); return fail(R_BAD, "png header"); }
  R.in_w = ih.width; R.in_h = ih.height;
  // every row of a PNG is inflated and filtered at full width: 60 MP and over is left as sent (a 200 KB file can claim 65,536 square)
  if ((double)ih.width * ih.height > 60e6) { spng_ctx_free(c); return fail(R_TOO_BIG, "png over 60 MP"); }
  struct spng_iccp ip; if (spng_get_iccp(c, &ip) == 0) icc_take((const uint8_t *)ip.profile, ip.profile_len);
  struct spng_trns trns; int alpha = ih.color_type == SPNG_COLOR_TYPE_GRAYSCALE_ALPHA || ih.color_type == SPNG_COLOR_TYPE_TRUECOLOR_ALPHA || spng_get_trns(c, &trns) == 0;
  int ow, oh; fit(ih.width, ih.height, max_w, max_px, &ow, &oh);
  int ch = alpha ? 4 : 3;
  Bands bd; if (!bands_init(&bd, ow, oh, ch)) { spng_ctx_free(c); return fail(R_NOMEM, "png out"); }
  Rs s; if (!rs_init(&s, ih.width, ih.height, ow, oh, ch, to_bands, &bd)) { bands_free(&bd); spng_ctx_free(c); return fail(R_NOMEM, "scaler"); }
  int fmt = alpha ? SPNG_FMT_RGBA8 : SPNG_FMT_RGB8;
  if (ih.interlace_method) {
    // Interlaced rows arrive out of order: decode whole, but only when that is small.
    size_t need; if (spng_decoded_image_size(c, fmt, &need) || need > (24u << 20)) { rs_free(&s); bands_free(&bd); spng_ctx_free(c); return fail(R_TOO_BIG, "interlaced png over 24 MB decoded"); }
    uint8_t *all = malloc(need); if (!all || spng_decode_image(c, all, need, fmt, SPNG_DECODE_TRNS)) { free(all); rs_free(&s); bands_free(&bd); spng_ctx_free(c); return fail(R_BAD, "png decode"); }
    for (uint32_t y = 0; y < ih.height; y++) rs_row(&s, all + (size_t)y * ih.width * ch);
    free(all);
  } else {
    if (spng_decode_image(c, NULL, 0, fmt, SPNG_DECODE_TRNS | SPNG_DECODE_PROGRESSIVE)) { rs_free(&s); bands_free(&bd); spng_ctx_free(c); return fail(R_BAD, "png progressive"); }
    size_t rowb = (size_t)ih.width * ch; uint8_t *row = malloc(rowb); if (!row) sk_throw(R_NOMEM);
    int e; struct spng_row_info ri;
    do {
      if ((e = spng_get_row_info(c, &ri))) break;
      e = spng_decode_row(c, row, rowb);
      if (e == 0 || e == SPNG_EOI) rs_row(&s, row);
    } while (e == 0);
    free(row);
    if (e != SPNG_EOI) { rs_free(&s); bands_free(&bd); spng_ctx_free(c); return fail(R_BAD, "png rows"); }
  }
  spng_ctx_free(c); rs_free(&s);
  R.frames = 1; R.has_alpha = alpha;
  int rc = bands_encode(&bd, quality); bands_free(&bd); return rc;
}

// ---------------------------------------------------------------- GIF -> animated WebP
typedef struct { const uint8_t *p; size_t n, at; } MemIn;
static int gif_read(GifFileType *g, GifByteType *buf, int len) {
  MemIn *m = g->UserData; size_t k = m->n - m->at < (size_t)len ? m->n - m->at : (size_t)len;
  memcpy(buf, m->p + m->at, k); m->at += k; return (int)k;
}

// Limits on what a picture may cost before anything is decoded: a hostile header can claim 65,536 x 65,536.
#define GIF_MAX_CANVAS 16000000L     // pixels on the canvas (64 MB of RGBA)
#define GIF_MAX_WORK 600000000LL     // pixels decoded plus pixels shrunk, summed over the frames: 240 frames of 810 x 540 is 210 M
static int do_gif(const uint8_t *in, size_t len, int max_w, long max_px, int quality, int max_frames) {
  MemIn m = { in, len, 0 }; int err = 0;
  GifFileType *g = DGifOpen(&m, gif_read, &err); if (!g) return fail(R_BAD, "gif open");
  int W = g->SWidth, H = g->SHeight; R.in_w = W; R.in_h = H;
  if (W <= 0 || H <= 0 || W > 16383 || H > 16383) { DGifCloseFile(g, &err); return fail(R_BAD, "gif size"); }
  if ((long)W * H > GIF_MAX_CANVAS) { DGifCloseFile(g, &err); return fail(R_TOO_BIG, "gif canvas over 16 MP"); }
  int ow, oh; fit(W, H, max_w, max_px, &ow, &oh);
  uint8_t *canvas = calloc((size_t)W * H, 4), *saved = NULL, *line = malloc((size_t)W), *small = malloc((size_t)ow * oh * 4);
  WebPAnimEncoder *enc = NULL; WebPPicture pic; int pic_ok = 0, rc = R_BAD; const char *why = "gif";
  WebPAnimEncoderOptions ao; WebPConfig cfg;
  if (!canvas || !line || !small) { rc = R_NOMEM; why = "gif buffers"; goto done; }
  if (!WebPAnimEncoderOptionsInit(&ao) || !WebPConfigInit(&cfg) || !WebPPictureInit(&pic)) { why = "webp init"; goto done; }
  pic_ok = 1; cfg.quality = (float)quality; cfg.method = g_method; ao.anim_params.loop_count = 0;
  enc = WebPAnimEncoderNew(ow, oh, &ao); if (!enc) { rc = R_NOMEM; why = "anim encoder"; goto done; }
  pic.use_argb = 1; pic.width = ow; pic.height = oh;
  GraphicsControlBlock gcb = { DISPOSAL_UNSPECIFIED, false, 0, NO_TRANSPARENT_COLOR };
  int ts = 0, frames = 0, loops = 0, looping = 0, broken = 0; GifRecordType rt = UNDEFINED_RECORD_TYPE;
  long long work = 0;   // every frame's own rectangle (decoded) plus the canvas (shrunk): a frame may be far larger than the canvas
  int prev_disp = DISPOSAL_UNSPECIFIED, cl = 0, ct = 0, cw = 0, ch_ = 0;   // the previous frame's rectangle, clipped to the canvas
  do {
    if (DGifGetRecordType(g, &rt) == GIF_ERROR) { broken = 1; break; }
    if (rt == EXTENSION_RECORD_TYPE) {
      int code; GifByteType *ext;
      if (DGifGetExtension(g, &code, &ext) == GIF_ERROR) { broken = 1; break; }
      if (code == GRAPHICS_EXT_FUNC_CODE && ext && ext[0] >= 4) DGifExtensionToGCB(ext[0], ext + 1, &gcb);
      else if (code == APPLICATION_EXT_FUNC_CODE && ext && ext[0] >= 11 && !memcmp(ext + 1, "NETSCAPE2.0", 11)) {
        if (DGifGetExtensionNext(g, &ext) == GIF_ERROR) { broken = 1; break; }
        if (ext && ext[0] >= 3 && ext[1] == 1) { loops = ext[2] | ext[3] << 8; looping = 1; }
      }
      while (ext) if (DGifGetExtensionNext(g, &ext) == GIF_ERROR) { broken = 1; ext = NULL; }
      if (broken) break;
    } else if (rt == IMAGE_DESC_RECORD_TYPE) {
      if (DGifGetImageDesc(g) == GIF_ERROR) { broken = 1; break; }
      if (max_frames > 0 && frames >= max_frames) { rc = R_TOO_BIG; why = "gif frames past the limit"; goto done; }
      // the previous frame's disposal, inside its clipped rectangle, before this one is drawn
      if (prev_disp == DISPOSE_BACKGROUND) for (int y = ct; y < ct + ch_; y++) memset(canvas + ((size_t)y * W + cl) * 4, 0, (size_t)cw * 4);
      else if (prev_disp == DISPOSE_PREVIOUS && saved) memcpy(canvas, saved, (size_t)W * H * 4);
      GifImageDesc *d = &g->Image; ColorMapObject *cm = d->ColorMap ? d->ColorMap : g->SColorMap;
      int L = d->Left, T = d->Top, FW = d->Width, FH = d->Height;
      if (FW <= 0 || FH <= 0 || FW > 16383 || FH > 16383) { broken = 1; break; }
      // Charged before a line is read. The limit counted only the canvas, so fifty 4000 x 4000 frames on a 1100 x 1 canvas decoded 800 M
      // pixels charged as 55 thousand, and (long)(frames + 1) * W * H, 32 bits here, wrapped past 2^31.
      work += (long long)FW * FH + (long long)W * H;
      if (work > GIF_MAX_WORK) { rc = R_TOO_BIG; why = "gif frames past the limit"; goto done; }
      if (gcb.DisposalMode == DISPOSE_PREVIOUS) { if (!saved && !(saved = malloc((size_t)W * H * 4))) { rc = R_NOMEM; why = "gif saved canvas"; goto done; } memcpy(saved, canvas, (size_t)W * H * 4); }
      if (FW > W) { uint8_t *nl = realloc(line, (size_t)FW); if (!nl) { rc = R_NOMEM; why = "gif line"; goto done; } line = nl; }
      static const int ioff[] = { 0, 4, 2, 1 }, ijmp[] = { 8, 8, 4, 2 };
      int passes = d->Interlace ? 4 : 1, lineerr = 0;
      for (int p = 0; p < passes && !lineerr; p++) for (int y = d->Interlace ? ioff[p] : 0; y < FH; y += d->Interlace ? ijmp[p] : 1) {
        if (DGifGetLine(g, line, FW) == GIF_ERROR) { lineerr = 1; break; }
        long cy = (long)T + y; if (cy >= H) continue;
        for (int x = 0; x < FW; x++) {
          long cx = (long)L + x; if (cx >= W) break; int ix = line[x];
          if (ix == gcb.TransparentColor || !cm || ix >= cm->ColorCount) continue;
          uint8_t *o = canvas + ((size_t)cy * W + cx) * 4; GifColorType c = cm->Colors[ix]; o[0] = c.Red; o[1] = c.Green; o[2] = c.Blue; o[3] = 255;
        }
      }
      if (lineerr) { broken = 1; break; }
      // shrink the whole canvas into `small`, then hand it to the animation encoder
      BufCtx bc = { small, ow * 4 }; Rs s; if (!rs_init(&s, W, H, ow, oh, 4, to_buf, &bc)) { rc = R_NOMEM; why = "resizer"; goto done; }
      for (int y = 0; y < H; y++) rs_row(&s, canvas + (size_t)y * W * 4);
      rs_free(&s);
      if (!WebPPictureImportRGBA(&pic, small, ow * 4)) { rc = R_NOMEM; why = "anim frame"; goto done; }
      if (!WebPAnimEncoderAdd(enc, &pic, ts, &cfg)) { why = "anim add"; goto done; }
      int delay = gcb.DelayTime * 10; ts += delay <= 10 ? 100 : delay;   // browsers show 0-1 hundredths as 100 ms
      frames++; prev_disp = gcb.DisposalMode;
      // the rectangle this frame covered, clipped to the canvas: a frame placed past the edge clears nothing outside it
      cl = L < W ? L : W; ct = T < H ? T : H; cw = (L + FW < W ? L + FW : W) - cl; ch_ = (T + FH < H ? T + FH : H) - ct;
      if (cw < 0) cw = 0; if (ch_ < 0) ch_ = 0;
      gcb.DisposalMode = DISPOSAL_UNSPECIFIED; gcb.DelayTime = 0; gcb.TransparentColor = NO_TRANSPARENT_COLOR;
    } else if (rt != TERMINATE_RECORD_TYPE) { broken = 1; break; }
  } while (rt != TERMINATE_RECORD_TYPE);
  // A file that broke off before its end is left as sent: a partial animation would replace it (and its original would be deleted).
  if (broken) { why = "gif broken before its end"; goto done; }
  if (!frames) { why = "gif has no frames"; goto done; }
  if (!WebPAnimEncoderAdd(enc, NULL, ts, NULL)) { why = "anim end"; goto done; }
  WebPData wd; WebPDataInit(&wd);
  if (!WebPAnimEncoderAssemble(enc, &wd)) { why = "anim assemble"; goto done; }
  // The GIF's own loop count: one with no NETSCAPE block plays once in browsers; the encoder was opened looping for ever.
  if (!looping || loops != 0) {
    WebPMux *mux = WebPMuxCreate(&wd, 1); WebPMuxAnimParams ap; WebPData out2; WebPDataInit(&out2);
    if (mux && WebPMuxGetAnimationParams(mux, &ap) == WEBP_MUX_OK) { ap.loop_count = looping ? loops : 1; if (WebPMuxSetAnimationParams(mux, &ap) == WEBP_MUX_OK && WebPMuxAssemble(mux, &out2) == WEBP_MUX_OK) { WebPDataClear(&wd); wd = out2; } }
    if (mux) WebPMuxDelete(mux);
  }
  R.out = (uint8_t *)wd.bytes; R.out_len = wd.size; R.out_w = ow; R.out_h = oh; R.frames = frames; R.has_alpha = 1; rc = R_OK;
done:
  DGifCloseFile(g, &err); free(canvas); free(saved); free(line); free(small);
  if (enc) WebPAnimEncoderDelete(enc); if (pic_ok) WebPPictureFree(&pic);
  return rc == R_OK ? R_OK : fail(rc, why);
}

// ---------------------------------------------------------------- WebP input (only re-encoded when wider than asked)
static int do_webp(const uint8_t *in, size_t len, int max_w, long max_px, int quality) {
  WebPBitstreamFeatures f; if (WebPGetFeatures(in, len, &f) != VP8_STATUS_OK) return fail(R_BAD, "webp header");
  R.in_w = f.width; R.in_h = f.height; R.has_alpha = f.has_alpha;
  if (f.has_animation) return fail(R_KEEP, "animated webp kept");
  int ow, oh; fit(f.width, f.height, max_w, max_px, &ow, &oh);
  if (ow == f.width) return fail(R_KEEP, "webp already small");
  // decoded whole: a WebP wider than the target is rare in mail, and capped
  if ((size_t)f.width * f.height * 4 > (40u << 20)) return fail(R_TOO_BIG, "webp over 40 MB decoded");
  { WebPData d = { in, len }, ic; WebPMux *mx = WebPMuxCreate(&d, 0); if (mx && WebPMuxGetChunk(mx, "ICCP", &ic) == WEBP_MUX_OK) icc_take(ic.bytes, ic.size); if (mx) WebPMuxDelete(mx); }
  int w, h; uint8_t *all = WebPDecodeRGBA(in, len, &w, &h); if (!all) return fail(R_BAD, "webp decode");
  Bands bd; Rs s; if (!bands_init(&bd, ow, oh, 4) || !rs_init(&s, w, h, ow, oh, 4, to_bands, &bd)) sk_throw(R_NOMEM);
  for (int y = 0; y < h; y++) rs_row(&s, all + (size_t)y * w * 4);
  WebPFree(all); rs_free(&s); R.frames = 1;
  int rc = bands_encode(&bd, quality); bands_free(&bd); return rc;
}

// ---------------------------------------------------------------- entry
EXPORT(sk_shrink) int sk_shrink(const uint8_t *in, size_t len, int max_w, int max_px, int quality, int method, int max_frames) {
  sk_release(); icc_clear(); memset(&R, 0, sizeof R); g_method = method < 0 ? 0 : method > 6 ? 6 : method;   // a result never copied out is freed first
  if (len < 12) return fail(R_BAD, "too short");
  if (in[0] == 0xFF && in[1] == 0xD8 && in[2] == 0xFF) { R.format = F_JPEG; return do_jpeg(in, len, max_w, max_px, quality); }
  if (!memcmp(in, "\x89PNG\r\n\x1a\n", 8)) { R.format = F_PNG; return do_png(in, len, max_w, max_px, quality); }
  if (!memcmp(in, "GIF87a", 6) || !memcmp(in, "GIF89a", 6)) { R.format = F_GIF; return do_gif(in, len, max_w, max_px, quality, max_frames); }
  if (!memcmp(in, "RIFF", 4) && !memcmp(in + 8, "WEBP", 4)) { R.format = F_WEBP; return do_webp(in, len, max_w, max_px, quality); }
  return fail(R_UNSUPPORTED, "not a JPEG, PNG, GIF or WebP");
}
