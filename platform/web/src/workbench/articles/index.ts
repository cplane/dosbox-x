import type { Article } from './types'
import { DATA } from './data'
import { ARITHMETIC } from './arith'
import { LOGIC } from './logic'
import { CONTROL } from './control'
import { STRINGS } from './strings'

export type { Article, Block } from './types'

/** Every article: the 8086's instructions and the topics around them. */
export const ARTICLES: Article[] = [...DATA, ...ARITHMETIC, ...LOGIC, ...CONTROL, ...STRINGS]

/** The index's sections, in order. */
export const GROUPS = [
  'Data transfer', 'Arithmetic', 'Logic and bits', 'Control flow', 'Stack and procedures', 'Strings',
  'Processor control', 'Addresses and data', 'Registers and flags',
]

const byName = new Map<string, Article>()
for (const a of ARTICLES) {
  byName.set(a.key.toUpperCase(), a)
  for (const n of a.aka ?? []) if (!byName.has(n.toUpperCase())) byName.set(n.toUpperCase(), a)
}

/** The article for a key or another name ("JZ" finds JE), case aside. */
export function findArticle(name: string): Article | undefined {
  return byName.get(name.trim().toUpperCase())
}
