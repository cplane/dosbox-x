/**
 * The 8086 guide's articles: one per instruction (aliases together: JE / JZ) or topic (addressing, registers,
 * directives), shown in the workbench's article tab. A header (the name and a few words), the short description
 * the guide's index has always shown, then the article itself: paragraphs, small headings and code snippets in
 * whatever order explains the instruction best.
 *
 * The interrupts chapter uses the same shape: an article per service (a vector and its function number, a few
 * close relatives together) or per vector (what it is for, how its services are called), with what goes in and
 * what comes back in place of the flags.
 */

/** One piece of an article's body. */
export type Block =
  /** A paragraph. `code` spans are written between backquotes in the text: `MOV AX, BX`. */
  | { p: string }
  /** A small heading inside the article ("Forms", "Flags", "Pitfalls"). */
  | { h: string }
  /** A code snippet with a copy button. `run`: the lines are a complete example for the .COM skeleton (code after
   *  START:, then the skeleton's exit, then `data`), and get an "open in editor" button too. */
  | { code: string[]; run?: boolean; data?: string[]; note?: string }
  /** A small table: a header row, then rows (forms and their meaning, flag effects, condition codes). */
  | { table: string[][] }

export interface Article {
  /** Stable key, the main mnemonic or the topic: "MOV", "JE", "ADDRESSING"; for an interrupt "int21-09" (vector, then
   *  the function in AH as two hex digits, in AX as four for INT 33h), "int21" for a vector's own article. */
  key: string
  /** As the header shows it: "MOV", "JE / JZ", "Addressing modes". */
  title: string
  /** Other names that find this article in the index ("JZ" for JE). */
  aka?: string[]
  /** A few words under the title: "copy data". */
  tagline: string
  /** The index section it is listed under. */
  group: string
  /** Syntax forms, one per line: "MOV reg, reg/mem", "MOV mem, imm"... */
  syntax: string[]
  /** Flags affected, as the guide writes them: "OF SF ZF AF PF CF", "none". */
  flags?: string
  /** An interrupt service: its vector and the function numbers it covers (AH, or AX for INT 33h); none for a
   *  vector's own article. */
  int?: number
  fns?: number[]
  /** An interrupt service: what goes in (registers, memory) and what comes back. */
  in?: string
  out?: string
  /** The short description: one or two sentences (the guide's index line). */
  short: string
  /** The article. */
  body: Block[]
  /** Keys of related articles. */
  see?: string[]
}
