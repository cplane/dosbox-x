import { walkName, type Walk } from './walks'

// The walks shipped with the guide, each loaded when its stepper first opens.
const files = import.meta.glob<Walk>('./walks/*.json', { import: 'default' })

/** The walk for an article's snippet, when there is one (and it was made from this text). */
export function hasWalk(key: string, block: number): boolean {
  return `./walks/${walkName(key, block)}.json` in files
}
export async function loadWalk(key: string, block: number, src: string): Promise<Walk | null> {
  const f = files[`./walks/${walkName(key, block)}.json`]
  if (!f) return null
  const w = await f()
  return w.src === src ? w : null
}
