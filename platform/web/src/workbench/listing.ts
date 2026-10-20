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
}

// " 0100  B8 1234<tabs>text", " 0110  BA 011A R<tabs>text" (R: relocatable), " 011A 48 65 6C<tabs>text" (data).
// Byte tokens are 2-4 hex digits a single space apart; at least two spaces (a tab) separate them from the text.
const CODE_LINE = /^ ([0-9A-F]{4})\s+((?:[0-9A-F]{2,4} )*[0-9A-F]{2,4})(?: R)?\s{2,}(.*)$/

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
  let best = -1
  for (const off of map.lineOf.keys()) if (off < ip && off > best && ip - off <= 6) best = off
  return best >= 0 ? map.lineOf.get(best) ?? null : null
}
