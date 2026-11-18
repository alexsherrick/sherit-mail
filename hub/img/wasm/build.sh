#!/bin/bash
# Builds shrink.wasm: the five libraries' sources, checked against the SHA-256 of the copies the prototype was measured
# with, compiled for wasm32-wasip1 with Homebrew's LLVM, lld, wasi-libc and wasi-runtimes (`brew install llvm lld wasi-libc
# wasi-runtimes`), then shrink.c linked over them. Memory is capped at 88 MiB: a picture that would need more fails cleanly (malloc
# returns NULL) and keeps its original, and the isolate keeps room for its own heap under the 128 MB limit.
# Usage: hub/img/wasm/build.sh (writes hub/img/wasm/shrink.wasm; sources go to vendor/, which git ignores)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; V="$HERE/vendor"; B="$V/build"
CLANG=/opt/homebrew/opt/llvm/bin/clang; AR=/opt/homebrew/opt/llvm/bin/llvm-ar
SYSROOT=/opt/homebrew/opt/wasi-libc/share/wasi-sysroot; RES=/opt/homebrew/opt/wasi-runtimes/share/wasi-runtimes
for t in "$CLANG" "$AR" /opt/homebrew/opt/lld/bin/wasm-ld "$SYSROOT" "$RES"; do [ -e "$t" ] || { echo "missing $t (brew install llvm lld wasi-libc wasi-runtimes)"; exit 1; }; done
mkdir -p "$V" "$B"

fetch() {   # name url sha256
  local name=$1 url=$2 sum=$3 tgz="$V/$1.tgz"
  [ -f "$tgz" ] || curl -sSL -o "$tgz" "$url"
  echo "$sum  $tgz" | shasum -a 256 -c --quiet || { echo "checksum mismatch for $name"; rm -f "$tgz"; exit 1; }
  [ -d "$V/$name" ] || { mkdir -p "$V/$name"; tar -xzf "$tgz" -C "$V/$name" --strip-components=1; }
}
fetch jpeg https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.1/libjpeg-turbo-3.2.1.tar.gz c27ad72a68da151177929aa969ae773a2da5ac2af9ce946079314fdac8cece7f
fetch webp https://github.com/webmproject/libwebp/archive/refs/tags/v1.6.0.tar.gz 93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136
fetch spng https://github.com/randy408/libspng/archive/refs/tags/v0.7.4.tar.gz 47ec02be6c0a6323044600a9221b049f63e1953faf816903e7383d4dc4234487
fetch zlib https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
fetch gif https://downloads.sourceforge.net/project/giflib/giflib-6.x/giflib-6.1.3.tar.gz b65b66b99f0424b93525f987386f22fc5efb9da2bfc92ad4a532249aaffbab0e

cat > "$B/cc.sh" <<EOF
#!/bin/bash
PATH=/opt/homebrew/opt/lld/bin:\$PATH exec "$CLANG" --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir "$RES" "\$@"
EOF
chmod +x "$B/cc.sh"; CC="$B/cc.sh"; MAP="-ffile-prefix-map=$HERE/="; CF="-O3 -msimd128 -w $MAP"   # no build path in the module's strings

if [ ! -f "$B/jpeg/libjpeg.a" ]; then
  mkdir -p "$B/jpeg"; (cd "$B/jpeg" && cmake "$V/jpeg" -DCMAKE_C_COMPILER="$CC" -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER_WORKS=1 -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-O3 -msimd128 $MAP" -DWITH_SIMD=0 -DENABLE_SHARED=0 -DENABLE_STATIC=1 \
    -DWITH_TURBOJPEG=0 -DWITH_TOOLS=0 -DWITH_TESTS=0 -DCMAKE_AR="$AR" -DCMAKE_RANLIB=/opt/homebrew/opt/llvm/bin/llvm-ranlib > cmake.log 2>&1 && make -j8 jpeg-static > make.log 2>&1)
fi
lib() {   # name "include flags" sources...
  local name=$1 inc=$2; shift 2; [ -f "$B/lib$name.a" ] && return 0
  mkdir -p "$B/obj/$name"
  for f in "$@"; do "$CC" $CF $inc -c "$f" -o "$B/obj/$name/$(basename "$(dirname "$f")")_$(basename "${f%.c}").o"; done
  "$AR" rcs "$B/lib$name.a" "$B/obj/$name"/*.o
}
lib z "-I$V/zlib" "$V"/zlib/{adler32,crc32,deflate,trees,inffast,inflate,inftrees,zutil}.c
lib spng "-I$V/zlib -DSPNG_STATIC -DSPNG_DISABLE_OPT" "$V/spng/spng/spng.c"
lib gif "-I$V/gif" "$V"/gif/{dgif_lib,gifalloc,gif_err,gif_hash,openbsd-reallocarray}.c
lib webp "-I$V/webp -I$V/webp/src" "$V"/webp/src/{dec,demux,dsp,enc,mux,utils}/*.c "$V"/webp/sharpyuv/*.c

"$CC" -O3 -msimd128 $MAP -mexec-model=reactor -DSPNG_STATIC \
  -I"$V/jpeg/src" -I"$B/jpeg" -I"$V/spng/spng" -I"$V/gif" -I"$V/webp/src" -I"$V/webp" \
  "$HERE/shrink.c" "$B/jpeg/libjpeg.a" "$B/libspng.a" "$B/libz.a" "$B/libgif.a" "$B/libwebp.a" \
  -Wl,--max-memory=92274688 -Wl,-z,stack-size=1048576 -Wl,--strip-all -o "$HERE/shrink.wasm"
echo "shrink.wasm: $(wc -c < "$HERE/shrink.wasm" | tr -d ' ') bytes, $(gzip -9 -c "$HERE/shrink.wasm" | wc -c | tr -d ' ') gzipped"
