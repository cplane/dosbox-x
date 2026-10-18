# Toolchain + build deps for compiling DOSBox-X, and nothing else.
#
# Split out of the image build so the compile can run as a plain container
# with a persistent ccache volume (see compile.sh, build.sh): this layer
# changes when a dependency changes, which is roughly never. build.sh tags
# it with a hash of this file and only rebuilds it when that tag is missing.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential autoconf automake libtool pkg-config nasm file ccache \
        libsdl2-dev libsdl2-net-dev libpng-dev zlib1g-dev libncurses-dev \
        libfreetype-dev libpcap-dev libslirp-dev libfluidsynth-dev \
        libx11-dev libxkbfile-dev libxrandr-dev libgl-dev libglu1-mesa-dev \
    && rm -rf /var/lib/apt/lists/*
