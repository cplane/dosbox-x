import type { Registers } from './useDebugger'

/**
 * The real-mode memory map: what lives where in the first megabyte, which
 * of it a program may write, and where the running program sits.
 */

interface Region {
  from: number
  to: number
  name: string
  what: string
  write: 'yes' | 'careful' | 'no'
  cls: string
}

const REGIONS: Region[] = [
  { from: 0x00000, to: 0x003ff, name: 'Interrupt vectors', what: '256 far pointers, 4 bytes each: vector n at 0000:n×4. INT 21h\'s handler lives at 0000:0084.', write: 'careful', cls: 'ivt' },
  { from: 0x00400, to: 0x004ff, name: 'BIOS data area', what: '0040:0017 shift state, 0040:001A/1C keyboard buffer head/tail (buffer at 0040:001E), 0040:004A columns, 0040:0050 cursor positions, 0040:006C timer ticks, 0040:0084 rows − 1.', write: 'careful', cls: 'bda' },
  { from: 0x00500, to: 0x005ff, name: 'DOS data', what: 'Print-screen status, DOS\'s own variables.', write: 'no', cls: 'dos' },
  { from: 0x00600, to: 0x0ffff, name: 'DOS kernel, drivers, COMMAND.COM', what: 'IO.SYS / MSDOS.SYS (in DOSBox-X: its built-in DOS), device drivers, the resident part of the shell. Size varies; the first MCB marks the end.', write: 'no', cls: 'dos' },
  { from: 0x10000, to: 0x9ffff, name: 'Free conventional memory', what: 'Programs load here: a PSP (256 bytes) then the code. A .COM gets one 64 KB segment (CS=DS=ES=SS), the stack at its top, and owns all the rest until it frees it (INT 21h 4Ah).', write: 'yes', cls: 'free' },
  { from: 0xa0000, to: 0xaffff, name: 'VGA graphics memory', what: 'The pixel buffer in graphics modes: mode 13h is one byte per pixel, 320×200 from A000:0000.', write: 'yes', cls: 'video' },
  { from: 0xb0000, to: 0xb7fff, name: 'Monochrome text memory', what: 'MDA/Hercules text at B000:0000.', write: 'yes', cls: 'video' },
  { from: 0xb8000, to: 0xbffff, name: 'Colour text memory', what: '80×25 cells of (character, attribute) from B800:0000: cell (row, col) at (row×80 + col)×2. Writing here is the fast way to draw text.', write: 'yes', cls: 'video' },
  { from: 0xc0000, to: 0xc7fff, name: 'Video BIOS ROM', what: 'The VGA adapter\'s BIOS.', write: 'no', cls: 'rom' },
  { from: 0xc8000, to: 0xeffff, name: 'Adapter ROMs / upper memory', what: 'Option ROMs (disk controllers, network cards); with a memory manager, upper memory blocks for TSRs and drivers.', write: 'no', cls: 'rom' },
  { from: 0xf0000, to: 0xfffff, name: 'System BIOS ROM', what: 'The BIOS: INT 10h, 13h, 16h handlers, POST; the reset vector at F000:FFF0.', write: 'no', cls: 'rom' },
]

const seg = (lin: number) => (lin >> 4).toString(16).toUpperCase().padStart(4, '0')

export function MemoryMapPanel({ regs }: { regs: Registers | null }) {
  const cs = regs ? (parseInt(regs.segments.cs, 16) & 0xffff) : null
  const ss = regs ? (parseInt(regs.segments.ss, 16) & 0xffff) : null
  const sp = regs ? (parseInt(regs.general.esp, 16) & 0xffff) : null
  const MB = 0x100000
  return (
    <div className="guide memmap-panel">
      <div className="guide-body">
        <div className="memmap-bar" title="the first megabyte, 0000:0000 to F000:FFFF">
          {REGIONS.map((r) => (
            <span key={r.from} className={r.cls} style={{ width: `${(100 * (r.to - r.from + 1)) / MB}%` }} title={`${seg(r.from)}:0000 – ${r.name}`} />
          ))}
          {cs !== null && <i className="memmap-you" style={{ left: `${(100 * (cs << 4)) / MB}%` }} title={`your program: CS = ${seg(cs << 4)}`} />}
        </div>
        <div className="memmap-scale"><span>0000</span><span>4000</span><span>8000</span><span>A000</span><span>C000</span><span>FFFF</span></div>
        {cs !== null && (
          <p className="guide-note">
            Your program: code at <b>{seg(cs << 4)}:0000</b> (PSP at {seg((cs - 0x10) << 4)}), stack top <b>{seg((ss ?? 0) << 4)}:{(sp ?? 0).toString(16).toUpperCase().padStart(4, '0')}</b>.
          </p>
        )}
        {REGIONS.map((r) => (
          <div key={r.from} className={`guide-entry memmap-row ${r.cls}`}>
            <div className="guide-head">
              <b>{seg(r.from)}–{seg(r.to)}</b> {r.name}
              <span className={`memmap-write w-${r.write}`}>{r.write === 'yes' ? 'yours to write' : r.write === 'careful' ? 'write with care' : 'do not write'}</span>
            </div>
            <div className="guide-desc">{r.what}</div>
          </div>
        ))}
        <p className="guide-note">Segment × 16 + offset = the address; the same byte has many names (0000:0400 = 0040:0000). Everything above 640 KB (A000) is hardware or ROM, not RAM a program may use.</p>
      </div>
    </div>
  )
}
