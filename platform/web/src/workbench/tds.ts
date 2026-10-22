import type { LineMap } from './listing'

/**
 * Borland Turbo Debugger symbols (TDS 2.x / 3.x) as Turbo C (-v) and Turbo
 * Pascal (-V) append them to an EXE: names, symbols (functions, globals,
 * locals with their BP offsets or registers), scopes (which symbols belong
 * to which stretch of code), segments, line numbers and types. The block
 * starts right after the load image with the word 0x52FB.
 */

export interface TdsSymbol {
  /** 1-based index, as scopes refer to it. */
  index: number
  name: string
  type: number
  offset: number
  /** Load-relative paragraph of the segment (0: the entry code segment). */
  seg: number
  cls: SymbolClass
}

export enum SymbolClass { Static = 0, Absolute = 1, Auto = 2, PascalVar = 3, Register = 4, Constant = 5, Typedef = 6, Tag = 7 }

export interface TdsScope {
  /** 1-based first symbol and how many. */
  symIndex: number
  symCount: number
  parent: number
  /** The function symbol (1-based) this scope belongs to; 0xffff / 0 when none. */
  fn: number
  offset: number
  length: number
}

export interface TdsSegment { module: number; seg: number; offset: number; length: number; scopeIndex: number; scopeCount: number }

export interface TdsType {
  index: number
  id: TypeId
  name: string
  size: number
  cls: number
  /** The element type (arrays), the target (pointers), the return type (functions), the first member (structs). */
  member: number
  /** A Pascal array's index bounds (array[low..high]), from its index type. */
  low?: number
  high?: number
}

export interface TdsMember { info: number; name: string; type: number }

export enum TypeId {
  Void = 0, LStr = 1, DStr = 2, PStr = 3, SChar = 4, SInt = 5, SLong = 6, UChar = 8, UInt = 9, ULong = 10, PChar = 12,
  Float = 13, TPReal = 14, Double = 15, LDouble = 16, Near = 21, Far = 22, Seg = 23, Array = 26, PArray = 28,
  Struct = 30, Union = 31, Enum = 34, Function = 35, Label = 36, Set = 37, TFile = 38, BFile = 39, Bool = 40,
  PEnum = 41, FuncPrototype = 44, SpecialFunc = 45, Object = 46, NRef = 52, FRef = 53, WordBool = 54, LongBool = 55,
}

export interface Tds {
  version: string
  symbols: TdsSymbol[]
  scopes: TdsScope[]
  segments: TdsSegment[]
  lines: { line: number; offset: number }[]
  /** Which line records belong to which segment and source file. */
  correlations: { segment: number; file: number; lineIndex: number; lineCount: number }[]
  types: TdsType[]
  members: TdsMember[]
  modules: { name: string }[]
  sources: string[]
}

/** The symbol block of a DOS EXE, or null when it has none. */
export function parseTds(exe: Uint8Array): Tds | null {
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength)
  const u16 = (o: number) => dv.getUint16(o, true)
  const u32 = (o: number) => dv.getUint32(o, true)
  if (exe.length < 64 || exe[0] !== 0x4d || exe[1] !== 0x5a) return null
  const cblp = u16(2), cp = u16(4)
  const base = (cp - 1) * 512 + (cblp || 512)
  if (base + 48 > exe.length || u16(base) !== 0x52fb) return null
  const version = `${exe[base + 3]}.${exe[base + 2].toString(16).padStart(2, '0')}`
  const namesPool = u32(base + 4)
  const c = {} as Record<'names' | 'types' | 'members' | 'symbols' | 'globals' | 'modules' | 'locals' | 'scopes' | 'lines' | 'sources' | 'segments' | 'correlations', number>
  const keys = ['names', 'types', 'members', 'symbols', 'globals', 'modules', 'locals', 'scopes', 'lines', 'sources', 'segments', 'correlations'] as const
  keys.forEach((k, i) => { c[k] = u16(base + 8 + i * 2) })
  const extension = u16(base + 8 + 24 + 14)

  // Names: C strings at the very end of the file, index 1 first.
  const names: string[] = ['']
  let p = exe.length - namesPool
  while (p < exe.length && names.length <= c.names) {
    let e = p
    while (e < exe.length && exe[e] !== 0) e++
    names.push(String.fromCharCode(...exe.subarray(p, e)))
    p = e + 1
  }
  const name = (i: number) => names[i] ?? ''

  p = base + 48 + extension
  const symbols: TdsSymbol[] = []
  for (let i = 0; i < c.symbols; i++, p += 9) {
    symbols.push({ index: i + 1, name: name(u16(p)), type: u16(p + 2), offset: u16(p + 4), seg: u16(p + 6), cls: (exe[p + 8] & 7) as SymbolClass })
  }
  const modules: { name: string }[] = []
  for (let i = 0; i < c.modules; i++, p += 16) modules.push({ name: name(u16(p)) })
  const sources: string[] = []
  for (let i = 0; i < c.sources; i++, p += 6) sources.push(name(u16(p)))
  const lines: { line: number; offset: number }[] = []
  for (let i = 0; i < c.lines; i++, p += 4) lines.push({ line: u16(p), offset: u16(p + 2) })
  const scopes: TdsScope[] = []
  for (let i = 0; i < c.scopes; i++, p += 12) {
    scopes.push({ symIndex: u16(p), symCount: u16(p + 2), parent: u16(p + 4), fn: u16(p + 6), offset: u16(p + 8), length: u16(p + 10) })
  }
  const segments: TdsSegment[] = []
  for (let i = 0; i < c.segments; i++, p += 16) {
    segments.push({ module: u16(p), seg: u16(p + 2), offset: u16(p + 4), length: u16(p + 6), scopeIndex: u16(p + 8), scopeCount: u16(p + 10) })
  }
  const correlations: Tds['correlations'] = []
  for (let i = 0; i < c.correlations; i++, p += 8) {
    correlations.push({ segment: u16(p), file: u16(p + 2), lineIndex: u16(p + 4), lineCount: u16(p + 6) })
  }
  const types: TdsType[] = []
  const typesAt = p
  for (let i = 0; i < c.types; i++, p += 8) {
    types.push({ index: i + 1, id: exe[p] as TypeId, name: name(u16(p + 1)), size: u16(p + 3), cls: exe[p + 5], member: u16(p + 6) })
  }
  // A Pascal array's record is followed by one more holding its index type; a subrange's record is followed by
  // one holding the bounds, two 32-bit numbers (array[5..7]: 05 00 00 00 07 00 00 00).
  const rec = (index: number) => typesAt + (index - 1) * 8
  for (const t of types) {
    if (t.id !== TypeId.PArray || t.index >= types.length) continue
    const indexType = u16(rec(t.index + 1))
    if (indexType < 1 || indexType >= types.length) continue
    const b = rec(indexType + 1)
    const low = dv.getInt32(b, true), high = dv.getInt32(b + 4, true)
    if (high >= low && high - low < 0x10000) { t.low = low; t.high = high }
  }
  const members: TdsMember[] = []
  for (let i = 0; i < c.members; i++, p += 5) members.push({ info: exe[p], name: name(u16(p + 1)), type: u16(p + 3) })
  return { version, symbols, scopes, segments, lines, correlations, types, members, modules, sources }
}

/**
 * Source line -> code offset for the entry code segment (load-relative
 * paragraph 0: the program's own code, CS at the entry), as a listing map:
 * a line's code runs until the next line's start.
 */
export function lineMapFromTds(tds: Tds): LineMap {
  const lineOf = new Map<number, number>()
  const offsetOf = new Map<number, number>()
  let last = 0
  // Only the line records correlated with a segment that is the entry segment.
  const entrySegments = new Set(tds.segments.map((s, i) => (s.seg === 0 ? i + 1 : 0)).filter(Boolean))
  const wanted = tds.correlations.length
    ? tds.correlations.filter((c) => entrySegments.has(c.segment)).flatMap((c) => tds.lines.slice(c.lineIndex - 1, c.lineIndex - 1 + c.lineCount))
    : tds.lines
  for (const { line, offset } of wanted) {
    if (!lineOf.has(offset)) lineOf.set(offset, line)
    if (!offsetOf.has(line)) offsetOf.set(line, offset)
    if (offset > last) last = offset
  }
  return { lineOf, offsetOf, span: 0x10000, end: last + 32 }
}
