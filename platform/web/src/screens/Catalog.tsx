import { useCallback, useEffect, useState } from 'react'
import { deleteItem, editItem, importFromArchive, listCatalog, NeedsSignIn, uploadItem, type CatalogItem } from '../api/client'
import { mb } from './CatalogPicker'

interface Props {
  onBack: () => void
  onSignedOut: () => void
}

const CATEGORIES = ['game', 'app', 'dev', 'util', 'demo', 'other']

/** Admin: the software catalog — import from archive.org, upload a zip, edit, delete. */
export function Catalog({ onBack, onSignedOut }: Props) {
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'archive' | 'upload'>('archive')
  const [form, setForm] = useState({ identifier: '', file: '', slug: '', title: '', dir: '', run: '', category: 'game', license: '', description: '' })
  const [zip, setZip] = useState<File | null>(null)

  const fail = useCallback((err: unknown) => {
    if (err instanceof NeedsSignIn) onSignedOut()
    else setError(err instanceof Error ? err.message : String(err))
  }, [onSignedOut])

  const reload = useCallback(() => listCatalog().then(setItems).catch(fail), [fail])

  useEffect(() => {
    reload()
    const t = window.setInterval(reload, 3000) // imports finish in the background
    return () => window.clearInterval(t)
  }, [reload])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const fields: Record<string, string> = {}
      for (const k of ['title', 'dir', 'run', 'category', 'license', 'description'] as const) if (form[k]) fields[k] = form[k]
      if (mode === 'archive') {
        await importFromArchive({ identifier: form.identifier.trim(), file: form.file.trim(), slug: form.slug.trim(), ...fields })
      } else {
        if (!zip || !form.slug) throw new Error('choose a zip and a slug')
        await uploadItem(form.slug.trim(), fields, zip)
      }
      setForm({ ...form, identifier: '', file: '', slug: '', title: '', dir: '', run: '', description: '' })
      setZip(null)
      await reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const edit = (it: CatalogItem) => async () => {
    const run = window.prompt(`Program that starts "${it.title}" (inside C:\\${it.dir}), e.g. GAME.EXE — empty for none`, it.run)
    if (run === null) return
    const title = window.prompt('Title', it.title)
    if (title === null) return
    try {
      await editItem(it.slug, { run, title })
      await reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = (it: CatalogItem) => async () => {
    if (!window.confirm(`Remove "${it.title}" from the catalog? Boxes keep their copies.`)) return
    try {
      await deleteItem(it.slug)
      await reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <div className="page">
      <header className="top">
        <button className="ghost" onClick={onBack}>← Boxes</button>
        <h1 className="title">Catalog</h1>
      </header>

      <form className="catalog-form" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === 'archive' ? 'on' : ''} onClick={() => setMode('archive')}>Import from archive.org</button>
          <button type="button" className={mode === 'upload' ? 'on' : ''} onClick={() => setMode('upload')}>Upload a zip</button>
        </div>
        {mode === 'archive' ? (
          <div className="grid2">
            <label>archive.org identifier<input value={form.identifier} onChange={set('identifier')} placeholder="e.g. msdos_Prince_of_Persia_1990" required /></label>
            <label>Zip file in the item (optional)<input value={form.file} onChange={set('file')} placeholder="default: the largest .zip" /></label>
            <label>Slug (optional)<input value={form.slug} onChange={set('slug')} placeholder="derived from the identifier" /></label>
          </div>
        ) : (
          <div className="grid2">
            <label>Zip file<input type="file" accept=".zip,application/zip" onChange={(e) => setZip(e.target.files?.[0] ?? null)} required /></label>
            <label>Slug<input value={form.slug} onChange={set('slug')} placeholder="e.g. keen1" required /></label>
          </div>
        )}
        <div className="grid2">
          <label>Title<input value={form.title} onChange={set('title')} placeholder="e.g. Prince of Persia" /></label>
          <label>Folder on C: (8.3)<input value={form.dir} onChange={set('dir')} placeholder="e.g. POP" maxLength={8} /></label>
          <label>Program to start<input value={form.run} onChange={set('run')} placeholder="e.g. PRINCE.EXE" /></label>
          <label>Category
            <select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label>License note<input value={form.license} onChange={set('license')} placeholder="e.g. shareware, freeware, owned copy" /></label>
          <label>Description<input value={form.description} onChange={set('description')} /></label>
        </div>
        <button className="primary" disabled={busy}>{busy ? 'Sending…' : mode === 'archive' ? 'Import' : 'Upload'}</button>
        <p className="muted small">
          Imports run in the background: the item shows as importing, then ready. Only add software you may
          redistribute to this site's users (shareware, freeware, or copies you own).
        </p>
      </form>
      {error && <p className="auth-error">{error}</p>}

      {items === null ? <p className="muted">Loading…</p> : (
        <table className="catalog-table">
          <thead>
            <tr><th>Item</th><th>C:</th><th>Start</th><th>Size</th><th>Status</th><th>Source / license</th><th /></tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.slug}>
                <td><b>{it.title}</b><div className="muted small">{it.slug} · {it.category}</div></td>
                <td>{it.dir}</td>
                <td>{it.run || <span className="muted">—</span>}</td>
                <td>{it.status === 'ready' ? `${mb(it.sizeBytes)} MB · ${it.files} files` : ''}</td>
                <td>
                  <span className={`state ${it.status === 'ready' ? 'running' : it.status === 'failed' ? 'failed' : 'starting'}`}>{it.status}</span>
                  {it.error && <div className="auth-error small">{it.error}</div>}
                </td>
                <td className="small">{it.source}<div className="muted">{it.license}</div></td>
                <td className="actions">
                  <button className="small" onClick={edit(it)}>Edit</button>
                  <button className="small danger" onClick={remove(it)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
