import type { Article } from './types'
import { DATA } from './data'
import { ARITHMETIC } from './arith'
import { LOGIC } from './logic'
import { CONTROL } from './control'
import { STRINGS } from './strings'
import { DOS_CONSOLE } from './int21con'
import { DOS_FILES } from './int21file'
import { DOS_PROCESS } from './int21proc'
import { VIDEO } from './int10'
import { BIOS } from './bios'

export type { Article, Block } from './types'

/** Every article: the 8086's instructions and the topics around them, then the interrupts. */
export const ARTICLES: Article[] = [...DATA, ...ARITHMETIC, ...LOGIC, ...CONTROL, ...STRINGS, ...DOS_CONSOLE, ...DOS_FILES, ...DOS_PROCESS, ...VIDEO, ...BIOS]

/** The index's sections, in order. */
export const GROUPS = [
  'Data transfer', 'Arithmetic', 'Logic and bits', 'Control flow', 'Stack and procedures', 'Strings',
  'Processor control', 'Addresses and data', 'Registers and flags',
]

/** The interrupts chapter's sections, in order. */
export const INT_GROUPS = [
  'DOS · console', 'DOS · files', 'DOS · disks and directories', 'DOS · memory and programs', 'DOS · system',
  'BIOS · video', 'BIOS · keyboard', 'Mouse driver', 'BIOS · time, disks, system', 'Hardware interrupts',
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

/** The article for an interrupt call: the service for AH (or AX: INT 33h), else the vector's own article. */
export function findInterrupt(int: number, ax: number): Article | undefined {
  const ah = (ax >> 8) & 0xff
  const forInt = ARTICLES.filter((a) => a.int === int)
  return forInt.find((a) => a.fns?.includes(int === 0x33 ? ax & 0xffff : ah)) ?? forInt.find((a) => !a.fns?.length)
}

/** `INT 21h`, `INT 21h AH=09h`, `INT 33h AX=0003h` written in a text: its article. */
export function findInterruptText(text: string): Article | undefined {
  const m = /^INT\s+([0-9A-F]{1,2})h(?:[\s,/]+(?:A[HX]\s*=\s*)?([0-9A-F]{2,4})h)?$/i.exec(text.trim())
  if (!m) return undefined
  const int = parseInt(m[1], 16)
  if (!m[2]) return ARTICLES.find((a) => a.int === int && !a.fns?.length)
  const fn = parseInt(m[2], 16)
  // Four digits are all of AX (INT 21h AX=4C00h, any INT 33h function); two are AH.
  return findInterrupt(int, int === 0x33 || m[2].length > 2 ? fn : fn << 8)
}
