import { SymbolClass, TypeId, type Tds, type TdsSymbol } from './tds'
import type { Registers } from './useDebugger'

/**
 * From the Turbo Debugger symbols to what a Variables panel shows: the
 * function at IP with its parameters and locals, the program's globals,
 * and their values read from the stopped machine and printed by type.
 */

export interface Frame {
  /** The function's name, or null outside any (the runtime, the main block of a Pascal program). */
  fn: string | null
  /** Where it starts (CS-relative), for the call stack. */
  fnOffset: number | null
  /** Parameters and locals in scope at IP, inner scopes after outer ones. */
  locals: TdsSymbol[]
}

/** Scopes of the entry code segment (load-relative paragraph 0), 1-based indexes kept. */
function entryScopes(tds: Tds): { index: number; scope: Tds['scopes'][number] }[] {
  const out: { index: number; scope: Tds['scopes'][number] }[] = []
  for (const seg of tds.segments) {
    if (seg.seg !== 0) continue
    for (let i = seg.scopeIndex; i < seg.scopeIndex + seg.scopeCount; i++) {
      const scope = tds.scopes[i - 1]
      if (scope) out.push({ index: i, scope })
    }
  }
  return out
}

export function frameAt(tds: Tds, ip: number): Frame {
  const covering = entryScopes(tds)
    .filter(({ scope }) => scope.length > 0 && ip >= scope.offset && ip < scope.offset + scope.length)
    .sort((a, b) => a.scope.offset - b.scope.offset || b.scope.length - a.scope.length)
  const locals: TdsSymbol[] = []
  const seen = new Set<string>()
  for (const { scope } of [...covering].reverse()) {
    for (let i = scope.symIndex; i < scope.symIndex + scope.symCount; i++) {
      const s = tds.symbols[i - 1]
      if (!s || seen.has(s.name)) continue
      if (s.cls === SymbolClass.Auto || s.cls === SymbolClass.PascalVar || s.cls === SymbolClass.Register) { seen.add(s.name); locals.unshift(s) }
    }
  }
  let fn: string | null = null, fnOffset: number | null = null
  const outer = covering[0]
  if (outer) {
    const byIndex = outer.scope.fn !== 0xffff && outer.scope.fn !== 0 ? tds.symbols[outer.scope.fn - 1] : undefined
    const byAddress = tds.symbols.find((s) => s.cls === SymbolClass.Static && s.seg === 0 && s.offset === outer.scope.offset && tds.types[s.type - 1]?.id === TypeId.Function)
    const sym = byIndex ?? byAddress
    if (sym) { fn = sym.name.replace(/^_/, ''); fnOffset = sym.offset }
  }
  return { fn, fnOffset, locals }
}

/** The function (name, start) whose code holds an address, for the call stack. */
export function functionAt(tds: Tds, ip: number): { name: string; offset: number } | null {
  const f = frameAt(tds, ip)
  return f.fn && f.fnOffset !== null ? { name: f.fn, offset: f.fnOffset } : null
}

/** The program's own global variables: static data the source names. */
export function globalsOf(tds: Tds, source: string): TdsSymbol[] {
  const idents = new Set(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
  const out: TdsSymbol[] = []
  const seen = new Set<string>()
  for (const s of tds.symbols) {
    if (s.cls !== SymbolClass.Static || s.seg === 0) continue
    const t = tds.types[s.type - 1]
    if (!t || t.id === TypeId.Function || t.id === TypeId.FuncPrototype || t.id === TypeId.Label) continue
    const plain = s.name.replace(/^_/, '')
    if (!idents.has(plain) && !idents.has(s.name)) continue
    if (seen.has(plain)) continue
    seen.add(plain)
    out.push(s)
  }
  return out
}

const BASIC: Partial<Record<TypeId, string>> = {
  [TypeId.Void]: 'void', [TypeId.SChar]: 'char', [TypeId.SInt]: 'int', [TypeId.SLong]: 'long', [TypeId.UChar]: 'unsigned char',
  [TypeId.UInt]: 'unsigned', [TypeId.ULong]: 'unsigned long', [TypeId.PChar]: 'char', [TypeId.Float]: 'float', [TypeId.TPReal]: 'real',
  [TypeId.Double]: 'double', [TypeId.LDouble]: 'long double', [TypeId.Bool]: 'boolean', [TypeId.WordBool]: 'wordbool', [TypeId.LongBool]: 'longbool',
  [TypeId.Enum]: 'enum', [TypeId.Set]: 'set', [TypeId.Struct]: 'struct', [TypeId.Union]: 'union', [TypeId.Object]: 'object',
}

export function typeName(tds: Tds, index: number, depth = 0): string {
  const t = tds.types[index - 1]
  if (!t) return '?'
  if (t.name && t.id !== TypeId.Function) return t.name
  switch (t.id) {
    case TypeId.PStr: return `string[${Math.max(0, t.size - 1)}]`
    case TypeId.Array: {
      const el = tds.types[t.member - 1]
      const n = el && el.size ? Math.floor(t.size / el.size) : 0
      return depth > 2 ? 'array' : `${typeName(tds, t.member, depth + 1)}[${n}]`
    }
    case TypeId.Near: case TypeId.Far: case TypeId.NRef: case TypeId.FRef:
      return depth > 2 ? 'pointer' : `${typeName(tds, t.member, depth + 1)}*`
    case TypeId.Function: return 'function'
    default: return BASIC[t.id] ?? `type ${t.id}`
  }
}

export interface VarValue {
  name: string
  type: string
  value: string
  /** Where it lives: a register, or segment:offset. */
  where: string
  changed: boolean
}

export interface Machine {
  regs: Registers
  entryCs: number
  read: (seg: number, offset: number, length: number) => Promise<Uint8Array>
}

const REG16 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']
const h4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')
const i16 = (b: Uint8Array, o = 0) => { const v = b[o] | (b[o + 1] << 8); return v > 0x7fff ? v - 0x10000 : v }
const u16 = (b: Uint8Array, o = 0) => b[o] | (b[o + 1] << 8)
const i32 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0, true)
const u32 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true)
const chr = (c: number) => (c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? '\\0' : `\\x${c.toString(16).padStart(2, '0')}`)

/** Turbo Pascal's 6-byte real: an 8-bit exponent then a 39-bit mantissa and the sign. */
function tpReal(b: Uint8Array): number {
  const exp = b[0]
  if (exp === 0) return 0
  const sign = b[5] & 0x80 ? -1 : 1
  let m = 0
  for (let i = 5; i >= 1; i--) m = m * 256 + (i === 5 ? (b[i] & 0x7f) | 0x80 : b[i])
  return sign * m * Math.pow(2, exp - 129 - 39)
}

/** A value's text from its bytes, by type; strings and small arrays spelled out. */
export async function format(tds: Tds, typeIndex: number, bytes: Uint8Array, m: Machine, depth = 0): Promise<string> {
  const t = tds.types[typeIndex - 1]
  if (!t) return bytes.length ? [...bytes].map((x) => x.toString(16).padStart(2, '0')).join(' ') : '?'
  switch (t.id) {
    case TypeId.SChar: case TypeId.PChar: return bytes.length ? `${i16(Uint8Array.from([bytes[0], bytes[0] & 0x80 ? 0xff : 0]))} '${chr(bytes[0])}'` : '?'
    case TypeId.UChar: return bytes.length ? `${bytes[0]} '${chr(bytes[0])}'` : '?'
    case TypeId.SInt: return bytes.length >= 2 ? String(i16(bytes)) : '?'
    case TypeId.UInt: case TypeId.Seg: return bytes.length >= 2 ? String(u16(bytes)) : '?'
    case TypeId.SLong: return bytes.length >= 4 ? String(i32(bytes)) : '?'
    case TypeId.ULong: return bytes.length >= 4 ? String(u32(bytes)) : '?'
    case TypeId.Bool: return bytes.length ? (bytes[0] ? 'true' : 'false') : '?'
    case TypeId.WordBool: return bytes.length >= 2 ? (u16(bytes) ? 'true' : 'false') : '?'
    case TypeId.LongBool: return bytes.length >= 4 ? (u32(bytes) ? 'true' : 'false') : '?'
    case TypeId.Float: return bytes.length >= 4 ? String(new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true)) : '?'
    case TypeId.Double: return bytes.length >= 8 ? String(new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)) : '?'
    case TypeId.TPReal: return bytes.length >= 6 ? String(Number(tpReal(bytes).toPrecision(11))) : '?'
    case TypeId.Enum: return bytes.length >= 2 ? String(u16(bytes)) : bytes.length ? String(bytes[0]) : '?'
    case TypeId.PStr: {
      const n = Math.min(bytes[0] ?? 0, bytes.length - 1)
      return `'${Array.from(bytes.subarray(1, 1 + n), chr).join('')}'`
    }
    case TypeId.Array: {
      const el = tds.types[t.member - 1]
      if (!el) return '[…]'
      if (el.id === TypeId.SChar || el.id === TypeId.UChar || el.id === TypeId.PChar) {
        const end = bytes.indexOf(0)
        return `"${Array.from(bytes.subarray(0, end < 0 ? bytes.length : end), chr).join('')}"`
      }
      if (!el.size || depth > 1) return '[…]'
      const n = Math.min(Math.floor(bytes.length / el.size), 16)
      const items: string[] = []
      for (let i = 0; i < n; i++) items.push(await format(tds, t.member, bytes.subarray(i * el.size, (i + 1) * el.size), m, depth + 1))
      return `[${items.join(', ')}${bytes.length / el.size > n ? ', …' : ''}]`
    }
    case TypeId.Near: case TypeId.NRef: {
      if (bytes.length < 2) return '?'
      const off = u16(bytes)
      const target = tds.types[t.member - 1]
      if (off && target && (target.id === TypeId.SChar || target.id === TypeId.UChar || target.id === TypeId.PChar) && depth < 2) {
        try { const s = await m.read(parseInt(m.regs.segments.ds, 16) & 0xffff, off, 40); const end = s.indexOf(0); return `${h4(off)} → "${Array.from(s.subarray(0, end < 0 ? 40 : end), chr).join('')}"` } catch { /* unreadable */ }
      }
      if (off && target && target.size && target.size <= 8 && depth < 2) {
        try { const v = await m.read(parseInt(m.regs.segments.ds, 16) & 0xffff, off, target.size); return `${h4(off)} → ${await format(tds, t.member, v, m, depth + 1)}` } catch { /* unreadable */ }
      }
      return off ? h4(off) : 'null'
    }
    case TypeId.Far: case TypeId.FRef: {
      if (bytes.length < 4) return '?'
      const off = u16(bytes), seg = u16(bytes, 2)
      const target = tds.types[t.member - 1]
      if ((seg || off) && target && (target.id === TypeId.SChar || target.id === TypeId.UChar || target.id === TypeId.PChar) && depth < 2) {
        try { const s = await m.read(seg, off, 40); const end = s.indexOf(0); return `${h4(seg)}:${h4(off)} → "${Array.from(s.subarray(0, end < 0 ? 40 : end), chr).join('')}"` } catch { /* unreadable */ }
      }
      if ((seg || off) && target && target.size && target.size <= 8 && depth < 2) {
        try { const v = await m.read(seg, off, target.size); return `${h4(seg)}:${h4(off)} → ${await format(tds, t.member, v, m, depth + 1)}` } catch { /* unreadable */ }
      }
      return seg || off ? `${h4(seg)}:${h4(off)}` : 'nil'
    }
    case TypeId.Struct: case TypeId.Union: case TypeId.Object: {
      // Members from the first one on, until the next type's first member; byte-packed (Turbo C's and Pascal's default).
      if (depth > 1) return '{…}'
      const first = t.member
      const next = Math.min(...tds.types.filter((x) => (x.id === TypeId.Struct || x.id === TypeId.Union || x.id === TypeId.Object) && x.member > first).map((x) => x.member), tds.members.length + 1)
      const parts: string[] = []
      let off = 0
      for (let i = first; i < next && parts.length < 12; i++) {
        const mem = tds.members[i - 1]
        if (!mem) break
        const mt = tds.types[mem.type - 1]
        const size = mt?.size ?? 0
        parts.push(`${mem.name}: ${await format(tds, mem.type, bytes.subarray(off, off + size), m, depth + 1)}`)
        if (t.id !== TypeId.Union) off += size
      }
      return `{${parts.join(', ')}}`
    }
    default:
      return bytes.length <= 4 ? [...bytes].reverse().map((x) => x.toString(16).padStart(2, '0')).join('') : `${bytes.length} bytes`
  }
}

export interface StackFrame {
  fn: string | null
  /** CS-relative address: IP for the innermost frame, the return address for the others. */
  ip: number
  bp: number
}

/**
 * The call stack from the BP chain (near calls: [BP] is the caller's BP,
 * [BP+2] the return address), innermost first, as far as the return
 * addresses stay in the program's own code.
 */
export async function callStack(tds: Tds, m: Machine, ip: number, bp: number, max = 8): Promise<StackFrame[]> {
  const frames: StackFrame[] = [{ fn: frameAt(tds, ip).fn, ip, bp }]
  const ss = parseInt(m.regs.segments.ss, 16) & 0xffff
  let cur = bp
  for (let i = 0; i < max; i++) {
    if (cur === 0 || cur > 0xfffb) break
    let link: Uint8Array
    try { link = await m.read(ss, cur, 4) } catch { break }
    const savedBp = u16(link), ret = u16(link, 2)
    const f = frameAt(tds, ret)
    if (!f.fn) break
    frames.push({ fn: f.fn, ip: ret, bp: savedBp })
    if (savedBp <= cur) break
    cur = savedBp
  }
  return frames
}

/** Reads and prints a frame's locals and the globals; `previous` marks what changed since. */
export async function readValues(tds: Tds, symbols: TdsSymbol[], m: Machine, bp: number, previous?: Map<string, string>): Promise<VarValue[]> {
  const out: VarValue[] = []
  // One read for the whole BP window the locals live in.
  const auto = symbols.filter((s) => s.cls === SymbolClass.Auto || s.cls === SymbolClass.PascalVar)
  let lo = 0, hi = 0
  for (const s of auto) {
    const off = s.offset > 0x7fff ? s.offset - 0x10000 : s.offset
    const size = s.cls === SymbolClass.PascalVar ? 4 : (tds.types[s.type - 1]?.size ?? 2)
    lo = Math.min(lo, off); hi = Math.max(hi, off + size)
  }
  const ss = parseInt(m.regs.segments.ss, 16) & 0xffff
  let window: Uint8Array | null = null
  if (auto.length) { try { window = await m.read(ss, (bp + lo) & 0xffff, hi - lo) } catch { window = null } }
  for (const s of symbols) {
    const t = tds.types[s.type - 1]
    const size = t?.size ?? 2
    const off = s.offset > 0x7fff ? s.offset - 0x10000 : s.offset
    let value = '?', where = ''
    try {
      if (s.cls === SymbolClass.Register) {
        const reg = REG16[s.offset & 7]
        const v = parseInt(m.regs.general[reg] ?? '0', 16) & 0xffff
        const bytes = Uint8Array.from([v & 0xff, v >> 8, 0, 0]).subarray(0, Math.max(1, Math.min(size, 2)))
        value = await format(tds, s.type, bytes, m)
        where = reg.slice(1).toUpperCase()
      } else if (s.cls === SymbolClass.Auto && window) {
        value = await format(tds, s.type, window.subarray(off - lo, off - lo + size), m)
        where = `[BP${off >= 0 ? '+' : ''}${off}]`
      } else if (s.cls === SymbolClass.PascalVar && window) {
        const p = window.subarray(off - lo, off - lo + 4)
        const poff = u16(p), pseg = u16(p, 2)
        value = await format(tds, s.type, await m.read(pseg, poff, size), m)
        where = `var → ${h4(pseg)}:${h4(poff)}`
      } else if (s.cls === SymbolClass.Static) {
        const seg = (m.entryCs + s.seg) & 0xffff
        value = await format(tds, s.type, await m.read(seg, s.offset, size), m)
        where = `${h4(seg)}:${h4(s.offset)}`
      }
    } catch (err) {
      value = `? (${err instanceof Error ? err.message : String(err)})`
    }
    const name = s.name.replace(/^_/, '')
    out.push({ name, type: typeName(tds, s.type), value, where, changed: previous !== undefined && previous.has(name) && previous.get(name) !== value })
  }
  return out
}
