#!/usr/bin/env bash
# Deploy (or upgrade) the dos-box platform: helm release "dosbox" in
# namespace dosbox, https://dosbox.pocket-maze.app.
#
#   platform/deploy.sh [extra helm args...]
#   RESTART_BOXES="creative" platform/deploy.sh   also restarts those boxes
#
# Each image is pinned to the build platform/build.sh last pushed
# (its newest tag), so a rollout is reproducible and box
# pods can use IfNotPresent. Build first: platform/build.sh platform|web|
# dosbox|stream. Prerequisites (once): the secret
#   kubectl -n dosbox create secret generic dosbox --from-literal=postgresUrl=...
# optionally with --from-literal=googleClientId=<id>.apps.googleusercontent.com
# (Google sign-in; that OAuth client must list https://dosbox.pocket-maze.app
# as an Authorized JavaScript origin),
# and the DNS A record dosbox.pocket-maze.app -> the ingress load balancer.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"

NS=${NS:-dosbox}

# pinned <repo>: the most recently pushed tag other than "latest", i.e. what
# platform/build.sh last pushed. Not resolved through "latest" itself: the
# DO registry has been seen to keep "latest" on the previous image after a
# Kaniko push of both tags.
pinned() {
  doctl registry repository list-tags "$1" -o json | node -e '
    const tags = JSON.parse(require("fs").readFileSync(0)).filter(t => t.tag !== "latest")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (!tags.length) process.exit(1);
    console.log(tags[0].tag);'
}

args=()
for img in platform:dosbox-platform web:dosbox-web dosbox:dosbox-x stream:dosbox-stream; do
  key=${img%%:*} repo=${img#*:}
  tag=$(pinned "$repo") || { echo "no pinned tag for $repo (build it first)" >&2; exit 1; }
  echo "$key: $repo:$tag"
  args+=(--set "images.$key.tag=$tag")
done

helm upgrade --install dosbox helm/dosbox -n "$NS" "${args[@]}" "$@"
kubectl -n "$NS" rollout status deploy/dosbox-auth --timeout=180s
kubectl -n "$NS" rollout status deploy/dosbox-gateway --timeout=180s
kubectl -n "$NS" rollout status deploy/dosbox-web --timeout=180s

# RESTART_BOXES="creative ..." (or "--all"): put those running boxes on the
# new box images right away instead of at their next start.
if [ -n "${RESTART_BOXES:-}" ]; then
  # shellcheck disable=SC2086
  ./restart-boxes.sh $RESTART_BOXES
fi
