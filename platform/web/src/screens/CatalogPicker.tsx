import type { CatalogItem } from '../api/client'

const CATEGORY_NAMES: Record<string, string> = {
  game: 'Games', app: 'Applications', dev: 'Development', util: 'Utilities', demo: 'Demos', other: 'Other',
}
const ORDER = ['game', 'dev', 'app', 'util', 'demo', 'other']

export const mb = (bytes: number) => (bytes / (1 << 20)).toFixed(bytes < 10 << 20 ? 1 : 0)

interface Props {
  items: CatalogItem[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  /** Room left on the box's C: drive, in bytes. */
  freeBytes: number
  /** Folders already on C: (an item whose folder exists can't be added). */
  taken?: Set<string>
}

/** Checkbox list of ready catalog items, grouped by category, with the total size. */
export function CatalogPicker({ items, selected, onChange, freeBytes, taken }: Props) {
  const ready = items.filter((it) => it.status === 'ready')
  if (ready.length === 0) return <p className="muted small">The catalog is empty.</p>

  const total = ready.filter((it) => selected.has(it.slug)).reduce((n, it) => n + it.sizeBytes, 0)
  const toggle = (slug: string) => {
    const next = new Set(selected)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    onChange(next)
  }
  const groups = ORDER.map((cat) => [cat, ready.filter((it) => it.category === cat)] as const).filter(([, its]) => its.length > 0)

  return (
    <div className="picker">
      {groups.map(([cat, its]) => (
        <fieldset key={cat} className="picker-group">
          <legend>{CATEGORY_NAMES[cat] ?? cat}</legend>
          {its.map((it) => {
            const isTaken = taken?.has(it.dir.toUpperCase()) ?? false
            return (
              <label key={it.slug} className={`picker-item ${isTaken ? 'taken' : ''}`} title={it.description || it.source}>
                <input type="checkbox" checked={selected.has(it.slug)} disabled={isTaken} onChange={() => toggle(it.slug)} />
                <span className="picker-title">{it.title}</span>
                <span className="muted small">C:\{it.dir} · {mb(it.sizeBytes)} MB{isTaken ? ' · already on C:' : ''}</span>
              </label>
            )
          })}
        </fieldset>
      ))}
      <p className={`small ${total > freeBytes ? 'auth-error' : 'muted'}`}>
        Selected: {mb(total)} MB of {mb(freeBytes)} MB free on C:
        {total > freeBytes ? ' — too much for this box' : ''}
      </p>
    </div>
  )
}
