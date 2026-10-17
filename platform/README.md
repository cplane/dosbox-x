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
| `stream/` | Go sidecar: Game Link frames -> JPEG over WebSocket, browser keyboard/mouse -> Game Link input; serves a test player page. |
| `build.sh` | Builds an image **inside the cluster** as a Kaniko Job (no local Docker): `build.sh dosbox` -> `dosbox-x`, `build.sh stream` -> `dosbox-stream`, tags `<sha>` and `latest` in `registry.digitalocean.com/container-registry-ams3`. Uploads the working tree (incl. uncommitted changes) as the build context. |
| `k8s/dosbox-instance.yaml` | One test box: Pod (dosbox + stream containers) + 1 Gi PVC in namespace `dosbox`, `/dev/shm` as a memory emptyDir shared by both. |

```bash
platform/build.sh dosbox
platform/build.sh stream
kubectl -n dosbox apply -f platform/k8s/dosbox-instance.yaml
kubectl -n dosbox port-forward pod/dosbox-test 8080:8080   # open http://localhost:8080/
```

## Stream sidecar (`stream/`)

| Endpoint | |
|---|---|
| `GET /` | test player: canvas, focus it to type; "Capture mouse" uses pointer lock |
| `GET /ws` | server -> client: binary JPEG frames, text `{"type":"meta","w","h","parX","parY","program"}` on change. client -> server text JSON: `{"k":<scancode>,"d":true\|false}`, `{"m":[dx,dy]}`, `{"b":<mask>}` |
| `GET /snapshot.jpg` | latest frame |
| `GET /healthz` | 200 while frames flow (readiness probe) |

- Scancodes are PC set-1, `0x80|code` for E0-extended keys (arrows, right Ctrl/Alt, keypad Enter...), matching `src/gamelink/scancodes_windows.h`. The page maps `KeyboardEvent.code`, so layout-independent physical keys are sent; text inserted without key events (paste, IME, some automation) is ignored for now.
- DOSBox-X only sees key *state* per poll, so the sidecar publishes one transition at a time and waits for DOSBox-X to clear the `ready` flag; mouse motion is coalesced. Keys a client holds are released when it disconnects.
- Frames are polled every 5 ms (`seq` change), encoded only while someone watches (plus one every 2 s for `/snapshot.jpg`), capped by `MAX_FPS` (30); each client gets only the newest frame. Env: `JPEG_QUALITY` (80), `MAX_FPS` (30), `LISTEN` (`:8080`), `GAMELINK_SHM`.
- **No auth**: reach it only via port-forward until the gateway fronts it.
- `go test ./...` in `stream/` checks the shm offsets against a fake Game Link file.

Verified 2026-10-17 on the DOKS cluster (image `dosbox-x:f95fb588686e`): box
boots to `C:\>` with `GAMELINK: rendersize=720x400`; `gl-snap` returns the
screen; `gl-type "echo hello from k8s > hello.txt|dir|"` runs in DOS and the
file lands on the PVC (`/data/c/HELLO.TXT`). With the sidecar
(`dosbox-stream`): the player page via port-forward shows the live screen
(~10 fps on a mostly static DOS prompt, ~10 KB/frame) and keys typed in the
browser run `ver` in DOS. Turbo C++ 3.0 from the volume opens, compiles and
runs (Ctrl+F9) a BGI paint program in 640x480x256 with `SVGA256.BGI`
(jharg93/SvgaBGI, MIT), and relative mouse input draws on its canvas.

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
- the INT 33h software cursor isn't drawn in VESA 256-color modes, so in
  e.g. 640x480x256 programs the arrow is invisible (positions/clicks work)

DOSBox-X changes made for headless use (this fork):
- `[sdl] hotkeys` (default `true`): `false` leaves DOSBox-X's own shortcuts
  unbound so every combo reaches DOS — otherwise Ctrl+F9 (Turbo C "Run")
  quits the emulator. `docker/dosbox-x.conf` sets `hotkeys = false`.
- Game Link mouse input is treated as a captured mouse
  (`OUTPUT_GAMELINK_InputEvent`): the cursor flags are normally refreshed
  only from SDL motion events, which never arrive headless, so DOSBox-X
  snapped the DOS cursor to (0,0) and never accumulated mickeys.

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
1. ~~`stream` sidecar~~ (done, keyboard + mouse verified).
   Next for it: a control API for agents/scripts — `/type` (text incl.
   shifted chars), `/keys` (combos), `/mouse`, file upload + auto `rescan`,
   lossless `/snapshot.png`.
2. `gateway`: box lifecycle via k8s API, auth middleware, WS proxy.
3. `web`: account + box list UI around the player.
4. Helm chart + ingress, same layout as the dunelegacy chart.
5. Audio: mixer hook in DOSBox-X -> PCM ring in shm -> sidecar (Opus/WebAudio).
