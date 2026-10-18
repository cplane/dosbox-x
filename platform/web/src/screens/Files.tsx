import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteFile, downloadURL, getBox, listFiles, NeedsSignIn, uploadFile, type Box, type FileEntry } from '../api/client'

interface Props {
  boxId: string
  onBack: () => void
  onOpen: () => void
  onSignedOut: () => void
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)

/**
 * The box's C: drive, served by the gateway from the shared volume, so it
 * works while the box is stopped. Uploads count against the box's limit; a
 * running box rescans its drives after each change.
 */
export function Files({ boxId, onBack, onOpen, onSignedOut }: Props) {
  const [box, setBox] = useState<Box | null>(null)
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const fail = useCallback((err: unknown) => {
    if (err instanceof NeedsSignIn) onSignedOut()
    else setError(err instanceof Error ? err.message : String(err))
  }, [onSignedOut])

  const reload = useCallback(async () => {
    try {
      const [b, list] = await Promise.all([getBox(boxId), listFiles(boxId, dir)])
      setBox(b)
      setEntries(list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)))
    } catch (err) {
      fail(err)
    }
  }, [boxId, dir, fail])

  useEffect(() => { setEntries(null); reload() }, [reload])

  const join = (name: string) => (dir ? `${dir}/${name}` : name)

  async function upload(files: FileList | null) {
    if (!files) return
    setError(null)
    for (const f of Array.from(files)) {
      setBusy(`Uploading ${f.name}…`)
      try {
        await uploadFile(boxId, join(f.name), f)
      } catch (err) {
        fail(err)
        break
      }
    }
    setBusy(null)
    if (input.current) input.current.value = ''
    reload()
  }

  async function remove(e: FileEntry) {
    if (!window.confirm(`Delete ${e.dir ? 'folder' : 'file'} ${join(e.name)}${e.dir ? ' and everything in it' : ''}?`)) return
    setError(null)
    try {
      await deleteFile(boxId, join(e.name), e.dir)
      reload()
    } catch (err) {
      fail(err)
    }
  }

  const crumbs = dir ? dir.split('/') : []
  return (
    <div className="page">
      <div className="bar">
        <button onClick={onBack}>← Boxes</button>
        <strong>{box?.name ?? '…'}</strong>
        {box && <span className={`state ${box.state}`}>{box.state}</span>}
        {box?.state === 'running' && <button className="primary" onClick={onOpen}>Open screen</button>}
        <span className="spacer" />
        {box && <span className="muted small">{size(box.usedBytes)} of {box.diskLimitMB} MB used</span>}
        <button className="primary" onClick={() => input.current?.click()} disabled={busy !== null}>Upload files…</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      </div>
      <p className="crumbs">
        <button className="link" onClick={() => setDir('')}>C:\</button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <button className="link" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button>\
          </span>
        ))}
      </p>
      {busy && <p className="muted">{busy}</p>}
      {error && <p className="auth-error">{error}</p>}
      <p className="muted small">DOS sees 8.3 names; longer names show up shortened (LONGFI~1.TXT).</p>
      {entries === null ? <p className="muted">Loading…</p> : entries.length === 0 ? <p className="muted">Empty.</p> : (
        <table className="files">
          <tbody>
            {entries.map((e) => (
              <tr key={e.name}>
                <td>
                  {e.dir
                    ? <button className="link" onClick={() => setDir(join(e.name))}>{e.name}\</button>
                    : <a href={downloadURL(boxId, join(e.name))}>{e.name}</a>}
                </td>
                <td className="muted small">{e.dir ? '' : size(e.size)}</td>
                <td className="muted small">{new Date(e.mtime).toLocaleString()}</td>
                <td><button className="danger small" onClick={() => remove(e)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
