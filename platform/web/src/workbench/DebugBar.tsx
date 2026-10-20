import { useState } from 'react'
import type { RPC } from '../screens/DebugPanel'
import { MemoryPanel } from '../screens/MemoryPanel'
import { GuidePanel } from './GuidePanel'
import { hex, type Debugger } from './useDebugger'

/**
 * The workbench's right column: the debugger's controls, then tabs for
 * registers, memory, disassembly and the 8086 guide.
 */

interface Props {
  rpc: RPC
  dbg: Debugger
  available: boolean | null
}

type Tab = 'regs' | 'mem' | 'asm' | 'guide'

function flagNames(flags: string): string {
  const f = parseInt(flags, 16)
  if (Number.isNaN(f)) return ''
  const names: [number, string][] = [[0x800, 'OF'], [0x400, 'DF'], [0x200, 'IF'], [0x100, 'TF'], [0x80, 'SF'], [0x40, 'ZF'], [0x10, 'AF'], [0x4, 'PF'], [0x1, 'CF']]
  return names.filter(([bit]) => f & bit).map(([, n]) => n).join(' ')
}

export function DebugBar({ rpc, dbg, available }: Props) {
  const [tab, setTab] = useState<Tab>('regs')
  const { session, stopped, regs, prevRegs, busy } = dbg
  const changed = (k: string, v: string) => prevRegs && regs && prevRegs !== regs && ((prevRegs.general[k] ?? prevRegs.segments[k]) !== v) ? 'changed' : ''
  const active = tab === 'guide' ? 'guide' : session ? tab : 'guide'

  return (
    <div className="dbg">
      <div className="dbg-tools">
        {session ? (
          <>
            <button onClick={() => dbg.step('into')} disabled={busy || !stopped} title="Step into (F7)">↓ into</button>
            <button onClick={() => dbg.step('over')} disabled={busy || !stopped} title="Step over (F8)">↷ over</button>
            {session.state === 'running'
              ? <button onClick={dbg.pause} disabled={busy} title="Pause">‖</button>
              : <button onClick={dbg.cont} disabled={busy || !stopped} title="Continue (F9)">▶</button>}
            <button className="danger" onClick={dbg.stop} disabled={busy} title="Stop the program">■</button>
            <span className={`state ${session.state}`}>{session.state}{session.stop_reason ? ` · ${session.stop_reason.kind}` : ''}</span>
          </>
        ) : (
          <span className="muted small">{available === false ? 'no debugger on this box (plain image)' : 'Debug in the editor starts a program at its entry'}</span>
        )}
      </div>
      {dbg.error && <p className="auth-error small">{dbg.error}</p>}
      <div className="dbg-tabs">
        {(['regs', 'mem', 'asm', 'guide'] as Tab[]).map((t) => (
          <button key={t} className={active === t ? 'on' : ''} disabled={t !== 'guide' && !session} onClick={() => setTab(t)}>
            {{ regs: 'Registers', mem: 'Memory', asm: 'Code', guide: '8086 guide' }[t]}
          </button>
        ))}
      </div>
      <div className="dbg-body">
        {active === 'regs' && regs && (
          <div className="regs">
            {['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'].map((k) => (
              <span key={k} className={changed(k, regs.general[k])}><b>{k.slice(1).toUpperCase()}</b> {hex(regs.general[k]).slice(-4)}</span>
            ))}
            {['cs', 'ds', 'es', 'ss'].map((k) => (
              <span key={k} className={changed(k, regs.segments[k])}><b>{k.toUpperCase()}</b> {hex(regs.segments[k])}</span>
            ))}
            <span className={prevRegs && prevRegs !== regs && prevRegs.instruction_pointer !== regs.instruction_pointer ? 'changed' : ''}>
              <b>IP</b> {hex(regs.instruction_pointer).slice(-4)}
            </span>
            <span><b>FL</b> {hex(regs.flags).slice(-4)}</span>
            <span className="regs-flags">{flagNames(regs.flags) || '(no flags set)'}</span>
          </div>
        )}
        {active === 'mem' && session && regs && <MemoryPanel rpc={rpc} sessionId={session.session_id} stopped={stopped} regs={regs} />}
        {active === 'asm' && session && (
          <div className="disasm">
            <table>
              <tbody>
                {dbg.lines.map((l) => (
                  <tr key={l.offset} className={l.offset === dbg.ip ? 'ip' : ''}>
                    <td className={`gutter ${dbg.breakpoints.has(l.offset) ? 'bp' : ''}`} onClick={() => dbg.toggleBreakpoint(l.offset)} title="Toggle breakpoint">{l.offset === dbg.ip ? '' : dbg.breakpoints.has(l.offset) ? '●' : '·'}</td>
                    <td className="addr" onClick={() => dbg.runTo(l.offset)} title="Run to here">{hex(dbg.cs).slice(-4)}:{l.offset.toString(16).toUpperCase().padStart(4, '0')}</td>
                    <td className="bytes">{l.bytes.replace(/(..)/g, '$1 ').trim()}</td>
                    <td>{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {active === 'guide' && <GuidePanel />}
      </div>
    </div>
  )
}
