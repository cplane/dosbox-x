import { useRef } from 'react'
import { FileTree, type FileTreeHandle } from '../screens/FileTree'
import type { EditorHandle } from '../screens/Editor'

/**
 * The Files tab: the current folder (the one last clicked, or the open file's), New file / New folder there,
 * Refresh, and the tree (right-click an item for its actions). Files open in the editor tab.
 */
interface Props {
  boxId: string
  /** Runs `then` on the editor once it is in view (brought back if it was collapsed). */
  withEditor: (then: (editor: EditorHandle) => void) => void
  /** The editor, when it is mounted: open files follow renames and deletes made here. */
  editor: () => EditorHandle | null
  selected: string | null
  dir: string
  refreshKey: number
  onDir: (dir: string) => void
}

const dosDir = (dir: string) => 'C:\\' + dir.replace(/\//g, '\\')

const NewFile = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /><path d="M8 7.5v5 M5.5 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)
const NewFolder = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /><path d="M8 7v4.5 M5.75 9.25h4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)
const Refresh = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M11.8 1.8v3h-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

export function FilesTab({ boxId, withEditor, editor, selected, dir, refreshKey, onDir }: Props) {
  const tree = useRef<FileTreeHandle>(null)
  return (
    <div className="files-tab">
      <div className="bar">
        <span className="mono" title="the current folder: New creates here (click a folder to change it)">{dosDir(dir)}</span>
        <span className="files-actions">
          <button className="icon-btn" onClick={() => tree.current?.newFile(dir)} title={`New file in ${dosDir(dir)}`}><NewFile /></button>
          <button className="icon-btn" onClick={() => tree.current?.newFolder(dir)} title={`New folder in ${dosDir(dir)}`}><NewFolder /></button>
          <button className="icon-btn" onClick={() => tree.current?.refresh()} title="Refresh: list the open folders again"><Refresh /></button>
        </span>
      </div>
      <FileTree
        ref={tree} boxId={boxId} selected={selected} refreshKey={refreshKey} onDir={onDir}
        onOpen={(p) => withEditor((e) => e.open(p))}
        onRenamed={(from, to) => editor()?.renamed(from, to)}
        onDeleted={(p) => editor()?.deleted(p)}
      />
    </div>
  )
}
