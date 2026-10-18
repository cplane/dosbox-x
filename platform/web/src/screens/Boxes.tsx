import { useCallback, useEffect, useState } from 'react'
import { createBox, deleteBox, limits, listBoxes, NeedsSignIn, startBox, stopBox, type Box, type Limits } from '../api/client'

interface Props {
  username: string
  onOpen: (id: string) => void
  onFiles: (id: string) => void
  onSignOut: () => void
  onSignedOut: () => void
}

const mb = (bytes: number) => (bytes / (1 << 20)).toFixed(bytes < 10 << 20 ? 1 : 0)

/** The user's boxes: create, start/stop, open the player, files, delete. */
export function Boxes({ username, onOpen, onFiles, onSignOut, onSignedOut }: Props) {
  const [boxes, setBoxes] = useState<Box[] | null>(null)
  const [cfg, setCfg] = useState<Limits | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback((err: unknown) => {
    if (err instanceof NeedsSignIn) onSignedOut()
    else setError(err instanceof Error ? err.message : String(err))
  }, [onSignedOut])

  const reload = useCallback(() => listBoxes().then(setBoxes).catch(fail), [fail])

  useEffect(() => {
    limits().then(setCfg).catch(() => undefined)
    reload()
    const t = window.setInterval(reload, 3000)
    return () => window.clearInterval(t)
  }, [reload])

  const act = (key: string, fn: () => Promise<unknown>) => async () => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault()
    act('create', async () => { await createBox(name.trim()); setName('') })()
  }

  return (
    <div className="page">
      <header className="top">
        <h1 className="title">DOS-BOX</h1>
        <span className="spacer" />
        <span className="muted">{username}</span>
        <button className="ghost" onClick={onSignOut}>Sign out</button>
      </header>

      <form className="create" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New box name, e.g. Turbo C" maxLength={40} required />
        <button className="primary" disabled={busy === 'create'}>Create box</button>
      </form>
      {cfg && (
        <p className="muted small">
          Up to {cfg.maxBoxesPerUser} boxes, {cfg.maxRunningPerUser} running at a time. Each has its own C: drive
          ({cfg.diskLimitMB} MB). A box nobody watches stops after {cfg.idleMinutes} minutes; its C: drive stays.
        </p>
      )}
      {error && <p className="auth-error">{error}</p>}

      {boxes === null ? <p className="muted">Loading…</p> : boxes.length === 0 ? (
        <p className="muted">No boxes yet. Create one, then upload files to its C: drive or type at its DOS prompt.</p>
      ) : (
        <ul className="boxes">
          {boxes.map((b) => {
            const used = Math.min(100, (b.usedBytes / (b.diskLimitMB << 20)) * 100)
            const running = b.state === 'running'
            return (
              <li key={b.id} className={`box ${b.state}`}>
                <div className="box-main">
                  <button className="box-name" disabled={!running} onClick={() => onOpen(b.id)} title={running ? 'Open the screen' : ''}>
                    {b.name}
                  </button>
                  <span className={`state ${b.state}`}>{b.state}</span>
                  {b.viewers > 0 && <span className="muted small">{b.viewers} watching</span>}
                </div>
                <div className="usage" title={`${mb(b.usedBytes)} of ${b.diskLimitMB} MB`}>
                  <div className={`fill ${used > 90 ? 'hot' : ''}`} style={{ width: `${used}%` }} />
                </div>
                <div className="muted small">
                  C: {mb(b.usedBytes)} / {b.diskLimitMB} MB{b.reason ? ` · ${b.reason}` : ''}
                </div>
                <div className="actions">
                  {running && <button className="primary" onClick={() => onOpen(b.id)}>Open</button>}
                  {(b.state === 'stopped' || b.state === 'failed') && (
                    <button className="primary" disabled={busy !== null} onClick={act(b.id, () => startBox(b.id).then(() => onOpen(b.id)))}>
                      Start
                    </button>
                  )}
                  {(running || b.state === 'starting') && (
                    <button disabled={busy !== null} onClick={act(b.id, () => stopBox(b.id))}>Stop</button>
                  )}
                  <button onClick={() => onFiles(b.id)}>Files</button>
                  <button
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Delete "${b.name}" and everything on its C: drive?`)) act(b.id, () => deleteBox(b.id))()
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
