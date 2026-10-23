import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, BorderNode, DockLocation, I18nLabel, Layout, Model, RowNode, TabNode, TabSetNode, type Action, type IJsonModel } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'
import type { RPC } from '../screens/DebugPanel'
import type { EditorDebug, EditorHandle } from '../screens/Editor'
import type { Step } from '../screens/Console'
import { Terminal, type TerminalHandle } from '../screens/Terminal'
import { pressKeys, typeText } from '../api/client'
import { FilesTab } from './FilesTab'
import { GuidePanel } from './GuidePanel'
import { ArticleView } from './ArticleView'
import { findArticle, findInterrupt } from './articles'
import { Machine } from './Machine'
import { MemoryMapPanel } from './MemoryMapPanel'
import { MemoryAtlas } from './MemoryAtlas'
import type { MemUpdate } from './memfeed'
import type { Debugger } from './useDebugger'
import type { HeatTick } from './heat'
import type { Tds } from './tds'
import { CallStackPanel } from './CallStackPanel'
import { WatchPanel } from './WatchPanel'
import { useDebugValues } from './values'
import { VariablesPanel } from './VariablesPanel'

/**
 * The workbench as a dockable workspace (flexlayout): every panel is a tab
 * that can be dragged to another group, split off or closed; the layout
 * is remembered. The Machine tab exists only while a program runs under
 * the debugger: it appears when a session starts and goes when it ends.
 */

const Editor = lazy(() => import('../screens/Editor').then((m) => ({ default: m.Editor })))

// Two layouts, each kept as the user leaves it: one for writing code, one for debugging it (the workspace
// switches when a debug session starts and when it ends).
type Mode = 'edit' | 'debug'
const LAYOUT_KEYS: Record<Mode, string> = { edit: 'dosbox.layout.edit.v6', debug: 'dosbox.layout.debug.v6' }
// The layouts before the guide moved in with the files (and the interrupts became its chapter): v6 starts from them.
const V5_KEYS: Record<Mode, string> = { edit: 'dosbox.layout.edit.v5', debug: 'dosbox.layout.debug.v5' }
const OLD_LAYOUT_KEY = 'dosbox.layout.v4' // the single layout before the split: the edit layout starts from it

const defaultLayout: IJsonModel = {
  global: { tabEnableClose: true, tabSetEnableMaximize: true, splitterSize: 6, tabEnableRenderOnDemand: true },
  // The bottom bar: collapsed panels live here as tabs; a click opens one as a flyout, ↥ puts it back.
  borders: [{ type: 'border', location: 'bottom', size: 320, children: [] }],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset', id: 'left', weight: 18, selected: 0,
        children: [
          { type: 'tab', id: 'files', name: 'Files', component: 'files', enableClose: false },
          { type: 'tab', id: 'guide', name: '8086 guide', component: 'guide' },
        ],
      },
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
          { type: 'tab', id: 'memmap', name: 'Memory map', component: 'memmap' },
        ],
      },
    ],
  },
}

// Debugging: the files narrow, the editor over the terminal, and on the right what the program is doing:
// variables, watches and the machine above, the call stack below.
const debugLayout: IJsonModel = {
  global: defaultLayout.global,
  borders: [{ type: 'border', location: 'bottom', size: 320, children: [] }],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset', id: 'left', weight: 14, selected: 0,
        children: [
          { type: 'tab', id: 'files', name: 'Files', component: 'files', enableClose: false },
          { type: 'tab', id: 'guide', name: '8086 guide', component: 'guide' },
        ],
      },
      {
        type: 'row', weight: 52,
        children: [
          { type: 'tabset', id: 'main', weight: 68, children: [{ type: 'tab', id: 'editor', name: 'Editor', component: 'editor', enableClose: false }] },
          { type: 'tabset', id: 'bottom', weight: 32, children: [{ type: 'tab', id: 'terminal', name: 'Terminal', component: 'terminal', enableClose: false }] },
        ],
      },
      {
        type: 'row', weight: 34,
        children: [
          {
            type: 'tabset', id: 'side', weight: 62, selected: 0,
            children: [
              { type: 'tab', id: 'vars', name: 'Variables', component: 'vars' },
              { type: 'tab', id: 'watch', name: 'Watch', component: 'watch' },
              { type: 'tab', id: 'machine', name: 'Machine', component: 'machine' },
              { type: 'tab', id: 'memmap', name: 'Memory map', component: 'memmap' },
            ],
          },
          { type: 'tabset', id: 'stack', weight: 38, children: [{ type: 'tab', id: 'calls', name: 'Call stack', component: 'calls' }] },
        ],
      },
    ],
  },
}
const DEFAULTS: Record<Mode, IJsonModel> = { edit: defaultLayout, debug: debugLayout }

/**
 * Where a collapsed tab comes back: next to the tab `with` (into its group for `center`, else in a new group on
 * that side of it), or at an edge of the window; `weight` is the size its group had, `anchorWeight` the
 * neighbour's then; `index` its place among the group's tabs.
 */
export interface Spot { with?: string; dock?: 'center' | 'top' | 'bottom' | 'left' | 'right'; edge?: 'start' | 'end'; weight?: number; anchorWeight?: number; index?: number }

const DOCK = { center: DockLocation.CENTER, top: DockLocation.TOP, bottom: DockLocation.BOTTOM, left: DockLocation.LEFT, right: DockLocation.RIGHT }
const OPPOSITE: Record<string, Spot['dock']> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', center: 'center' }

/**
 * For a group about to go: the nearest neighbour (going up through the rows: a row left with nothing in it goes
 * too) and the side the group was on, with the size of what goes (the group, or the row it was alone in).
 */
function neighbourOf(model: Model, group: TabSetNode): Spot {
  const root = model.getRoot()
  let node: TabSetNode | RowNode = group
  for (let parent = node.getParent(); parent instanceof RowNode; node = parent, parent = parent.getParent()) {
    const kids = parent.getChildren()
    const i = kids.indexOf(node)
    const next = kids[i + 1], prev = kids[i - 1]
    const sibling = next ?? prev
    if (!sibling) continue // alone in this row: look one level up
    const across = parent.getOrientation() === DockLocation.LEFT.getOrientation()
    const dock: Spot['dock'] = next ? (across ? 'left' : 'top') : (across ? 'right' : 'bottom')
    if (sibling instanceof TabSetNode) {
      const sel = sibling.getSelectedNode() ?? sibling.getChildren()[0]
      if (sel) return { with: sel.getId(), dock, weight: node.getWeight(), anchorWeight: sibling.getWeight() }
    }
    // A row beside it: at the window's edge when it was at one, else against the nearest group in that row.
    if (parent === root && (i === 0 || i === kids.length - 1)) return { edge: i === 0 ? 'start' : 'end', weight: node.getWeight() }
    let leaf: TabSetNode | undefined
    const walk = (n: RowNode | TabSetNode) => {
      if (n instanceof TabSetNode) { if (!leaf || !next) leaf = n; return }
      const cs = n.getChildren() as (RowNode | TabSetNode)[]
      for (const c of next ? cs : [...cs]) { walk(c); if (leaf && next) return }
    }
    walk(sibling as RowNode)
    const sel = leaf?.getSelectedNode() ?? leaf?.getChildren()[0]
    if (sel) return { with: sel.getId(), dock, weight: node.getWeight(), anchorWeight: leaf?.getWeight() }
  }
  return {}
}

/** For a tab collapsed before spots were kept: its place in the default layout. */
function defaultSpot(model: Model, id: string): Spot {
  const isOpen = (x: string) => { const n = model.getNodeById(x); return n instanceof TabNode && n.getParent() instanceof TabSetNode }
  const side = SIDE.find((x) => x !== id && isOpen(x))
  if (id === 'editor' || id === 'terminal') {
    const partner = id === 'editor' ? 'terminal' : 'editor'
    if (isOpen(partner)) return id === 'editor' ? { with: partner, dock: 'top', weight: 70, anchorWeight: 30 } : { with: partner, dock: 'bottom', weight: 30, anchorWeight: 70 }
    // The middle column: right of the files, else left of the side panels.
    if (isOpen('files')) return { with: 'files', dock: 'right', weight: 57, anchorWeight: 18 }
    if (side) return { with: side, dock: 'left', weight: 57, anchorWeight: 25 }
    return {}
  }
  if (id === 'files') return { edge: 'start', weight: 18 }
  if (id === 'guide') return isOpen('files') ? { with: 'files', dock: 'center' } : { edge: 'start', weight: 18 }
  // The side panels: with one of them that is out, else a group of their own at the right edge.
  return side ? { with: side, dock: 'center' } : { edge: 'end', weight: 25 }
}

const SIDE = ['memmap', 'machine', 'vars', 'watch']

function loadModel(mode: Mode): Model {
  try {
    const now = localStorage.getItem(LAYOUT_KEYS[mode])
    const raw = now ?? localStorage.getItem(V5_KEYS[mode]) ?? (mode === 'edit' ? localStorage.getItem(OLD_LAYOUT_KEY) : null)
    if (raw) {
      const m = Model.fromJson(JSON.parse(raw) as IJsonModel)
      if (!now) {
        // From an older layout: the Interrupts tab is gone (a chapter of the guide now), the guide goes behind the files.
        if (m.getNodeById('ints')) m.doAction(Actions.deleteTab('ints'))
        const files = m.getNodeById('files')
        const group = files?.getParent()
        if (group instanceof TabSetNode) {
          if (m.getNodeById('guide')) m.doAction(Actions.moveNode('guide', group.getId(), DockLocation.CENTER, 1, false))
          else m.doAction(Actions.addNode({ type: 'tab', id: 'guide', name: '8086 guide', component: 'guide' }, group.getId(), DockLocation.CENTER, 1, false))
          m.doAction(Actions.selectTab('files'))
        }
      }
      if (mode === 'edit') {
        if (m.getNodeById('machine')) m.doAction(Actions.deleteTab('machine')) // only while a program runs
        for (const id of ['vars', 'watch', 'calls']) if (m.getNodeById(id)) m.doAction(Actions.deleteTab(id)) // only while debugging
      }
      // Empty groups kept by an earlier version of collapsing: they only take space.
      const empty: string[] = []
      m.visitNodes((n) => { if (n instanceof TabSetNode && n.getChildren().length === 0) empty.push(n.getId()) })
      for (const id of empty) m.doAction(Actions.deleteTabset(id))
      if (m.getNodeById('editor') && m.getNodeById('files') && m.getNodeById('terminal')) return m
    }
  } catch { /* a stale or broken layout: start over */ }
  return Model.fromJson(DEFAULTS[mode])
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
  /** Live memory from the box (the sidecar's "M" messages), and the tiles to ask for. */
  subscribeMem?: (fn: (u: MemUpdate) => void) => () => void
  setMemTiles?: (tiles: number[]) => void
  /** The player's handle on the editor for the view handoff (set while the workspace is on). */
  handoff?: React.MutableRefObject<WorkbenchHandoff | null>
}

export interface WorkbenchHandoff {
  /** The editor's open file. */
  path: () => string | null
  save: () => Promise<boolean>
  open: (path: string) => void
  /** Whether the editor is mounted (open works). */
  ready: () => boolean
}

export function Workspace({ boxId, running, program, dbg, available, onRun, terminalRef, subscribeCon, onTermKey, subscribeHeat, setHeat: setHeatRaw, subscribeMem, setMemTiles, handoff }: Props) {
  // Live heat is one switch on the box for every view that shows it (the Machine view, the memory map): on while
  // any of them wants it.
  const heatUsers = useRef(0)
  const setHeat = useMemo(() => (setHeatRaw ? (on: boolean) => {
    const before = heatUsers.current
    heatUsers.current = Math.max(0, before + (on ? 1 : -1))
    if ((before === 0) !== (heatUsers.current === 0)) setHeatRaw(heatUsers.current > 0)
  } : undefined), [setHeatRaw])
  // Debugging from the moment Start is pressed (the build runs in the debug layout) until the session ends.
  const [startingDebug, setStartingDebug] = useState(false)
  const mode: Mode = dbg.session || startingDebug ? 'debug' : 'edit'
  const [layout, setLayout] = useState<{ mode: Mode; model: Model }>(() => ({ mode, model: loadModel(mode) }))
  useEffect(() => {
    // The layout being left was saved as it changed (onModelChange); the other comes back as it was left.
    if (layout.mode !== mode) setLayout({ mode, model: loadModel(mode) })
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const model = layout.model
  const editorRef = useRef<EditorHandle | null>(null)
  useEffect(() => {
    if (!handoff) return
    handoff.current = {
      path: () => editorRef.current?.path() ?? null,
      save: () => editorRef.current?.save() ?? Promise.resolve(true),
      open: (p) => editorRef.current?.open(p),
      ready: () => !!editorRef.current,
    }
    return () => { handoff.current = null }
  }, [handoff])
  const [path, setPath] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [treeKey, setTreeKey] = useState(0)
  // The program's debug symbols, from the editor's last debug build, for the Variables panel.
  const [symbols, setSymbols] = useState<{ tds: Tds; source: string } | null>(null)
  const onSymbols = useCallback((tds: Tds | null, source: string) => setSymbols(tds ? { tds, source } : null), [])
  // The call stack, the chosen frame's locals, the globals and the watch evaluator, shared by the debug panels.
  // The chosen frame's line is marked in the editor when IP is outside the program; its address is where Stop
  // brings the program back to before terminating it.
  const values = useDebugValues(dbg, symbols)
  const frameIp = useRef<number | null>(null)
  frameIp.current = values.frameIp
  // A program waiting for a key gets Enter, then Escape, then a space, so it comes back to its own code to be ended.
  const nudge = useCallback((attempt: number) => pressKeys(boxId, ['enter', 'esc', 'space'][attempt] ?? 'enter'), [boxId])
  const stopProgram = useCallback(() => dbg.stop(frameIp.current ?? undefined, nudge), [dbg.stop, nudge])
  const startProgram = useCallback((command: string, entryParagraph?: number) => dbg.start(command, nudge, entryParagraph), [dbg.start, nudge])
  const debugStarting = useCallback((on: boolean) => setStartingDebug(on), [])
  // The shell's input line was interrupted by the program: an Enter brings the prompt back, as after any session.
  const endOrphan = useCallback(async () => {
    const ended = await dbg.endOrphan(nudge)
    if (ended) setTimeout(() => { terminalRef.current?.run('').catch(() => undefined) }, 300)
    return ended
  }, [dbg.endOrphan, nudge, terminalRef])
  const valuesRef = useRef(values)
  valuesRef.current = values
  const lookupValue = useCallback((name: string) => {
    const all = [...valuesRef.current.locals, ...valuesRef.current.enclosing.flatMap((e) => e.values), ...valuesRef.current.globals]
    // BASIC: the word under the mouse has no type suffix (nm for nm$), the variable may have one.
    const bare = (n: string) => n.replace(/[%&!#$@]$/, '').toLowerCase()
    const v = all.find((x) => x.name === name) ?? all.find((x) => x.name.toLowerCase() === name.toLowerCase())
      ?? (symbols?.tds.language === 'basic' ? all.find((x) => bare(x.name) === bare(name)) : undefined)
    return v ? `${v.value}  ·  ${v.type}` : undefined
  }, [symbols])
  // Collapsing: the tab goes to the bottom bar and remembers, in its own config (saved with the layout, so a
  // reload keeps it), where to come back: into a group that still has other tabs, or, when it was alone (its
  // group is deleted once empty, freeing the space), beside a neighbour on a side, or at an edge of the window.
  const bottomBorder = () => model.getBorderSet().getBorders().find((b) => b.getLocation() === DockLocation.BOTTOM)
  const spotOf = (tab: TabNode): Spot | undefined => (tab.getConfig() as { spot?: Spot } | undefined)?.spot
  const setSpot = (tab: TabNode, spot: Spot | undefined) => {
    const { spot: _old, home: _h, homeWeight: _w, ...rest } = (tab.getConfig() ?? {}) as Record<string, unknown>
    model.doAction(Actions.updateNodeAttributes(tab.getId(), { config: spot ? { ...rest, spot } : rest }))
  }
  const collapse = (tab: TabNode) => {
    const border = bottomBorder()
    const group = tab.getParent()
    if (!border || !(group instanceof TabSetNode)) return
    const other = group.getChildren().find((c) => c !== tab)
    // Alone in the window too (everything else collapsed): no neighbour to remember, its usual place then.
    const near = other ? undefined : neighbourOf(model, group)
    setSpot(tab, other ? { with: other.getId(), dock: 'center', index: group.getChildren().indexOf(tab) } : near && (near.with || near.edge) ? near : defaultSpot(model, tab.getId()))
    model.doAction(Actions.moveNode(tab.getId(), border.getId(), DockLocation.CENTER, -1, false))
  }
  const restore = (tab: TabNode) => {
    // Everything collapsed: the first one back simply fills the window; the others dock against what is open.
    let open = 0
    model.visitNodes((n) => { if (n instanceof TabSetNode) open += n.getChildren().length })
    const own = spotOf(tab) ?? defaultSpot(model, tab.getId())
    let spot: Spot = open === 0 ? { weight: own.weight } : own // its own size, so what comes back next sits in proportion
    // The neighbour is collapsed too: take its place, and let it come back on our other side later.
    for (let hops = 0; spot.with && hops < 6; hops++) {
      const anchor = model.getNodeById(spot.with)
      if (!(anchor instanceof TabNode) || !(anchor.getParent() instanceof BorderNode)) break
      const recorded = spotOf(anchor)
      // A neighbour collapsed with no record of its own (by an older version): our usual place among what is open.
      if (!recorded) { spot = defaultSpot(model, tab.getId()); break }
      const theirs = recorded
      // It comes back on our other side (or into our group), so the two end up as they were.
      setSpot(anchor, spot.dock && spot.dock !== 'center'
        ? { with: tab.getId(), dock: OPPOSITE[spot.dock], weight: spot.anchorWeight, anchorWeight: spot.weight }
        : { with: tab.getId(), dock: 'center', index: theirs.index })
      spot = { ...theirs, weight: theirs.weight ?? spot.weight } // our size there is theirs
    }
    const anchor = spot.with ? model.getNodeById(spot.with) : undefined
    const anchorGroup = anchor instanceof TabNode ? anchor.getParent() : undefined
    if (anchorGroup instanceof TabSetNode) {
      // Into a group: side panels by their usual order, other tabs at the place they had.
      const kids = anchorGroup.getChildren().map((c) => c.getId())
      const rank = SIDE.indexOf(tab.getId())
      const at = spot.dock === 'center' || !spot.dock
        ? (rank >= 0 && kids.every((k) => SIDE.includes(k)) ? kids.filter((k) => SIDE.indexOf(k) < rank).length : Math.min(spot.index ?? -1, kids.length))
        : -1
      model.doAction(Actions.moveNode(tab.getId(), anchorGroup.getId(), DOCK[spot.dock ?? 'center'], at, true))
      if (spot.dock && spot.dock !== 'center' && spot.anchorWeight !== undefined) model.doAction(Actions.updateNodeAttributes(anchorGroup.getId(), { weight: spot.anchorWeight }))
    } else if (spot.edge) {
      model.doAction(Actions.moveNode(tab.getId(), model.getRoot().getId(), spot.edge === 'start' ? DockLocation.LEFT : DockLocation.RIGHT, -1, true))
    } else {
      // Nothing to dock against: any group there is.
      let target: TabSetNode | undefined
      model.visitNodes((n) => { if (!target && n instanceof TabSetNode) target = n })
      if (target) model.doAction(Actions.moveNode(tab.getId(), target.getId(), DockLocation.CENTER, -1, true))
      else model.doAction(Actions.moveNode(tab.getId(), model.getRoot().getId(), DockLocation.LEFT, -1, true))
    }
    const group = tab.getParent()
    if (group instanceof TabSetNode && spot.weight !== undefined && spot.dock !== 'center') model.doAction(Actions.updateNodeAttributes(group.getId(), { weight: spot.weight }))
    setSpot(tab, undefined)
    // The empty group flexlayout keeps when every tab was collapsed: no longer needed once something is back.
    const empty: string[] = []
    let groups = 0
    model.visitNodes((n) => { if (n instanceof TabSetNode) { groups++; if (n.getChildren().length === 0) empty.push(n.getId()) } })
    if (groups > empty.length) for (const id of empty) model.doAction(Actions.deleteTabset(id))
  }
  // Brings a tab into view: back from the bottom bar if it was collapsed there, else selected where it is.
  const reveal = (id: string) => {
    const node = model.getNodeById(id)
    if (!(node instanceof TabNode)) return false
    if (node.getParent() instanceof BorderNode) restore(node)
    else model.doAction(Actions.selectTab(id))
    return true
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
    // A tab's × collapses it to the bottom bar rather than dropping it: a panel closed by mistake (or by a click
    // meant for the overflow menu) is always one click away. In the bar itself, × does nothing.
    if (action.type === Actions.DELETE_TAB) {
      const node = model.getNodeById((action.data as { node: string }).node)
      // The guide's article tab is a page, not a panel: × closes it (the index opens it again).
      if (node instanceof TabNode && node.getId() === 'article') { articleHistory.current = []; return action }
      if (node instanceof TabNode && node.getParent() instanceof TabSetNode) { collapse(node); return undefined }
      if (node instanceof TabNode && node.getParent() instanceof BorderNode) return undefined
    }
    return action
  }
  const i18n = (id: I18nLabel) => (id === I18nLabel.Close_Tab ? 'Collapse to the bottom bar' : undefined)

  // Show a tab (adding it back if it was closed) and select it.
  const show = (id: string, name: string, component: string) => {
    if (reveal(id)) return
    const target = model.getNodeById('side') ?? model.getNodeById('main')
    if (target) model.doAction(Actions.addNode({ type: 'tab', id, name, component }, target.getId(), DockLocation.CENTER, -1, true))
  }
  // The editor in view (back from the bottom bar if collapsed there), then `then` once it is mounted.
  const withEditor = (then: (editor: EditorHandle) => void) => {
    show('editor', 'Editor', 'editor')
    let tries = 0
    const go = () => {
      if (editorRef.current) then(editorRef.current)
      else if (tries++ < 40) window.setTimeout(go, 50)
    }
    window.setTimeout(go, 0)
  }
  const openInEditor = (file: string, code: string) => withEditor((e) => e.createFile(file, code))
  // The 8086 guide's article tab: beside the editor, one article at a time, with a way back. Its key is kept in
  // the tab's config (so the layout remembers it); the articles shown before it, for "back".
  const articleHistory = useRef<string[]>([])
  const [, setArticleShown] = useState<string | null>(null) // re-renders the index's mark
  const articleNode = model.getNodeById('article')
  const currentArticle = articleNode instanceof TabNode ? ((articleNode.getConfig() as { key?: string } | undefined)?.key ?? null) : null
  const openArticle = (key: string, remember = true) => {
    const a = findArticle(key)
    if (!a) return
    const node = model.getNodeById('article')
    const name = `8086 · ${a.title}`
    if (node instanceof TabNode) {
      const was = (node.getConfig() as { key?: string } | undefined)?.key
      if (remember && was && was !== a.key) articleHistory.current.push(was)
      model.doAction(Actions.updateNodeAttributes('article', { name, config: { key: a.key } }))
      reveal('article')
    } else {
      // Into the editor's group (or, with the editor collapsed, the main one).
      const editor = model.getNodeById('editor')
      const group = editor instanceof TabNode && editor.getParent() instanceof TabSetNode ? editor.getParent()! : model.getNodeById('main')
      let target = group
      if (!target) model.visitNodes((n) => { if (!target && n instanceof TabSetNode) target = n })
      if (target) model.doAction(Actions.addNode({ type: 'tab', id: 'article', name, component: 'article', config: { key: a.key } }, target.getId(), DockLocation.CENTER, -1, true))
    }
    setArticleShown(a.key)
  }
  const articleBack = () => {
    const prev = articleHistory.current.pop()
    if (prev) openArticle(prev, false)
  }
  // The Machine view's INT: the service's article in the guide's interrupts chapter.
  const showInterrupt = (int: number, ax: number) => {
    const a = findInterrupt(int, ax)
    if (a) openArticle(a.key)
  }

  // The Machine tab appears on execution: a debug session, or any program running on the box (live heat).
  const active = mode === 'debug' || (!!program && program.toUpperCase() !== 'COMMAND')
  // In the edit layout it comes and goes with a running program, and the tab that was selected there before it
  // is selected again when it goes. Neither effect touches a layout that is about to be swapped out (its mode is
  // not the current one): what it did would be saved into the wrong layout.
  const beforeMachine = useRef<string | null>(null)
  const inSync = layout.mode === mode
  useEffect(() => {
    if (!inSync) return
    const has = !!model.getNodeById('machine')
    if (active && !has) {
      const target = model.getNodeById('side') ?? model.getNodeById('main')
      if (!(target instanceof TabSetNode)) return
      beforeMachine.current = target.getSelectedNode()?.getId() ?? null
      model.doAction(Actions.addNode({ type: 'tab', id: 'machine', name: 'Machine', component: 'machine' }, target.getId(), DockLocation.CENTER, -1, true))
    } else if (!active && has && mode === 'edit') {
      model.doAction(Actions.deleteTab('machine'))
      const back = beforeMachine.current
      beforeMachine.current = null
      if (back && model.getNodeById(back)) model.doAction(Actions.selectTab(back))
    }
  }, [active, model, inSync, mode])
  // The debug panels follow a debug session of a program with symbols: Variables and Watch in the side tabset
  // (top right), the Call stack in a tabset of its own below it.
  // Only once the session is up (while building, the symbols are the previous program's).
  const vars = !!dbg.session && !!symbols
  useEffect(() => {
    if (!dbg.session || !inSync) return
    const has = !!model.getNodeById('vars')
    if (vars && !has) {
      const side = model.getNodeById('side') ?? model.getNodeById('main')
      if (!side) return
      model.doAction(Actions.addNode({ type: 'tab', id: 'watch', name: 'Watch', component: 'watch' }, side.getId(), DockLocation.CENTER, 0, false))
      model.doAction(Actions.addNode({ type: 'tab', id: 'vars', name: 'Variables', component: 'vars' }, side.getId(), DockLocation.CENTER, 0, true))
      if (!model.getNodeById('calls')) model.doAction(Actions.addNode({ type: 'tab', id: 'calls', name: 'Call stack', component: 'calls' }, side.getId(), DockLocation.BOTTOM, -1, true))
    } else if (!vars && has) {
      // Assembly: nothing for these to show; the Machine view is the one to look at.
      for (const id of ['vars', 'watch', 'calls']) if (model.getNodeById(id)) model.doAction(Actions.deleteTab(id))
      if (model.getNodeById('machine')) model.doAction(Actions.selectTab('machine'))
    }
  }, [vars, model, dbg.session, inSync])

  // Step out of the innermost frame: back in its caller (frame 1), once that frame's SP is above frame 0's BP.
  const caller = values.frames[1]
  const innermost = values.frames[0]
  const stepOut = useMemo(() => (caller && innermost ? () => { void dbg.stepOut(caller.ip, innermost.bp) } : undefined), [caller?.ip, innermost?.bp, dbg.stepOut]) // eslint-disable-line react-hooks/exhaustive-deps

  const debug: EditorDebug = useMemo(() => ({
    // "running" covers a step in progress too (a line step is many short runs), so pause stays put and can halt it.
    active: !!dbg.session, stopped: dbg.stopped, running: !!dbg.session && (!dbg.stopped || dbg.busy), busy: dbg.busy, error: dbg.error, ip: dbg.ip, cs: dbg.cs, entryCs: dbg.entryCs, ended: dbg.ended, breakpoints: dbg.breakpoints,
    toggleBreakpoint: dbg.toggleBreakpoint, start: startProgram, endOrphan, step: dbg.step, stepUntil: dbg.stepUntil, cont: dbg.cont, pause: dbg.pause, stop: stopProgram, runTo: dbg.runTo, stepOut, starting: debugStarting,
  }), [stepOut, debugStarting, dbg.session, dbg.stopped, dbg.busy, dbg.error, dbg.ip, dbg.cs, dbg.entryCs, dbg.ended, dbg.breakpoints, dbg.toggleBreakpoint, startProgram, endOrphan, dbg.step, dbg.stepUntil, dbg.cont, dbg.pause, stopProgram, dbg.runTo])

  // When a session ends, the program's output sits on the prompt line: an Enter gives DOS a fresh prompt,
  // so the next build (and the sidecar's prompt check) finds it.
  const hadSession = useRef(false)
  useEffect(() => {
    if (dbg.session) hadSession.current = true
    else if (hadSession.current) { hadSession.current = false; window.setTimeout(() => { void typeText(boxId, '\n').catch(() => undefined) }, 300) }
  }, [dbg.session, terminalRef])

  const factory = (node: TabNode) => {
    switch (node.getComponent()) {
      case 'files':
        return <FilesTab boxId={boxId} withEditor={withEditor} editor={() => editorRef.current} selected={path} dir={dir} refreshKey={treeKey} onDir={setDir} />
      case 'editor':
        return (
          <Suspense fallback={<p className="muted">Loading the editor…</p>}>
            <Editor
              ref={editorRef} boxId={boxId} running={running} onRun={onRun} look="paper" program={program} debug={debug}
              tree={false} onPathChange={setPath} onDirChange={setDir} onSaved={() => setTreeKey((k) => k + 1)} onSymbols={onSymbols} lookupValue={lookupValue} frameLine={values.frameLine}
            />
          </Suspense>
        )
      case 'terminal':
        return <Terminal ref={terminalRef} boxId={boxId} running={running} subscribe={subscribeCon} onKey={onTermKey} />
      case 'guide':
        return <GuidePanel onOpen={openInEditor} onArticle={(k) => openArticle(k)} current={currentArticle} />
      case 'article': {
        const key = (node.getConfig() as { key?: string } | undefined)?.key ?? 'MOV'
        return (
          <div className="dbg-body">
            <ArticleView articleKey={key} onNavigate={(k) => openArticle(k)} onBack={articleHistory.current.length ? articleBack : undefined} onOpen={openInEditor} />
          </div>
        )
      }
      case 'memmap':
        return (
          <MemoryMapPanel regs={dbg.regs}>
            <MemoryAtlas dbg={dbg} symbols={symbols} subscribeMem={subscribeMem} setMemTiles={setMemTiles} subscribeHeat={subscribeHeat} setHeat={setHeat} program={program} />
          </MemoryMapPanel>
        )
      case 'machine':
        return <div className="dbg-body"><Machine dbg={dbg} controls={debug} onShowInterrupt={showInterrupt} program={program} /></div>
      case 'vars':
        return symbols ? <VariablesPanel values={values} stopped={dbg.stopped} /> : <div className="muted">no symbols</div>
      case 'calls':
        return symbols ? <CallStackPanel values={values} stopped={dbg.stopped} /> : <div className="muted">no symbols</div>
      case 'watch':
        return symbols ? <WatchPanel values={values} stopped={dbg.stopped} boxId={boxId} /> : <div className="muted">no symbols</div>
    }
    return <div className="muted">?</div>
  }

  const reset = () => {
    try { localStorage.removeItem(LAYOUT_KEYS[layout.mode]) } catch { /* ignore */ }
    setLayout({ mode: layout.mode, model: Model.fromJson(DEFAULTS[layout.mode]) })
  }

  return (
    <div className="workspace">
      <Layout
        model={model}
        factory={factory}
        onRenderTabSet={onRenderTabSet}
        onAction={onAction}
        i18nMapper={i18n}
        onModelChange={(m) => { try { localStorage.setItem(LAYOUT_KEYS[layout.mode], JSON.stringify(m.toJson())) } catch { /* private mode */ } }}
      />
      <button className="ghost workspace-reset" onClick={reset} title={`Put the panels of the ${layout.mode === 'debug' ? 'debugging' : 'editing'} layout back where they started`}>⟲ {layout.mode === 'debug' ? 'debug layout' : 'layout'}</button>
      {available === false && <span className="workspace-note muted small">no debugger on this box (plain image)</span>}
    </div>
  )
}
