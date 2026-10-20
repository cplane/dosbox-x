import { useState } from 'react'
import type { RPC } from '../screens/DebugPanel'
import { GuidePanel } from './GuidePanel'
import { Machine } from './Machine'
import type { Debugger } from './useDebugger'

/** The workbench's right column: the machine (memory field, CPU, tape) or the 8086 guide. */

interface Props {
  rpc: RPC
  dbg: Debugger
  available: boolean | null
}

export function DebugBar({ dbg, available }: Props) {
  const [tab, setTab] = useState<'machine' | 'guide'>('machine')
  return (
    <div className="dbg">
      <div className="dbg-tabs">
        <button className={tab === 'machine' ? 'on' : ''} onClick={() => setTab('machine')}>Machine</button>
        <button className={tab === 'guide' ? 'on' : ''} onClick={() => setTab('guide')}>8086 guide</button>
        {available === false && <span className="muted small">no debugger on this box (plain image)</span>}
      </div>
      {dbg.error && <p className="auth-error small">{dbg.error}</p>}
      <div className="dbg-body">
        {tab === 'machine' ? <Machine dbg={dbg} /> : <GuidePanel />}
      </div>
    </div>
  )
}
