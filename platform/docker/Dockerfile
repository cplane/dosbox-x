# Headless DOSBox-X (SDL2) image for the dos-box platform.
# Build context = repository root (see platform/build.sh).

# Emulator sources without platform/, so edits to the platform files (this
# Dockerfile, conf, tools) don't invalidate the cached compile layer.
FROM busybox:1.36 AS source
COPY . /src
RUN rm -rf /src/platform

FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential autoconf automake libtool pkg-config nasm file \
        libsdl2-dev libsdl2-net-dev libpng-dev zlib1g-dev libncurses-dev \
        libfreetype-dev libpcap-dev libslirp-dev libfluidsynth-dev \
        libx11-dev libxkbfile-dev libxrandr-dev libgl-dev libglu1-mesa-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY --from=source /src /src
ARG JOBS=4
RUN chmod +x autogen.sh && ./autogen.sh \
    && ./configure --prefix=/usr --enable-sdl2 --disable-debug \
    && make -j"${JOBS}"
RUN make install DESTDIR=/out \
    && strip -s /out/usr/bin/dosbox-x

# Resolve the runtime packages from the binary's shared-library deps so the
# runtime stage doesn't need a hand-maintained (and t64-renamed) list.
RUN ldd /out/usr/bin/dosbox-x | awk '/=> \//{print $3}' | while read -r lib; do \
        p=$(readlink -f "$lib"); \
        dpkg -S "$lib" 2>/dev/null || dpkg -S "$p" 2>/dev/null \
            || dpkg -S "/usr$lib" 2>/dev/null || dpkg -S "${p#/usr}" 2>/dev/null; \
    done | grep -E '^[^ ]+: /' | cut -d: -f1 | sort -u > /out/runtime-packages.txt \
    && cat /out/runtime-packages.txt

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=build /out/runtime-packages.txt /tmp/
RUN apt-get update && apt-get install -y --no-install-recommends \
        $(cat /tmp/runtime-packages.txt) python3-minimal tini \
    && rm -rf /var/lib/apt/lists/* /tmp/runtime-packages.txt
COPY --from=build /out/usr /usr
COPY platform/docker/dosbox-x.conf /etc/dosbox/dosbox-x.conf
COPY platform/docker/entrypoint.sh /usr/local/bin/dosbox-entrypoint
COPY platform/docker/gl-snap.py /usr/local/bin/gl-snap
RUN chmod +x /usr/local/bin/dosbox-entrypoint /usr/local/bin/gl-snap \
    && mkdir -p /data \
    && ! ldd /usr/bin/dosbox-x | grep "not found"

ENV SDL_VIDEODRIVER=dummy \
    SDL_AUDIODRIVER=dummy \
    HOME=/data
WORKDIR /data
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dosbox-entrypoint"]
