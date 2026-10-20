import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, DockLocation, Layout, Model, type IJsonModel, type TabNode } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'
import type { RPC } from '../screens/DebugPanel'
import type { EditorDebug, EditorHandle } from '../screens/Editor'
import type { Step } from '../screens/Console'
import { Terminal, type TerminalHandle } from '../screens/Terminal'
import { FilesTab } from './FilesTab'
import { GuidePanel } from './GuidePanel'
import { Machine } from './Machine'
import type { Debugger } from './useDebugger'

/**
 * The workbench as a dockable workspace (flexlayout): every panel is a tab
 * that can be dragged to another group, split off or closed; the layout
 * is remembered. The Machine tab exists only while a program runs under
 * the debugger: it appears when a session starts and goes when it ends.
 */

const Editor = lazy(() => import('../screens/Editor').then((m) => ({ default: m.Editor })))

const LAYOUT_KEY = 'dosbox.layout.v1'

const defaultLayout: IJsonModel = {
  global: { tabEnableClose: true, tabSetEnableMaximize: true, splitterSize: 6, tabEnableRenderOnDemand: true },
  borders: [],
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
      { type: 'tabset', id: 'side', weight: 25, children: [{ type: 'tab', id: 'guide', name: '8086 guide', component: 'guide' }] },
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
}

export function Workspace({ boxId, running, program, dbg, available, onRun, terminalRef, subscribeCon, onTermKey }: Props) {
  const [model, setModel] = useState<Model>(loadModel)
  const editorRef = useRef<EditorHandle | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [treeKey, setTreeKey] = useState(0)

  // The Machine tab follows the debug session.
  const active = !!dbg.session
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
    active, stopped: dbg.stopped, ip: dbg.ip, breakpoints: dbg.breakpoints,
    toggleBreakpoint: dbg.toggleBreakpoint, start: dbg.start, step: dbg.step, cont: dbg.cont,
  }), [active, dbg.stopped, dbg.ip, dbg.breakpoints, dbg.toggleBreakpoint, dbg.start, dbg.step, dbg.cont])

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
        return <GuidePanel />
      case 'machine':
        return <div className="dbg-body"><Machine dbg={dbg} /></div>
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
        onModelChange={(m) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(m.toJson())) } catch { /* private mode */ } }}
      />
      <button className="ghost workspace-reset" onClick={reset} title="Put the panels back where they started">⟲ layout</button>
      {available === false && <span className="workspace-note muted small">no debugger on this box (plain image)</span>}
    </div>
  )
}
