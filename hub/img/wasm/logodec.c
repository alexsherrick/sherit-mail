// logodec.wasm: decodes a WebP logo to RGBA for the hub's logo fingerprint (index.js logoPixels). resvg draws SVG,
// PNG, JPEG and GIF; it does not read WebP, which 35 of the 373 logos the hub held on 2026-11-26 were. Built from the same libwebp as
// shrink.wasm (build_logodec.sh); only the decoder is linked.
#include <stdint.h>
#include <stdlib.h>
#include "webp/decode.h"
#define EXPORT(name) __attribute__((export_name(#name)))
static uint8_t *out = 0; static int ow = 0, oh = 0;
EXPORT(ld_alloc) void *ld_alloc(size_t n) { return malloc(n); }
EXPORT(ld_free) void ld_free(void *p) { free(p); }
EXPORT(ld_release) void ld_release(void) { if (out) WebPFree(out); out = 0; ow = oh = 0; }
EXPORT(ld_w) int ld_w(void) { return ow; }
EXPORT(ld_h) int ld_h(void) { return oh; }
EXPORT(ld_ptr) uint8_t *ld_ptr(void) { return out; }
// 1 when decoded (pixels at ld_ptr, ld_w x ld_h x 4), 0 when not a WebP, too big (over 4096 px a side) or broken. An animation's first frame.
EXPORT(ld_webp) int ld_webp(const uint8_t *in, size_t len) {
  ld_release();
  WebPBitstreamFeatures f; if (WebPGetFeatures(in, len, &f) != VP8_STATUS_OK) return 0;
  if (f.width <= 0 || f.height <= 0 || f.width > 4096 || f.height > 4096) return 0;
  out = WebPDecodeRGBA(in, len, &ow, &oh);
  return out ? 1 : 0;
}
