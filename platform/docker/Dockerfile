# Headless DOSBox-X (SDL2) runtime image for the dos-box platform.
# Build context = platform/docker (see platform/build.sh).
#
# The emulator is compiled beforehand by compile.sh (builder image +
# persistent ccache) into a binary-only image, dosbox-x-bin:<source hash>;
# this just puts it on a runtime base. build.sh passes BIN_IMAGE.
ARG BIN_IMAGE
FROM ${BIN_IMAGE} AS bin

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# Runtime packages resolved from the binary's shared-library deps
# (compile.sh); this layer stays cached while that list is unchanged.
COPY --from=bin /runtime-packages.txt /tmp/
RUN apt-get update && apt-get install -y --no-install-recommends \
        $(cat /tmp/runtime-packages.txt) python3-minimal tini \
    && rm -rf /var/lib/apt/lists/* /tmp/runtime-packages.txt
COPY --from=bin /usr /usr
COPY dosbox-x.conf /etc/dosbox/dosbox-x.conf
COPY entrypoint.sh /usr/local/bin/dosbox-entrypoint
COPY gl-snap.py /usr/local/bin/gl-snap
# AGENT=1 (the dosbox-x-debug image): keep the RPC debugger agent config;
# the entrypoint starts the agent when the file is there.
ARG AGENT=0
COPY agent.env /etc/dosbox/agent.env
RUN chmod +x /usr/local/bin/dosbox-entrypoint /usr/local/bin/gl-snap \
    && mkdir -p /data \
    && ! ldd /usr/bin/dosbox-x | grep "not found" \
    && if [ "$AGENT" != 1 ]; then rm /etc/dosbox/agent.env; fi

ENV SDL_VIDEODRIVER=dummy \
    SDL_AUDIODRIVER=dummy \
    HOME=/data
WORKDIR /data
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dosbox-entrypoint"]
