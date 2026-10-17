#!/bin/sh
# Starts one headless DOSBox-X instance. Extra arguments are passed through,
# e.g. -c "dir" -c "game.exe" or -set "cpu cycles=max".
set -e
mkdir -p /data/c /data/capture
exec /usr/bin/dosbox-x -conf "${DOSBOX_CONF:-/etc/dosbox/dosbox-x.conf}" \
    -nomenu -fastlaunch -nopromptfolder "$@"
