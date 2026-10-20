import { useCallback, useEffect, useRef, useState } from 'react'
import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { getBox, readTextFile, runCommand, writeTextFile } from '../api/client'
import { languageFor, monaco } from '../player/monaco'
import type { Step } from './Console'
import { FileTree } from './FileTree'
import { lineForOffset, parseListing, type LineMap } from '../workbench/listing'

/** What the editor needs from the debugger (workbench): where it is, its breakpoints, and the controls. */
export interface EditorDebug {
  active: boolean
  stopped: boolean
  /** IP while stopped. */
  ip: number | null
  breakpoints: Set<number>
  toggleBreakpoint: (offset: number) => void
  start: (command: string) => Promise<void>
  step: (mode: 'into' | 'over') => void
  cont: () => void
}

/**
 * The workbench editor: a file browser over the box's C: drive and Monaco
 * with the DOS theme. Editing is entirely local; Save PUTs the file, Build &
 * Run saves and hands the console a CD + build + run list for the file's
 * toolchain (ML for .ASM, TCC for .C/.CPP, TPC for .PAS; batch files and
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
}

type Lang = 'asm' | 'c' | 'pas' | 'bat' | 'prog' | 'none'

/**
 * The build command for a source file, {} is the bare file name. The catalog
 * copies each toolchain flat (headers and libs in C:\TCC itself, so its
 * TURBOC.CFG's C:\TC paths are overridden here).
 */
const defaultBuild: Record<string, string> = {
  asm: 'C:\\MASM611\\BIN\\ML /AT /nologo {}',
  c: 'C:\\TCC\\TCC -IC:\\TCC -LC:\\TCC {} GRAPHICS.LIB', // GRAPHICS.LIB: BGI programs link; harmless otherwise
  pas: 'C:\\TP70\\TPC {}',
}

/** Exits with errorlevel 1: mov ax,4C01h / int 21h. Marks a failed build for the console. */
const FAIL_COM = String.fromCharCode(0xb8, 0x01, 0x4c, 0xcd, 0x21)

function langOf(name: string): Lang {
  switch (name.toLowerCase().replace(/^.*\./, '')) {
    case 'asm': return 'asm'
    case 'c': case 'cpp': return 'c'
    case 'pas': return 'pas'
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
export function buildBatch(path: string, buildCmd: string, cycles: string, opts: { run: boolean; listing: boolean } = { run: true, listing: false }): string {
  const [dir, name] = split(path)
  const base = name.replace(/\.[^.]*$/, '')
  const lines = ['@ECHO OFF', 'C:', `CD ${dosDir(dir)}`]
  // {} is where the file goes; a command without it gets the file appended, so it always builds the open file.
  let build = buildCmd.includes('{}') ? buildCmd.replace('{}', name) : `${buildCmd.trim()} ${name}`
  // The debugger steps by source line through ML's listing (/Fl).
  if (opts.listing && /\bML\b/i.test(build) && !/\/Fl\b/i.test(build)) build = build.replace(/\bML\b/i, 'ML /Fl')
  switch (langOf(name)) {
    case 'asm': case 'c': case 'pas':
      lines.push(
        'CONFIG -set "cpu cycles=max"',
        // ML finds LINK.EXE through the PATH; TCC and TPC find theirs next to themselves.
        ...(langOf(name) === 'asm' ? ['PATH C:\\MASM611\\BIN;C:\\MASM611\\BINR;%PATH%'] : []),
        build,
        'IF ERRORLEVEL 1 GOTO FAIL',
        `CONFIG -set "cpu cycles=${cycles}"`,
        ...(opts.run ? [`ECHO --- ${base} ---`, base] : [`ECHO --- ${base} built ---`]),
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
export const buildSteps: Step[] = [{ cmd: 'C:\\BUILD', check: true }]

export function Editor({ boxId, running, onRun, look = 'dos', program, debug }: Props) {
  // A program other than the shell has the keyboard: typing C:\BUILD would go to it.
  const busyWith = program && program.toUpperCase() !== 'COMMAND' ? program : null
  // Source lines <-> code offsets of the last debug build (MASM listing).
  const [lineMap, setLineMap] = useState<LineMap | null>(null)
  const lineMapRef = useRef<LineMap | null>(null)
  lineMapRef.current = lineMap
  const debugRef = useRef<EditorDebug | undefined>(debug)
  debugRef.current = debug
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const [dir, setDir] = useState('')
  const [treeKey, setTreeKey] = useState(0) // bumped when the tree should re-list (a save)
  const [path, setPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [buildCmd, setBuildCmd] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<() => Promise<boolean>>(async () => false)
  const dirty = text !== saved
  const lang = path ? langOf(split(path)[1]) : 'none'

  useEffect(() => { if (running) setTreeKey((k) => k + 1) }, [running])

  async function open(p: string) {
    if (dirty && !confirm('Discard the unsaved changes?')) return
    setBusy(true)
    try {
      const t = await readTextFile(boxId, p)
      setPath(p)
      setText(t)
      setSaved(t)
      setBuildCmd(loadBuild(langOf(split(p)[1])))
      setStatus('')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function create() {
    const name = prompt('New file name (8.3, e.g. HELLO.ASM):')?.trim().toUpperCase()
    if (!name || !/^[A-Z0-9_$~!#%&\-{}@`'()^]{1,8}(\.[A-Z0-9_$~!#%&\-{}@`'()^]{1,3})?$/.test(name)) return
    if (dirty && !confirm('Discard the unsaved changes?')) return
    const p = dir ? `${dir}/${name}` : name
    setPath(p)
    setText('')
    setSaved('\0') // never equal: a new file is dirty until saved
    setBuildCmd(loadBuild(langOf(name)))
    setStatus('')
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
    if (busyWith) {
      setStatus(`${busyWith} has the keyboard: quit it first (the Screen view), then build`)
      return
    }
    if (dirty && !(await save())) return
    setStatus('running…')
    try {
      await writeTextFile(boxId, 'BUILD.BAT', buildBatch(path, buildCmd, cycles))
      await writeTextFile(boxId, '$FAIL.COM', FAIL_COM)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
      return
    }
    const ok = await onRun(buildSteps)
    setStatus(ok ? (look === 'paper' ? 'running in the terminal' : 'done') : 'failed (see the console)')
  }

  // Debug: build (with the listing for .ASM), then start the program at its
  // entry; the current line and breakpoints then show in the gutter.
  async function debugRun() {
    if (!path || !running || !debug) return
    if (busyWith) {
      setStatus(`${busyWith} has the keyboard: quit it first (the Screen view), then debug`)
      return
    }
    if (dirty && !(await save())) return
    const [dir, name] = split(path)
    const base = name.replace(/\.[^.]*$/, '')
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
      if (lang === 'asm') {
        try {
          const lst = await readTextFile(boxId, (dir ? `${dir}/` : '') + `${base}.LST`)
          const map = parseListing(lst, text)
          setLineMap(map)
          if (map.lineOf.size === 0) setStatus('no lines matched the listing; stepping by instruction')
        } catch {
          setStatus('no listing (.LST); stepping by instruction')
        }
      }
      const exe = `${dosDir(dir)}${dir ? '\\' : ''}${base}.${lang === 'asm' ? 'COM' : 'EXE'}`
      setStatus(`debugging ${base}`)
      await debug.start(exe)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

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
      const cur = debug.stopped && debug.ip !== null ? lineForOffset(map, debug.ip) : null
      if (cur) {
        decos.push({ range: new monaco.Range(cur, 1, cur, 1), options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-arrow' } })
        editor.revealLineInCenterIfOutsideViewport(cur)
      }
    }
    decoRef.current.set(decos)
  }, [debug?.active, debug?.stopped, debug?.ip, debug?.breakpoints, lineMap])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current() })
    // Debugging from the keyboard, and breakpoints from the gutter.
    editor.addCommand(monaco.KeyCode.F7, () => debugRef.current?.step('into'))
    editor.addCommand(monaco.KeyCode.F8, () => debugRef.current?.step('over'))
    editor.addCommand(monaco.KeyCode.F9, () => debugRef.current?.cont())
    editor.onMouseDown((e) => {
      const t = e.target.type
      if (t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return
      const line = e.target.position?.lineNumber
      const off = line ? lineMapRef.current?.offsetOf.get(line) : undefined
      if (off !== undefined && debugRef.current?.stopped) debugRef.current.toggleBreakpoint(off)
    })
    // The web font may arrive after Monaco measured the fallback: measure again then.
    if ('fonts' in document) document.fonts.ready.then(() => monaco.editor.remeasureFonts())
    editor.focus()
  }

  const name = path ? split(path)[1] : ''
  return (
    <div className="editor">
      <div className="editor-side">
        <div className="bar">
          <span className="mono" title="where New creates a file">{dosDir(dir)}</span>
          <button onClick={create} title="New file in this folder">New</button>
        </div>
        <FileTree boxId={boxId} selected={path} refreshKey={treeKey} onOpen={open} onDir={setDir} />
      </div>
      <div className="editor-main">
        <div className="bar">
          <strong className="mono">{path ? `${dosDir(split(path)[0])}${split(path)[0] ? '\\' : ''}${name}` : 'no file'}</strong>
          {dirty && <span className="lag">•</span>}
          <button disabled={!path || !dirty || busy} onClick={save} title="Ctrl+S">Save</button>
          {(lang === 'asm' || lang === 'c' || lang === 'pas') && (
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
              disabled={!path || busy || !running || !!busyWith}
              onClick={buildAndRun}
              title={busyWith ? `${busyWith} is running on the box; quit it first` : undefined}
            >
              {lang === 'bat' || lang === 'prog' ? 'Run' : 'Build & Run'}
            </button>
          )}
          {debug && (lang === 'asm' || lang === 'c' || lang === 'pas') && (
            <button disabled={!path || busy || !running || !!busyWith || debug.active} onClick={debugRun} title="Build, then start the program stopped at its entry">Debug</button>
          )}
          {busyWith && <span className="lag">{busyWith} has the keyboard</span>}
          <span className="muted">{status}</span>
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
}
