# dos-box platform (work in progress)

Goal: run DOSBox-X instances ("dos-boxes") in the DOKS cluster and drive them
from a browser — accounts, allocate a box, see its screen, type/move the mouse,
manage boxes. Modeled on the dunelegacy deployment already in the cluster
(namespace `dunelegacy`: `auth`, `gateway`, `web`, ingress on
`*.pocket-maze.app`).

## What exists now (step 1: build + run headless)

| Path | What |
|---|---|
| `docker/Dockerfile.builder`, `docker/compile.sh` | Toolchain image and the compile script it runs (SDL2, `--disable-debug`, ccache); see Build notes. |
| `docker/Dockerfile` | Runtime image: the compiled binary on Ubuntu 24.04 + runtime deps resolved from `ldd`. |
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

- Scancodes are PC set-1, `0x80|code` for E0-extended keys (arrows, right Ctrl/Alt, keypad Enter...), matching `src/gamelink/scancodes_windows.h`. The page maps `KeyboardEvent.code`, so layout-independent physical keys are sent (`KeyboardEvent.key` when `code` is missing); text inserted without key events (paste, IME) is ignored — use `POST /type`.
- DOSBox-X only sees key *state* per poll, so the sidecar publishes one transition at a time and waits for DOSBox-X to clear the `ready` flag; mouse motion is coalesced. Keys a client holds are released when it disconnects.
- Frames are polled every 5 ms (`seq` change), encoded only while someone watches (plus one every 2 s for `/snapshot.jpg`), capped by `MAX_FPS` (30); each client gets only the newest frame. Env: `JPEG_QUALITY` (80), `MAX_FPS` (30), `LISTEN` (`:8080`), `GAMELINK_SHM`.
- **No auth**: reach it only via port-forward until the gateway fronts it.
- `go test ./...` in `stream/` (also run by the image build) checks the shm offsets, the text -> scancode mapping and the control API against a fake Game Link file and a fake DOSBox-X.

### Control API (agents, scripts)

Plain HTTP on the same port, so a box can be driven without a browser
(`kubectl -n dosbox port-forward pod/dosbox-test 18080:8080`). Input calls
return once DOSBox-X has taken every key/button transition into its
emulated keyboard/mouse (a slow program may still be catching up: wait
for the screen before the next step); they are serialized, so two `/type`
calls never interleave. `/keys` and `/mouse` read JSON whatever the
Content-Type; `/type` only with a JSON Content-Type.

| Endpoint | |
|---|---|
| `POST /type` | `{"text": "dir > out.txt\n", "hold_ms": 20, "gap_ms": 10}` (or any non-JSON body = the text). US-layout ASCII: Shift is pressed for `> : " { ! ...`; `\n`/`\r\n` = Enter, `\t` = Tab, `\b` = Backspace. Anything else -> 400 before any key is sent. |
| `POST /keys` | `{"combo": "ctrl+f9"}`; several: `"ctrl+k ctrl+b enter"`. Names: `esc enter tab space backspace ctrl alt shift rctrl ralt rshift f1`..`f12` `up down left right home end pgup pgdn ins del capslock numlock scrolllock kpenter kp0`..`kp9 kp+ kp- kp* kp/ kp. prtsc pause win menu`, or one character (`ctrl+:` adds Shift, `ctrl++`/`plus` = '+'). `hold_ms` (50) per combo; `"action": "down"`/`"up"` presses or releases without the other half. |
| `POST /mouse` | `{"dx": 10, "dy": -5}` relative motion (mickeys), `"buttons": <mask>` sets bit0 L / bit1 R / bit2 M, `"click": "left"\|"right"\|"middle"`, `"double": true`, `hold_ms` (50). Applied in that order. |
| `POST /click` | same as `/mouse` with `click` defaulting to `left` |
| `GET /snapshot.png` | current frame straight from Game Link, lossless; headers `X-Frame-Seq`, `X-Frame-Par`, `X-Program` |
| `PUT /files/<path>` | writes the body to `C:\<path>` (`/data/c`, parents created, temp file + rename), then rescans so DOS sees it; `?rescan=0` to skip when uploading many. 201 new / 200 replaced; `warning` if a component isn't 8.3 (DOS then sees e.g. `LONGFI~1.TXT`). Limit `MAX_UPLOAD_MB` (512). |
| `GET /files/<path>` | JSON listing `[{"name","size","dir","mtime"}]` for a directory (`/files/` = `C:\`), the bytes for a file |
| `POST /rescan` | rescan all drives (DOSBox-X "Rescan all drives") |

```bash
curl -s localhost:18080/type -H 'Content-Type: application/json' -d '{"text":"echo \"hi\" > a.txt\n"}'
curl -s localhost:18080/keys -d '{"combo":"ctrl+f9"}'
curl -s -T hello.c localhost:18080/files/SRC/HELLO.C
curl -s localhost:18080/snapshot.png -o screen.png
```

- Key timing: `/type` holds every key down `hold_ms` (20) and pauses
  `gap_ms` (10) after each release, ~30 ms per character (~33 chars/s,
  about a keyboard's maximum typematic rate). Programs that read the
  keyboard through their own INT 9 handler and sample key state (Turbo
  C++ 3.0's IDE) miss a key pressed and released within a millisecond and
  repeat the previous character instead: at full speed `main(void)` came
  out as `maii(voii)`. With these defaults a 275-character C program typed
  into the Turbo C editor arrives exactly. TC's screen can lag the input by
  seconds; poll `/snapshot.png` until it stops changing.
- Back-pressure: this fork leaves the Game Link input block unconsumed
  until the guest has read every scancode of the previous change from
  port 60h, plus 2 ms of emulated time (capped at 1 s), and the sidecar
  waits (up to 2 s) for each transition to be consumed. So a fast client
  can't overflow DOSBox-X's 96-code controller queue (which then drops
  *everything* queued) or queue several bytes at once (the next one is
  served 0.3 ms after the first port 60h read, so an ISR that reads 60h
  and then chains to the BIOS, which reads it again, gets the wrong one).
- `/type` also waits while the guest's BIOS type-ahead buffer is more than
  half full (read from guest RAM, which Game Link maps right after its
  core block), giving up on that for the rest of the request if it doesn't
  drain for 2 s. Programs with their own INT 9 handler (Turbo C) never use
  that buffer. It also reads the BIOS Caps Lock flag and inverts Shift
  for letters, so the case you send is the case DOS gets.
- Rescan goes through Game Link's command buffer (`buf_recv`, the
  "mechanical" `:reset`/`:pause`/`:shutdown` channel): the sidecar writes
  `:rescan`, which this fork adds (below), so nothing is typed at the DOS
  prompt and it works while a program runs. Without a rescan, opening a
  new file by its exact name already works; it is `DIR` and wildcard
  searches that show a stale listing. A program that already has a
  listing in memory (e.g. an open-file dialog) still needs to re-read it.
- The stream container mounts the PVC's `c/` at `/data/c` (`DATA_DIR`).
- The player falls back to `KeyboardEvent.key` (US layout, with a
  synthesized Shift for `:` etc.) when an event has no `code`.

Verified 2026-10-17 on the DOKS cluster (image `dosbox-x:f95fb588686e`): box
boots to `C:\>` with `GAMELINK: rendersize=720x400`; `gl-snap` returns the
screen; `gl-type "echo hello from k8s > hello.txt|dir|"` runs in DOS and the
file lands on the PVC (`/data/c/HELLO.TXT`). With the sidecar
(`dosbox-stream`): the player page via port-forward shows the live screen
(~10 fps on a mostly static DOS prompt, ~10 KB/frame) and keys typed in the
browser run `ver` in DOS. Turbo C++ 3.0 from the volume opens, compiles and
runs (Ctrl+F9) a BGI paint program in 640x480x256 with `SVGA256.BGI`
(jharg93/SvgaBGI, MIT), and relative mouse input draws on its canvas.

Verified 2026-10-18 (control API): `/type` puts `echo "Hi: <>|{}~!@#$%^&*()_+?"`
at the prompt exactly; a C program typed into Turbo C++ through `/type`
matches the source, then `/keys ctrl+f9` + `alt+f5` show its output
(`sum of squares 1..10 = 385`); `/click` opens TC's File menu; after a PUT
with `?rescan=0` `DIR` doesn't list the file, after `POST /rescan` (or a
normal PUT) it does; `/snapshot.png` returns the 720x400 frame.

Build notes (`build.sh dosbox`, same recipe as the dunelegacy engine build):
the emulator is compiled **outside** the image build, because Kaniko's layer
cache misses on any source change and recompiled all ~600 objects (14 min).
1. `dosbox-x-builder:<hash of docker/Dockerfile.builder>`: toolchain +
   ccache; rebuilt only when that file changes.
2. `dosbox-x-bin:<hash of the emulator sources, compile.sh, pch.h, builder>`:
   a Job runs `docker/compile.sh` in the builder image with a persistent
   ccache PVC (`dosbox-build-ccache`, 10 Gi; also caches autogen output and
   `configure` results), then Kaniko pushes the binary as a `FROM scratch`
   image. Skipped when that tag already exists: `platform/` changes never
   recompile the emulator.
3. `dosbox-x:<tag>`: `docker/Dockerfile` puts the binary on Ubuntu with the
   runtime packages `compile.sh` resolved via `ldd` (cached layer).

Measured 2026-10-18 (2 vCPU requested, `-j4`):

| Change | Before | Now |
|---|---|---|
| none in the emulator (platform files only) | ~4 min | 67 s |
| one `.cpp` (or a recipe change, warm cache) | ~15–18 min | ~3.5 min, of which the compile is ~45 s (585/585 ccache hits); the rest is pod start, PVC attach, the 51 MB upload and two pushes |
| cold cache | ~15 min | ~15 min (make 834 s) |

A precompiled header (`PCH=1 platform/build.sh dosbox`, `docker/pch.h`:
standard headers only, force-included via `CXXFLAGS`, the `.gch` cached by
content so ccache keeps hitting) cut a cold make only from 834 s to 777 s,
since `-O2` code generation, not header parsing, dominates this build. So
it is off by default. A header that many files include (e.g. `dosbox.h`)
still means a near-cold build. The Windows checkout is CRLF
(`core.autocrlf=true`); `build.sh` exports LF via `git archive`. The Linux
build still needs `vs/sdl/{include,src/cdrom}` and `vs/zlib`; only the big
vendored libs under `vs/` are left out. Concurrent `build.sh stream` and
`build.sh dosbox` runs are fine (per-component temp files).

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
- Game Link `:rescan` command (`src/gamelink/gamelink_term.cpp`): runs
  "Rescan all drives" so files the sidecar writes into a mounted directory
  show up in DOS.
- Game Link input back-pressure (`OUTPUT_GAMELINK_InputEvent`,
  `KEYBOARD_IdleFor()` in `src/hardware/keyboard.cpp`): input stays
  pending until the keyboard controller is idle and its last byte was
  read >= 2 ms ago (at most 1 s), see "Back-pressure" above.
- Game Link commands are read on input polls too
  (`GameLink::MessagePending()`): DOSBox-X only read `buf_recv` when a frame
  was rendered, so on a static screen (a dialog without a blinking cursor)
  `:rescan` waited until something on screen changed.

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
1. ~~`stream` sidecar~~ (done, keyboard + mouse verified), ~~control API~~
   (`/type`, `/keys`, `/mouse`, `/files` + rescan, `/snapshot.png`).
2. `gateway`: box lifecycle via k8s API, auth middleware, WS proxy.
3. `web`: account + box list UI around the player.
4. Helm chart + ingress, same layout as the dunelegacy chart.
5. Audio: mixer hook in DOSBox-X -> PCM ring in shm -> sidecar (Opus/WebAudio).
