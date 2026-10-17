# dos-box platform (work in progress)

Goal: run DOSBox-X instances ("dos-boxes") in the DOKS cluster and drive them
from a browser — accounts, allocate a box, see its screen, type/move the mouse,
manage boxes. Modeled on the dunelegacy deployment already in the cluster
(namespace `dunelegacy`: `auth`, `gateway`, `web`, ingress on
`*.pocket-maze.app`).

## What exists now (step 1: build + run headless)

| Path | What |
|---|---|
| `docker/Dockerfile` | Ubuntu 24.04 multi-stage build of DOSBox-X with SDL2 (system SDL2), `--disable-debug`. Runtime deps resolved from `ldd`. |
| `docker/dosbox-x.conf` | Headless defaults: `videodriver=dummy`, `output=gamelink`, `gamelink master=true`, no sound, `C:` = `/data/c`. |
| `docker/entrypoint.sh` | Starts one instance; extra args pass through (`-c "cmd"`, `-set "sec key=val"`). |
| `docker/gl-snap.py` | Reads the Game Link shared memory and writes the current frame as PNG (proves the frame path). |
| `docker/gl-type.py` | Types text into the box through the Game Link input block (`\|` = Enter). Not baked into the image yet: `kubectl exec -i ... -- sh -c 'cat > /tmp/gl-type.py' < platform/docker/gl-type.py`. |
| `build.sh` | Builds the image **inside the cluster** with Kaniko (no local Docker), pushes `dosbox-x:<sha>` and `:latest` to `registry.digitalocean.com/container-registry-ams3`. Uploads the working tree (incl. uncommitted changes) as the build context. |
| `k8s/dosbox-instance.yaml` | One test box: Pod + 1 Gi PVC in namespace `dosbox`, `/dev/shm` as a memory emptyDir. |

```bash
platform/build.sh
kubectl -n dosbox apply -f platform/k8s/dosbox-instance.yaml
kubectl -n dosbox exec dosbox-test -c dosbox -- gl-snap /data/capture/frame.png
kubectl -n dosbox cp dosbox-test:/data/capture/frame.png frame.png -c dosbox
```

Verified 2026-10-17 on the DOKS cluster (image `dosbox-x:f95fb588686e`): box
boots to `C:\>` with `GAMELINK: rendersize=720x400`; `gl-snap` returns the
screen; `gl-type "echo hello from k8s > hello.txt|dir|"` runs in DOS and the
file lands on the PVC (`/data/c/HELLO.TXT`).

Build notes: a full compile is ~14 min on 2 vCPU requested; Kaniko layer cache
(`dosbox-x-cache` repo) brings unchanged-source rebuilds to ~4 min. The
Windows checkout is CRLF (`core.autocrlf=true`) — `build.sh` exports LF via
`git archive`. The Linux build still needs `vs/sdl/{include,src/cdrom}` and
`vs/zlib`; only the big vendored libs under `vs/` are excluded.

## Why Game Link

DOSBox-X already ships a headless I/O channel (`src/gamelink/`, SDL2 builds):
with `output=gamelink` every frame is copied as 32-bit BGRA into POSIX shared
memory `/dev/shm/DWD_GAMELINK_MMAP_R4` (guarded by semaphore
`/DWD_GAMELINK_MUTEX_R4`), and keyboard/mouse are read back from the same
block (`sSharedMMapInput_R2`: 256-bit scancode bitmap + relative mouse +
buttons), injected in `OUTPUT_GAMELINK_InputEvent()`. So a sidecar in the same
pod can stream video out and feed input in **without patching DOSBox-X**.

Limits to rework later:
- max frame 1280x1024; the full frame is copied every refresh (no dirty rects)
- input is a key-state bitmap (Windows scancodes), mouse is relative only
- no audio over Game Link (only volume) — needs a mixer hook or PulseAudio sink
- one Game Link instance per IPC namespace -> one box per pod (fine)

## Target architecture

```
browser ──https/wss──> ingress (dosbox.pocket-maze.app)
                        ├── web      SPA: login, box list, player (canvas)
                        ├── auth     accounts, JWT access/refresh cookies
                        │            (same model as dunelegacy-auth; could be shared)
                        └── gateway  REST: /boxes CRUD, start/stop/snapshot
                                     WS:   /boxes/{id}/stream -> proxied to box
                                     owns a k8s client (ServiceAccount, ns dosbox)
                                     Postgres: users<->boxes, quotas, state
box pod (one per allocated dos-box, ns dosbox)
  ├── dosbox   this image; output=gamelink
  └── stream   sidecar: shm frames -> encode (JPEG/WebP first, H.264/WebRTC
               later) -> WS; WS input -> shm input block
  PVC          the box's C: drive / disk images (or DO Spaces sync)
```

Differences from dunelegacy: its gateway spawns `dlserver` as child processes
inside the gateway pod; for DOS boxes a pod per box gives resource limits,
isolation (arbitrary user DOS software) and independent lifetimes.

## Next steps
1. `stream` sidecar (Go): shm reader/writer, WebSocket, JPEG frames, keyboard + mouse.
2. `gateway`: box lifecycle via k8s API, auth middleware, WS proxy.
3. `web`: player page.
4. Helm chart + ingress, same layout as the dunelegacy chart.
