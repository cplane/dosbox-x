/**
 * A MASM listing (ML /Fl) maps code offsets to source lines. Each listing
 * line for code or data starts with the offset (4 hex digits), then the
 * bytes, then the source text from a fixed column:
 *
 *	 0100  B8 1234			mov ax,1234h
 *
 * There are no line numbers, so the source text is matched against the
 * editor's lines in order (the listing follows the source; macro expansions
 * and includes add lines that simply don't match and are skipped).
 */

export interface LineMap {
  /** code offset -> 1-based source line */
  lineOf: Map<number, number>
  /** 1-based source line -> code offset (the first instruction on it) */
  offsetOf: Map<number, number>
  /** How far past a line's start an address still belongs to it (a listing: one instruction; a map: until the next line). */
  span?: number
  /** Addresses from here on are not this source's (the runtime, the libraries). */
  end?: number
}

// " 0100  B8 1234<tabs>text", " 0110  BA 011A R<tabs>text" (R: relocatable, between bytes too: "C6 06 0126 R 03"), " 011A 48 65 6C<tabs>text" (data).
// Byte tokens are 2-4 hex digits a single space apart; at least two spaces (a tab) separate them from the text.
const CODE_LINE = /^ ([0-9A-F]{4})\s+((?:[0-9A-F]{2,4}(?: R)? )*[0-9A-F]{2,4})(?: R)?\s{2,}(.*)$/

export function parseListing(listing: string, source: string): LineMap {
  const src = source.split(/\r?\n/).map((l) => l.trim())
  const lineOf = new Map<number, number>()
  const offsetOf = new Map<number, number>()
  let next = 0 // where the next match may start in the source
  for (const raw of listing.split(/\r?\n/)) {
    const m = CODE_LINE.exec(raw.replace(/\t/g, '        '))
    if (!m) continue
    const text = m[3].trim()
    if (!text) continue
    // Find this text in the source, at or after the last match.
    let found = -1
    for (let i = next; i < src.length && i < next + 200; i++) {
      if (src[i] === text) { found = i; break }
    }
    if (found < 0) continue
    next = found + 1
    const offset = parseInt(m[1], 16)
    if (!lineOf.has(offset)) lineOf.set(offset, found + 1)
    if (!offsetOf.has(found + 1)) offsetOf.set(found + 1, offset)
  }
  return { lineOf, offsetOf }
}

/** The source line for an IP: exact, or the last instruction that starts before it (IP inside a multi-byte instruction). */
export function lineForOffset(map: LineMap, ip: number): number | null {
  const exact = map.lineOf.get(ip)
  if (exact) return exact
  // The line whose code starts last before ip: within a few bytes for a listing (one
  // instruction per line), anywhere before the next line's start for a link map.
  const span = map.span ?? 6
  if (map.end !== undefined && ip >= map.end) return null
  let best = -1
  for (const off of map.lineOf.keys()) if (off < ip && off > best && ip - off <= span) best = off
  return best >= 0 ? map.lineOf.get(best) ?? null : null
}

/**
 * The line numbers in a Turbo C / TLINK map (the compiler's -y, the linker's
 * map), for the one source file: "Line numbers for x.obj(x.c) segment _TEXT"
 * then "   13 0000:02B3" pairs. Segment 0000 is the load segment, which is
 * CS at the program's entry, so the offsets are CS-relative as a listing's.
 */
export function parseMap(map: string, sourceName: string): LineMap {
  const lineOf = new Map<number, number>()
  const offsetOf = new Map<number, number>()
  const want = sourceName.toLowerCase()
  let inSection = false
  let lastOff = 0
  for (const raw of map.split(/\r?\n/)) {
    const head = /^Line numbers for \S+\((.+?)\) segment (\S+)/.exec(raw)
    if (head) { inSection = head[1].toLowerCase() === want && head[2] === '_TEXT'; continue }
    if (/^(Program entry point|  Address|\s*$)/.test(raw)) { if (/^Program entry point/.test(raw)) inSection = false; if (!inSection) continue }
    if (!inSection) continue
    for (const m of raw.matchAll(/(\d+)\s+([0-9A-F]{4}):([0-9A-F]{4})/g)) {
      if (m[2] !== '0000') continue
      const line = Number(m[1]), off = parseInt(m[3], 16)
      if (!lineOf.has(off)) lineOf.set(off, line)
      if (!offsetOf.has(line)) offsetOf.set(line, off)
      if (off > lastOff) lastOff = off
    }
  }
  return { lineOf, offsetOf, span: 0x10000, end: lastOff + 32 }
}
