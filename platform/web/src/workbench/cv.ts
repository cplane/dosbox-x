import { SymbolClass, TypeId, type Tds, type TdsMember, type TdsScope, type TdsSymbol, type TdsType } from './tds'

/**
 * Microsoft CodeView symbols (NB00-NB02: CodeView 3, as LINK /CO appends them to a DOS EXE) for a program built by
 * the BASIC compiler (BC /Zi): its procedures with their parameters and locals, the module's variables, its types
 * and line numbers, turned into the model the Turbo Debugger symbols use, so the panels, the call stack and the
 * watches work on BASIC as they do on C and Pascal.
 *
 * Segments here are relative to the source's code segment (as a TDS's are to the entry's): the code at 0, the data
 * segment (DGROUP) at `dataSeg`, and the entry CS `entryParagraph` paragraphs on (BASIC's entry is in its runtime).
 */

const SST = { modules: 0x101, types: 0x103, symbols: 0x104, srcLines: 0x105, srcLnSeg: 0x109 } as const

/** CodeView's primitive types (below 0x200) that BASIC uses, with BASIC's names. */
const PRIMITIVE: Record<number, [TypeId, number, string]> = {
  0x80: [TypeId.SChar, 1, 'BYTE'], 0x81: [TypeId.SInt, 2, 'INTEGER'], 0x82: [TypeId.SLong, 4, 'LONG'],
  0x84: [TypeId.UChar, 1, 'BYTE'], 0x85: [TypeId.UInt, 2, 'WORD'], 0x86: [TypeId.ULong, 4, 'DWORD'],
  0x88: [TypeId.Float, 4, 'SINGLE'], 0x89: [TypeId.Double, 8, 'DOUBLE'], 0x8a: [TypeId.LDouble, 10, 'TEMPREAL'],
  0x97: [TypeId.BStr, 4, 'STRING'], 0x99: [TypeId.Currency, 8, 'CURRENCY'],
}

/** BASIC's spellings of the names in a source (BC upper-cases them): "TOTAL&" is the source's "Total". */
function spellings(source: string): (name: string) => string {
  const code = source.replace(/"[^"\r\n]*"?/g, ' ').replace(/(^|\s|:)(REM\b|')[^\r\n]*/gi, ' ')
  const exact = new Map<string, string>(), bare = new Map<string, string>()
  for (const w of code.match(/[A-Za-z][A-Za-z0-9.]*[%&!#$@]?/g) ?? []) {
    const up = w.toUpperCase()
    if (!exact.has(up)) exact.set(up, w)
    const base = w.replace(/[%&!#$@]$/, '')
    if (!bare.has(base.toUpperCase())) bare.set(base.toUpperCase(), base)
  }
  return (name: string) => exact.get(name.toUpperCase()) ?? bare.get(name.replace(/[%&!#$@]$/, '').toUpperCase()) ?? name
}

/** The CodeView symbols of a DOS EXE built from `fileName`, or null when it has none. */
export function parseCodeView(exe: Uint8Array, fileName: string, source = ''): Tds | null {
  if (exe.length < 64 || exe[0] !== 0x4d || exe[1] !== 0x5a) return null
  const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength)
  const u8 = (o: number) => exe[o]
  const u16 = (o: number) => dv.getUint16(o, true)
  const i16 = (o: number) => dv.getInt16(o, true)
  const u32 = (o: number) => dv.getUint32(o, true)
  const sig = (o: number) => String.fromCharCode(...exe.subarray(o, o + 4))
  const str = (o: number) => String.fromCharCode(...exe.subarray(o + 1, o + 1 + u8(o)))

  if (!/^NB0[0-2]$/.test(sig(exe.length - 8))) return null
  const base = exe.length - u32(exe.length - 4)
  if (base < 0 || base + 8 > exe.length || !/^NB0[0-2]$/.test(sig(base))) return null
  // The directory: a count, then 10-byte entries (subsection, module, offset from the base, length).
  const at = base + u32(base + 4)
  if (at + 2 > exe.length) return null
  const dir: { sst: number; mod: number; at: number; cb: number }[] = []
  for (let i = 0, e = at + 2; i < u16(at) && e + 10 <= exe.length; i++, e += 10) {
    dir.push({ sst: u16(e), mod: u16(e + 2), at: base + u32(e + 4), cb: u16(e + 8) })
  }
  const section = (sst: number, mod: number) => dir.find((d) => d.sst === sst && d.mod === mod)

  // The module whose line numbers are the file's (the program's own; the runtime's library modules have none).
  const want = fileName.toUpperCase().replace(/^.*[\\/]/, '')
  type Line = { line: number; offset: number }
  let mod = 0, file = '', codeSeg = 0, lines: Line[] = []
  for (const d of dir) {
    if (d.sst !== SST.srcLnSeg && d.sst !== SST.srcLines) continue
    for (let q = d.at; q < d.at + d.cb;) {
      const name = str(q); q += 1 + u8(q)
      let seg = 0
      if (d.sst === SST.srcLnSeg) { seg = u16(q); q += 2 } else { const m = section(SST.modules, d.mod); seg = m ? u16(m.at) : 0 }
      const count = u16(q); q += 2
      const found: Line[] = []
      for (let k = 0; k < count; k++, q += 4) found.push({ line: u16(q), offset: u16(q + 2) })
      const named = name.toUpperCase().replace(/^.*[\\/]/, '')
      if (!mod || (named === want && file.toUpperCase().replace(/^.*[\\/]/, '') !== want)) { mod = d.mod; file = name; codeSeg = seg; lines = found }
      else if (d.mod === mod && name === file && seg === codeSeg) lines.push(...found)
    }
  }
  if (!mod) return null
  const pretty = spellings(source)
  // A symbol's name as the source spells it, and the type suffix BC gave it (TOTAL& is the source's Total, a LONG).
  const named = (raw: string) => ({ name: pretty(raw), suffix: /[%&!#$@]$/.exec(raw)?.[0] })

  // Types: records from index 0x200, each a run of leaves.
  const records = new Map<number, number[]>() // index -> [start, end] of its leaves
  const typesAt = section(SST.types, mod)
  if (typesAt) {
    let index = 0x200
    for (let q = typesAt.at; q + 3 <= typesAt.at + typesAt.cb; index++) {
      const len = u16(q + 1)
      records.set(index, [q + 3, q + 3 + len])
      q += 3 + len
    }
  }
  // Leaf readers over a record: an index (0x83), a name (0x82), a number (below 0x80, or 0x85/0x86/0x88-0x8a).
  const reader = (start: number, end: number) => {
    let q = start
    return {
      more: () => q < end,
      peek: () => u8(q),
      byte: () => u8(q++),
      index: () => { if (u8(q) !== 0x83) return 0; const v = u16(q + 1); q += 3; return v },
      name: () => { if (u8(q) !== 0x82) return ''; const s = str(q + 1); q += 2 + u8(q + 1); return s },
      num: () => {
        const b = u8(q++)
        if (b < 0x80) return b
        switch (b) {
          case 0x85: { const v = u16(q); q += 2; return v }
          case 0x86: { const v = u32(q); q += 4; return v }
          case 0x88: { const v = dv.getInt8(q); q += 1; return v }
          case 0x89: { const v = i16(q); q += 2; return v }
          case 0x8a: { const v = dv.getInt32(q, true); q += 4; return v }
          default: return 0
        }
      },
      skip: () => { const b = u8(q); if (b === 0x83) q += 3; else if (b === 0x82) q += 2 + u8(q + 1); else if (b === 0x85 || b === 0x89) q += 3; else if (b === 0x86 || b === 0x8a) q += 5; else q += 1 },
    }
  }

  const types: TdsType[] = []
  const members: TdsMember[] = []
  const done = new Map<number, number>()
  const add = (t: Omit<TdsType, 'index'>) => { types.push({ ...t, index: types.length + 1 }); return types.length }
  // A CodeView type index -> the index of its TdsType (made on first use).
  const tid = (cv: number, depth = 0): number => {
    const known = done.get(cv)
    if (known) return known
    if (depth > 12) return add({ id: TypeId.Void, name: '?', size: 0, cls: 0, member: 0 })
    let made: number
    if (cv < 0x200) {
      const prim = PRIMITIVE[cv & ~0x60]
      const mode = cv & 0x60
      if (prim && mode) made = add({ id: mode === 0x20 ? TypeId.Near : TypeId.Far, name: '', size: mode === 0x20 ? 2 : 4, cls: 0, member: tid(cv & ~0x60, depth + 1) })
      else if (prim) made = add({ id: prim[0], name: prim[2], size: prim[1], cls: 0, member: 0 })
      else made = add({ id: TypeId.Void, name: cv === 0x80 ? 'BYTE' : '?', size: 0, cls: 0, member: 0 })
      done.set(cv, made)
      return made
    }
    const range = records.get(cv)
    if (!range) { made = add({ id: TypeId.Void, name: '?', size: 0, cls: 0, member: 0 }); done.set(cv, made); return made }
    const r = reader(range[0], range[1])
    const leaf = r.more() ? r.byte() : 0x80
    switch (leaf) {
      case 0x79: { // a structure (BASIC's TYPE): size in bits, field count, the field types and the names with offsets
        const bits = r.num(); r.num()
        const typeList = r.index(), nameList = r.index()
        const name = pretty(r.name())
        const fieldTypes: number[] = [], fieldNames: string[] = []
        const tl = records.get(typeList)
        if (tl) { const lr = reader(tl[0], tl[1]); if (lr.byte() === 0x7f) while (lr.more()) { const ix = lr.index(); if (!ix && lr.more()) { lr.skip(); continue } fieldTypes.push(ix) } }
        const nl = records.get(nameList)
        if (nl) { const lr = reader(nl[0], nl[1]); if (lr.byte() === 0x7f) while (lr.more()) { if (lr.peek() !== 0x82) { lr.skip(); continue } fieldNames.push(lr.name()); if (lr.more()) lr.num() } }
        // The fields' own types first, so this structure's members are one run (as the TDS model needs).
        made = add({ id: TypeId.Struct, name, size: Math.ceil(bits / 8), cls: 0, member: 0 })
        done.set(cv, made)
        const fieldTids = fieldTypes.map((t) => tid(t, depth + 1))
        types[made - 1].member = members.length + 1
        fieldTids.forEach((t, k) => members.push({ info: 0, name: pretty(fieldNames[k] ?? `field${k + 1}`), type: t }))
        return made
      }
      case 0x7a: { // a pointer: its model (0x74 near, 0x73 far, 0x5e huge), then what it points to
        const model = r.byte()
        made = add({ id: model === 0x74 ? TypeId.Near : TypeId.Far, name: '', size: model === 0x74 ? 2 : 4, cls: 0, member: 0 })
        done.set(cv, made)
        types[made - 1].member = tid(r.index(), depth + 1)
        return made
      }
      case 0x76: { // a parameter's reference: the pointer it wraps
        made = tid(r.index(), depth + 1)
        done.set(cv, made)
        return made
      }
      case 0x75: { // a procedure: (nil), its return type
        if (r.peek() === 0x80) r.byte()
        made = add({ id: TypeId.Function, name: '', size: 0, cls: 0, member: 0 })
        done.set(cv, made)
        types[made - 1].member = tid(r.index() || 0x80, depth + 1)
        return made
      }
      case 0x8c: { // a BASIC array: through a descriptor (data pointer, dimensions, element size, bounds)
        made = add({ id: TypeId.BArray, name: '', size: 0x0e + 4 * 8, cls: 0, member: 0 })
        done.set(cv, made)
        types[made - 1].member = tid(r.index(), depth + 1)
        return made
      }
      case 0x8d: { // STRING * n
        r.byte()
        const n = r.num()
        made = add({ id: TypeId.FStr, name: `STRING * ${n}`, size: n, cls: 0, member: 0 })
        break
      }
      case 0x78: { // a fixed array: its size in bits, then the element type
        const bits = r.num()
        made = add({ id: TypeId.Array, name: '', size: Math.ceil(bits / 8), cls: 0, member: 0 })
        done.set(cv, made)
        types[made - 1].member = tid(r.index(), depth + 1)
        return made
      }
      default:
        made = add({ id: TypeId.Void, name: '?', size: 0, cls: 0, member: 0 })
    }
    done.set(cv, made)
    return made
  }

  // Symbols: blocks (the module's own, around everything), procedures with their parameters and locals, statics.
  interface Building { scope: Omit<TdsScope, 'symIndex' | 'symCount'>; syms: TdsSymbol[] }
  const scopes: Building[] = []
  const procs: TdsSymbol[] = []
  let farFrames = false
  let dataSeg: number | undefined
  const symsAt = section(SST.symbols, mod)
  if (symsAt) {
    const stack: number[] = [] // open scopes (indexes into `scopes`, 1-based)
    const open = (offset: number, length: number, fn: number) => {
      scopes.push({ scope: { parent: stack[stack.length - 1] ?? 0, fn, offset, length }, syms: [] })
      stack.push(scopes.length)
    }
    const here = () => scopes[(stack[stack.length - 1] ?? 0) - 1]
    for (let q = symsAt.at; q < symsAt.at + symsAt.cb;) {
      const len = u8(q)
      if (!len) break
      const kind = u8(q + 1), d = q + 2
      q += 1 + len
      switch (kind) {
        case 0x00: open(u16(d), u16(d + 2), 0); break // a block
        case 0x01: { // a procedure: offset, type, length, debug start/end, reserved, near (0) / far (4), name
          const far = u8(d + 12) === 4
          if (far) farFrames = true
          procs.push({ index: procs.length + 1, ...named(str(d + 13)), type: tid(u16(d + 2)), offset: u16(d), seg: 0, cls: SymbolClass.Static })
          open(u16(d), u16(d + 4), procs.length)
          break
        }
        case 0x02: stack.pop(); break
        case 0x04: { // BP-relative: a parameter (by near reference unless BYVAL) or a local
          const cvType = u16(d + 2)
          const range = records.get(cvType)
          const isRef = !!range && u8(range[0]) === 0x76
          let type = tid(cvType)
          if (isRef) type = types[type - 1]?.member || type
          here()?.syms.push({ index: 0, ...named(str(d + 4)), type, offset: u16(d), seg: 0, cls: isRef ? SymbolClass.NearVar : SymbolClass.Auto })
          break
        }
        case 0x05: { // static data: offset, segment, type
          const seg = (u16(d + 2) - codeSeg) & 0xffff
          if (dataSeg === undefined) dataSeg = seg
          const owner = here()
          owner?.syms.push({ index: 0, ...named(str(d + 6)), type: tid(u16(d + 4)), offset: u16(d), seg, cls: SymbolClass.Static, local: owner.scope.fn !== 0 || undefined })
          break
        }
        case 0x0d: { // a register variable (8 = AX ... 15 = DI)
          here()?.syms.push({ index: 0, ...named(str(d + 3)), type: tid(u16(d)), offset: (u8(d + 2) - 8) & 7, seg: 0, cls: SymbolClass.Register })
          break
        }
        default: break // labels, constants, typedefs and the like
      }
    }
  }
  // One array of symbols: the procedures first (scopes name them by index), then each scope's own in a run.
  const symbols: TdsSymbol[] = [...procs]
  const tdsScopes: TdsScope[] = scopes.map(({ scope, syms }) => {
    const symIndex = symbols.length + 1
    for (const s of syms) symbols.push({ ...s, index: symbols.length + 1 })
    return { ...scope, symIndex, symCount: syms.length }
  })

  const headerCs = u16(0x16)
  return {
    version: `CodeView ${sig(base)}`,
    symbols, scopes: tdsScopes,
    segments: [{ module: 1, seg: 0, offset: 0, length: 0xffff, scopeIndex: 1, scopeCount: tdsScopes.length }],
    lines, correlations: [], types, members,
    modules: [{ name: file }], sources: [file],
    language: /\.BAS$/i.test(file) ? 'basic' : undefined,
    farFrames, entryParagraph: (headerCs - codeSeg) & 0xffff, dataSeg,
  }
}
