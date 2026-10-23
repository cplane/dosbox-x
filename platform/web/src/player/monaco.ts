import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

/**
 * Monaco, bundled (no CDN), with what the workbench edits: MASM-style x86
 * assembly (our own tokenizer), C/C++ and Pascal (Monaco's), batch files,
 * and a theme in the colours of the Borland IDEs.
 */

self.MonacoEnvironment = { getWorker: () => new editorWorker() }
loader.config({ monaco })

const registers = [
  'al', 'ah', 'ax', 'eax', 'bl', 'bh', 'bx', 'ebx', 'cl', 'ch', 'cx', 'ecx', 'dl', 'dh', 'dx', 'edx',
  'si', 'esi', 'di', 'edi', 'bp', 'ebp', 'sp', 'esp', 'ip', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs',
  'cr0', 'cr2', 'cr3', 'st',
]

const directives = [
  '.model', '.code', '.data', '.data?', '.stack', '.const', '.startup', '.exit', '.8086', '.186', '.286', '.286p',
  '.386', '.386p', '.486', '.486p', '.586', '.8087', '.287', '.387', '.radix', '.list', '.nolist', '.xlist',
  'org', 'end', 'proc', 'endp', 'segment', 'ends', 'assume', 'group', 'db', 'dw', 'dd', 'dq', 'dt', 'df',
  'equ', 'public', 'extrn', 'extern', 'externdef', 'include', 'includelib', 'macro', 'endm', 'exitm', 'local',
  'offset', 'seg', 'ptr', 'byte', 'word', 'dword', 'qword', 'tbyte', 'near', 'far', 'short', 'dup', 'length',
  'size', 'type', 'sizeof', 'lengthof', 'this', 'label', 'struc', 'struct', 'union', 'record', 'typedef',
  'if', 'ife', 'ifdef', 'ifndef', 'ifb', 'ifnb', 'else', 'elseif', 'endif', 'rept', 'irp', 'irpc', 'while',
  'invoke', 'proto', 'uses', 'name', 'title', 'subttl', 'page', 'comment', 'echo', 'even', 'align',
  '.if', '.else', '.elseif', '.endif', '.while', '.endw', '.repeat', '.until', '.break', '.continue',
  'mask', 'width', 'low', 'high', 'lowword', 'highword', 'not', 'and', 'or', 'xor', 'shl', 'shr', 'mod',
  'eq', 'ne', 'lt', 'le', 'gt', 'ge',
]

const instructions = [
  'mov', 'movzx', 'movsx', 'xchg', 'lea', 'lds', 'les', 'lfs', 'lgs', 'lss', 'push', 'pop', 'pusha', 'popa',
  'pushad', 'popad', 'pushf', 'popf', 'pushfd', 'popfd', 'add', 'adc', 'sub', 'sbb', 'inc', 'dec', 'neg',
  'cmp', 'mul', 'imul', 'div', 'idiv', 'cbw', 'cwd', 'cwde', 'cdq', 'aaa', 'aad', 'aam', 'aas', 'daa', 'das',
  'and', 'or', 'xor', 'not', 'test', 'shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd',
  'bt', 'bts', 'btr', 'btc', 'bsf', 'bsr', 'jmp', 'call', 'ret', 'retn', 'retf', 'iret', 'iretd', 'int',
  'into', 'enter', 'leave', 'bound', 'loop', 'loope', 'loopz', 'loopne', 'loopnz', 'jcxz', 'jecxz',
  'ja', 'jae', 'jb', 'jbe', 'jc', 'jnc', 'je', 'jz', 'jne', 'jnz', 'jg', 'jge', 'jl', 'jle', 'jo', 'jno',
  'js', 'jns', 'jp', 'jpe', 'jnp', 'jpo', 'jna', 'jnae', 'jnb', 'jnbe', 'jng', 'jnge', 'jnl', 'jnle',
  'seta', 'setae', 'setb', 'setbe', 'setc', 'sete', 'setg', 'setge', 'setl', 'setle', 'setne', 'setnz',
  'setz', 'seto', 'sets', 'setp', 'setnc', 'setno', 'setns', 'setnp', 'cmc', 'clc', 'stc', 'cld', 'std',
  'cli', 'sti', 'nop', 'hlt', 'wait', 'lock', 'in', 'out', 'ins', 'insb', 'insw', 'outs', 'outsb', 'outsw',
  'movs', 'movsb', 'movsw', 'movsd', 'cmps', 'cmpsb', 'cmpsw', 'cmpsd', 'scas', 'scasb', 'scasw', 'scasd',
  'lods', 'lodsb', 'lodsw', 'lodsd', 'stos', 'stosb', 'stosw', 'stosd', 'rep', 'repe', 'repz', 'repne',
  'repnz', 'xlat', 'xlatb', 'lahf', 'sahf', 'cpuid', 'rdtsc', 'lgdt', 'sgdt', 'lidt', 'sidt', 'lmsw', 'smsw',
  'fld', 'fst', 'fstp', 'fadd', 'fsub', 'fmul', 'fdiv', 'fild', 'fist', 'fistp', 'finit', 'fninit', 'fwait',
  'fcom', 'fcomp', 'fstsw', 'fnstsw', 'fldz', 'fld1', 'fchs', 'fabs', 'fsqrt',
]

monaco.languages.register({ id: 'masm', extensions: ['.asm', '.inc'] })
monaco.languages.setLanguageConfiguration('masm', {
  comments: { lineComment: ';' },
  brackets: [['[', ']'], ['(', ')']],
})
monaco.languages.setMonarchTokensProvider('masm', {
  ignoreCase: true,
  registers,
  directives,
  instructions,
  tokenizer: {
    root: [
      [/;.*$/, 'comment'],
      [/^\s*[a-z_@$?.][\w@$?.]*:/, 'type.identifier'],
      [/"/, 'string', '@dstring'],
      [/'/, 'string', '@sstring'],
      [/\b[0-9][0-9a-f]*h\b/, 'number.hex'],
      [/\b[01]+b\b/, 'number.binary'],
      [/\b[0-7]+[oq]\b/, 'number.octal'],
      [/\b\d+d?\b/, 'number'],
      [/\.?[a-z_@$?][\w@$?]*/, {
        cases: { '@registers': 'variable', '@directives': 'keyword.directive', '@instructions': 'keyword', '@default': 'identifier' },
      }],
      [/[\[\]()]/, '@brackets'],
      [/[,:+\-*/]/, 'delimiter'],
    ],
    dstring: [[/[^"]+/, 'string'], [/"/, 'string', '@pop']],
    sstring: [[/[^']+/, 'string'], [/'/, 'string', '@pop']],
  },
})

// The Borland IDE palette on the VGA blue.
monaco.editor.defineTheme('dos', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'ffff55' },
    { token: 'comment', foreground: 'aaaaaa' },
    { token: 'keyword', foreground: 'ffffff', fontStyle: 'bold' },
    { token: 'keyword.directive', foreground: '55ffff' },
    { token: 'variable', foreground: 'ff55ff' },
    { token: 'type.identifier', foreground: '55ff55' },
    { token: 'identifier', foreground: 'ffff55' },
    { token: 'number', foreground: '55ff55' },
    { token: 'string', foreground: '55ffff' },
    { token: 'delimiter', foreground: 'ffffff' },
    { token: 'type', foreground: '55ffff' },
  ],
  colors: {
    'editor.background': '#0000aa',
    'editor.foreground': '#ffff55',
    'editor.lineHighlightBackground': '#0000c8',
    'editor.selectionBackground': '#aaaaaa',
    'editor.selectionForeground': '#000000',
    'editorCursor.foreground': '#ffff55',
    'editorLineNumber.foreground': '#55ffff',
    'editorLineNumber.activeForeground': '#ffffff',
    'editorIndentGuide.background': '#0000c8',
    'editorWhitespace.foreground': '#0000ff',
    'editorGutter.background': '#0000aa',
    'scrollbarSlider.background': '#aaaaaa80',
    'minimap.background': '#000080',
  },
})

/** The Monaco language for a DOS file name. */
export function languageFor(name: string): string {
  const ext = name.toLowerCase().replace(/^.*\./, '')
  switch (ext) {
    case 'asm': case 'inc': return 'masm'
    case 'c': case 'h': case 'cpp': case 'hpp': return 'cpp'
    case 'pas': return 'pascal'
    case 'bas': case 'bi': return 'vb' // Monaco's Visual Basic: close enough to QuickBASIC's keywords
    case 'bat': return 'bat'
    case 'mak': return 'makefile'
    case 'ini': case 'cfg': return 'ini'
    default: return 'plaintext'
  }
}

export { monaco }

// The workbench's look: paper. Warm light background, brown ink, few
// colours, nothing shouting.
monaco.editor.defineTheme('paper', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '35342f' },
    { token: 'comment', foreground: '9c9a92', fontStyle: 'italic' },
    { token: 'keyword', foreground: '5f5a4e' },
    { token: 'keyword.directive', foreground: '6e685a' },
    { token: 'variable', foreground: '5a5a7e' },
    { token: 'type.identifier', foreground: '577143' },
    { token: 'identifier', foreground: '35342f' },
    { token: 'number', foreground: '8a6f2e' },
    { token: 'string', foreground: '577143' },
    { token: 'delimiter', foreground: '6e685a' },
    { token: 'type', foreground: '5a5a7e' },
  ],
  colors: {
    'editor.background': '#fcfcfa',
    'editor.foreground': '#35342f',
    'editor.lineHighlightBackground': '#f3f2ee',
    'editor.selectionBackground': '#e2e0d8',
    'editorCursor.foreground': '#35342f',
    'editorLineNumber.foreground': '#b4b2aa',
    'editorLineNumber.activeForeground': '#7b7972',
    'editorIndentGuide.background': '#e8e7e2',
    'editorWhitespace.foreground': '#e8e7e2',
    'editorGutter.background': '#fcfcfa',
    'editorRuler.foreground': '#ecebe6',
    'scrollbarSlider.background': '#d6d5cf80',
    'minimap.background': '#f6f5f1',
  },
})

// The 8086 guide in the editor, as in the Machine view and the guide's snippets: hovering a mnemonic shows the
// instruction and its short description with a link to its article; Ctrl+click opens the article. An INT line names
// the function too: AH (or AX) is taken from the nearest MOV AH/AX/AL above it in the same block.
import { INTERRUPTS, h2 as inth2, lookupInt } from '../workbench/interrupts'
import { findInterrupt } from '../workbench/articles'
import { opsIn, openArticleRef, refFor } from '../workbench/asmref'

monaco.editor.registerCommand('dosbox.article', (_accessor, key: string) => openArticleRef(key))
const articleLink = (key: string, text: string) => `[${text}](command:dosbox.article?${encodeURIComponent(JSON.stringify([key]))} "Open in the guide")`

/** The INT on a line and the function the lines above load into AH / AX (null when they don't say). */
function intAt(model: monaco.editor.ITextModel, lineNumber: number): { int: number; value: number | null } | null {
  const m = /^\s*(?:[A-Za-z_@$?][\w@$?]*:)?\s*INT\s+([0-9A-Fa-f]+)h?\b/i.exec(model.getLineContent(lineNumber))
  if (!m) return null
  let ah: number | null = null, al = 0, ax: number | null = null
  for (let l = lineNumber - 1; l >= Math.max(1, lineNumber - 25); l--) {
    const t = model.getLineContent(l)
    if (/^\s*(RET|JMP|END\b)/i.test(t) || /^[A-Za-z_@$?][\w@$?]*:\s*$/.test(t.trim())) break
    let r: RegExpExecArray | null
    if (ax === null && ah === null && (r = /^\s*MOV\s+AX\s*,\s*([0-9A-Fa-f]+)h?\b/i.exec(t))) { ax = parseInt(r[1], 16); break }
    if (ah === null && (r = /^\s*MOV\s+AH\s*,\s*([0-9A-Fa-f]+)h?\b/i.exec(t))) ah = parseInt(r[1], 16)
    if (al === 0 && (r = /^\s*MOV\s+AL\s*,\s*([0-9A-Fa-f]+)h?\b/i.exec(t))) al = parseInt(r[1], 16)
  }
  return { int: parseInt(m[1], 16), value: ax !== null ? ax : ah !== null ? (ah << 8) | al : null }
}

/** The guide article for what is at a position: the mnemonic's; for INT, the service's (or the vector's). */
export function articleAt(model: monaco.editor.ITextModel, position: monaco.IPosition): string | null {
  const op = opsIn(model.getLineContent(position.lineNumber)).find((o) => position.column - 1 >= o.start && position.column - 1 <= o.end)
  if (!op) return null
  if (/^INT$/i.test(op.word)) {
    const call = intAt(model, position.lineNumber)
    const a = call && findInterrupt(call.int, call.value ?? 0)
    if (a && (call.value !== null || !a.fns?.length)) return a.key
  }
  return refFor(op.word)?.key ?? null
}

monaco.languages.registerHoverProvider('masm', {
  provideHover(model, position) {
    const lines: string[] = []
    const op = opsIn(model.getLineContent(position.lineNumber)).find((o) => position.column - 1 >= o.start && position.column - 1 <= o.end)
    const a = op && refFor(op.word)
    if (a) lines.push(`**${a.title}** · ${a.tagline}`, a.short)
    const call = intAt(model, position.lineNumber)
    if (call) {
      const { int, value } = call
      const vec = INTERRUPTS.find((v) => v.int === int)
      lines.push(`**INT ${inth2(int)}**${vec ? ` · ${vec.title}` : ''}`)
      if (vec && value !== null) {
        const hit = lookupInt(int, value)
        if (hit?.fn) {
          const f = hit.fn
          lines.push(`${f.ax ? 'AX' : 'AH'}=${(f.ax ? value : value >> 8).toString(16).toUpperCase().padStart(f.ax ? 4 : 2, '0')}h — **${f.name}**`)
          if (f.in) lines.push(`in: ${f.in}`)
          if (f.out) lines.push(`out: ${f.out}`)
          if (f.note) lines.push(`_${f.note}_`)
        } else lines.push(`AH=${(value >> 8).toString(16).toUpperCase().padStart(2, '0')}h — not in the reference`)
      } else if (vec) {
        lines.push(vec.note ?? '', ...vec.fns.slice(0, 12).map((f) => `${f.ax ? 'AX' : 'AH'}=${f.fn.toString(16).toUpperCase().padStart(f.ax ? 4 : 2, '0')}h ${f.name}`))
        if (vec.fns.length > 12) lines.push(`… ${vec.fns.length - 12} more in the guide's Interrupts chapter`)
      }
    }
    if (!lines.length) return null
    const key = articleAt(model, position) ?? (call ? findInterrupt(call.int, call.value ?? 0)?.key ?? null : a?.key ?? null)
    if (key) lines.push(`${articleLink(key, 'Open the article')} · Ctrl+click the ${call && !a ? 'INT' : 'mnemonic'}`)
    return {
      range: op ? new monaco.Range(position.lineNumber, op.start + 1, position.lineNumber, op.end + 1) : undefined,
      contents: lines.filter(Boolean).map((value) => ({ value, isTrusted: { enabledCommands: ['dosbox.article'] } })),
    }
  },
})
