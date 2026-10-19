#!/usr/bin/env bash
# Restart running boxes onto the box images the gateway currently starts
# boxes with (after a deploy). Like Stop + Start in the UI: the box's C:
# drive stays, whatever runs in DOS is closed.
#
#   platform/restart-boxes.sh <box name>...    e.g. creative
#   platform/restart-boxes.sh --all            every running box
#
# A box already on the current images is left alone (FORCE=1 restarts it
# anyway). Boxes that aren't running are skipped: they get the new images
# on their next start.
#
# The pod is recreated from its own spec with the images swapped, rather
# than through the gateway API, which would need the owner's session.
set -euo pipefail
export MSYS_NO_PATHCONV=1

NS=${NS:-dosbox}
[ $# -gt 0 ] || { echo "usage: $0 <box name>... | --all" >&2; exit 2; }

gw_env() {
  kubectl -n "$NS" get deploy dosbox-gateway \
    -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name==\"$1\")].value}"
}
DOSBOX_IMAGE=$(gw_env BOX_DOSBOX_IMAGE)
STREAM_IMAGE=$(gw_env BOX_STREAM_IMAGE)
[ -n "$DOSBOX_IMAGE" ] && [ -n "$STREAM_IMAGE" ] || { echo "can't read the box images from dosbox-gateway" >&2; exit 1; }

# name<TAB>pod<TAB>up-to-date for every running box pod
pods=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=dosbox-box -o json | node -e '
  const [dosbox, stream] = process.argv.slice(1);
  for (const p of JSON.parse(require("fs").readFileSync(0)).items) {
    if (p.metadata.deletionTimestamp) continue;
    const img = Object.fromEntries(p.spec.containers.map(c => [c.name, c.image]));
    const current = img.dosbox === dosbox && img.stream === stream;
    console.log([p.metadata.annotations["dosbox/name"], p.metadata.name, current ? "current" : "old"].join("\t"));
  }' "$DOSBOX_IMAGE" "$STREAM_IMAGE")

want=" $* "
restarted=0
while IFS=$'\t' read -r name pod state; do
  [ -n "$pod" ] || continue
  [ "$want" = " --all " ] || [[ "$want" == *" $name "* ]] || continue
  if [ "$state" = current ] && [ -z "${FORCE:-}" ]; then
    echo "$name ($pod): already on the current images"
    continue
  fi
  echo "$name ($pod): restarting"
  manifest=$(kubectl -n "$NS" get pod "$pod" -o json | node -e '
    const [dosbox, stream] = process.argv.slice(1);
    const p = JSON.parse(require("fs").readFileSync(0));
    const { name, namespace, labels, annotations } = p.metadata;
    const spec = p.spec;
    delete spec.nodeName; // let the scheduler place it (pod affinity keeps it by the volume)
    for (const c of spec.containers) c.image = c.name === "dosbox" ? dosbox : c.name === "stream" ? stream : c.image;
    console.log(JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name, namespace, labels, annotations }, spec }));
  ' "$DOSBOX_IMAGE" "$STREAM_IMAGE")
  kubectl -n "$NS" delete pod "$pod" --wait=true --timeout=90s >/dev/null
  printf '%s' "$manifest" | kubectl -n "$NS" create -f - >/dev/null
  kubectl -n "$NS" wait --for=condition=Ready "pod/$pod" --timeout=180s >/dev/null
  echo "$name ($pod): running on ${DOSBOX_IMAGE##*/} + ${STREAM_IMAGE##*/}"
  restarted=$((restarted + 1))
done <<<"$pods"
echo "restarted $restarted box(es)"
