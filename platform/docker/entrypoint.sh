#!/bin/sh
# Starts one headless DOSBox-X instance. Extra arguments are passed through,
# e.g. -c "dir" -c "game.exe" or -set "cpu cycles=max".
#
# C_FREESIZE_MB (set by the platform gateway): the free space DOS sees on C:,
# i.e. what is left of the box's disk allowance (MOUNT -freesize). It is
# only reported, not enforced; the gateway enforces the limit.
set -e
mkdir -p /data/c /data/capture
conf=${DOSBOX_CONF:-/etc/dosbox/dosbox-x.conf}
if [ -n "${C_FREESIZE_MB:-}" ]; then
    sed "s|^mount c /data/c\$|mount c /data/c -freesize ${C_FREESIZE_MB}|" "$conf" > /tmp/dosbox-x.conf
    conf=/tmp/dosbox-x.conf
fi
agent=""
if [ -f /etc/dosbox/agent.env ]; then   # the dosbox-x-debug image
    agent="-agent-config /etc/dosbox/agent.env"
fi
# shellcheck disable=SC2086
exec /usr/bin/dosbox-x -conf "$conf" -nomenu -fastlaunch -nopromptfolder $agent "$@"
