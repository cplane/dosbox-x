#!/usr/bin/env bash
# Build a dos-box platform image inside the DOKS cluster (no local Docker)
# and push it to the DigitalOcean registry.
#
#   platform/build.sh [dosbox|stream|platform|web] [tag]
#
#   dosbox  headless DOSBox-X -> dosbox-x, in up to three steps, each skipped
#           when its result already exists in the registry:
#             1. builder image  dosbox-x-builder:<hash of Dockerfile.builder>
#             2. compile Job    dosbox-x-bin:<hash of emulator sources+recipe>
#                (builder image + persistent ccache PVC, see compile.sh)
#             3. runtime image  dosbox-x:<tag> = bin + platform/docker files
#   stream  Game Link streaming sidecar (platform/stream) -> dosbox-stream
#   platform  auth + gateway Go services (platform/go) -> dosbox-platform
#   web     browser client + nginx (platform/web) -> dosbox-web
#   tag     default: git short sha (+ -dirty-<snapshot> with uncommitted changes)
#
# Needs: kubectl (context = the DOKS cluster), doctl (authenticated), git, gzip.
set -euo pipefail
export MSYS_NO_PATHCONV=1

NS=${NS:-dosbox}
REGISTRY=${REGISTRY:-registry.digitalocean.com/container-registry-ams3}
KANIKO=${KANIKO:-gcr.io/kaniko-project/executor:v1.23.2}
JOBS=${JOBS:-4}
PCH=${PCH:-0}        # 1: precompiled std headers (compile.sh); ~7% off a cold build, so off
CCACHE_PVC=${CCACHE_PVC:-dosbox-build-ccache}
COMPONENT=${1:-dosbox}

cd "$(dirname "$0")/.."
GIT_DIR=$(git rev-parse --git-dir)   # relative paths: Windows git/kubectl choke on /tmp and C:

case "$COMPONENT" in
  dosbox) DIRTY_PATHS=(. ':!platform/stream' ':!platform/go' ':!platform/web' ':!platform/helm' ':!platform/k8s' ':!platform/README.md') ;;
  stream) DIRTY_PATHS=(platform/stream) ;;
  platform) DIRTY_PATHS=(platform/go) ;;
  web) DIRTY_PATHS=(platform/web) ;;
  *) echo "usage: $0 [dosbox|stream|platform|web] [tag]" >&2; exit 2 ;;
esac
TAG=${2:-$(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD -- "${DIRTY_PATHS[@]}" || echo -dirty)}

# Temp files are per component, so a stream and a dosbox build can run at once.
tmp="$GIT_DIR/$COMPONENT-build"
trap 'rm -f "$tmp".*' EXIT

retry() {
  local n
  for n in 1 2 3 4 5 6; do
    "$@" && return 0
    echo "retry $n: $*" >&2
    sleep $((n * 5))
  done
  return 1
}

# Does repo:tag exist in the registry? (A missing repo counts as no.)
published() {
  local out
  local n
  for n in 1 2 3; do   # (not retry(): a repo that doesn't exist yet fails every time)
    out=$(doctl registry repository list-tags "$1" -o json 2>/dev/null) && break
    sleep 3
  done
  grep -q "\"tag\": \"$2\"" <<<"$out"
}

retry kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"

# Pull secret for pods, short-lived push secret for Kaniko.
doctl registry kubernetes-manifest --namespace "$NS" --name container-registry-ams3 | retry kubectl apply -f - >/dev/null
doctl registry docker-config --read-write --expiry-seconds 7200 > "$tmp.json"
kubectl -n "$NS" create secret generic registry-push --from-file=config.json="$tmp.json" \
    --dry-run=client -o yaml | retry kubectl apply -f - >/dev/null
rm -f "$tmp.json"

# Snapshot the working tree (incl. uncommitted/untracked changes) into a
# throwaway index; prints the tree id.
snapshot_tree() {
  cp "$GIT_DIR/index" "$tmp.idx"
  GIT_INDEX_FILE="$tmp.idx" git add -A 2>/dev/null
  GIT_INDEX_FILE="$tmp.idx" git write-tree
  rm -f "$tmp.idx"
}

# archive <tree>[:subdir] [pathspec...] -> $tmp.tar.gz, LF line endings (the
# Windows checkout uses autocrlf).
archive() {
  local tree=$1; shift
  git -c core.autocrlf=false archive --format=tar "$tree" -- . "$@" | gzip -1 > "$tmp.tar.gz"
  echo "context: $tree ($(du -h "$tmp.tar.gz" | cut -f1))"
}

# run_job <name> <pod spec yaml>: the pod's first init container waits for
# /workspace/.ready; we upload $tmp.tar.gz to /workspace/context.tar.gz with
# (retried) kubectl cp, so a flaky local link can't kill the build, then
# follow the logs until the Job finishes.
run_job() {
  local job="$1-$(date +%s)" spec=$2 pod="" since="" ok bad c
  retry kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $job
  namespace: $NS
  labels: {app: dosbox-build}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels: {app: dosbox-build, job: $job}
    spec:
      restartPolicy: Never
      imagePullSecrets: [{name: container-registry-ams3}]
$spec
EOF
  until [ -n "$pod" ]; do
    pod=$(kubectl -n "$NS" get pod -l job="$job" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -n "$pod" ] || sleep 2
  done
  until kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.initContainerStatuses[0].state.running.startedAt}' 2>/dev/null | grep -q .; do
    sleep 2
  done
  retry kubectl -n "$NS" cp "$tmp.tar.gz" "$pod:/workspace/context.tar.gz" -c context
  retry kubectl -n "$NS" exec "$pod" -c context -- touch /workspace/.ready
  echo "uploaded; job $job running"
  for c in $(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.spec.initContainers[*].name} {.spec.containers[*].name}'); do
    [ "$c" = context ] && continue
    stuck=0
    until kubectl -n "$NS" get pod "$pod" -o jsonpath="{.status.initContainerStatuses[?(@.name==\"$c\")].state.terminated.reason}{.status.initContainerStatuses[?(@.name==\"$c\")].state.running.startedAt}{.status.containerStatuses[?(@.name==\"$c\")].state.running.startedAt}{.status.containerStatuses[?(@.name==\"$c\")].state.terminated.reason}" 2>/dev/null | grep -q .; do
      kubectl -n "$NS" get job "$job" -o jsonpath='{.status.failed}' 2>/dev/null | grep -q 1 && break
      if kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.initContainerStatuses[*].state.waiting.reason} {.status.containerStatuses[*].state.waiting.reason}' 2>/dev/null \
          | grep -qE 'ErrImagePull|ImagePullBackOff|InvalidImageName'; then
        stuck=$((stuck + 1))
        [ $stuck -gt 45 ] && { kubectl -n "$NS" describe pod "$pod" | tail -5; echo "build FAILED: image pull (job $job)"; exit 1; }
      fi
      sleep 2
    done
    echo "--- $c"
    since=""
    while :; do
      kubectl -n "$NS" logs -f "$pod" -c "$c" $since 2>/dev/null || true
      since="--since=15s"
      st=$(kubectl -n "$NS" get pod "$pod" -o jsonpath="{.status.initContainerStatuses[?(@.name==\"$c\")].state.terminated.reason}{.status.containerStatuses[?(@.name==\"$c\")].state.terminated.reason}" 2>/dev/null || true)
      [ -n "$st" ] && break
      sleep 3
    done
    [ "$st" = Completed ] || { echo "build FAILED in $c (job $job)"; exit 1; }
  done
  ok=$(kubectl -n "$NS" get job "$job" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  [ "$ok" = 1 ] || sleep 5
}

# Pod spec pieces (indented for run_job's template).
CONTEXT_INIT='        - name: context
          image: busybox:1.36
          command: [sh, -c, "until [ -f /workspace/.ready ]; do sleep 1; done"]
          volumeMounts: [{name: workspace, mountPath: /workspace}]'
VOLUMES='      volumes:
        - {name: workspace, emptyDir: {}}
        - {name: docker-config, secret: {secretName: registry-push}}'

# kaniko_spec <dockerfile> <image:tag>... [-- extra kaniko args]: build the
# uploaded tar context.
kaniko_spec() {
  local dockerfile=$1; shift
  local dests="" extra="" d cache_repo="${1%%:*}-cache"
  while [ $# -gt 0 ] && [ "$1" != -- ]; do dests+="
            - --destination=$1"; shift; done
  [ "${1:-}" = -- ] && shift
  for d in "$@"; do extra+="
            - $d"; done
  cat <<EOF
      initContainers:
$CONTEXT_INIT
      containers:
        - name: kaniko
          image: $KANIKO
          args:
            - --context=tar:///workspace/context.tar.gz
            - --dockerfile=$dockerfile$dests
            - --cache=true
            - --cache-repo=$cache_repo
            - --snapshot-mode=redo
            - --compressed-caching=false$extra
          resources:
            requests: {cpu: "1", memory: 1Gi}
            limits: {memory: 4Gi}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: docker-config, mountPath: /kaniko/.docker}
$VOLUMES
EOF
}

tree=$(snapshot_tree)

# A dirty build is also tagged by its snapshot: two builds from different
# uncommitted changes must not share a tag, or deploy.sh pins the same tag
# again and IfNotPresent pods keep running the first image.
if [ -z "${2:-}" ] && [ "${TAG%-dirty}" != "$TAG" ]; then
  TAG="$TAG-${tree:0:8}"
fi

if [ "$COMPONENT" != dosbox ]; then
  sub=$COMPONENT
  [ "$COMPONENT" = platform ] && sub=go
  IMAGE=${IMAGE:-$REGISTRY/dosbox-$COMPONENT}
  archive "$tree:platform/$sub"
  run_job "$COMPONENT-build" "$(kaniko_spec Dockerfile "$IMAGE:$TAG" "$IMAGE:latest")"
  echo "pushed $IMAGE:$TAG"
  exit 0
fi

IMAGE=${IMAGE:-$REGISTRY/dosbox-x}
BUILDER=$REGISTRY/dosbox-x-builder
BIN=$REGISTRY/dosbox-x-bin

# 1. Toolchain image, keyed by its Dockerfile.
builder_tag=$(git cat-file -p "$tree:platform/docker/Dockerfile.builder" | sha256sum | cut -c1-12)
if published dosbox-x-builder "$builder_tag"; then
  echo "builder: $BUILDER:$builder_tag (exists)"
else
  echo "builder: building $BUILDER:$builder_tag"
  archive "$tree:platform/docker"
  run_job dosbox-builder "$(kaniko_spec Dockerfile.builder "$BUILDER:$builder_tag")"
fi

# 2. The emulator binary, keyed by everything that goes into it: the
# sources (all of the repo but platform/ and the trees the Linux build never
# touches), the compile recipe and the toolchain.
SRC_EXCLUDES=(':!platform' ':!vs/sdl2' ':!vs/sdl2net' ':!vs/freetype' ':!vs/libpng' ':!ref' ':!docs' ':!build-scripts' ':!experiments')
# The upload also needs compile.sh (pathspec excludes win over includes).
UPLOAD_EXCLUDES=(":!platform/stream" ":!platform/go" ":!platform/web" ":!platform/helm" ":!platform/k8s" ":!platform/README.md" ":!platform/build.sh" "${SRC_EXCLUDES[@]:1}")
# (git ls-tree takes no exclude pathspecs: filter its "<mode> <type> <id>\t<path>" lines.)
src_re=$(printf '%s|' "${SRC_EXCLUDES[@]#:!}")
src_re=$'\t'"(${src_re%|})(/|\$)"
bin_tag=$( { git ls-tree -r "$tree" | grep -vE "$src_re"; git cat-file -p "$tree:platform/docker/compile.sh"; git cat-file -p "$tree:platform/docker/pch.h"; echo "$builder_tag pch=$PCH"; } \
          | sha256sum | cut -c1-12)
if published dosbox-x-bin "$bin_tag"; then
  echo "compile: $BIN:$bin_tag (exists, sources unchanged)"
else
  echo "compile: building $BIN:$bin_tag"
  archive "$tree" "${UPLOAD_EXCLUDES[@]}"
  retry kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: $CCACHE_PVC, namespace: $NS}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: do-block-storage
  resources: {requests: {storage: 10Gi}}
EOF
  run_job dosbox-compile "      initContainers:
$CONTEXT_INIT
        - name: compile
          image: $BUILDER:$builder_tag
          command: [bash, -c, 'mkdir -p /src && tar -xzf /workspace/context.tar.gz -C /src && exec bash /src/platform/docker/compile.sh']
          env:
            - {name: JOBS, value: \"$JOBS\"}
            - {name: CACHE_KEY, value: \"$builder_tag\"}
            - {name: PCH, value: \"$PCH\"}
            - {name: OUT, value: /workspace/out}
          resources:
            requests: {cpu: \"2\", memory: 3Gi}
            limits: {memory: 6Gi}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: cache, mountPath: /cache}
      containers:
        - name: kaniko
          image: $KANIKO
          args:
            - --context=dir:///workspace/out
            - --dockerfile=Dockerfile
            - --destination=$BIN:$bin_tag
            - --snapshot-mode=redo
          resources:
            requests: {cpu: 500m, memory: 512Mi}
            limits: {memory: 2Gi}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: docker-config, mountPath: /kaniko/.docker}
$VOLUMES
        - {name: cache, persistentVolumeClaim: {claimName: $CCACHE_PVC}}"
fi

# 3. Runtime image: the binary on an Ubuntu base plus platform/docker files.
archive "$tree:platform/docker"
run_job dosbox-runtime "$(kaniko_spec Dockerfile "$IMAGE:$TAG" "$IMAGE:latest" -- "--build-arg=BIN_IMAGE=$BIN:$bin_tag")"
echo "pushed $IMAGE:$TAG (bin $bin_tag, builder $builder_tag)"
