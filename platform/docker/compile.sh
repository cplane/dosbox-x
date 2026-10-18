#!/usr/bin/env bash
# Compiles DOSBox-X inside the builder image (Dockerfile.builder) as the
# compile init container of build.sh's Job, NOT inside `docker build`:
# a compiler cache is what makes a one-file change cheap, and an image
# build can't carry one (Kaniko's layer cache misses as soon as any source
# changes, because the whole tree is copied in front of the compile).
#
#   /src     the uploaded tree; a fixed path, so ccache hashes don't move
#   /cache   persistent volume: ccache, autogen output, configure cache
#   $OUT     rootfs/usr + rootfs/runtime-packages.txt + Dockerfile for the
#            binary-only image (dosbox-x-bin) Kaniko pushes next
#
# Env: JOBS (4), CACHE_KEY (builder image tag; part of every cache key).
set -euo pipefail

SRC=/src
CACHE=${CACHE:-/cache}
OUT=${OUT:-/workspace/out}
JOBS=${JOBS:-4}
CACHE_KEY=${CACHE_KEY:-none}

export CCACHE_DIR=$CACHE/ccache
export CCACHE_MAXSIZE=5G
export CCACHE_BASEDIR=$SRC
export CCACHE_COMPILERCHECK=content
# The tree is re-extracted every build, so every header looks brand new;
# hash contents, not timestamps.
export CCACHE_SLOPPINESS=time_macros,include_file_mtime,include_file_ctime
mkdir -p "$CCACHE_DIR" "$CACHE/autogen" "$CACHE/configure"

phase() { echo "=== $(date -u +%T) $*"; }
t0=$(date +%s)
cd "$SRC"
ccache --zero-stats >/dev/null

# autogen.sh (aclocal/autoheader/automake/autoconf) output depends only on
# the autotools inputs; reuse it when they are unchanged. Extracted with -m
# so the outputs are newer than the freshly unpacked sources and make
# doesn't re-run automake.
phase autogen
ag_key=$( { echo "$CACHE_KEY"; cat configure.ac acinclude.m4; find . -name Makefile.am | sort | xargs cat; } \
          | sha256sum | cut -c1-16)
ag_tar=$CACHE/autogen/$ag_key.tar
if [ -f "$ag_tar" ]; then
    tar -xmf "$ag_tar"
    echo "autogen: cached ($ag_key)"
else
    touch /tmp/autogen.stamp
    sleep 1
    chmod +x autogen.sh && ./autogen.sh
    find . -newer /tmp/autogen.stamp -type f ! -path './autom4te.cache/*' -print0 \
        | tar --null -cf "$ag_tar.tmp" -T - && mv "$ag_tar.tmp" "$ag_tar"
fi

phase configure
cfg_cache=$CACHE/configure/$(echo "$CACHE_KEY" | cat - configure | sha256sum | cut -c1-16).cache
./configure --prefix=/usr --enable-sdl2 --disable-debug --cache-file="$cfg_cache" \
    CC="ccache gcc" CXX="ccache g++" >/tmp/configure.log \
    || { tail -50 /tmp/configure.log; exit 1; }

# PCH=1: precompiled header (pch.h, standard headers only) force-included into
# every C++ file via CXXFLAGS. GCC's .gch isn't byte-reproducible and ccache
# hashes it into every object that uses it, so the .gch is itself cached by
# content (header + flags + toolchain): rebuilding it would cost every hit.
# Measured: a cold make took 777 s with it vs 834 s without (-O2 code
# generation, not header parsing, dominates here), so it is off by default.
make_args=()
if [ "${PCH:-0}" = 1 ]; then
    phase pch
    mkdir -p "$SRC/pch" "$CACHE/pch"
    cp platform/docker/pch.h "$SRC/pch/pch.h"
    mkvar() { sed -n "s/^$1 = //p" Makefile; }
    cxxflags=$(mkvar CXXFLAGS)
    pch_flags="$(mkvar DEFS) $(mkvar CPPFLAGS) $cxxflags"
    pch_key=$( { echo "$CACHE_KEY $pch_flags"; cat "$SRC/pch/pch.h"; } | sha256sum | cut -c1-16)
    if [ -f "$CACHE/pch/$pch_key.gch" ]; then
        cp "$CACHE/pch/$pch_key.gch" "$SRC/pch/pch.h.gch"
        echo "pch: cached ($pch_key)"
    else
        # shellcheck disable=SC2086
        g++ $pch_flags -x c++-header "$SRC/pch/pch.h" -o "$SRC/pch/pch.h.gch"
        cp "$SRC/pch/pch.h.gch" "$CACHE/pch/$pch_key.gch.tmp" && mv "$CACHE/pch/$pch_key.gch.tmp" "$CACHE/pch/$pch_key.gch"
    fi
    make_args=(CXXFLAGS="$cxxflags -include $SRC/pch/pch.h -Winvalid-pch")
    export CCACHE_SLOPPINESS=$CCACHE_SLOPPINESS,pch_defines
fi

phase make -j"$JOBS"
make -j"$JOBS" "${make_args[@]}" >/tmp/make.log 2>&1 || { grep -E -B2 -A8 'error|Error' /tmp/make.log | tail -80; exit 1; }
if [ "${PCH:-0}" = 1 ]; then
    echo "pch: not usable in $(grep -c 'pch.h.gch.*not used' /tmp/make.log || true) compiles"
    grep 'pch.h.gch.*not used' /tmp/make.log | sort | uniq -c | sort -rn | head -5 || true
fi

phase install
rm -rf "$OUT" && mkdir -p "$OUT/rootfs"
make install DESTDIR="$OUT/rootfs" >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }
test -x "$OUT/rootfs/usr/bin/dosbox-x"
strip -s "$OUT/rootfs/usr/bin/dosbox-x"

# Runtime packages from the binary's shared-library deps, so the runtime
# image doesn't need a hand-maintained (and t64-renamed) list.
ldd "$OUT/rootfs/usr/bin/dosbox-x" | awk '/=> \//{print $3}' | while read -r lib; do
    p=$(readlink -f "$lib")
    dpkg -S "$lib" 2>/dev/null || dpkg -S "$p" 2>/dev/null \
        || dpkg -S "/usr$lib" 2>/dev/null || dpkg -S "${p#/usr}" 2>/dev/null
done | grep -E '^[^ ]+: /' | cut -d: -f1 | sort -u > "$OUT/rootfs/runtime-packages.txt"
cat "$OUT/rootfs/runtime-packages.txt"

printf 'FROM scratch\nCOPY rootfs/ /\n' > "$OUT/Dockerfile"

phase done in $(( $(date +%s) - t0 ))s
ccache --show-stats
