import { useCallback, useEffect, useState } from 'react'
import {
  attachItems, createBox, deleteBox, limits, listBoxes, listCatalog, NeedsSignIn, startBox, stopBox,
  type Box, type CatalogItem, type Limits,
} from '../api/client'
import { CatalogPicker, mb } from './CatalogPicker'

interface Props {
  username: string
  isAdmin: boolean
  onOpen: (id: string) => void
  onFiles: (id: string) => void
  onCatalog: () => void
  onSignOut: () => void
  onSignedOut: () => void
}

/** The user's boxes: create (optionally with catalog software), start/stop, open, files, delete. */
export function Boxes({ username, isAdmin, onOpen, onFiles, onCatalog, onSignOut, onSignedOut }: Props) {
  const [boxes, setBoxes] = useState<Box[] | null>(null)
  const [cfg, setCfg] = useState<Limits | null>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [addingTo, setAddingTo] = useState<string | null>(null) // box id with the picker open
  const [toAdd, setToAdd] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback((err: unknown) => {
    if (err instanceof NeedsSignIn) onSignedOut()
    else setError(err instanceof Error ? err.message : String(err))
  }, [onSignedOut])

  const reload = useCallback(() => listBoxes().then(setBoxes).catch(fail), [fail])

  useEffect(() => {
    limits().then(setCfg).catch(() => undefined)
    listCatalog().then(setCatalog).catch(() => undefined)
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
    act('create', async () => {
      await createBox(name.trim(), picking ? [...chosen] : [])
      setName('')
      setChosen(new Set())
      setPicking(false)
    })()
  }

  const limitBytes = (cfg?.diskLimitMB ?? 500) << 20
  const hasCatalog = catalog.some((it) => it.status === 'ready')

  return (
    <div className="page">
      <header className="top">
        <h1 className="title">DOS-BOX</h1>
        <span className="spacer" />
        {isAdmin && <button className="ghost" onClick={onCatalog}>Catalog</button>}
        <span className="muted">{username}</span>
        <button className="ghost" onClick={onSignOut}>Sign out</button>
      </header>

      <form className="create-form" onSubmit={create}>
        <div className="create">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New box name, e.g. Turbo C" maxLength={40} required />
          {hasCatalog && (
            <button type="button" className={picking ? 'on' : ''} onClick={() => setPicking(!picking)}>
              {picking ? 'Clean box' : '+ Software'}
            </button>
          )}
          <button className="primary" disabled={busy === 'create'}>
            {busy === 'create' && chosen.size > 0 ? 'Copying…' : 'Create box'}
          </button>
        </div>
        {picking && (
          <>
            <p className="muted small">Pick software to copy onto the new box's C: drive. Each gets its own folder and a .BAT that starts it.</p>
            <CatalogPicker items={catalog} selected={chosen} onChange={setChosen} freeBytes={limitBytes} />
          </>
        )}
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
            const adding = addingTo === b.id
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
                  {hasCatalog && (
                    <button className={adding ? 'on' : ''} onClick={() => { setAddingTo(adding ? null : b.id); setToAdd(new Set()) }}>
                      Add software
                    </button>
                  )}
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
                {adding && (
                  <div className="add-panel">
                    <CatalogPicker items={catalog} selected={toAdd} onChange={setToAdd} freeBytes={(b.diskLimitMB << 20) - b.usedBytes} />
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={toAdd.size === 0 || busy !== null}
                        onClick={act(`add-${b.id}`, async () => { await attachItems(b.id, [...toAdd]); setAddingTo(null) })}
                      >
                        {busy === `add-${b.id}` ? 'Copying…' : `Copy to C: (${toAdd.size})`}
                      </button>
                      <button onClick={() => setAddingTo(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
