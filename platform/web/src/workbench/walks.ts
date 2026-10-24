/**
 * Walkthroughs: a guide example run on a box under the debugger, one instruction at a time, with the machine's
 * state before each (the registers, the example's variables, the top of the stack, what it has printed so far)
 * and what each instruction read and wrote. Made ahead of time by tools/walkthrough.mts and shipped as JSON next
 * to the guide, one file per example; the article loads one when its stepper opens.
 */

export interface WalkVar {
  name: string
  /** Offset in the program's segment. */
  offset: number
  /** 1 (DB), 2 (DW) or 4 (DD) bytes per item. */
  unit: number
  /** Bytes it has (to the next variable or the end of the program). */
  length: number
}

/** The machine before one instruction (the last state: after the last one). */
export interface WalkState {
  /** AX BX CX DX SI DI BP SP CS DS ES SS IP FLAGS. */
  r: number[]
  /** The line of the snippet the instruction is on (0-based, as shown); -1: outside it (the skeleton's exit). */
  line: number
  /** The instruction about to run (empty in the last state). */
  text: string
  bytes: string
  /** The example's data area (from the first variable to the end of the program), hex. */
  data: string
  /** The 16 words at SS:SP (hex), the top first. */
  stack: string
  /** What the program has printed so far through DOS. */
  out: string
  /** What the instruction before this state read and wrote: [linear address, size, 1 = write]. */
  acc: [number, number, number][]
  /** A loop before this state ran on at full speed, unrecorded: one that waits (for the timer, a key) or one that
   *  goes round many times (a delay, a long copy). */
  waited?: boolean
}

export interface Walk {
  v: 1
  /** The snippet the walk was made from (its code and data lines): a walk for another text is not shown. */
  src: string
  /** The program's segment, and where the data area starts in it. */
  seg: number
  dataAt: number
  vars: WalkVar[]
  states: WalkState[]
  /** How it ended: "exited"; "wait" when it went round a loop waiting for something outside it (the timer, a key),
   *  the walk stopping there; "limit" when it ran longer than a walk keeps. After "wait" and "limit" the program ran
   *  on to its end at full speed. */
  end: string
}

export const REG_NAMES = ['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'BP', 'SP', 'CS', 'DS', 'ES', 'SS', 'IP', 'FLAGS']

/** The text a walk is checked against: the snippet's code and data lines. */
export function walkSource(code: string[], data: string[] = []): string {
  return [...code, '', ...data].join('\n')
}

/** The file a walk lives in: the article's key and the snippet's place in it. */
export const walkName = (key: string, block: number) => `${key.replace(/[^A-Za-z0-9-]/g, '_')}.${block}`
