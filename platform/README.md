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
| `build.sh` | Builds an image **inside the cluster** as a Kaniko Job (no local Docker): `build.sh dosbox` -> `dosbox-x`, `stream` -> `dosbox-stream`, `platform` -> `dosbox-platform`, `web` -> `dosbox-web`, tags `<sha>` and `latest` in `registry.digitalocean.com/container-registry-ams3`. Uploads the working tree (incl. uncommitted changes) as the build context. |
| `go/`, `web/`, `helm/`, `deploy.sh` | The web platform, see "Web platform" below. |
| `k8s/dosbox-instance.yaml` | One standalone test box (outside the platform): Pod (dosbox + stream containers) + 1 Gi PVC in namespace `dosbox`, `/dev/shm` as a memory emptyDir shared by both. |

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
| `GET /ws` | server -> client: binary **strip updates** — `"S" 1 count:u16 w:u16 h:u16` then count × `(y:u16 h:u16 len:u32 jpeg)`, only the 32-row strips that changed; text `{"type":"meta",…}` on mode change, `{"type":"pong","t","encodeMs","fps"}`. client -> server text JSON: `{"k":<scancode>,"d":true\|false}`, `{"a":[x,y]}` absolute mouse (0..1 of the frame), `{"m":[dx,dy]}` relative mouse, `{"b":<mask>}`, `{"ack":1}` per update drawn, `{"ping":t}` |
| `GET /snapshot.jpg` | latest frame |
| `GET /screen.txt` | the text screen as UTF-8 (codepage decoded), one line per row; headers `X-Text-Size`, `X-Codepage`, `X-Cursor`; 409 in graphics modes. Through the gateway: `/api/boxes/{id}/ctl/screen.txt` |
| `GET /screen.ansi` | the same text with 24-bit colour escapes from the screen's own palette (blink: SGR 5), for a terminal: `curl …/screen.ansi` |
| `GET /screen.json` | `cols, rows, cellW, cellH, codepage, cursor{x,y,visible}, blinkAttribute, palette[16] ("#rrggbb"), lines[{text, fg[], bg[], blink[]}]` — `text` has exactly `cols` characters, so `text[i]` goes with `fg[i]`/`bg[i]`; `blink` lists blinking columns. Control bytes 01-1F show as the DOS glyphs (☺ ► ↑ …) in all three |
| `GET /agent`, `POST /agent` | the DOSBox-X **RPC debugger agent** (debug image only; see "Debugger"): GET → `{"available"}`; POST body = one JSON-RPC 2.0 request, the agent's response as is (409 without the agent). Over the player socket: `{"rpc": <request>}` → `{"type":"rpc","response":…}`. Through the gateway: `POST /api/boxes/{id}/ctl/agent` |
| `GET /ws` + `{"hello":{"con":1}}` | the **console stream** live: binary `"C" 1 flags bytes…` chunks of what DOS writes to CON as it happens (flags bit 0: bytes were lost before these); the last 8 KB first. The player's Workbench view feeds this to an xterm.js terminal; keys go back as scancodes like the screen's |
| `POST /run` | run one command line at the DOS prompt and return what it printed, like a terminal: `{"cmd":"ml /AT hello.asm","timeout_ms":60000}` (or a text/plain body) → `{"output","errorlevel","ms","timed_out","prompt","source":"con"\|"screen","truncated"?}`. 409 when DOS is not at a prompt (a program is running, or a graphics mode). The output comes from the console stream (`/dev/shm/DWD_GAMELINK_CON_R1`, every byte DOS wrote to CON) when DOSBox-X publishes one, else from the text screen; a program that never returns to the prompt ends in `timed_out` with what was captured. Through the gateway: `/api/boxes/{id}/ctl/run` |
| `GET /healthz` | 200 while frames flow (readiness probe) |

- Scancodes are PC set-1, `0x80|code` for E0-extended keys (arrows, right Ctrl/Alt, keypad Enter...), matching `src/gamelink/scancodes_windows.h`. The page maps `KeyboardEvent.code`, so layout-independent physical keys are sent (`KeyboardEvent.key` when `code` is missing); text inserted without key events (paste, IME) is ignored — use `POST /type`.
- DOSBox-X only sees key *state* per poll, so the sidecar publishes one transition at a time and waits for DOSBox-X to clear the `ready` flag; mouse motion is coalesced. Keys a client holds are released when it disconnects.
- Frames are polled every 2 ms (`seq` change), capped by `MAX_FPS` (60). Each frame is diffed against the previous one in 32-row strips; only changed strips are JPEG-encoded (in parallel) — a moving cursor costs one or two strips (WC2 menu: ~3 ms encode, ~16 KB per update, vs 16 ms for a full 640×480 frame). Each client keeps the set of strips it still needs, so updates skipped under flow control are merged, never lost.
- **Flow control:** a client that acks (`{"ack":1}` per update drawn) has at most `FRAME_WINDOW` (3) updates in flight; a slow or stalling link shows the newest screen late instead of a growing backlog. Clients draw updates in order.
- **Native cursor:** the player sends the browser cursor's position (`{"a"}`); DOSBox-X places the DOS cursor exactly there (Game Link extension, see "Why Game Link"), so clicks land where the user's arrow is regardless of video delay. "Capture mouse" switches to relative motion (pointer lock).
- **Text modes are sent as data, not video.** DOSBox-X publishes the text screen — cells (char + attribute), cursor, 16-colour palette, the VGA font, the DOS codepage — in `/dev/shm/DWD_GAMELINK_TEXT_R1` (`output_gamelink.cpp`, a seqlock, read from the BIOS data area and the active page). A client that sends `{"hello":{"text":1}}` gets text updates in text modes: `"T" 1 flags cols rows cellW cellH curX curY curStart curEnd codepage sections` then palette / font (when changed) / changed rows (`row:u16` + cols × (char, attr)). The player (`web/src/player/textmode.ts`) draws them pixel-exact from the VGA font and blinks cursor and blink attribute locally; switching to graphics falls back to strips and back. A full 80×25 screen with font is ~8 KB, a typed character ~200 bytes; key -> echoed row measured at ~RTT + 10 ms (median 87 ms at 82 ms RTT). The renderer is a separate module so other styles (any web font, colour schemes, via the codepage) can be added. Clients that don't say hello keep getting strips.
- Latency meter: the player pings once a second; the toolbar shows fps and round trip (tooltip: server encode time and fps). Measured 2026-10-19 (WC2 main menu, via port-forward, 60 ms RTT): mouse move -> updated strips received, median 87 ms.
- Env: `JPEG_QUALITY` (75), `MAX_FPS` (60), `FRAME_WINDOW` (3), `LISTEN` (`:8080`), `GAMELINK_SHM`.
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

## Debugger (the learning workbench)

The longer-term goal: DOS as a **headless execution core** in the pod and a
rich browser workbench around it — editor, console, CPU registers, memory
map, disassembly, instruction traces — so a learner sees everything an
8086/286/386 machine does, which a real DOS box never shows. Console tools
(MASM, TC, TP, batch) do the work; nothing needs the DOS screen.

What exists (first milestone; the platform's boxes run this image now, see
`images.dosbox` in the chart). Measured 2026-10-19 with a 13.1M-iteration `loop`
(`BENCH.COM`, through `/run`): at `cycles=auto` both images take 4.85 s (the
rate is fixed, the host keeps up); at `cycles=max` the plain image took
0.86-1.45 s and the debug image 0.93-1.94 s on a shared node, i.e. the
debugger costs roughly 10-30 % at full speed and nothing at the fixed rates
the machine presets use:

- **`dosbox-x-debug` image** (`build.sh dosbox-debug`): the same emulator
  configured `--enable-debug=heavy --enable-dosbox_agent`, i.e. DOSBox-X's
  internal debugger (heavy: CPU trace, memory-change breakpoints) plus its
  RPC debugger agent (`src/agent`, protocol in `docs/rpc-agent-usage.md`),
  started by the entrypoint with `-agent-config /etc/dosbox/agent.env`.
  Changes made for this: a **Unix socket transport** for the agent (upstream
  only had Windows named pipes) and a **headless debugger** (without a
  terminal the curses console is skipped: `initscr()` would exit the
  process; every drawing routine already tolerates no window).
- **Agent** = JSON-RPC 2.0 as JSON Lines on `/dev/shm/dosbox-agent.sock`:
  `session.start` (runs `DEBUGBOX <program>` on C: and stops at its entry),
  `state.get_registers`, `memory.read/write` (segmented / linear / physical),
  `breakpoints.create/list/delete`, `execution.step/continue/pause/wait`,
  `trace.start/read/stop`, `debugger.execute_command` (allow-listed),
  `session.stop`. Numbers are hex strings; continue/pause/stop return an
  operation to `execution.wait` on. One session per box at a time.
- **Sidecar bridge** (`stream/agent.go`): a connection per request (the
  agent serves each on its own thread, so a blocking wait doesn't stall
  other calls), `POST /agent` for scripts and `{"rpc":…}` over the player
  socket for the browser.
- **Player "Debug" panel** (`web/src/screens/DebugPanel.tsx`): start a
  program at its entry, step into/over (F7/F8), continue (F9), pause, stop;
  registers (changed ones highlighted), flags by name, and a **disassembly
  window** that follows CS:IP (`code.disassemble`, added to the agent: the
  debugger's own DasmI386, so 8086-386 opcodes come out right) with
  breakpoints in the gutter and run-to-cursor on an address.
- **Memory** (`MemoryPanel.tsx`): a hex window at any segment:offset with
  DS / ES / SS:SP / CS:IP presets, pointers outlined, bytes changed since
  the last stop in red, a byte written on click; and the first megabyte as
  a bar — DOS's MCB chain (`debugger.execute_command "DOS MCBS"`, allow-listed)
  with the program's block marked, video memory, BIOS ROM.
- **Timeline** (`TracePanel.tsx`): record N instructions with the CPU trace
  (`trace.start`, continue until it is full, `trace.read`), shown as a strip
  and a table: INT 21h/10h/16h/33h calls decoded by function (AX/DX are
  reconstructed from the register changes), port I/O named (PIC, PIT,
  keyboard, VGA, Sound Blaster...), branches marked; filter by kind.
- **Console** (`Console.tsx`): a terminal for the DOS prompt. Line editing
  and history are local; Enter runs the line through the sidecar's
  `POST /run`, which types it, waits for the prompt to come back and
  answers with the output, DOS's errorlevel (text mirror v2 carries
  `dos.return_code`), the time taken and the new prompt. The output comes
  from the **console stream**: DOSBox-X mirrors every byte written to the
  CON device (programs' stdout/stderr, the shell's echo and prompt) into a
  ring buffer in `/dev/shm/DWD_GAMELINK_CON_R1` (`output_gamelink.cpp`,
  hooked in `dev_con.h`), so fast output that scrolls off between frames is
  complete; the text screen is the fallback for programs that draw directly.
- **Workbench view** (the Screen / Workbench select on the player's bar): a
  dockable **workspace** (`workbench/Workspace.tsx`, flexlayout) on paper
  colours, the DOS screen put away. Files, Editor, Terminal, the 8086
  guide, the Interrupts reference and the Memory map are tabs that can be
  dragged between groups, split, maximised or closed; the layout is
  remembered (⟲ resets it). The **Machine** tab exists only while a
  program runs under the debugger. The terminal (`Terminal.tsx`, xterm.js)
  is the console stream live (`hello con`), so a program's output appears
  while it runs; every key goes to DOS the way the screen's do (DOS
  echoes), pasted text is typed. Build & Run types `C:\BUILD` there.
  Programs that draw the screen directly don't show in it — switch back
  to Screen for those.
- **References** (`workbench/`): the **8086 guide** (`guide.ts`) —
  instructions grouped by what you reach for first, one line each with the
  flags, every one with an example that "open in editor" drops into the
  .COM skeleton as a new file, plus ready programs (minimal .COM, keys,
  counting with AAM, direct video, string length); the **Interrupts**
  reference (`interrupts.ts`: INT 21h, 10h, 16h, 33h, 1Ah, 13h, 15h by
  function with in/out/notes) — the machine view names the function when
  the current instruction is an INT (it knows AH) and links there, and
  hovering an `INT` line in the editor shows it (AH found from the MOV
  above); the **Memory map** (`MemoryMapPanel.tsx`): the first megabyte,
  what lives where, which regions a program may write, and where the
  running program sits.
- **The machine** (`workbench/Machine.tsx`): the workbench's right column
  draws the running program instead of listing it. Memory is a field of
  cells (the data segment, 4 KB at a byte per cell up to 64 KB; the stack
  top as a strip with SP marked): at every stop the cells the step wrote
  flash warm and fade (the window is diffed), the cells the next
  instruction will touch flash cool (its operands decoded with the live
  registers, `operands.ts`), the cell under IP is marked and executed
  cells stay tinted. Under it the CPU: register cells and flag bits that
  flash when they change, and the instructions as a tape feeding the
  CPU, the current one at the head (click: run to; ○/●: breakpoint).
  Step (F7/F8), run to a breakpoint (F9), or **play** at 1-20 steps a
  second. The other tab is the **8086 guide** (`guide.ts`: instructions
  grouped by what you reach for first, registers, DOS and BIOS calls, the
  .COM skeleton; a filter box). **Debug** in the editor builds the open
  file — for .ASM with `ML /Fl`, whose listing maps code offsets to source
  lines (`listing.ts`) — then starts it stopped at its entry: the current
  line gets an arrow and a tint in Monaco's gutter, a click on the gutter
  sets a breakpoint, and the arrow follows every step. C and Pascal
  programs debug at the instruction level (the Code tab).
- **Editor** (`Editor.tsx`): a browser over C: and Monaco (bundled, lazy)
  with a MASM tokenizer, C/C++, Pascal and batch highlighting and the
  Borland blue theme; files are read and written byte for byte (CP437 kept)
  with CRLF line ends. **Build & Run** saves, writes `C:\BUILD.BAT` (CD to
  the file's folder, the build at `cycles=max`, the box's own speed back,
  then the program; `$FAIL.COM` ends a failed build with errorlevel 1) and
  has the console type `C:\BUILD` — typing costs ~35 ms a character, so a
  long compiler line is not typed. Toolchains: `ML /AT` for .ASM, `TCC`
  for .C/.CPP, `TPC` for .PAS; .BAT/.EXE/.COM just run; the build command
  is editable and remembered per language.
- **Machine per box** (`gateway/machine.go`, the Boxes screen): CPU model
  (8086, 186, 286, 386, 486, Pentium or the default), memory (1-64 MB) and
  speed (cycles, with presets named after the PCs they approximate),
  stored with the box and passed to the pod as `-set` arguments; changed
  while the box is stopped.
- Example: `platform/examples/asm/HELLO.ASM` (MASM 6.11: `ML /AT HELLO.ASM`).

Next for it: a live memory read/write heatmap (needs access counters in
DOSBox-X), watch expressions, source-level stepping from MASM listings.

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
- input is a key-state bitmap (Windows scancodes); mouse is relative, plus our extension: bit 7 of `mouse_btn` marks `mouse_dx/dy` as an absolute 0..1 position (`output_gamelink.cpp` feeds it to DOSBox-X's seamless-mouse path, still counting mickeys)
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

## Web platform: https://dosbox.pocket-maze.app

Helm release `dosbox` in namespace `dosbox` (`helm/dosbox`), deployed with
`platform/deploy.sh`. Same layout as dunelegacy: the ingress sends
everything to `web`, whose nginx serves the app and routes `/auth/` and
`/api/` on the same origin (host-only, httpOnly, SameSite=Lax cookies; no
CORS). TLS: the load balancer's `*.pocket-maze.app` certificate; DNS: an A
record `dosbox` -> 167.99.18.243.

```
browser ──https/wss──> ingress-nginx ──> dosbox-web (nginx + React app, 2 replicas)
                                          ├── /auth/ ──> dosbox-auth     accounts, RS256 JWT cookies
                                          │                              (dbx_access 1h / dbx_refresh 90d)
                                          └── /api/  ──> dosbox-gateway  boxes, pods, proxy, files, janitor
                                                            │  k8s API (ServiceAccount, Role: pods)
                                                            ▼
                                          box-<id> pods: dosbox (DOSBox-X) + stream sidecar
                                          dosbox-boxes volume (10 Gi): <id>/ = box /data, <id>/c = C:
Postgres: database dosbox-01 (owner: user dosbox) on the managed cluster
db-pgsql-ams3-80134; tables identity/refresh_token (auth), box (gateway).
```

| Piece | What |
|---|---|
| `go/` | One Go module, one image `dosbox-platform` (`/app/auth`, `/app/gateway`). `core/auth` + `services/auth` are a copy of dunelegacy's auth service (cookies renamed `dbx_*`, issuer `dosbox-auth`). `services/gateway` is new. |
| `web/` | React 18 + Vite + TypeScript, image `dosbox-web`: sign-in (from dunelegacy), box list, file browser, player (canvas + keyboard + pointer-lock mouse, as the stream test page). Routes in the hash: `#/box/<id>`, `#/box/<id>/files`. |
| `helm/dosbox` | auth (+ keys PVC), gateway (+ ServiceAccount/Role/RoleBinding, `dosbox-boxes` PVC, NetworkPolicy for box pods), web, ingress. PVCs carry `helm.sh/resource-policy: keep`. |
| `deploy.sh` | `helm upgrade --install`, each image pinned to its newest pushed tag. `RESTART_BOXES="creative"` (or `--all`) also restarts those running boxes onto the new box images (`restart-boxes.sh`: recreates the pod from its own spec with the images swapped; C: kept; skipped if already current). |
| Secret `dosbox` | `postgresUrl` (created out of band); optional `googleClientId` (Google sign-in) and `spacesKey`/`spacesSecret` (catalog master copies in Spaces). |

Gateway API (all need a session cookie or `Authorization: Bearer <access token>`; only the owner, or an admin, sees a box):

| | |
|---|---|
| `GET/POST /api/boxes`, `GET/DELETE /api/boxes/{id}` | list / create `{"name"}` / status / delete (pod, folder and row) |
| `POST /api/boxes/{id}/start`, `/stop` | create / delete the box's pod |
| `GET /api/boxes/{id}/ws` | the player WebSocket, proxied to the box's stream sidecar (counts viewers) |
| `/api/boxes/{id}/ctl/{type,keys,mouse,click,rescan,snapshot.png,snapshot.jpg}` | the box control API (see Control API), proxied without the user's credentials |
| `GET/PUT/DELETE /api/boxes/{id}/files/<path>` | the box's C: drive, served by the gateway from the volume (works while the box is stopped); PUT is checked against the disk allowance and makes a running box rescan |
| `GET /api/config` | limits, for the UI |

### Software catalog

Ready-made DOS software a box gets a **copy** of on its C: drive — picked
when creating a box (or "Clean box": nothing), or added later ("Add
software"). An item lands in `C:\<DIR>` plus `C:\<DIR>.BAT` that starts its
program; the copy is the box's own (saves, configs, swap files just work)
and counts against its allowance.

- **Storage:** unpacked on the boxes volume (`<boxes>/_catalog/<slug>`, what
  boxes are filled from); master copy zipped in DO Spaces
  (`dosbox-catalog-ams3/catalog/<slug>.zip`). The gateway syncs hourly and at
  start: a missing volume copy is restored from Spaces, a missing zip is
  uploaded. Without `spacesKey`/`spacesSecret` in the `dosbox` secret the
  catalog runs volume-only (the gateway logs it).
- **Table** `catalog_item` (slug, title, category, dir, run, source, license,
  size, status `ready|importing|failed`, error).
- **Seeding** from a local DOS folder: `platform/catalog/seed.sh [dir] [slug…]`
  streams each folder as a tar into `gateway catalog-put` in the gateway pod
  (cluster access is the credential). Seeded 2026-10-18 from `C:\dosdrive`:
  17 items (Keen 1-8, Dune II, Prince of Persia, Stunts, Warcraft II, Turbo
  C++ 3.0, Turbo Pascal 7.0, MASM 6.11, QBX 7.1, Norton Commander 5, tools).
- **Admins** (`identity.role = 'admin'`) get a Catalog page: import from
  archive.org by identifier (the gateway downloads the item's zip — the named
  one or the largest — and ingests it in the background), upload a zip, edit,
  delete. Archives are unpacked with path, size (`CATALOG_MAX_ITEM_MB`, 400)
  and file-count checks; a single top-level folder is unwrapped.

| | |
|---|---|
| `GET /api/catalog` | items (players: ready ones) |
| `POST /api/boxes` `{"name","items":[slug…]}` | create with items copied onto C: (413 if over the allowance, nothing created) |
| `POST /api/boxes/{id}/attach` `{"items":[slug…]}` | copy into an existing box (409 if `C:\<DIR>` exists); a running box rescans |
| `PUT /api/catalog/{slug}?title=&dir=&run=&category=&license=` | admin: zip body, 202 |
| `POST /api/catalog/import` `{"identifier","file"?,"slug"?,"title"?,"dir"?,"run"?,…}` | admin: archive.org, 202 |
| `PATCH /api/catalog/{slug}`, `DELETE /api/catalog/{slug}` | admin |

Box model and limits (values `gateway.limits`):
- A box is a folder plus a row; it **runs** while pod `box-<id>` exists.
  Start creates the pod (~15 s to a DOS prompt), stop/idle deletes it, and
  the C: drive stays. Delete removes all three.
- 3 boxes and 1 running box per user, 8 running in total, 500 MB per C:.
  A running box nobody watches (no player socket, no API calls) stops after
  15 min.
- **One node.** The volume is a DO block volume (attaches to one node), so
  the gateway and every box pod share the label `dosbox/storage=boxes` with
  a required pod affinity on it: all land on the node that holds the
  volume (the first of them picks it). That node's capacity (~4 vCPU /
  6 GB, each box requests 350m / 160Mi) bounds `runningTotal`.
- **Soft disk limit** (no privileged quota tooling): DOS sees the remaining
  allowance as free space (`mount c /data/c -freesize N`, set from
  `C_FREESIZE_MB` by `docker/entrypoint.sh`); uploads that don't fit are
  refused (413); the janitor (every 30 s) measures each running box's C:
  and stops a box that went over, and a box over its allowance can't start
  until files are deleted (Files page or `DELETE /files/...`).
- **Isolation:** box pods have no service account token and no network
  card in DOSBox-X (`ne2000 = false`), and a NetworkPolicy lets only the
  gateway reach them (`:8080`) and them reach nothing.

Verified 2026-10-18 on https://dosbox.pocket-maze.app: sign-up and session
via `/auth`; create, start (pod Ready in 15 s on the volume's node), type
`ver`/`dir`/`type hello.txt` after uploading `HELLO.TXT` (DOS lists it at
once and shows 524,288,000 bytes free), PNG snapshot, the player WebSocket
through ingress, web nginx and gateway (meta + ~9 fps, viewer counted),
another pod blocked from the box by the NetworkPolicy, stop and delete.
Gateway unit tests (`go test ./...` in `go/`, also run by the image build)
cover limits, ownership, credential stripping, the file API and disk
limit, and the janitor (idle, over-limit, orphan pods).

## Next steps
1. ~~`stream` sidecar~~ (done, keyboard + mouse verified), ~~control API~~
   (`/type`, `/keys`, `/mouse`, `/files` + rescan, `/snapshot.png`).
2. ~~`gateway`, `web`, Helm chart + ingress~~ (done: dosbox.pocket-maze.app).
3. Audio: mixer hook in DOSBox-X -> PCM ring in shm -> sidecar (Opus/WebAudio).
