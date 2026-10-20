import type { Registers } from './useDebugger'

/**
 * What an instruction touches in memory, worked out from its disassembly
 * and the registers at that moment: the effective address of a [..]
 * operand (BX/BP/SI/DI plus a displacement, a segment override), the
 * string operations' DS:SI / ES:DI, and the stack for PUSH/POP/CALL/RET/INT.
 * The emulator doesn't report reads, so this is how the memory field
 * knows which cells an instruction is about to look at; writes are
 * found exactly by diffing the window after the step.
 */

export interface Touch {
  seg: number
  offset: number
  size: number
  kind: 'read' | 'write' | 'rw'
}

const reg16 = (r: Registers, name: string): number => {
  const g = r.general
  switch (name) {
    case 'ax': return parseInt(g.eax, 16) & 0xffff
    case 'bx': return parseInt(g.ebx, 16) & 0xffff
    case 'cx': return parseInt(g.ecx, 16) & 0xffff
    case 'dx': return parseInt(g.edx, 16) & 0xffff
    case 'si': return parseInt(g.esi, 16) & 0xffff
    case 'di': return parseInt(g.edi, 16) & 0xffff
    case 'bp': return parseInt(g.ebp, 16) & 0xffff
    case 'sp': return parseInt(g.esp, 16) & 0xffff
  }
  return 0
}
const seg = (r: Registers, name: string) => parseInt(r.segments[name] ?? '0', 16) & 0xffff

/** The operand size: a byte if a byte register or "byte" is named, else a word. */
function sizeOf(text: string): number {
  if (/\b(al|ah|bl|bh|cl|ch|dl|dh)\b|\bbyte\b/i.test(text)) return 1
  if (/\bdword\b|\be[a-d]x\b|\be[sd]i\b/i.test(text)) return 4
  return 2
}

export function touches(text: string, r: Registers): Touch[] {
  const t = text.trim().toLowerCase()
  const [op] = t.split(/\s+/)
  const out: Touch[] = []
  const sp = reg16(r, 'sp')
  const ss = seg(r, 'ss')
  // The stack.
  if (op === 'push' || op === 'pushf' || op === 'call') out.push({ seg: ss, offset: (sp - 2) & 0xffff, size: op === 'call' && /:/.test(t) ? 4 : 2, kind: 'write' })
  if (op === 'pop' || op === 'popf' || op === 'ret' || op === 'retn' || op === 'retf' || op === 'iret') out.push({ seg: ss, offset: sp, size: op === 'retf' || op === 'iret' ? 4 : 2, kind: 'read' })
  if (op === 'int') out.push({ seg: ss, offset: (sp - 6) & 0xffff, size: 6, kind: 'write' })
  // Strings: DS:SI source, ES:DI destination.
  const strOp = /^(rep[ez]?|repn[ez]?)?\s*(movs|lods|stos|cmps|scas)([bwd])?/.exec(t)
  if (strOp) {
    const n = strOp[3] === 'b' ? 1 : strOp[3] === 'd' ? 4 : 2
    const kind = strOp[2]
    if (kind === 'movs' || kind === 'lods' || kind === 'cmps') out.push({ seg: seg(r, 'ds'), offset: reg16(r, 'si'), size: n, kind: 'read' })
    if (kind === 'movs' || kind === 'stos') out.push({ seg: seg(r, 'es'), offset: reg16(r, 'di'), size: n, kind: 'write' })
    if (kind === 'cmps' || kind === 'scas') out.push({ seg: seg(r, 'es'), offset: reg16(r, 'di'), size: n, kind: 'read' })
    return out
  }
  if (op === 'xlat' || op === 'xlatb') { out.push({ seg: seg(r, 'ds'), offset: (reg16(r, 'bx') + (parseInt(r.general.eax, 16) & 0xff)) & 0xffff, size: 1, kind: 'read' }); return out }
  // A [..] operand: segment override, base + index + displacement.
  const m = /(?:(cs|ds|es|ss):)?\[([^\]]+)\]/.exec(t)
  if (!m) return out
  let segName = m[1] ?? (/\bbp\b/.test(m[2]) ? 'ss' : 'ds')
  let off = 0
  for (const term of m[2].split('+')) {
    const x = term.trim()
    if (/^(bx|bp|si|di)$/.test(x)) off += reg16(r, x)
    else if (/^-?[0-9a-f]+h?$/.test(x)) off += parseInt(x.replace(/h$/, ''), 16)
  }
  off &= 0xffff
  const size = sizeOf(t)
  // Destination first in Intel syntax: "mov [bx],ax" writes, "mov ax,[bx]" reads; read-modify-write ops do both.
  const comma = t.indexOf(',')
  const bracketAt = t.indexOf('[')
  const isDst = comma < 0 ? !/^(push|jmp|call|cmp|test|div|idiv|mul|imul)$/.test(op) : bracketAt < comma
  let kind: Touch['kind'] = isDst ? 'write' : 'read'
  if (isDst && /^(add|sub|adc|sbb|inc|dec|neg|not|and|or|xor|shl|sal|shr|sar|rol|ror|rcl|rcr|xchg)$/.test(op)) kind = 'rw'
  if (op === 'lea') return out // LEA only computes the address
  if (op === 'cmp' || op === 'test') kind = 'read'
  out.push({ seg: seg(r, segName), offset: off, size, kind })
  if (/^(lds|les)$/.test(op)) out[out.length - 1].size = 4
  void segName
  return out
}
