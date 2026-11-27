#!/bin/bash
# Builds hub/img/wasm/logodec.wasm from logodec.c over the libwebp that build.sh compiled into vendor/build (run build.sh
# first on a fresh checkout). Only WebP decoding is linked; memory capped at 32 MiB (a 4096 x 4096 RGBA frame is 64 MiB, so the cap,
# not the size check, is what refuses the largest; malloc returns NULL and ld_webp answers 0).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; V="$HERE/vendor"; B="$V/build"
CLANG=/opt/homebrew/opt/llvm/bin/clang; SYSROOT=/opt/homebrew/opt/wasi-libc/share/wasi-sysroot; RES=/opt/homebrew/opt/wasi-runtimes/share/wasi-runtimes
[ -f "$B/libwebp.a" ] || { echo "run build.sh first (vendor/build/libwebp.a missing)"; exit 1; }
MAP="-ffile-prefix-map=$HERE/="
PATH=/opt/homebrew/opt/lld/bin:$PATH "$CLANG" --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir "$RES" -O3 -msimd128 $MAP -mexec-model=reactor \
  -I"$V/webp/src" -I"$V/webp" "$HERE/logodec.c" "$B/libwebp.a" \
  -Wl,--max-memory=33554432 -Wl,-z,stack-size=262144 -Wl,--strip-all -o "$HERE/logodec.wasm"
echo "logodec.wasm: $(wc -c < "$HERE/logodec.wasm" | tr -d ' ') bytes"
