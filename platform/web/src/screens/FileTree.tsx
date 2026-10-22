import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { deleteFile, listFiles, makeDir, renamePath, writeTextFile, type FileEntry } from '../api/client'

/**
 * The box's C: drive as a tree. A click on a folder opens or closes it, makes it the current folder (where New
 * creates) and lists it afresh; a click on a file opens it in the editor and makes its folder current. A right
 * click gives the actions for that item (Open, New file, New folder, Rename, Delete, Refresh; F2 and Delete on a
 * row do the same); names are typed in place (8.3, as DOS wants them), and errors show under the tree.
 */

interface Props {
  boxId: string
  /** The open file's path ("ASM/HELLO.ASM"), highlighted. */
  selected: string | null
  /** Bump to re-list the folders that are open (after a save or a build). */
  refreshKey: number
  onOpen: (path: string) => void
  /** The folder the user is in (clicked, or the open file's), for New. */
  onDir: (dir: string) => void
  /** A file or folder was renamed / deleted here: the editor's open files follow. */
  onRenamed?: (from: string, to: string) => void
  onDeleted?: (path: string) => void
}

export interface FileTreeHandle {
  /** Starts typing the name of a new file / folder in a folder (the current one when none is given). */
  newFile: (dir?: string) => void
  newFolder: (dir?: string) => void
  /** Lists every open folder afresh. */
  refresh: () => void
}

type Editing = { kind: 'newFile' | 'newFolder' | 'rename'; parent: string; name: string; target?: string; error?: string }
type Menu = { x: number; y: number; path: string | null; dir: boolean; confirm?: boolean }

const DOS_NAME = /^[A-Z0-9_$~!#%&\-{}@`'()^]{1,8}(\.[A-Z0-9_$~!#%&\-{}@`'()^]{1,3})?$/
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dosPath = (p: string) => 'C:\\' + p.replace(/\//g, '\\')
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`tree-chevron ${open ? 'open' : ''}`} viewBox="0 0 10 10" width="10" height="10"><path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const Folder = ({ open }: { open: boolean }) => (
  <svg className="tree-icon" viewBox="0 0 16 16" width="15" height="15">
    <path d={open ? 'M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z M1.5 7.5h13' : 'M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z'} fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
)
const File = ({ kind }: { kind: 'code' | 'prog' | 'text' | 'other' }) => (
  <svg className="tree-icon" viewBox="0 0 16 16" width="15" height="15">
    <path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    {kind === 'code' && <path d="M6 8l-1.5 1.5L6 11 M10 8l1.5 1.5L10 11" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />}
    {kind === 'prog' && <path d="M6 8.5l3 1.5-3 1.5z" fill="currentColor" />}
    {kind === 'text' && <path d="M5.5 8h5 M5.5 10h5 M5.5 12h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />}
  </svg>
)

function kindOf(name: string): 'code' | 'prog' | 'text' | 'other' {
  switch (name.toLowerCase().replace(/^.*\./, '')) {
    case 'asm': case 'inc': case 'c': case 'h': case 'cpp': case 'hpp': case 'pas': case 'bas': case 'bat': return 'code'
    case 'exe': case 'com': return 'prog'
    case 'txt': case 'doc': case 'md': case 'ini': case 'cfg': case 'lst': case 'map': return 'text'
    default: return 'other'
  }
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree({ boxId, selected, refreshKey, onOpen, onDir, onRenamed, onDeleted }, ref) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const [lists, setLists] = useState<Record<string, FileEntry[] | 'loading' | 'error'>>({})
  const [cur, setCur] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  const load = useCallback(async (dir: string) => {
    setLists((l) => ({ ...l, [dir]: l[dir] && l[dir] !== 'error' ? l[dir] : 'loading' }))
    try {
      const es = await listFiles(boxId, dir)
      es.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      setLists((l) => ({ ...l, [dir]: es }))
    } catch {
      setLists((l) => ({ ...l, [dir]: 'error' }))
    }
  }, [boxId])

  const choose = useCallback((dir: string) => { setCur(dir); onDir(dir) }, [onDir])

  // Open folders are listed again when the key changes (a save, a build); a newly opened one is listed then.
  useEffect(() => { for (const d of openRef.current) load(d) }, [refreshKey, boxId, load])

  // The open file's folders are shown open, and its folder is the current one.
  useEffect(() => {
    if (!selected) return
    const parts = selected.split('/').slice(0, -1)
    setOpen((o) => {
      const n = new Set(o)
      for (let i = 1; i <= parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!n.has(d)) { n.add(d); load(d) } }
      return n
    })
    setCur(parts.join('/'))
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const expand = (dir: string) => {
    setOpen((o) => (o.has(dir) ? o : new Set(o).add(dir)))
    load(dir)
  }
  const toggle = (dir: string) => {
    const opening = !open.has(dir)
    setOpen((o) => { const n = new Set(o); if (n.has(dir)) n.delete(dir); else n.add(dir); return n })
    if (opening) load(dir) // what is on the box now, not what was there when it was last open
    choose(dir)
  }

  const startNew = (kind: 'newFile' | 'newFolder', dir?: string) => {
    const parent = dir ?? cur
    setMenu(null)
    setNote(null)
    if (parent) expand(parent)
    setEditing({ kind, parent, name: '' })
  }
  useImperativeHandle(ref, () => ({
    newFile: (dir) => startNew('newFile', dir),
    newFolder: (dir) => startNew('newFolder', dir),
    refresh: () => { for (const d of openRef.current) load(d) },
  }))

  const exists = (parent: string, name: string) => {
    const l = lists[parent]
    return Array.isArray(l) && l.some((e) => e.name.toUpperCase() === name.toUpperCase())
  }

  const commit = async () => {
    if (!editing) return
    const name = editing.name.trim().toUpperCase()
    if (!name) { setEditing(null); return }
    if (!DOS_NAME.test(name)) { setEditing({ ...editing, error: 'DOS names: up to 8 letters, digits or _ - $ ~ ! # % & @, then optionally . and up to 3 more' }); return }
    const target = join(editing.parent, name)
    try {
      if (editing.kind === 'rename' && editing.target) {
        if (baseOf(editing.target).toUpperCase() === name) { setEditing(null); return }
        if (exists(editing.parent, name)) { setEditing({ ...editing, error: `${name} is already there` }); return }
        await renamePath(boxId, editing.target, target)
        onRenamed?.(editing.target, target)
        setOpen((o) => new Set([...o].map((d) => (d === editing.target ? target : d.startsWith(editing.target + '/') ? target + d.slice(editing.target!.length) : d))))
        if (cur === editing.target || cur.startsWith(editing.target + '/')) choose(target + cur.slice(editing.target.length))
      } else {
        if (exists(editing.parent, name)) { setEditing({ ...editing, error: `${name} is already there` }); return }
        if (editing.kind === 'newFolder') {
          await makeDir(boxId, target)
          setOpen((o) => new Set(o).add(target))
          choose(target)
        } else {
          await writeTextFile(boxId, target, '')
        }
      }
      setEditing(null)
      await load(editing.parent)
      if (editing.kind === 'newFolder') load(target)
      if (editing.kind === 'newFile') { choose(editing.parent); onOpen(target) }
    } catch (err) {
      setEditing({ ...editing, error: message(err) })
    }
  }

  const remove = async (path: string, dir: boolean) => {
    setMenu(null)
    try {
      await deleteFile(boxId, path, dir)
      onDeleted?.(path)
      setOpen((o) => new Set([...o].filter((d) => d !== path && !d.startsWith(path + '/'))))
      if (cur === path || cur.startsWith(path + '/')) choose(parentOf(path))
      await load(parentOf(path))
      setNote(`deleted ${dosPath(path)}`)
    } catch (err) {
      setNote(`could not delete ${dosPath(path)}: ${message(err)}`)
    }
  }

  // The menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest?.('.tree-menu')) return
      setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [menu])

  const openMenu = (e: React.MouseEvent, path: string | null, dir: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    if (path !== null) choose(dir ? path : parentOf(path))
    setMenu({ x: e.clientX, y: e.clientY, path, dir })
  }
  const keys = (e: React.KeyboardEvent, path: string, dir: boolean) => {
    if (e.key === 'F2') { e.preventDefault(); setEditing({ kind: 'rename', parent: parentOf(path), name: baseOf(path), target: path }) }
    else if (e.key === 'Delete') {
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ x: r.left + 24, y: r.bottom, path, dir, confirm: true })
    }
  }

  const input = (depth: number, icon: React.ReactNode) => editing && (
    <div className="tree-edit" style={{ paddingLeft: 14 + depth * 14 }}>
      <div className="tree-edit-row">
        {icon}
        <input
          autoFocus value={editing.name} spellCheck={false} maxLength={12}
          placeholder={editing.kind === 'newFolder' ? 'FOLDER' : 'NAME.EXT'}
          onChange={(e) => setEditing({ ...editing, name: e.target.value.toUpperCase(), error: undefined })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit() } else if (e.key === 'Escape') setEditing(null) }}
          onBlur={() => { if (!editing.name.trim()) setEditing(null) }}
        />
      </div>
      {editing.error && <div className="tree-error">{editing.error}</div>}
    </div>
  )

  const render = (dir: string, depth: number): React.ReactNode => {
    const list = lists[dir]
    const adding = editing && editing.kind !== 'rename' && editing.parent === dir
      ? input(depth, editing.kind === 'newFolder' ? <Folder open={false} /> : <File kind={kindOf(editing.name)} />)
      : null
    if (list === 'loading' || !list) return <>{adding}<div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>…</div></>
    if (list === 'error') return <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>can't list</div>
    if (list.length === 0 && !adding) return <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>empty</div>
    return <>{adding}{list.map((e) => {
      const p = join(dir, e.name)
      if (editing?.kind === 'rename' && editing.target === p) return <div key={p}>{input(depth, e.dir ? <Folder open={false} /> : <File kind={kindOf(e.name)} />)}</div>
      if (e.dir) {
        const isOpen = open.has(p)
        return (
          <div key={p}>
            <button className={`tree-row ${cur === p ? 'cur' : ''}`} style={{ paddingLeft: depth * 14 }} onClick={() => toggle(p)} onContextMenu={(ev) => openMenu(ev, p, true)} onKeyDown={(ev) => keys(ev, p, true)} title={dosPath(p)}>
              <Chevron open={isOpen} /><Folder open={isOpen} /><span>{e.name}</span>
            </button>
            {isOpen && render(p, depth + 1)}
          </div>
        )
      }
      return (
        <button key={p} className={`tree-row ${selected === p ? 'on' : ''}`} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => { choose(dir); onOpen(p) }} onContextMenu={(ev) => openMenu(ev, p, false)} onKeyDown={(ev) => keys(ev, p, false)} title={`${dosPath(p)} · ${e.size.toLocaleString()} bytes`}>
          <File kind={kindOf(e.name)} /><span>{e.name}</span>
        </button>
      )
    })}</>
  }

  const item = (label: string, act: () => void, danger = false) => (
    <button className={`tree-menu-item ${danger ? 'danger' : ''}`} onClick={act}>{label}</button>
  )
  const menuDir = menu ? (menu.path === null ? cur : menu.dir ? menu.path : parentOf(menu.path)) : ''
  return (
    <div className="tree" onContextMenu={(e) => openMenu(e, null, true)}>
      {render('', 0)}
      {note && <div className="tree-status" onClick={() => setNote(null)} title="click to dismiss">{note}</div>}
      {menu && (
        <div className="tree-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.confirm && menu.path ? (
            <>
              <div className="tree-menu-title">Delete {dosPath(menu.path)}{menu.dir ? ' and everything in it' : ''}?</div>
              {item('Delete', () => void remove(menu.path!, menu.dir), true)}
              {item('Cancel', () => setMenu(null))}
            </>
          ) : (
            <>
              {menu.path && !menu.dir && item('Open', () => { setMenu(null); onOpen(menu.path!) })}
              {menu.path && menu.dir && item(open.has(menu.path) ? 'Close folder' : 'Open folder', () => { setMenu(null); toggle(menu.path!) })}
              {item(`New file in ${dosPath(menuDir)}`, () => startNew('newFile', menuDir))}
              {item(`New folder in ${dosPath(menuDir)}`, () => startNew('newFolder', menuDir))}
              {menu.path && item('Rename (F2)', () => { setMenu(null); setEditing({ kind: 'rename', parent: parentOf(menu.path!), name: baseOf(menu.path!), target: menu.path! }) })}
              {menu.path && item('Delete… (Del)', () => setMenu({ ...menu, confirm: true }), true)}
              {item('Refresh', () => { setMenu(null); for (const d of open) load(d) })}
            </>
          )}
        </div>
      )}
    </div>
  )
})
