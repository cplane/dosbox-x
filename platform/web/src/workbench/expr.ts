import { format, typeName, type Machine, type VarValue } from './symbols'
import { SymbolClass, TypeId, type Tds, type TdsSymbol } from './tds'

/**
 * Watch expressions. A variable with any of `.field`, `->field`, `[index]` (`[i, j]` is `[i][j]`), a trailing
 * `^` (Pascal) or a leading `*` (C) to follow pointers, where an index may itself be an expression (`a[i + 1]`);
 * and integer or real arithmetic over such values: `+ - * /`, `div`, `mod` (or `%`), parentheses. Names are the
 * chosen frame's variables, then those of the procedures it is nested in (Pascal), then the program's globals.
 */

export interface Scope {
  locals: TdsSymbol[]
  bp: number
  /** A Pascal nested procedure's enclosing procedures, innermost first, each with its frame. */
  enclosing: { locals: TdsSymbol[]; bp: number }[]
}

type Access = { k: 'field'; name: string; arrow: boolean } | { k: 'index'; at: Node } | { k: 'deref' }
type Node =
  | { k: 'num'; v: number }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'var'; derefs: number; name: string; ops: Access[] }

class ParseError extends Error {}

function parse(src: string): Node {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  const peek = (s: string) => { ws(); return src.startsWith(s, i) }
  const word = (w: string) => { ws(); const m = new RegExp(`^${w}\\b`, 'i').exec(src.slice(i)); return m ? m[0] : null }
  const eat = (s: string) => { if (!peek(s)) throw new ParseError(`expected "${s}" at "${src.slice(i) || 'the end'}"`); i += s.length }
  const name = () => { ws(); const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); if (!m) throw new ParseError(`expected a name at "${src.slice(i) || 'the end'}"`); i += m[0].length; return m[0] }

  const expr = (): Node => {
    let a = term()
    for (;;) {
      if (peek('+')) { i++; a = { k: 'bin', op: '+', a, b: term() } }
      else if (peek('-') && !peek('->')) { i++; a = { k: 'bin', op: '-', a, b: term() } }
      else return a
    }
  }
  const term = (): Node => {
    let a = factor()
    for (;;) {
      let op: string | null = null
      if (peek('*')) { i++; op = '*' }
      else if (peek('/')) { i++; op = '/' }
      else if (peek('%')) { i++; op = 'mod' }
      else { const w = word('div') ?? word('mod'); if (w) { i += w.length; op = w.toLowerCase() } }
      if (!op) return a
      a = { k: 'bin', op, a, b: factor() }
    }
  }
  const factor = (): Node => {
    ws()
    if (peek('(')) { i++; const e = expr(); eat(')'); return e }
    if (peek('-')) { i++; return { k: 'neg', a: factor() } }
    const num = /^(\$[0-9a-f]+|0x[0-9a-f]+|[0-9a-f]+h\b|\d+(\.\d+)?)/i.exec(src.slice(i))
    if (num) {
      i += num[0].length
      const t = num[0]
      const v = t.startsWith('$') ? parseInt(t.slice(1), 16) : /^0x/i.test(t) ? parseInt(t.slice(2), 16) : /h$/i.test(t) ? parseInt(t.slice(0, -1), 16) : parseFloat(t)
      return { k: 'num', v }
    }
    let derefs = 0
    while (peek('*')) { i++; derefs++ }
    const n = name()
    const ops: Access[] = []
    for (;;) {
      if (peek('->')) { i += 2; ops.push({ k: 'field', name: name(), arrow: true }) }
      else if (peek('.')) { i++; ops.push({ k: 'field', name: name(), arrow: false }) }
      else if (peek('^')) { i++; ops.push({ k: 'deref' }) }
      else if (peek('[')) {
        i++
        ops.push({ k: 'index', at: expr() })
        while (peek(',')) { i++; ops.push({ k: 'index', at: expr() }) }
        eat(']')
      } else break
    }
    return { k: 'var', derefs, name: n, ops }
  }

  const root = expr()
  ws()
  if (i < src.length) throw new ParseError(`cannot read "${src.slice(i)}"`)
  return root
}

class EvalError extends Error {}

const h4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')
const u16 = (b: Uint8Array, o = 0) => b[o] | (b[o + 1] << 8)
const REG16 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']

/** Where a value is: in memory, or held in a register. */
type Ref = { type: number; place: { seg: number; off: number } } | { type: number; reg: { name: string; value: number } }

/** The byte-packed members of a struct, union or object type, with their offsets. */
export function membersOf(tds: Tds, t: Tds['types'][number]): { name: string; type: number; off: number }[] {
  const first = t.member
  const next = Math.min(...tds.types.filter((x) => (x.id === TypeId.Struct || x.id === TypeId.Union || x.id === TypeId.Object) && x.member > first).map((x) => x.member), tds.members.length + 1)
  const out: { name: string; type: number; off: number }[] = []
  let off = 0
  for (let i = first; i < next; i++) {
    const mem = tds.members[i - 1]
    if (!mem) break
    if (t.id !== TypeId.Union && t.size && off >= t.size) break // the next type's members start here
    out.push({ name: mem.name, type: mem.type, off })
    if (t.id !== TypeId.Union) off += tds.types[mem.type - 1]?.size ?? 0
  }
  return out
}

/** A value's number when its type is a number (integers, chars, booleans, enums, reals). */
function numberOf(tds: Tds, type: number, b: Uint8Array): number | null {
  const t = tds.types[type - 1]
  if (!t) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  switch (t.id) {
    case TypeId.SChar: return b.length >= 1 ? dv.getInt8(0) : null
    case TypeId.UChar: case TypeId.PChar: case TypeId.Bool: return b.length >= 1 ? b[0] : null
    case TypeId.SInt: return b.length >= 2 ? dv.getInt16(0, true) : null
    case TypeId.UInt: case TypeId.Seg: case TypeId.WordBool: return b.length >= 2 ? dv.getUint16(0, true) : null
    case TypeId.SLong: return b.length >= 4 ? dv.getInt32(0, true) : null
    case TypeId.ULong: case TypeId.LongBool: return b.length >= 4 ? dv.getUint32(0, true) : null
    case TypeId.Enum: case TypeId.PEnum: return t.size === 1 ? b[0] : b.length >= 2 ? dv.getUint16(0, true) : null
    case TypeId.Float: return b.length >= 4 ? dv.getFloat32(0, true) : null
    case TypeId.Double: return b.length >= 8 ? dv.getFloat64(0, true) : null
    case TypeId.TPReal: {
      if (b.length < 6 || b[0] === 0) return 0
      let mant = 0
      for (let k = 5; k >= 1; k--) mant = mant * 256 + (k === 5 ? (b[k] & 0x7f) | 0x80 : b[k])
      return (b[5] & 0x80 ? -1 : 1) * mant * Math.pow(2, b[0] - 129 - 39)
    }
    default: return null
  }
}

export async function evaluate(tds: Tds, m: Machine, scope: Scope, expr: string): Promise<VarValue> {
  const out = (type: string, value: string, where = ''): VarValue => ({ name: expr, type, value, where, changed: false })
  let root: Node
  try { root = parse(expr.trim()) } catch (err) { return out('', `? (${err instanceof Error ? err.message : String(err)})`) }

  const ss = parseInt(m.regs.segments.ss, 16) & 0xffff
  const ds = parseInt(m.regs.segments.ds, 16) & 0xffff

  const lookup = (name: string): { sym: TdsSymbol; bp: number } => {
    const lc = name.toLowerCase()
    const named = (x: TdsSymbol) => x.name.toLowerCase() === lc || x.name.replace(/^_/, '').toLowerCase() === lc
    const own = scope.locals.find(named)
    if (own) return { sym: own, bp: scope.bp }
    for (const level of scope.enclosing) {
      const found = level.locals.find((x) => x.cls !== SymbolClass.Register && named(x))
      if (found) return { sym: found, bp: level.bp }
    }
    const global = tds.symbols.find((x) => x.cls === SymbolClass.Static && x.seg !== 0 && named(x) && tds.types[x.type - 1]?.id !== TypeId.Function)
    if (global) return { sym: global, bp: scope.bp }
    throw new EvalError(`no variable ${name} here`)
  }

  const read = async (ref: Ref): Promise<Uint8Array> => {
    const size = Math.max(1, Math.min(tds.types[ref.type - 1]?.size ?? 2, 256))
    if ('reg' in ref) return Uint8Array.from([ref.reg.value & 0xff, (ref.reg.value >> 8) & 0xff]).subarray(0, Math.min(size, 2))
    return m.read(ref.place.seg, ref.place.off, size)
  }

  const deref = async (ref: Ref): Promise<Ref> => {
    const t = tds.types[ref.type - 1]
    if (!t) throw new EvalError('unknown type')
    if (t.id === TypeId.Near || t.id === TypeId.NRef) {
      const off = 'reg' in ref ? ref.reg.value : u16(await m.read(ref.place.seg, ref.place.off, 2))
      if (!off) throw new EvalError('null pointer')
      return { type: t.member, place: { seg: ds, off } }
    }
    if (t.id === TypeId.Far || t.id === TypeId.FRef) {
      if ('reg' in ref) throw new EvalError('a far pointer in a register')
      const b = await m.read(ref.place.seg, ref.place.off, 4)
      if (!u16(b) && !u16(b, 2)) throw new EvalError('nil pointer')
      return { type: t.member, place: { seg: u16(b, 2), off: u16(b) } }
    }
    throw new EvalError(`${typeName(tds, ref.type)} is not a pointer`)
  }

  const resolve = async (node: Extract<Node, { k: 'var' }>): Promise<Ref> => {
    const { sym, bp } = lookup(node.name)
    const off = sym.offset > 0x7fff ? sym.offset - 0x10000 : sym.offset
    let ref: Ref
    if (sym.cls === SymbolClass.Register) {
      const reg = REG16[sym.offset & 7]
      ref = { type: sym.type, reg: { name: reg.slice(1).toUpperCase(), value: parseInt(m.regs.general[reg] ?? '0', 16) & 0xffff } }
    } else if (sym.cls === SymbolClass.Auto) {
      ref = { type: sym.type, place: { seg: ss, off: (bp + off) & 0xffff } }
    } else if (sym.cls === SymbolClass.PascalVar) {
      const p = await m.read(ss, (bp + off) & 0xffff, 4)
      ref = { type: sym.type, place: { seg: u16(p, 2), off: u16(p) } }
    } else if (sym.cls === SymbolClass.Static) {
      ref = { type: sym.type, place: { seg: (m.entryCs + sym.seg) & 0xffff, off: sym.offset } }
    } else throw new EvalError(`${node.name} is not a variable`)

    for (const op of node.ops) {
      if (op.k === 'deref') { ref = await deref(ref); continue }
      if (op.k === 'field') {
        if (op.arrow) ref = await deref(ref)
        const t = tds.types[ref.type - 1]
        if (!t || (t.id !== TypeId.Struct && t.id !== TypeId.Union && t.id !== TypeId.Object)) throw new EvalError(`${typeName(tds, ref.type)} has no fields`)
        if ('reg' in ref) throw new EvalError(`${node.name} lives in ${ref.reg.name}: no fields to follow`)
        const mem = membersOf(tds, t).find((x) => x.name.toLowerCase() === op.name.toLowerCase())
        if (!mem) throw new EvalError(`no field ${op.name} in ${typeName(tds, ref.type)}`)
        ref = { type: mem.type, place: { seg: ref.place.seg, off: (ref.place.off + mem.off) & 0xffff } }
        continue
      }
      // [index]: through a pointer first (C's p[i]), then into the array.
      const index = Math.trunc(await num(op.at))
      let t = tds.types[ref.type - 1]
      if (t && (t.id === TypeId.Near || t.id === TypeId.NRef || t.id === TypeId.Far || t.id === TypeId.FRef)) {
        const target = await deref(ref)
        const tt = tds.types[target.type - 1]
        if (tt && (tt.id === TypeId.Array || tt.id === TypeId.PArray)) ref = target
        else {
          // A pointer to an element (C's char *s; s[i]): step by the element's size.
          if ('reg' in target) throw new EvalError('?')
          ref = { type: target.type, place: { seg: target.place.seg, off: (target.place.off + index * (tt?.size || 1)) & 0xffff } }
          continue
        }
        t = tds.types[ref.type - 1]
      }
      if (!t || (t.id !== TypeId.Array && t.id !== TypeId.PArray)) throw new EvalError(`${typeName(tds, ref.type)} is not an array`)
      if ('reg' in ref) throw new EvalError('an array in a register')
      const el = tds.types[t.member - 1]
      if (!el || !el.size) throw new EvalError('unknown element size')
      // Pascal arrays start at their low bound (array[1..3]: [1] is the first element); C's at 0.
      const low = t.id === TypeId.PArray ? t.low ?? 0 : 0
      const count = Math.floor(t.size / el.size)
      if (index - low < 0 || index - low >= count) throw new EvalError(`index ${index} is outside ${typeName(tds, ref.type)}`)
      ref = { type: t.member, place: { seg: ref.place.seg, off: (ref.place.off + (index - low) * el.size) & 0xffff } }
    }
    for (let k = 0; k < node.derefs; k++) ref = await deref(ref)
    return ref
  }

  const num = async (node: Node): Promise<number> => {
    switch (node.k) {
      case 'num': return node.v
      case 'neg': return -(await num(node.a))
      case 'var': {
        const ref = await resolve(node)
        const v = numberOf(tds, ref.type, await read(ref))
        if (v === null) throw new EvalError(`${node.name} (${typeName(tds, ref.type)}) is not a number`)
        return v
      }
      case 'bin': {
        const a = await num(node.a), b = await num(node.b)
        switch (node.op) {
          case '+': return a + b
          case '-': return a - b
          case '*': return a * b
          case '/': if (b === 0) throw new EvalError('division by zero'); return a / b
          case 'div': if (b === 0) throw new EvalError('division by zero'); return Math.trunc(a / b)
          case 'mod': if (b === 0) throw new EvalError('division by zero'); return a % b
        }
        throw new EvalError(`unknown operator ${node.op}`)
      }
    }
  }

  try {
    if (root.k === 'var') {
      const ref = await resolve(root)
      const bytes = await read(ref)
      return out(typeName(tds, ref.type), await format(tds, ref.type, bytes, m), 'reg' in ref ? ref.reg.name : `${h4(ref.place.seg)}:${h4(ref.place.off)}`)
    }
    const v = await num(root)
    return out(Number.isInteger(v) ? 'integer' : 'real', Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(11))))
  } catch (err) {
    return out('', `? (${err instanceof Error ? err.message : String(err)})`)
  }
}
