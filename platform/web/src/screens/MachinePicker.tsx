import type { Machine } from '../api/client'

/**
 * The machine a box emulates: CPU model, memory and speed, as three
 * selects. Empty values are DOSBox-X's defaults (a fast 486-class machine
 * with 16 MB); the presets name the real machines the cycle counts
 * approximate (DOSBox cycles ≈ instructions per millisecond).
 */

const cpus: [NonNullable<Machine['cpu']>, string][] = [
  ['', 'default CPU (486-class)'],
  ['8086', '8086'],
  ['186', '80186'],
  ['286', '80286'],
  ['386', '80386'],
  ['486', '80486'],
  ['pentium', 'Pentium'],
]

const memories: [number, string][] = [
  [0, 'default (16 MB)'], [1, '1 MB'], [2, '2 MB'], [4, '4 MB'], [8, '8 MB'], [16, '16 MB'], [32, '32 MB'], [64, '64 MB'],
]

const speeds: [string, string][] = [
  ['', 'default speed (auto)'],
  ['300', 'PC/XT, 4.77 MHz (300)'],
  ['1000', 'AT 286, 8 MHz (1000)'],
  ['3000', '286, 16 MHz (3000)'],
  ['8000', '386, 33 MHz (8000)'],
  ['25000', '486, 66 MHz (25000)'],
  ['60000', 'Pentium (60000)'],
  ['max', 'as fast as possible (max)'],
]

interface Props {
  value: Machine
  onChange: (m: Machine) => void
  disabled?: boolean
}

export function MachinePicker({ value, onChange, disabled }: Props) {
  return (
    <span className="machine-picker">
      <select value={value.cpu ?? ''} disabled={disabled} onChange={(e) => onChange({ ...value, cpu: e.target.value as Machine['cpu'] })} title="CPU">
        {cpus.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <select value={value.memoryMB ?? 0} disabled={disabled} onChange={(e) => onChange({ ...value, memoryMB: Number(e.target.value) })} title="memory">
        {memories.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <select value={value.cycles ?? ''} disabled={disabled} onChange={(e) => onChange({ ...value, cycles: e.target.value })} title="speed (DOSBox cycles)">
        {speeds.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        {value.cycles && !speeds.some(([v]) => v === value.cycles) && <option value={value.cycles}>{value.cycles} cycles</option>}
      </select>
    </span>
  )
}

/** "8086 · 1 MB · 300 cycles", or "default machine". */
export function describeMachine(m: Machine | undefined): string {
  if (!m) return 'default machine'
  const parts: string[] = []
  if (m.cpu) parts.push(cpus.find(([v]) => v === m.cpu)?.[1] ?? m.cpu)
  if (m.memoryMB) parts.push(`${m.memoryMB} MB`)
  if (m.cycles) parts.push(m.cycles === 'max' ? 'max speed' : `${m.cycles} cycles`)
  return parts.length ? parts.join(' · ') : 'default machine'
}
