import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type Action, type IJsonModel } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'
import type { RPC } from '../screens/DebugPanel'
import type { EditorDebug, EditorHandle } from '../screens/Editor'
import type { Step } from '../screens/Console'
import { Terminal, type TerminalHandle } from '../screens/Terminal'
import { FilesTab } from './FilesTab'
import { GuidePanel } from './GuidePanel'
import { InterruptsPanel } from './InterruptsPanel'
import { Machine } from './Machine'
import { MemoryMapPanel } from './MemoryMapPanel'
import type { Debugger } from './useDebugger'
import type { HeatTick } from './heat'

/**
 * The workbench as a dockable workspace (flexlayout): every panel is a tab
 * that can be dragged to another group, split off or closed; the layout
 * is remembered. The Machine tab exists only while a program runs under
 * the debugger: it appears when a session starts and goes when it ends.
 */

const Editor = lazy(() => import('../screens/Editor').then((m) => ({ default: m.Editor })))

const LAYOUT_KEY = 'dosbox.layout.v3'

const defaultLayout: IJsonModel = {
  global: { tabEnableClose: true, tabSetEnableMaximize: true, splitterSize: 6, tabEnableRenderOnDemand: true },
  // The bottom bar: collapsed panels live here as tabs; a click opens one as a flyout, ↥ puts it back.
  borders: [{ type: 'border', location: 'bottom', size: 320, children: [] }],
  layout: {
    type: 'row',
    children: [
      { type: 'tabset', id: 'left', weight: 18, children: [{ type: 'tab', id: 'files', name: 'Files', component: 'files', enableClose: false }] },
      {
        type: 'row', weight: 57,
        children: [
          { type: 'tabset', id: 'main', weight: 70, children: [{ type: 'tab', id: 'editor', name: 'Editor', component: 'editor', enableClose: false }] },
          { type: 'tabset', id: 'bottom', weight: 30, children: [{ type: 'tab', id: 'terminal', name: 'Terminal', component: 'terminal', enableClose: false }] },
        ],
      },
      {
        type: 'tabset', id: 'side', weight: 25,
        children: [
          { type: 'tab', id: 'guide', name: '8086 guide', component: 'guide' },
          { type: 'tab', id: 'ints', name: 'Interrupts', component: 'ints' },
          { type: 'tab', id: 'memmap', name: 'Memory map', component: 'memmap' },
        ],
      },
    ],
  },
}

function loadModel(): Model {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const m = Model.fromJson(JSON.parse(raw) as IJsonModel)
      if (m.getNodeById('machine')) m.doAction(Actions.deleteTab('machine')) // only while a program runs
      if (m.getNodeById('editor') && m.getNodeById('files') && m.getNodeById('terminal')) return m
    }
  } catch { /* a stale or broken layout: start over */ }
  return Model.fromJson(defaultLayout)
}

interface Props {
  boxId: string
  running: boolean
  program?: string
  rpc: RPC
  dbg: Debugger
  available: boolean | null
  onRun: (steps: Step[]) => Promise<boolean>
  terminalRef: React.RefObject<TerminalHandle>
  subscribeCon: (fn: (chunk: Uint8Array, lost: boolean) => void) => () => void
  onTermKey: (e: KeyboardEvent, down: boolean) => void
  /** Live heat ticks from the box (the sidecar's "H" messages), and the switch that asks for them. */
  subscribeHeat?: (fn: (tick: HeatTick) => void) => () => void
  setHeat?: (on: boolean) => void
}

export function Workspace({ boxId, running, program, dbg, available, onRun, terminalRef, subscribeCon, onTermKey, subscribeHeat, setHeat }: Props) {
  const [model, setModel] = useState<Model>(loadModel)
  const editorRef = useRef<EditorHandle | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [treeKey, setTreeKey] = useState(0)
  const [intFocus, setIntFocus] = useState<{ int: number; ax: number } | null>(null)
  // Where a collapsed tab came from, to put it back.
  const homes = useRef(new Map<string, string>())

  const bottomBorder = () => model.getBorderSet().getBorders().find((b) => b.getLocation() === DockLocation.BOTTOM)
  const collapse = (tab: TabNode) => {
    const border = bottomBorder()
    if (!border) return
    homes.current.set(tab.getId(), tab.getParent()?.getId() ?? 'main')
    model.doAction(Actions.moveNode(tab.getId(), border.getId(), DockLocation.CENTER, -1, false))
  }
  const restore = (tab: TabNode) => {
    const home = homes.current.get(tab.getId())
    const target = home ? model.getNodeById(home) : undefined
    if (target) model.doAction(Actions.moveNode(tab.getId(), target.getId(), DockLocation.CENTER, -1, true))
    else {
      // Its group went away with it (it was the last tab): a new split under the editor.
      const main = model.getNodeById('main')
      if (main) model.doAction(Actions.moveNode(tab.getId(), main.getId(), DockLocation.BOTTOM, -1, true))
    }
  }
  // A tabset header gets –: the selected tab collapses to the bottom bar. A click on a bar tab puts it back where it was.
  const onRenderTabSet = (node: TabSetNode | BorderNode, values: { buttons: React.ReactNode[] }) => {
    if (!(node instanceof TabSetNode)) return
    const sel = node.getSelectedNode() as TabNode | undefined
    if (!sel) return
    values.buttons.push(
      <button key="collapse" className="ws-collapse" title="Collapse to the bottom bar" onMouseDown={(e) => e.stopPropagation()} onClick={() => collapse(sel)}>–</button>,
    )
  }
  const onAction = (action: Action): Action | undefined => {
    if (action.type === Actions.SELECT_TAB) {
      const node = model.getNodeById((action.data as { tabNode: string }).tabNode)
      if (node instanceof TabNode && node.getParent() instanceof BorderNode) { restore(node); return undefined }
    }
    return action
  }

  // Show a tab (adding it back if it was closed) and select it.
  const show = (id: string, name: string, component: string) => {
    if (!model.getNodeById(id)) {
      const target = model.getNodeById('side') ?? model.getNodeById('main')
      if (target) model.doAction(Actions.addNode({ type: 'tab', id, name, component }, target.getId(), DockLocation.CENTER, -1, true))
    } else {
      model.doAction(Actions.selectTab(id))
    }
  }
  const openInEditor = (file: string, code: string) => {
    show('editor', 'Editor', 'editor')
    window.setTimeout(() => editorRef.current?.createFile(file, code), 50)
  }
  const showInterrupt = (int: number, ax: number) => {
    setIntFocus({ int, ax })
    show('ints', 'Interrupts', 'ints')
  }

  // The Machine tab appears on execution: a debug session, or any program running on the box (live heat).
  const active = !!dbg.session || (!!program && program.toUpperCase() !== 'COMMAND')
  useEffect(() => {
    const has = !!model.getNodeById('machine')
    if (active && !has) {
      const target = model.getNodeById('side') ?? model.getNodeById('main')
      if (target) model.doAction(Actions.addNode({ type: 'tab', id: 'machine', name: 'Machine', component: 'machine' }, target.getId(), DockLocation.CENTER, -1, true))
    } else if (!active && has) {
      model.doAction(Actions.deleteTab('machine'))
    }
  }, [active, model])

  const debug: EditorDebug = useMemo(() => ({
    active: !!dbg.session, stopped: dbg.stopped, running: !!dbg.session && !dbg.stopped, busy: dbg.busy, error: dbg.error, ip: dbg.ip, cs: dbg.cs, breakpoints: dbg.breakpoints,
    toggleBreakpoint: dbg.toggleBreakpoint, start: dbg.start, step: dbg.step, stepUntil: dbg.stepUntil, cont: dbg.cont, pause: dbg.pause, stop: dbg.stop,
  }), [dbg.session, dbg.stopped, dbg.busy, dbg.error, dbg.ip, dbg.cs, dbg.breakpoints, dbg.toggleBreakpoint, dbg.start, dbg.step, dbg.stepUntil, dbg.cont, dbg.pause, dbg.stop])

  const factory = (node: TabNode) => {
    switch (node.getComponent()) {
      case 'files':
        return <FilesTab boxId={boxId} editorRef={editorRef} selected={path} dir={dir} refreshKey={treeKey} onDir={setDir} />
      case 'editor':
        return (
          <Suspense fallback={<p className="muted">Loading the editor…</p>}>
            <Editor
              ref={editorRef} boxId={boxId} running={running} onRun={onRun} look="paper" program={program} debug={debug}
              tree={false} onPathChange={setPath} onDirChange={setDir} onSaved={() => setTreeKey((k) => k + 1)}
            />
          </Suspense>
        )
      case 'terminal':
        return <Terminal ref={terminalRef} boxId={boxId} running={running} subscribe={subscribeCon} onKey={onTermKey} />
      case 'guide':
        return <GuidePanel onOpen={openInEditor} />
      case 'ints':
        return <InterruptsPanel focus={intFocus} />
      case 'memmap':
        return <MemoryMapPanel regs={dbg.regs} />
      case 'machine':
        return <div className="dbg-body"><Machine dbg={dbg} onShowInterrupt={showInterrupt} subscribeHeat={subscribeHeat} setHeat={setHeat} program={program} /></div>
    }
    return <div className="muted">?</div>
  }

  const reset = () => {
    try { localStorage.removeItem(LAYOUT_KEY) } catch { /* ignore */ }
    setModel(Model.fromJson(defaultLayout))
  }

  return (
    <div className="workspace">
      <Layout
        model={model}
        factory={factory}
        onRenderTabSet={onRenderTabSet}
        onAction={onAction}
        onModelChange={(m) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(m.toJson())) } catch { /* private mode */ } }}
      />
      <button className="ghost workspace-reset" onClick={reset} title="Put the panels back where they started">⟲ layout</button>
      {available === false && <span className="workspace-note muted small">no debugger on this box (plain image)</span>}
    </div>
  )
}
