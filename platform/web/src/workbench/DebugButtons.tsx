import type { ReactNode } from 'react'
import { Icon } from './icons'

/**
 * The debugger's controls, one set for every toolbar (the editor's, the Machine view's): the workspace makes
 * them once, so continue, pause, step out and stop are the very same actions wherever they are pressed.
 */
export interface DebugControls {
  active: boolean
  stopped: boolean
  /** The target runs (continue, a line step in progress): pause is the thing to offer. */
  running: boolean
  busy: boolean
  cont: () => void
  pause: () => void
  /** Ends the program (bringing it back from inside DOS first when it is paused there). */
  stop: () => void
  /** Run until the current function returns; none when there is no caller. */
  stepOut?: () => void
}

interface Props {
  c: DebugControls
  /** What one step is here: a source line (the editor) or one instruction (the Machine view). */
  unit: 'line' | 'instruction'
  onStep: (mode: 'into' | 'over') => void
  /** Before the controls (the editor's Start). */
  lead?: ReactNode
  /** After the steps, before Stop (the Machine view's stepping on its own). */
  children?: ReactNode
  /** Continue and the steps unavailable here for now (a replay on show, stepping on its own under way). */
  hold?: boolean
}

export function DebugButtons({ c, unit, onStep, lead, children, hold }: Props) {
  const idle = !c.active || c.busy || !c.stopped || !!hold
  const line = unit === 'line'
  return (
    <span className="media" role="group" aria-label="debug">
      {lead}
      {c.running
        ? <button className="media-btn" onClick={c.pause} title="Pause">{Icon.pause}</button>
        : <button className="media-btn" disabled={idle} onClick={c.cont} title="Continue to the next breakpoint or the end (F9)">{Icon.play}</button>}
      <button className="media-btn" disabled={idle} onClick={() => onStep('over')} title={line ? 'Step over: to the next line, calls run through (F8)' : 'Step over one instruction: a CALL or INT runs through'}>{Icon.over}</button>
      <button className="media-btn" disabled={idle} onClick={() => onStep('into')} title={line ? 'Step into: to the next line, into calls (F7)' : 'Step into one instruction'}>{Icon.into}</button>
      <button className="media-btn" disabled={idle || !c.stepOut} onClick={() => c.stepOut?.()} title={`Step out: run until this function returns${line ? ' (Alt+F8)' : ''}`}>{Icon.out}</button>
      {children}
      <button className="media-btn stop" disabled={!c.active} onClick={c.stop} title="Stop debugging (ends the program)">{Icon.stop}</button>
    </span>
  )
}
