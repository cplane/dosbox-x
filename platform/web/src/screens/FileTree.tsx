import { useCallback, useEffect, useState } from 'react'
import { listFiles, type FileEntry } from '../api/client'

/**
 * The box's C: drive as a tree: folders open on click (listed when first
 * opened, listed again when `refreshKey` changes), files open in the
 * editor. Icons are small line drawings, so they sit quietly on paper.
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
}

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

export function FileTree({ boxId, selected, refreshKey, onOpen, onDir }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const [lists, setLists] = useState<Record<string, FileEntry[] | 'loading' | 'error'>>({})

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

  // Open folders are (re)listed when the key changes; a newly opened one is listed once.
  useEffect(() => { for (const d of open) load(d) }, [refreshKey, boxId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const d of open) if (!lists[d]) load(d) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // The open file's folders are shown open.
  useEffect(() => {
    if (!selected) return
    const parts = selected.split('/').slice(0, -1)
    setOpen((o) => {
      const n = new Set(o)
      for (let i = 1; i <= parts.length; i++) n.add(parts.slice(0, i).join('/'))
      return n
    })
  }, [selected])

  const toggle = (dir: string) => {
    setOpen((o) => { const n = new Set(o); if (n.has(dir)) n.delete(dir); else n.add(dir); return n })
    onDir(dir)
  }

  const render = (dir: string, depth: number): React.ReactNode => {
    const list = lists[dir]
    if (list === 'loading' || !list) return <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>…</div>
    if (list === 'error') return <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>can't list</div>
    if (list.length === 0) return <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>empty</div>
    return list.map((e) => {
      const p = dir ? `${dir}/${e.name}` : e.name
      if (e.dir) {
        const isOpen = open.has(p)
        return (
          <div key={p}>
            <button className="tree-row" style={{ paddingLeft: depth * 14 }} onClick={() => toggle(p)} title={`C:\\${p.replace(/\//g, '\\')}`}>
              <Chevron open={isOpen} /><Folder open={isOpen} /><span>{e.name}</span>
            </button>
            {isOpen && render(p, depth + 1)}
          </div>
        )
      }
      return (
        <button key={p} className={`tree-row ${selected === p ? 'on' : ''}`} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => { onDir(dir); onOpen(p) }} title={`${e.size.toLocaleString()} bytes`}>
          <File kind={kindOf(e.name)} /><span>{e.name}</span>
        </button>
      )
    })
  }

  return <div className="tree">{render('', 0)}</div>
}
