import type { Registers } from './useDebugger'
import { touches, type Touch } from './operands'

/**
 * Where the data of an instruction goes, for the arrows in the machine
 * view: each flow joins a source and a destination among the register
 * cells, a memory cell, the immediate on the tape, and the flags. Worked
 * out from the disassembly text and the live registers, before the step.
 */

export type Anchor =
  | { kind: 'reg'; name: string }       // ax, bx, ... (16-bit cell; AL/AH map to AX)
  | { kind: 'mem'; seg: number; offset: number }
  | { kind: 'imm' }                      // the instruction itself (the tape head)
  | { kind: 'flags' }

export interface Flow {
  from: Anchor
  to: Anchor
}

const REG16: Record<string, string> = {
  ax: 'ax', al: 'ax', ah: 'ax', bx: 'bx', bl: 'bx', bh: 'bx', cx: 'cx', cl: 'cx', ch: 'cx', dx: 'dx', dl: 'dx', dh: 'dx',
  si: 'si', di: 'di', bp: 'bp', sp: 'sp', cs: 'cs', ds: 'ds', es: 'es', ss: 'ss',
}

function operand(text: string, mem: Touch | undefined): Anchor | null {
  const t = text.trim().toLowerCase().replace(/^(byte|word|dword)\s+ptr\s+/, '')
  if (REG16[t]) return { kind: 'reg', name: REG16[t] }
  if (/\[/.test(t)) return mem ? { kind: 'mem', seg: mem.seg, offset: mem.offset } : null
  if (/^[0-9a-f]+h?$/.test(t) || /^-?\d+$/.test(t)) return { kind: 'imm' }
  return null
}

export function flows(text: string, r: Registers): Flow[] {
  const t = text.trim().toLowerCase()
  const sp = /^(\S+)\s*(.*)$/.exec(t)
  if (!sp) return []
  const op = sp[1]
  const args = sp[2] ? sp[2].split(',').map((a) => a.trim()) : []
  const mems = touches(text, r)
  // The [..] operand's address: the last touch (a PUSH/POP of memory lists the stack first).
  const memOp = t.includes('[') ? mems[mems.length - 1] : undefined
  const out: Flow[] = []
  const push = (from: Anchor | null, to: Anchor | null) => { if (from && to) out.push({ from, to }) }
  const stackTop = (delta: number): Anchor => ({ kind: 'mem', seg: parseInt(r.segments.ss, 16) & 0xffff, offset: ((parseInt(r.general.esp, 16) & 0xffff) + delta) & 0xffff })
  const ax: Anchor = { kind: 'reg', name: 'ax' }, dx: Anchor = { kind: 'reg', name: 'dx' }, flags: Anchor = { kind: 'flags' }

  switch (op) {
    case 'mov': case 'lea': case 'movzx': case 'movsx': case 'lds': case 'les':
      if (args.length === 2) push(op === 'lea' ? { kind: 'imm' } : operand(args[1], memOp), operand(args[0], memOp))
      break
    case 'xchg':
      if (args.length === 2) { push(operand(args[1], memOp), operand(args[0], memOp)); push(operand(args[0], memOp), operand(args[1], memOp)) }
      break
    case 'add': case 'sub': case 'adc': case 'sbb': case 'and': case 'or': case 'xor':
    case 'shl': case 'sal': case 'shr': case 'sar': case 'rol': case 'ror': case 'rcl': case 'rcr':
      if (args.length === 2) { push(operand(args[1], memOp), operand(args[0], memOp)); push(operand(args[0], memOp), flags) }
      break
    case 'cmp': case 'test':
      if (args.length === 2) { push(operand(args[0], memOp), flags); push(operand(args[1], memOp), flags) }
      break
    case 'inc': case 'dec': case 'neg': case 'not':
      if (args.length === 1) push(operand(args[0], memOp), flags)
      break
    case 'mul': case 'imul': case 'div': case 'idiv':
      if (args.length === 1) { push(operand(args[0], memOp), ax); push(ax, ax); if (!/\b(al|bl|cl|dl|ah|bh|ch|dh|byte)\b/.test(t)) push(ax, dx) }
      break
    case 'push': if (args.length === 1) push(operand(args[0], memOp), stackTop(-2)); break
    case 'pushf': push(flags, stackTop(-2)); break
    case 'pop': if (args.length === 1) push(stackTop(0), operand(args[0], memOp)); break
    case 'popf': push(stackTop(0), flags); break
    case 'call': push({ kind: 'imm' }, stackTop(-2)); break
    case 'ret': case 'retn': case 'retf': push(stackTop(0), { kind: 'imm' }); break
    case 'int': push({ kind: 'reg', name: 'ax' }, { kind: 'imm' }); push(flags, stackTop(-2)); break
    case 'iret': push(stackTop(0), flags); break
    case 'lodsb': case 'lodsw': case 'lods': { const m = mems.find((x) => x.kind === 'read'); if (m) push({ kind: 'mem', seg: m.seg, offset: m.offset }, ax); break }
    case 'stosb': case 'stosw': case 'stos': { const m = mems.find((x) => x.kind === 'write'); if (m) push(ax, { kind: 'mem', seg: m.seg, offset: m.offset }); break }
    case 'movsb': case 'movsw': case 'movs': { const a = mems.find((x) => x.kind === 'read'), b = mems.find((x) => x.kind === 'write'); if (a && b) push({ kind: 'mem', seg: a.seg, offset: a.offset }, { kind: 'mem', seg: b.seg, offset: b.offset }); break }
    case 'scasb': case 'scasw': case 'cmpsb': case 'cmpsw': { for (const m of mems) push({ kind: 'mem', seg: m.seg, offset: m.offset }, flags); if (/scas/.test(op)) push(ax, flags); break }
    case 'xlat': case 'xlatb': { const m = mems[0]; if (m) push({ kind: 'mem', seg: m.seg, offset: m.offset }, ax); break }
    case 'in': push({ kind: 'imm' }, ax); break
    case 'out': push(ax, { kind: 'imm' }); break
    case 'cbw': case 'cwd': push(ax, op === 'cwd' ? dx : ax); break
    case 'lahf': push(flags, ax); break
    case 'sahf': push(ax, flags); break
    case 'clc': case 'stc': case 'cmc': case 'cld': case 'std': case 'cli': case 'sti': push({ kind: 'imm' }, flags); break
    default:
      if (/^(j[a-z]+|loop[a-z]*|jcxz|jecxz)$/.test(op)) push(flags, { kind: 'imm' })
  }
  // The same cell on both ends says nothing.
  return out.filter((f) => !(f.from.kind === 'reg' && f.to.kind === 'reg' && f.from.name === f.to.name))
}
