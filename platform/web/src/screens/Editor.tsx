import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { getBox, pressKeys, readBinaryFile, readTextFile, runCommand, writeTextFile } from '../api/client'
import { languageFor, monaco } from '../player/monaco'
import type { Step } from './Console'
import { FileTree } from './FileTree'
import { lineForOffset, parseListing, type LineMap } from '../workbench/listing'
import { lineMapFromTds, parseTds, type Tds } from '../workbench/tds'
import { parseCodeView } from '../workbench/cv'

/** What the editor needs from the debugger (workbench): where it is, its breakpoints, and the controls. */
export interface EditorDebug {
  active: boolean
  stopped: boolean
  /** The target runs (continue, play): pause is the thing to offer. */
  running: boolean
  busy: boolean
  /** The last failed debugger call, if any. */
  error: string | null
  /** IP and CS while stopped; CS at the entry (the load segment) that symbols are relative to. */
  ip: number | null
  cs: string
  entryCs: number | null
  /** How the last session ended: the program exited, or Stop ended it. */
  ended?: 'exit' | 'stop' | null
  breakpoints: Set<number>
  toggleBreakpoint: (offset: number) => void | Promise<void>
  /** `entryParagraph`: the entry CS's distance from the code segment the symbols are relative to (BASIC's runtime). */
  start: (command: string, entryParagraph?: number) => Promise<void>
  /** Ends a debug session this page does not know about (left by a reload); true when there was one. */
  endOrphan?: () => Promise<boolean>
  step: (mode: 'into' | 'over') => void
  /** Many instructions in one go, each decided before it runs. */
  stepUntil: (decide: (ip: number, cs: string, text: string) => 'into' | 'over' | 'stop', max?: number) => void
  cont: () => void
  pause: () => void
  stop: () => void
  /** Run to a code offset (a one-shot breakpoint). */
  runTo: (offset: number) => Promise<void>
  /** Run until the current function returns (none when there is no caller to return to). */
  stepOut?: () => void
  /** Start begins (true) and is over (false): the workspace shows its debugging layout from the first moment. */
  starting?: (on: boolean) => void
}

// The media-style debug buttons.
const Icon = {
  // Continue (play to the next breakpoint or the end): the triangle, then a bar.
  play: <svg viewBox="0 0 16 16" aria-hidden><path d="M2.5 2.5v11l7.5-5.5z" fill="currentColor" /><rect x="11.5" y="2.5" width="2.2" height="11" rx="0.6" fill="currentColor" /></svg>,
  pause: <svg viewBox="0 0 16 16" aria-hidden><rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" /><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" /></svg>,
  stop: <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>,
  // Start (build, then debug from the beginning): the plain triangle.
  start: <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>,
  over: <svg viewBox="0 0 16 16" aria-hidden><path d="M3 8.5a5 5 0 0 1 9.2-2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M12.5 2.5v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="12.6" r="1.7" fill="currentColor" /></svg>,
  // Step out: up and out of the function.
  out: <svg viewBox="0 0 16 16" aria-hidden><path d="M8 10V3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M5 6l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="1.7" fill="currentColor" /></svg>,
  into: <svg viewBox="0 0 16 16" aria-hidden><path d="M8 1.8v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="1.7" fill="currentColor" /></svg>,
}

/**
 * The workbench editor: a file browser over the box's C: drive and Monaco
 * with the DOS theme. Editing is entirely local; Save PUTs the file, Build &
 * Run saves and hands the console a CD + build + run list for the file's
 * toolchain (ML for .ASM, TCC for .C/.CPP, TPC for .PAS, BC and LINK for .BAS; batch files and
 * programs just run).
 */

interface Props {
  boxId: string
  running: boolean
  /** Runs steps in the console (opening it); false when one failed. */
  onRun: (steps: Step[]) => Promise<boolean>
  /** dos: the Borland blue under the screen; paper: the workbench's light look. */
  look?: 'dos' | 'paper'
  /** What the box runs (the player's meta): Build & Run needs the DOS prompt, i.e. COMMAND. */
  program?: string
  /** The debugger, when the editor should show the current line and take breakpoints. */
  debug?: EditorDebug
  /** false: no file tree beside the editor (the workspace has a Files tab that drives it through the handle). */
  tree?: boolean
  onPathChange?: (path: string | null) => void
  onDirChange?: (dir: string) => void
  onSaved?: () => void
  /** The debug symbols of the last debug build (null when the EXE has none), with the source they describe. */
  onSymbols?: (tds: Tds | null, source: string) => void
  /** A variable's current value by name, for the hover while debugging. */
  lookupValue?: (name: string) => string | undefined
  /** The line of the frame chosen in the call stack: marked when IP has no line of its own (paused in the runtime). */
  frameLine?: number | null
}

/** What a Files tab (or anything else) can ask the editor to do. */
export interface EditorHandle {
  open: (path: string) => void
  /** The open file's path (null when none) and a save of it (true when there was nothing to save or it saved). */
  path: () => string | null
  save: () => Promise<boolean>
  /** New file in the current folder (asks for the name). */
  create: () => void
  /** A new file with this content, in the current folder, unsaved (the guide's examples). */
  createFile: (name: string, text: string) => void
  /** A file or folder was renamed on the box: open files under it follow. */
  renamed: (from: string, to: string) => void
  /** A file or folder was deleted on the box: its open files close (nothing left to save them to). */
  deleted: (path: string) => void
}

type Lang = 'asm' | 'c' | 'pas' | 'bas' | 'bat' | 'prog' | 'none'

/** The languages that build into a program (and debug). */
const BUILT: Lang[] = ['asm', 'c', 'pas', 'bas']

/**
 * The build command for a source file, {} is the bare file name. The catalog
 * copies each toolchain flat (headers and libs in C:\TCC itself, so its
 * TURBOC.CFG's C:\TC paths are overridden here).
 */
const defaultBuild: Record<string, string> = {
  asm: 'C:\\MASM611\\BIN\\ML /AT /nologo {}',
  c: 'C:\\TCC\\TCC -IC:\\TCC -LC:\\TCC {} GRAPHICS.LIB', // GRAPHICS.LIB: BGI programs link; harmless otherwise
  pas: 'C:\\TP70\\TPC {}',
  // BASIC PDS 7.1's compiler, stand-alone (/O: no BRUN71 runtime needed); LINK follows (see buildBatch).
  bas: 'C:\\QBX\\BINB\\BC /O {};',
}

/** Exits with errorlevel 1: mov ax,4C01h / int 21h. Marks a failed build for the console. */
const FAIL_COM = String.fromCharCode(0xb8, 0x01, 0x4c, 0xcd, 0x21)

function langOf(name: string): Lang {
  switch (name.toLowerCase().replace(/^.*\./, '')) {
    case 'asm': return 'asm'
    case 'c': case 'cpp': return 'c'
    case 'pas': return 'pas'
    case 'bas': return 'bas'
    case 'bat': return 'bat'
    case 'exe': case 'com': return 'prog'
    default: return 'none'
  }
}

function loadBuild(lang: string): string {
  try { return localStorage.getItem(`dosbox.build.${lang}`) ?? defaultBuild[lang] ?? '' } catch { return defaultBuild[lang] ?? '' }
}

function saveBuild(lang: string, cmd: string) {
  try { localStorage.setItem(`dosbox.build.${lang}`, cmd) } catch { /* private mode */ }
}

/** "ASM/HELLO.ASM" -> ["ASM", "HELLO.ASM"] */
const split = (path: string) => {
  const i = path.lastIndexOf('/')
  return i < 0 ? ['', path] : [path.slice(0, i), path.slice(i + 1)]
}

/** The DOS form of a /files/ directory: "" -> "C:\", "ASM/SRC" -> "C:\ASM\SRC". */
const dosDir = (dir: string) => 'C:\\' + dir.replace(/\//g, '\\')

/**
 * The batch file Build & Run writes to C:\BUILD.BAT and runs. Typing at the
 * DOS prompt costs ~35 ms a character (one key press per emulated frame),
 * so a CD plus a 50-character compiler line took seconds before the
 * compiler even started; "C:\BUILD" is 8. The build itself runs at
 * cycles=max (the host's speed) and the box's own speed is restored before
 * the program runs; a failed build ends in $FAIL.COM so the console sees
 * errorlevel 1.
 */
/**
 * Where a BASIC program's output goes. Its PRINT writes into video memory while its output is the console, so
 * the terminal (what goes through DOS) would show nothing; sent to TTY (the box's console under another name)
 * it goes through DOS, to the screen and the terminal both. A program that colours, places or draws its output
 * (COLOR, LOCATE, SCREEN, graphics) or reads lines from the keyboard (INPUT: BASIC echoes the typing into video
 * memory at its own cursor, which output through DOS does not move) keeps the screen to itself and runs as it is:
 * the Screen view shows it.
 */
export function basicRedirect(source: string): string {
  const code = source.replace(/"[^"\r\n]*"?/g, '""').replace(/(^|\s|:)(REM\b|')[^\r\n]*/gi, ' ')
  const screen = /\b(LOCATE|COLOR|SCREEN\s*\d|PSET|PRESET|CIRCLE|PAINT|DRAW|VIEW|WINDOW|PCOPY|PALETTE|WIDTH)\b|\bLINE\s*-?\s*\(|\b(PUT|GET)\s*\(|\bINPUT\b(?!\s*#)(?!\$)/i
  return screen.test(code) ? '' : ' > TTY'
}

export function buildBatch(path: string, buildCmd: string, cycles: string, opts: { run: boolean; listing: boolean; redirect?: string } = { run: true, listing: false }): string {
  const [dir, name] = split(path)
  const base = name.replace(/\.[^.]*$/, '')
  const lines = ['@ECHO OFF', 'C:', `CD ${dosDir(dir)}`]
  // {} is where the file goes; a command without it gets the file appended, so it always builds the open file.
  let build = buildCmd.includes('{}') ? buildCmd.replace('{}', name) : `${buildCmd.trim()} ${name}`
  // The debugger steps by source line through ML's listing (/Fl).
  if (opts.listing && /\bML\b/i.test(build) && !/\/Fl\b/i.test(build)) build = build.replace(/\bML\b/i, 'ML /Fl')
  // Turbo C (-v) and Turbo Pascal (-V) put Turbo Debugger symbols in the EXE: lines, functions, variables with types.
  // The compiler token is the one followed by a space (not the directory of the same name).
  if (opts.listing && /\bTCC(\.EXE)?(?=\s)/i.test(build) && !/\s-v\b/.test(build)) build = build.replace(/\bTCC(\.EXE)?(?=\s)/i, 'TCC -v')
  if (opts.listing && /\bTPC(\.EXE)?(?=\s)/i.test(build) && !/\s[-/]V\b/.test(build)) build = build.replace(/\bTPC(\.EXE)?(?=\s)/i, 'TPC -V')
  // BASIC: /Zi puts CodeView symbols in the object (LINK /CO below keeps them); BC asks for the object's name
  // and a listing unless the line ends in ";".
  const bas = langOf(name) === 'bas'
  if (bas && opts.listing && /\bBC(\.EXE)?(?=\s)/i.test(build) && !/\s\/Zi\b/i.test(build)) build = build.replace(/\bBC(\.EXE)?(?=\s)/i, 'BC /Zi')
  if (bas && !build.trim().endsWith(';')) build = `${build.trim()};`
  switch (langOf(name)) {
    case 'asm': case 'c': case 'pas': case 'bas':
      lines.push(
        'CONFIG -set "cpu cycles=max"',
        // ML finds LINK.EXE through the PATH, and so does TCC its TLINK; TPC finds its own.
        ...(langOf(name) === 'asm' ? ['PATH C:\\MASM611\\BIN;C:\\MASM611\\BINR;%PATH%'] : langOf(name) === 'c' ? ['PATH C:\\TCC;%PATH%'] : []),
        // BASIC's LINK finds the runtime library (BCL71ENR.LIB, named in the object) through LIB.
        ...(bas ? ['SET LIB=C:\\QBX\\LIB'] : []),
        build,
        'IF ERRORLEVEL 1 GOTO FAIL',
        ...(bas ? [`C:\\QBX\\BINB\\LINK /NOE${opts.listing ? ' /CO' : ''} ${base}.OBJ;`, 'IF ERRORLEVEL 1 GOTO FAIL'] : []),
        `CONFIG -set "cpu cycles=${cycles}"`,
        // Output to TTY where the box has that device (an older image has not: the program runs as it is). Not
        // "IF EXIST TTY X > TTY": the shell opens the redirection first, which would make a file TTY to find.
        ...(opts.run
          ? [`ECHO --- ${base} ---`, ...(opts.redirect ? ['IF NOT EXIST TTY GOTO PLAIN', `${base}${opts.redirect}`, 'GOTO END', ':PLAIN'] : []), base]
          : [`ECHO --- ${base} built ---`]),
        'GOTO END',
        ':FAIL',
        `CONFIG -set "cpu cycles=${cycles}"`,
        'ECHO *** build failed ***',
        'C:\\$FAIL',
      )
      break
    case 'bat': case 'prog':
      lines.push(name)
      break
  }
  lines.push(':END')
  return lines.join('\r\n') + '\r\n'
}

/** The one step the console types for a build. */
/** A Pascal source whose first word is `unit`: it builds to a .TPU, there is no program to run. */
export function isPascalUnit(text: string): boolean {
  const body = text.replace(/\{[^}]*\}|\(\*[\s\S]*?\*\)/g, ' ')
  return /^\s*unit\b/i.test(body)
}

export const buildSteps: Step[] = [{ cmd: 'C:\\BUILD', check: true }]

// The variable hover: one provider for all editors, asking whichever editor is current.
const lookupRef: { current?: (name: string) => string | undefined } = {}
let hoverRegistered = false
function registerVariableHover() {
  if (hoverRegistered) return
  hoverRegistered = true
  for (const language of ['c', 'cpp', 'pascal', 'masm', 'vb', 'plaintext']) {
    monaco.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        const w = model.getWordAtPosition(position)
        const value = w && lookupRef.current ? lookupRef.current(w.word) : undefined
        if (!w || value === undefined) return null
        return { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), contents: [{ value: `**${w.word}** = ${value}` }] }
      },
    })
  }
}

interface Doc { text: string; saved: string }

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ boxId, running, onRun, look = 'dos', program, debug, tree = true, onPathChange, onDirChange, onSaved, onSymbols, lookupValue, frameLine }: Props, ref) {
  lookupRef.current = lookupValue
  // A program other than the shell has the keyboard: typing C:\BUILD would go to it.
  const busyWith = program && program.toUpperCase() !== 'COMMAND' ? program : null
  // Source lines <-> code offsets of the last debug build (MASM listing).
  const [lineMap, setLineMap] = useState<LineMap | null>(null)
  const lineMapRef = useRef<LineMap | null>(null)
  lineMapRef.current = lineMap
  const debugRef = useRef<EditorDebug | undefined>(debug)
  debugRef.current = debug
  // Breakpoints set in the gutter before (or between) sessions, by file and line; applied when a debug run starts.
  const [pendingBps, setPendingBps] = useState<Record<string, Set<number>>>({})
  const pendingRef = useRef(pendingBps)
  pendingRef.current = pendingBps
  const pathRef = useRef<string | null>(null)
  const togglePending = (p: string, line: number) => setPendingBps((all) => {
    const s = new Set(all[p] ?? [])
    if (s.has(line)) s.delete(line); else s.add(line)
    return { ...all, [p]: s }
  })
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  // The stop the editor last scrolled to ("path:line:cs:ip"): scrolling happens once per stop.
  const revealedRef = useRef<string | null>(null)
  const [dir, setDir] = useState('')
  const [treeKey, setTreeKey] = useState(0) // bumped when the tree should re-list (a save)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => { onPathChange?.(path) }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  pathRef.current = path
  useEffect(() => { onDirChange?.(dir) }, [dir]) // eslint-disable-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({
    open: (p: string) => { open(p) },
    path: () => path,
    save: () => (dirty ? save() : Promise.resolve(true)),
    create: () => { create() },
    createFile: (name: string, content: string) => {
      show(dir ? `${dir}/${name}` : name, content, '\0')
      setStatus('from the guide: Save, then Build & Run or Debug')
    },
    renamed: (from: string, to: string) => {
      const move = (x: string) => (x === from ? to : x.startsWith(from + '/') ? to + x.slice(from.length) : x)
      setDocs((all) => Object.fromEntries(Object.entries(all).map(([k, v]) => [move(k), v])))
      setOrder((o) => o.map(move))
      setPath((cur) => (cur ? move(cur) : cur))
    },
    deleted: (gone: string) => {
      const under = (x: string) => x === gone || x.startsWith(gone + '/')
      const rest = order.filter((x) => !under(x))
      setDocs((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !under(k))))
      setOrder(rest)
      if (path && under(path)) setPath(rest[0] ?? null)
    },
  }))
  // Every open file: its text as edited and as last saved (a new file's "saved" is '\0', never equal). Tabs in `order`.
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [order, setOrder] = useState<string[]>([])
  const doc = path ? docs[path] : undefined
  const text = doc?.text ?? ''
  const setText = (t: string) => { if (path) setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], text: t } } : d)) }
  const setSaved = (t: string) => { if (path) setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], saved: t } } : d)) }
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [buildCmd, setBuildCmd] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<() => Promise<boolean>>(async () => false)
  const dirty = !!doc && doc.text !== doc.saved
  const lang = path ? langOf(split(path)[1]) : 'none'

  useEffect(() => { if (running) setTreeKey((k) => k + 1) }, [running])

  /** Put a file in the tabs (or replace its text) and make it current. */
  function show(p: string, t: string, savedText: string) {
    setDocs((d) => ({ ...d, [p]: { text: t, saved: savedText } }))
    setOrder((o) => (o.includes(p) ? o : [...o, p]))
    setPath(p)
    setBuildCmd(loadBuild(langOf(split(p)[1])))
    setStatus('')
  }

  async function open(p: string) {
    if (docs[p]) { setPath(p); setBuildCmd(loadBuild(langOf(split(p)[1]))); return }
    setBusy(true)
    try {
      const t = await readTextFile(boxId, p)
      show(p, t, t)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function close(p: string) {
    const d = docs[p]
    if (d && d.text !== d.saved && !confirm(`Close ${split(p)[1]} and discard the unsaved changes?`)) return
    const rest = order.filter((x) => x !== p)
    setOrder(rest)
    setDocs((all) => { const { [p]: _gone, ...keep } = all; void _gone; return keep })
    if (path === p) {
      const i = order.indexOf(p)
      const next = rest[Math.min(i, rest.length - 1)] ?? null
      setPath(next)
      if (next) setBuildCmd(loadBuild(langOf(split(next)[1])))
    }
  }

  function create() {
    const name = prompt('New file name (8.3, e.g. HELLO.ASM):')?.trim().toUpperCase()
    if (!name || !/^[A-Z0-9_$~!#%&\-{}@`'()^]{1,8}(\.[A-Z0-9_$~!#%&\-{}@`'()^]{1,3})?$/.test(name)) return
    show(dir ? `${dir}/${name}` : name, '', '\0')
  }

  const save = useCallback(async (): Promise<boolean> => {
    if (!path) return false
    const t = (editorRef.current?.getValue() ?? text).replace(/\r?\n/g, '\r\n')
    setBusy(true)
    try {
      await writeTextFile(boxId, path, t)
      setText(t)
      setSaved(t)
      setStatus(`saved ${split(path)[1]}`)
      onSaved?.()
      setTreeKey((k) => k + 1)
      return true
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [boxId, path, text, dir])
  saveRef.current = save

  // The box's own speed, restored after a build (the build runs at max).
  const [cycles, setCycles] = useState('auto')
  useEffect(() => { getBox(boxId).then((b) => setCycles(b.machine?.cycles || 'auto')).catch(() => undefined) }, [boxId, running])

  async function buildAndRun() {
    if (!path || !running) return
    if (!(await endWhatRuns())) return
    if (dirty && !(await save())) return
    const unit = lang === 'pas' && isPascalUnit(editorRef.current?.getValue() ?? text)
    setStatus(unit ? 'building the unit…' : 'running…')
    const redirect = lang === 'bas' ? basicRedirect(editorRef.current?.getValue() ?? text) : ''
    try {
      await writeTextFile(boxId, 'BUILD.BAT', buildBatch(path, buildCmd, cycles, { run: !unit, listing: false, redirect }))
      await writeTextFile(boxId, '$FAIL.COM', FAIL_COM)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
      return
    }
    const ok = await onRun(buildSteps)
    if (unit) { setStatus(ok ? `${split(path)[1]} is a unit (nothing to run): built` : 'failed (see the console)'); return }
    // A BASIC program that keeps the screen to itself (INPUT, COLOR, LOCATE, graphics) shows in the Screen view only.
    const ownScreen = lang === 'bas' && !redirect
    setStatus(ok ? (look === 'paper' ? (ownScreen ? 'running on the box\'s screen (INPUT, COLOR, LOCATE or graphics): see the Screen view' : 'running in the terminal') : 'done') : 'failed (see the console)')
  }

  // Debug: build (with the listing for .ASM), then start the program at its
  // entry; the current line and breakpoints then show in the gutter.
  // Whatever runs on the box ends before a build: a debug session through the agent, a loose program with
  // Ctrl+C / Ctrl+Break (DOS checks them on every console write), each followed by a fresh prompt.
  async function endWhatRuns(): Promise<boolean> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const atPrompt = async () => { try { const r = await runCommand(boxId, 'ECHO.', 8000); return !r.timed_out } catch { return false } }
    if (debugRef.current?.active) {
      setStatus('stopping…')
      debugRef.current.stop()
      for (let i = 0; i < 80 && debugRef.current?.active; i++) await wait(100)
      if (debugRef.current?.active) { setStatus(debugRef.current.error ? `could not stop the program: ${debugRef.current.error}` : 'could not stop the program'); return false }
      await wait(900)
      return true
    }
    if (busyWith && debugRef.current?.endOrphan) {
      // A debug session this page lost (a reload): the agent still has it, so end it through the agent.
      setStatus(`${busyWith} is running: ending it…`)
      try {
        if (await debugRef.current.endOrphan()) { await wait(900); return true }
      } catch (err) {
        setStatus(`could not end ${busyWith}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    }
    if (busyWith) {
      setStatus(`${busyWith} is running: ending it…`)
      for (const combo of ['ctrl+c', 'ctrl+pause', 'ctrl+c']) {
        try { await pressKeys(boxId, combo) } catch { /* no key path: try the prompt anyway */ }
        await wait(700)
        if (await atPrompt()) return true
      }
      setStatus(`${busyWith} does not stop on Ctrl+Break: quit it in the Screen view, or restart the box`)
      return false
    }
    return true
  }

  async function debugRun() {
    debugRef.current?.starting?.(true)
    try { await debugRunSteps() } finally { debugRef.current?.starting?.(false) }
  }

  async function debugRunSteps() {
    if (!path || !running || !debug) return
    if (!(await endWhatRuns())) return
    if (dirty && !(await save())) return
    const [dir, name] = split(path)
    const base = name.replace(/\.[^.]*$/, '')
    if (lang === 'pas' && isPascalUnit(editorRef.current?.getValue() ?? text)) {
      setStatus(`${name} is a unit, not a program: open the program that uses it and debug that`)
      return
    }
    setStatus('building…')
    try {
      await writeTextFile(boxId, 'BUILD.BAT', buildBatch(path, buildCmd, cycles, { run: false, listing: true }))
      await writeTextFile(boxId, '$FAIL.COM', FAIL_COM)
      const r = await runCommand(boxId, 'C:\\BUILD', 180000)
      if (r.timed_out || (r.errorlevel ?? 0) !== 0) {
        setStatus('build failed (see the terminal)')
        return
      }
      setLineMap(null)
      let tds: Tds | null = null
      if (lang === 'c' || lang === 'pas' || lang === 'bas') {
        // Debug symbols in the EXE: lines, functions and variables (Turbo Debugger's; CodeView's for BASIC).
        try {
          const exe = await readBinaryFile(boxId, (dir ? `${dir}/` : '') + `${base}.EXE`)
          tds = lang === 'bas' ? parseCodeView(exe, name, editorRef.current?.getValue() ?? text) : parseTds(exe)
          if (tds) { const map = lineMapFromTds(tds); setLineMap(map); lineMapRef.current = map }
          else setStatus('no debug symbols in the EXE; stepping by instruction')
        } catch {
          setStatus(`the build produced no ${base}.EXE (a unit, or a different output name?)`)
          return
        }
      }
      onSymbols?.(tds, text)
      if (lang === 'asm') {
        try {
          const lst = await readTextFile(boxId, (dir ? `${dir}/` : '') + `${base}.LST`)
          const map = parseListing(lst, text)
          setLineMap(map)
          lineMapRef.current = map
          if (map.lineOf.size === 0) setStatus('no lines matched the listing; stepping by instruction')
        } catch {
          setStatus('no listing (.LST); stepping by instruction')
        }
      }
      // A bare name: the agent takes a DOS filename only, and BUILD.BAT left the shell in the file's directory.
      const exe = `${base}.${lang === 'asm' ? 'COM' : 'EXE'}`
      const mapped = lineMapRef.current?.lineOf.size ?? 0
      const debugging = mapped ? `debugging ${base} · ${mapped} lines mapped` : `debugging ${base} · no line map, stepping by instruction`
      setStatus(debugging)
      const redirect = lang === 'bas' ? basicRedirect(editorRef.current?.getValue() ?? text) : ''
      await debug.start(`${exe}${redirect}`, tds?.entryParagraph ?? 0)
      if (redirect) {
        // An older agent takes no redirection: the program then runs with its output on the screen only.
        for (let i = 0; i < 10 && !debugRef.current?.active && !debugRef.current?.error; i++) await new Promise((r) => setTimeout(r, 100))
        if (!debugRef.current?.active && /DOS-safe|redirect/i.test(debugRef.current?.error ?? '')) {
          await debug.start(exe, tds?.entryParagraph ?? 0)
          setStatus(debugging)
        }
      }
      // Let the session state land (a few renders may be needed before the live debugger shows it stopped).
      // (the code segment too: whether the entry stop is on a line of ours depends on it)
      for (let i = 0; i < 30 && !(debugRef.current?.active && debugRef.current.stopped && debugRef.current.ip !== null && debugRef.current.entryCs !== null); i++) await new Promise((r) => setTimeout(r, 100))
      if (!debugRef.current?.active) { setStatus(debugRef.current?.error ? `debugger: ${debugRef.current.error}` : 'the debugger did not start'); return }
      // The breakpoints set in the gutter beforehand, now that lines map to code (through the live debugger, not
      // the one captured when this started).
      const map = lineMapRef.current
      const lines = pendingRef.current[path]
      let armed = 0
      if (map && lines) {
        for (const line of lines) {
          const off = map.offsetOf.get(line)
          if (off !== undefined) { await debugRef.current?.toggleBreakpoint(off); armed++ }
        }
      }
      // Stopped in the runtime before any line of ours (C's startup code): on to main, as Turbo Debugger does
      // (a breakpoint on the way stops it first); without a main, to the first breakpoint or the end.
      const d = debugRef.current
      if (map && d?.stopped && d.ip !== null && (lineForOffset(map, d.ip) === null || (d.entryCs !== null && (parseInt(d.cs, 16) & 0xffff) !== d.entryCs))) {
        const main = tds?.symbols.find((s) => (s.name === '_main' || s.name === 'main') && s.seg === 0)
        // BASIC: the module's code comes first in its segment, its procedures after it.
        const first = main ? [...map.offsetOf.values()].filter((o) => o >= main.offset).sort((a, b) => a - b)[0]
          : tds?.language === 'basic' ? Math.min(...map.offsetOf.values()) : undefined
        if (first !== undefined) d.runTo(first)
        else d.cont()
      }
      void armed
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  // A debugger error shows in the status line, where the build errors show; so does the end of a session.
  useEffect(() => { if (debug?.error) setStatus(`debugger: ${debug.error}`) }, [debug?.error])
  const wasActive = useRef(false)
  useEffect(() => {
    if (debug?.active) wasActive.current = true
    else if (wasActive.current) { wasActive.current = false; setStatus(debug?.ended === 'exit' ? 'the program ended · debugging ended' : 'debugging ended') }
  }, [debug?.active])

  // CS at the program's entry (the load segment): the symbols' and the listing's offsets are relative to it; elsewhere
  // (DOS, the BIOS, a Pascal unit's segment) no line applies.
  const atEntryCs = (cs: string) => debug?.entryCs !== null && debug?.entryCs !== undefined && (parseInt(cs, 16) & 0xffff) === debug.entryCs

  // A step by source line when lines map to code: instructions until the line changes, never into code without lines.
  const stepSource = (mode: 'into' | 'over') => {
    const d = debugRef.current, map = lineMapRef.current
    if (!d || !d.stopped) return
    const start = map && d.ip !== null && atEntryCs(d.cs) ? lineForOffset(map, d.ip) : null
    if (!map || start === null) { d.step(mode); return }
    let n = 0
    d.stepUntil((ip, cs, text) => {
      const line = atEntryCs(cs) ? lineForOffset(map, ip) : null
      // A new line, or the start of a line again (a loop whose increment belongs to the body line): a step is done.
      if (line !== null && (line !== start || (n > 0 && map.lineOf.has(ip)))) return 'stop'
      n++
      if (line === null) return 'over'
      // "call 00000291 ($-29)" / "call 00D0:0012": a near call to a line of ours is the one thing stepped into.
      // So is a far one into the program's own code segment (BASIC's SUBs and FUNCTIONs: "call 082B:01AF").
      const call = /^call\s+(?:([0-9a-f]{4}):)?([0-9a-f]{4,8})\b/i.exec(text.trim())
      const ownSeg = !call?.[1] || (d.entryCs !== null && parseInt(call[1], 16) === d.entryCs)
      if (call && mode === 'into' && ownSeg && lineForOffset(map, parseInt(call[2], 16) & 0xffff) !== null) return 'into'
      return 'over'
    })
  }
  const stepSourceRef = useRef(stepSource)
  stepSourceRef.current = stepSource

  // Monaco decorations: the current line (an arrow, a tint) and breakpoints.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (!decoRef.current) decoRef.current = editor.createDecorationsCollection()
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const map = lineMap
    if (debug?.active && map) {
      for (const [line, off] of map.offsetOf) {
        if (debug.breakpoints.has(off)) decos.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'dbg-bp', glyphMarginHoverMessage: { value: 'breakpoint' } } })
      }
      const cur = debug.stopped && debug.ip !== null && atEntryCs(debug.cs) ? lineForOffset(map, debug.ip) : null
      if (cur) {
        decos.push({ range: new monaco.Range(cur, 1, cur, 1), options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-arrow' } })
      }
      // Scroll to the line only when the stop (or the chosen frame) moves, not on every redraw: in between the
      // user scrolls freely to read the file and set breakpoints.
      const at = debug.stopped && frameLine && frameLine !== cur ? frameLine : cur // a caller picked in the stack wins
      const spot = at ? `${path}:${at}:${debug.cs}:${debug.ip}` : null
      if (at && spot !== revealedRef.current) editor.revealLineInCenterIfOutsideViewport(at)
      revealedRef.current = spot
      // The chosen frame's line (paused inside the runtime, or a caller picked in the stack): a hollow arrow.
      if (debug.stopped && frameLine && frameLine !== cur) {
        decos.push({ range: new monaco.Range(frameLine, 1, frameLine, 1), options: { isWholeLine: true, className: 'dbg-line outer', glyphMarginClassName: 'dbg-arrow outer' } })
      }
    } else if (path) {
      // No session: the breakpoints waiting for the next debug run.
      for (const line of pendingBps[path] ?? []) {
        decos.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'dbg-bp pending', glyphMarginHoverMessage: { value: 'breakpoint (set when debugging starts)' } } })
      }
    }
    decoRef.current.set(decos)
  }, [debug?.active, debug?.stopped, debug?.ip, debug?.cs, debug?.entryCs, debug?.breakpoints, lineMap, pendingBps, path, frameLine]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    registerVariableHover()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current() })
    // Debugging from the keyboard, and breakpoints from the gutter.
    editor.addCommand(monaco.KeyCode.F7, () => stepSourceRef.current('into'))
    editor.addCommand(monaco.KeyCode.F8, () => stepSourceRef.current('over'))
    editor.addCommand(monaco.KeyCode.F9, () => debugRef.current?.cont())
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F8, () => debugRef.current?.stepOut?.())
    editor.onMouseDown((e) => {
      const t = e.target.type
      if (t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return
      const line = e.target.position?.lineNumber
      const p = pathRef.current
      if (!line || !p) return
      const d = debugRef.current
      const off = lineMapRef.current?.offsetOf.get(line)
      if (d?.active && off !== undefined) {
        // In a session: the real breakpoint, and the pending one with it so it outlives the session.
        if (d.stopped || d.running) { d.toggleBreakpoint(off); togglePending(p, line) }
        return
      }
      togglePending(p, line)
    })
    // The web font may arrive after Monaco measured the fallback: measure again then.
    if ('fonts' in document) document.fonts.ready.then(() => monaco.editor.remeasureFonts())
    editor.focus()
  }

  const name = path ? split(path)[1] : ''
  return (
    <div className={`editor ${tree ? '' : 'no-tree'}`}>
      {tree && (
        <div className="editor-side">
          <div className="bar">
            <span className="mono" title="where New creates a file">{dosDir(dir)}</span>
            <button onClick={create} title="New file in this folder">New</button>
          </div>
          <FileTree boxId={boxId} selected={path} refreshKey={treeKey} onOpen={open} onDir={setDir} />
        </div>
      )}
      <div className="editor-main">
        <div className="bar">
          <strong className="mono">{path ? `${dosDir(split(path)[0])}${split(path)[0] ? '\\' : ''}${name}` : 'no file'}</strong>
          {dirty && <span className="lag">•</span>}
          <button disabled={!path || !dirty || busy} onClick={save} title="Ctrl+S">Save</button>
          {BUILT.includes(lang) && (
            <>
              <input
                className="mono"
                value={buildCmd}
                onChange={(e) => { setBuildCmd(e.target.value); saveBuild(lang, e.target.value) }}
                title="The build command; {} is where the open file's name goes (appended when there is no {})"
              />
              {buildCmd !== defaultBuild[lang] && (
                <button className="ghost" onClick={() => { setBuildCmd(defaultBuild[lang]); saveBuild(lang, defaultBuild[lang]) }} title={`Back to the default: ${defaultBuild[lang]}`}>↺</button>
              )}
            </>
          )}
          {lang !== 'none' && (
            <button
              className="primary"
              disabled={!path || busy || !running}
              onClick={buildAndRun}
              title={busyWith ? `${busyWith} is running on the box: it is ended first` : undefined}
            >
              {lang === 'bat' || lang === 'prog' ? 'Run' : 'Build & Run'}
            </button>
          )}
          {debug && BUILT.includes(lang) && (
            <span className="media" role="group" aria-label="debug">
              <button className="media-btn" disabled={!path || busy || !running} onClick={debugRun} title={debug.active ? 'Start again from the beginning (build, then debug)' : 'Start: build, then debug'}>{Icon.start}</button>
              {debug.running
                ? <button className="media-btn" onClick={debug.pause} title="Pause">{Icon.pause}</button>
                : <button className="media-btn" disabled={!debug.active || debug.busy || !debug.stopped} onClick={debug.cont} title="Continue to the next breakpoint or the end (F9)">{Icon.play}</button>}
              <button className="media-btn" disabled={!debug.active || debug.busy || !debug.stopped} onClick={() => stepSource('over')} title="Step over (F8)">{Icon.over}</button>
              <button className="media-btn" disabled={!debug.active || debug.busy || !debug.stopped} onClick={() => stepSource('into')} title="Step into (F7)">{Icon.into}</button>
              <button className="media-btn" disabled={!debug.active || debug.busy || !debug.stopped || !debug.stepOut} onClick={() => debug.stepOut?.()} title="Step out: run until this function returns (Alt+F8)">{Icon.out}</button>
              <button className="media-btn stop" disabled={!debug.active} onClick={debug.stop} title="Stop debugging (ends the program)">{Icon.stop}</button>
            </span>
          )}
          {busyWith && <span className="lag">{busyWith} has the keyboard</span>}
          <span className="muted">{status}</span>
        </div>
          <div className="editor-tabs" role="tablist">
            {order.map((p) => {
              const d = docs[p]
              const isDirty = !!d && d.text !== d.saved
              return (
                <span key={p} role="tab" aria-selected={p === path} className={`editor-tab ${p === path ? 'on' : ''}`} title={`C:\\${p.replace(/\//g, '\\')}`} onClick={() => open(p)} onAuxClick={(e) => { if (e.button === 1) close(p) }}>
                  {split(p)[1]}{isDirty && <i className="lag">•</i>}
                  <button className="editor-tab-close" title="Close" onClick={(e) => { e.stopPropagation(); close(p) }}>×</button>
                </span>
              )
            })}
          </div>
        <div className="editor-box">
          {path ? (
            <MonacoEditor
              height="100%"
              path={`c:/${path}`}
              language={languageFor(name)}
              value={text}
              theme={look}
              onChange={(v) => setText(v ?? '')}
              onMount={onMount}
              options={{
                fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
                fontSize: 14,
                lineHeight: 20,
                minimap: { enabled: false },
                scrollbar: { verticalScrollbarSize: 3, horizontalScrollbarSize: 3 },
                scrollBeyondLastLine: false,
                tabSize: 4,
                detectIndentation: false, // or Monaco infers 8 from a file indented that way
                insertSpaces: true,
                renderLineHighlight: 'line',
                wordWrap: 'off',
                rulers: [80],
                automaticLayout: true,
                glyphMargin: !!debug,
              }}
            />
          ) : (
            <div className="editor-empty muted">Pick a file on the left, or New.</div>
          )}
        </div>
      </div>
    </div>
  )
})
