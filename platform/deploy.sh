#!/usr/bin/env bash
# Deploy (or upgrade) the dos-box platform: helm release "dosbox" in
# namespace dosbox, https://dosbox.pocket-maze.app.
#
#   platform/deploy.sh [extra helm args...]
#
# Each image is pinned to the build its registry "latest" tag points at
# (what platform/build.sh last pushed), so a rollout is reproducible and box
# pods can use IfNotPresent. Build first: platform/build.sh platform|web|
# dosbox|stream. Prerequisites (once): the secret
#   kubectl -n dosbox create secret generic dosbox --from-literal=postgresUrl=...
# and the DNS A record dosbox.pocket-maze.app -> the ingress load balancer.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"

NS=${NS:-dosbox}

# pinned <repo>: the newest non-latest tag sharing latest's digest.
pinned() {
  doctl registry repository list-tags "$1" -o json | node -e '
    const tags = JSON.parse(require("fs").readFileSync(0));
    const latest = tags.find(t => t.tag === "latest");
    if (!latest) process.exit(1);
    const same = tags.filter(t => t.tag !== "latest" && t.manifest_digest === latest.manifest_digest)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (!same.length) process.exit(1);
    console.log(same[0].tag);'
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
