import { FileTree } from '../screens/FileTree'
import type { EditorHandle } from '../screens/Editor'

/** The Files tab: the folder New creates in, New, and the tree; opens files in the editor tab. */
interface Props {
  boxId: string
  /** Runs `then` on the editor once it is in view (brought back if it was collapsed). */
  withEditor: (then: (editor: EditorHandle) => void) => void
  selected: string | null
  dir: string
  refreshKey: number
  onDir: (dir: string) => void
}

const dosDir = (dir: string) => 'C:\\' + dir.replace(/\//g, '\\')

export function FilesTab({ boxId, withEditor, selected, dir, refreshKey, onDir }: Props) {
  return (
    <div className="files-tab">
      <div className="bar">
        <span className="mono" title="where New creates a file">{dosDir(dir)}</span>
        <button onClick={() => withEditor((e) => e.create())} title="New file in this folder">New</button>
      </div>
      <FileTree boxId={boxId} selected={selected} refreshKey={refreshKey} onOpen={(p) => withEditor((e) => e.open(p))} onDir={onDir} />
    </div>
  )
}
