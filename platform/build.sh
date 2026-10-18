#!/usr/bin/env bash
# Build a dos-box platform image inside the DOKS cluster with Kaniko (no
# local Docker) and push it to the DigitalOcean registry.
#
#   platform/build.sh [dosbox|stream] [tag]
#
#   dosbox  headless DOSBox-X (context: repo root)       -> dosbox-x
#   stream  Game Link streaming sidecar (platform/stream) -> dosbox-stream
#   tag     default: git short sha (+ -dirty)
#
# Needs: kubectl (context = the DOKS cluster), doctl (authenticated), git, gzip.
set -euo pipefail
export MSYS_NO_PATHCONV=1

NS=${NS:-dosbox}
REGISTRY=${REGISTRY:-registry.digitalocean.com/container-registry-ams3}
KANIKO=${KANIKO:-gcr.io/kaniko-project/executor:v1.23.2}
JOBS=${JOBS:-4}
COMPONENT=${1:-dosbox}

cd "$(dirname "$0")/.."
GIT_DIR=$(git rev-parse --git-dir)   # relative paths: Windows git/kubectl choke on /tmp and C:

case "$COMPONENT" in
  dosbox)
    IMAGE=${IMAGE:-$REGISTRY/dosbox-x}
    SUBTREE=""                                   # whole repo
    DOCKERFILE=platform/docker/Dockerfile
    # Trees the Linux SDL2 build never touches; vs/ stays because the SDL2
    # build still includes vs/sdl/{include,src/cdrom} and vs/zlib.
    EXCLUDES=(':!vs/sdl2' ':!vs/sdl2net' ':!vs/freetype' ':!vs/libpng' ':!ref' ':!docs' ':!build-scripts' ':!experiments')
    DIRTY_PATHS=(. ':!platform')
    ;;
  stream)
    IMAGE=${IMAGE:-$REGISTRY/dosbox-stream}
    SUBTREE=platform/stream
    DOCKERFILE=Dockerfile
    EXCLUDES=()
    DIRTY_PATHS=(platform/stream)
    ;;
  *) echo "usage: $0 [dosbox|stream] [tag]" >&2; exit 2 ;;
esac
TAG=${2:-$(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD -- "${DIRTY_PATHS[@]}" || echo -dirty)}

idx="$GIT_DIR/index.$COMPONENT-build"
ctx="$GIT_DIR/$COMPONENT-build-context.tar.gz"
cfg="$GIT_DIR/$COMPONENT-build-docker.json"
trap 'rm -f "$idx" "$ctx" "$cfg"' EXIT

retry() {
  local n
  for n in 1 2 3 4 5 6; do
    "$@" && return 0
    echo "retry $n: $*" >&2
    sleep $((n * 5))
  done
  return 1
}

retry kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"

# Pull secret for pods, short-lived push secret for Kaniko.
doctl registry kubernetes-manifest --namespace "$NS" --name container-registry-ams3 | retry kubectl apply -f - >/dev/null
doctl registry docker-config --read-write --expiry-seconds 7200 > "$cfg"
kubectl -n "$NS" create secret generic registry-push --from-file=config.json="$cfg" \
    --dry-run=client -o yaml | retry kubectl apply -f - >/dev/null
rm -f "$cfg"

# Build context = working tree (incl. uncommitted/untracked changes) snapshotted
# into a throwaway index, exported with LF endings (the Windows checkout uses
# autocrlf).
cp "$GIT_DIR/index" "$idx"
GIT_INDEX_FILE="$idx" git add -A 2>/dev/null
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
rm -f "$idx"
[ -n "$SUBTREE" ] && tree="$tree:$SUBTREE"
git -c core.autocrlf=false archive --format=tar "$tree" -- . "${EXCLUDES[@]}" | gzip -1 > "$ctx"
echo "context: tree $tree ($(du -h "$ctx" | cut -f1)) -> $IMAGE:$TAG"

# The build runs as a Job so a flaky local link can't kill it: an init
# container waits for the context, we upload it with (retried) kubectl cp,
# then Kaniko builds and pushes on its own while we follow the logs.
job="$COMPONENT-build-$(date +%s)"
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
      initContainers:
        - name: context
          image: busybox:1.36
          command: [sh, -c, 'until [ -f /workspace/.ready ]; do sleep 1; done']
          volumeMounts: [{name: workspace, mountPath: /workspace}]
      containers:
        - name: kaniko
          image: $KANIKO
          args:
            - --context=tar:///workspace/context.tar.gz
            - --dockerfile=$DOCKERFILE
            - --destination=$IMAGE:$TAG
            - --destination=$IMAGE:latest
            - --build-arg=JOBS=$JOBS
            - --cache=true
            - --cache-repo=$IMAGE-cache
            - --snapshot-mode=redo
            - --compressed-caching=false
          resources:
            requests: {cpu: "2", memory: 3Gi}
            limits: {memory: 6Gi}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: docker-config, mountPath: /kaniko/.docker}
      volumes:
        - name: workspace
          emptyDir: {}
        - name: docker-config
          secret: {secretName: registry-push}
EOF

pod=""
until [ -n "$pod" ]; do
  pod=$(kubectl -n "$NS" get pod -l job="$job" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  [ -n "$pod" ] || sleep 2
done
until kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.initContainerStatuses[0].state.running.startedAt}' 2>/dev/null | grep -q .; do
  sleep 2
done
retry kubectl -n "$NS" cp "$ctx" "$pod:/workspace/context.tar.gz" -c context
retry kubectl -n "$NS" exec "$pod" -c context -- touch /workspace/.ready
echo "uploaded; job $job building (kubectl -n $NS logs -f $pod -c kaniko)"

# Follow logs, reconnecting on network drops, until the Job finishes.
since=""
while :; do
  kubectl -n "$NS" logs -f "$pod" -c kaniko $since 2>/dev/null || true
  since="--since=15s"
  ok=$(kubectl -n "$NS" get job "$job" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  bad=$(kubectl -n "$NS" get job "$job" -o jsonpath='{.status.failed}' 2>/dev/null || true)
  [ "$ok" = 1 ] && break
  [ "$bad" = 1 ] && { echo "build FAILED (job $job)"; exit 1; }
  sleep 5
done
echo "pushed $IMAGE:$TAG"
