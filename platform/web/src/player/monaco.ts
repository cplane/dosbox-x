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
    { token: '', foreground: '3a3226' },
    { token: 'comment', foreground: '9a8c70', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7a4a1f' },
    { token: 'keyword.directive', foreground: '6b5a3e' },
    { token: 'variable', foreground: '5a4a8a' },
    { token: 'type.identifier', foreground: '4f6b2f' },
    { token: 'identifier', foreground: '3a3226' },
    { token: 'number', foreground: '8a5a00' },
    { token: 'string', foreground: '4f6b2f' },
    { token: 'delimiter', foreground: '6b5a3e' },
    { token: 'type', foreground: '5a4a8a' },
  ],
  colors: {
    'editor.background': '#f7f1e3',
    'editor.foreground': '#3a3226',
    'editor.lineHighlightBackground': '#efe6d2',
    'editor.selectionBackground': '#e3d4ad',
    'editorCursor.foreground': '#3a3226',
    'editorLineNumber.foreground': '#b9ad93',
    'editorLineNumber.activeForeground': '#7a6a4f',
    'editorIndentGuide.background': '#e6dcc6',
    'editorWhitespace.foreground': '#e6dcc6',
    'editorGutter.background': '#f7f1e3',
    'editorRuler.foreground': '#eadfc7',
    'scrollbarSlider.background': '#d8ccb080',
    'minimap.background': '#f3ecdb',
  },
})
