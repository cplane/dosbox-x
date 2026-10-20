/**
 * The 8086 guide shown in the workbench: instructions grouped by what you
 * reach for first, one line each (syntax, what it does, the flags it
 * touches) with a small example that runs as is inside the .COM skeleton
 * ("open in editor" writes it as a file), then the registers, the
 * addressing modes and ready programs. The interrupt functions have their
 * own reference (interrupts.ts).
 */

export interface Entry {
  /** Mnemonic(s) as written, e.g. "MOV" or "JE / JZ". */
  m: string
  /** Syntax. */
  s: string
  /** What it does, in one or two sentences. */
  d: string
  /** Flags affected, if any. */
  f?: string
  /** Example lines (code after START:, before the exit). */
  ex?: string[]
  /** Data lines the example needs (after the exit). */
  data?: string[]
}

export interface Section {
  title: string
  note?: string
  entries: Entry[]
}

export interface Program {
  name: string
  file: string
  what: string
  code: string
}

/** The .COM skeleton an example is dropped into; `END` marks where. */
export function wrapExample(mnemonic: string, ex: string[], data: string[] = []): string {
  const body = ex.map((l) => (l.endsWith(':') || /^[A-Z_][A-Z0-9_]*:/i.test(l) ? l : '        ' + l))
  const dat = data.map((l) => (/^[A-Z_][A-Z0-9_]*\s/i.test(l) ? l : '        ' + l))
  return [
    `; ${mnemonic} — from the 8086 guide. Build & Run, or Debug and step with F7.`,
    '        .MODEL  TINY',
    '        .CODE',
    '        ORG     100h',
    'START:',
    ...body,
    '        MOV     AX, 4C00h       ; exit to DOS',
    '        INT     21h',
    ...dat,
    '        END     START',
    '',
  ].join('\r\n')
}

/** A file name for an example: 8.3, from the mnemonic. */
export function exampleFile(mnemonic: string): string {
  const base = mnemonic.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)
  return `EX_${base || 'ASM'}.ASM`
}

const PRINT = ['MOV     AH, 09h          ; DOS: print the string at DS:DX', 'MOV     DX, OFFSET MSG', 'INT     21h']
const MSG = (s: string) => [`MSG     DB      '${s}', 13, 10, '$'`]
/** Print AL as a decimal digit (0-9): the smallest "see a number" helper. */
const DIGIT = ['ADD     AL, "0"          ; digit -> character', 'MOV     DL, AL', 'MOV     AH, 02h          ; DOS: print DL', 'INT     21h']

export const GUIDE: Section[] = [
  {
    title: 'Start here',
    note: 'The dozen instructions almost every program is made of. Each example is a complete program when opened in the editor.',
    entries: [
      { m: 'MOV', s: 'MOV dst, src', d: 'Copy src into dst (register, memory or immediate). Not memory to memory, not immediate to a segment register, not segment to segment.',
        ex: ['MOV     AX, 1234h        ; immediate -> register', 'MOV     BX, AX           ; register -> register', 'MOV     [VAR], BX        ; register -> memory', 'MOV     CX, [VAR]        ; memory -> register'], data: ['VAR     DW      0'] },
      { m: 'ADD / SUB', s: 'ADD dst, src', d: 'dst = dst + src (or − src).', f: 'OF SF ZF AF PF CF',
        ex: ['MOV     AL, 3', 'ADD     AL, 4            ; AL = 7', 'SUB     AL, 2            ; AL = 5', ...DIGIT] },
      { m: 'INC / DEC', s: 'INC dst', d: 'dst + 1 or − 1. Leaves CF alone, which loops rely on.', f: 'OF SF ZF AF PF',
        ex: ['MOV     AL, 0', 'INC     AL', 'INC     AL', 'DEC     AL               ; AL = 1', ...DIGIT] },
      { m: 'CMP', s: 'CMP a, b', d: 'Compute a − b, keep only the flags; the conditional jumps read them.', f: 'OF SF ZF AF PF CF',
        ex: ['MOV     AL, 5', 'CMP     AL, 5            ; equal: ZF = 1', 'JE      SAME', 'MOV     AL, 0', 'JMP     SHOW', 'SAME:', 'MOV     AL, 1', 'SHOW:', ...DIGIT] },
      { m: 'JMP', s: 'JMP label', d: 'Go to label unconditionally. SHORT reaches ±127 bytes, NEAR the segment, FAR another segment.',
        ex: ['JMP     SKIP', 'MOV     AL, 9            ; never runs', 'SKIP:', 'MOV     AL, 2', ...DIGIT] },
      { m: 'JE / JNE', s: 'JE label', d: 'Jump if equal (ZF=1) / not equal (ZF=0), after a CMP. Also written JZ / JNZ.',
        ex: ['MOV     AL, 7', 'CMP     AL, 3', 'JNE     DIFF', 'MOV     AL, 0', 'JMP     SHOW', 'DIFF:', 'MOV     AL, 1            ; 7 is not 3', 'SHOW:', ...DIGIT] },
      { m: 'JL JLE JG JGE', s: 'JL label', d: 'Signed comparisons: less, less or equal, greater, greater or equal (after CMP a, b).',
        ex: ['MOV     AL, -5           ; FBh, negative when signed', 'CMP     AL, 1', 'JL      LESS', 'MOV     AL, 0', 'JMP     SHOW', 'LESS:', 'MOV     AL, 1            ; -5 < 1 signed', 'SHOW:', ...DIGIT] },
      { m: 'JB JBE JA JAE', s: 'JB label', d: 'Unsigned comparisons: below, below or equal, above, above or equal. JB = JC, JAE = JNC.',
        ex: ['MOV     AL, 0FBh         ; 251 when unsigned', 'CMP     AL, 1', 'JA      ABOVE', 'MOV     AL, 0', 'JMP     SHOW', 'ABOVE:', 'MOV     AL, 1            ; 251 > 1 unsigned', 'SHOW:', ...DIGIT] },
      { m: 'LOOP', s: 'LOOP label', d: 'CX = CX − 1; jump to label while CX ≠ 0. Set CX before the loop.',
        ex: ['MOV     CX, 5', 'MOV     AL, "A"', 'AGAIN:', 'MOV     DL, AL', 'MOV     AH, 02h          ; print DL', 'INT     21h', 'INC     AL               ; next letter', 'LOOP    AGAIN            ; prints ABCDE'] },
      { m: 'CALL / RET', s: 'CALL proc', d: 'Push the return address and go to proc; RET pops it and comes back. RET n also discards n bytes of arguments.',
        ex: ['MOV     AL, 3', 'CALL    DOUBLE', 'CALL    DOUBLE           ; AL = 12 -> prints "<"', 'JMP     DONE', 'DOUBLE:', 'ADD     AL, AL', 'RET', 'DONE:', ...DIGIT] },
      { m: 'PUSH / POP', s: 'PUSH ax', d: 'Put a word on the stack (SP − 2) / take it back (SP + 2). Pop in the reverse order of the pushes.',
        ex: ['MOV     AX, 1', 'MOV     BX, 2', 'PUSH    AX', 'PUSH    BX', 'POP     AX               ; AX = 2', 'POP     BX               ; BX = 1: swapped', ...DIGIT] },
      { m: 'INT', s: 'INT 21h', d: 'Call interrupt handler n: DOS (21h), BIOS video (10h), keyboard (16h). The function number goes in AH — see the Interrupts tab.',
        ex: [...PRINT], data: MSG('Hello from INT 21h') },
      { m: 'XOR reg, reg', s: 'XOR ax, ax', d: 'The idiom for AX = 0: shorter than MOV ax, 0 and sets ZF.', f: 'ZF PF SF; CF=OF=0',
        ex: ['MOV     AX, 1234h', 'XOR     AX, AX           ; AX = 0, ZF = 1', ...DIGIT] },
    ],
  },
  {
    title: 'Arithmetic',
    entries: [
      { m: 'MUL', s: 'MUL src', d: 'Unsigned multiply by AL (8-bit: result AX) or AX (16-bit: result DX:AX).', f: 'CF OF (upper half ≠ 0)',
        ex: ['MOV     AL, 3', 'MOV     BL, 3', 'MUL     BL               ; AX = 9', ...DIGIT] },
      { m: 'IMUL', s: 'IMUL src', d: 'Signed multiply, same registers as MUL.', f: 'CF OF',
        ex: ['MOV     AL, -2', 'MOV     BL, -3', 'IMUL    BL               ; AX = 6', ...DIGIT] },
      { m: 'DIV', s: 'DIV src', d: 'Unsigned divide AX by an 8-bit src (AL quotient, AH remainder) or DX:AX by a 16-bit src (AX quotient, DX remainder). Clear DX first! Division by zero raises INT 0.',
        ex: ['MOV     AX, 17', 'MOV     BL, 5', 'DIV     BL               ; AL = 3, AH = 2', ...DIGIT] },
      { m: 'IDIV', s: 'IDIV src', d: 'Signed divide, same registers as DIV; sign-extend with CBW/CWD first.',
        ex: ['MOV     AL, -9', 'CBW                      ; AX = -9', 'MOV     BL, 2', 'IDIV    BL               ; AL = -4, AH = -1', 'NEG     AL               ; show 4', ...DIGIT] },
      { m: 'ADC / SBB', s: 'ADC dst, src', d: 'Add / subtract with the carry: the way to do 32-bit sums in 16-bit halves.', f: 'OF SF ZF AF PF CF',
        ex: ['MOV     AX, 0FFFFh       ; low word', 'MOV     DX, 0            ; high word', 'ADD     AX, 1            ; carries out', 'ADC     DX, 0            ; DX:AX = 0001:0000', 'MOV     AL, DL', ...DIGIT] },
      { m: 'NEG', s: 'NEG dst', d: 'Two\'s complement: dst = −dst.', f: 'OF SF ZF AF PF CF',
        ex: ['MOV     AL, -4', 'NEG     AL               ; AL = 4', ...DIGIT] },
      { m: 'CBW / CWD', s: 'CBW', d: 'Sign-extend AL into AX / AX into DX:AX (before IDIV).',
        ex: ['MOV     AL, -1', 'CBW                      ; AX = FFFFh', 'CWD                      ; DX = FFFFh', 'MOV     AL, 1', ...DIGIT] },
      { m: 'AAA AAS AAM AAD', s: 'AAM', d: 'ASCII/BCD adjustments after ADD, SUB, MUL, DIV on unpacked decimal digits. AAM also splits AL into AH:AL = AL/10, AL mod 10 — handy for printing numbers.',
        ex: ['MOV     AL, 42', 'AAM                      ; AH = 4, AL = 2', 'MOV     BL, AL', 'MOV     AL, AH', ...DIGIT, 'MOV     AL, BL', ...DIGIT] },
      { m: 'DAA / DAS', s: 'DAA', d: 'Decimal adjust AL after adding / subtracting packed BCD.',
        ex: ['MOV     AL, 19h          ; BCD 19', 'ADD     AL, 01h', 'DAA                      ; AL = 20h, not 1Ah', 'SHR     AL, 1', 'SHR     AL, 1', 'SHR     AL, 1', 'SHR     AL, 1            ; AL = 2', ...DIGIT] },
    ],
  },
  {
    title: 'Logic and bits',
    entries: [
      { m: 'AND / OR / XOR', s: 'AND dst, src', d: 'Bitwise and, or, exclusive or. AND masks bits off, OR sets them, XOR flips them.', f: 'SF ZF PF; CF=OF=0',
        ex: ['MOV     AL, 0F5h', 'AND     AL, 0Fh          ; keep the low nibble: 05h', 'OR      AL, 02h          ; set bit 1: 07h', 'XOR     AL, 04h          ; flip bit 2: 03h', ...DIGIT] },
      { m: 'NOT', s: 'NOT dst', d: 'Flip every bit. No flags.',
        ex: ['MOV     AL, 0FEh', 'NOT     AL               ; AL = 01h', ...DIGIT] },
      { m: 'TEST', s: 'TEST a, b', d: 'AND without storing: only the flags. TEST al, 1 then JNZ odd.', f: 'SF ZF PF; CF=OF=0',
        ex: ['MOV     AL, 7', 'TEST    AL, 1            ; bit 0 set?', 'JNZ     ODD', 'MOV     AL, 0', 'JMP     SHOW', 'ODD:', 'MOV     AL, 1', 'SHOW:', ...DIGIT] },
      { m: 'SHL / SAL', s: 'SHL dst, 1 | CL', d: 'Shift left, zeros in from the right; ×2 per bit. The last bit out lands in CF. Count is 1 or CL on the 8086.', f: 'CF OF SF ZF PF',
        ex: ['MOV     AL, 1', 'MOV     CL, 3', 'SHL     AL, CL           ; 1 << 3 = 8', ...DIGIT] },
      { m: 'SHR', s: 'SHR dst, 1 | CL', d: 'Logical shift right, zeros in from the left: unsigned ÷2.', f: 'CF OF SF ZF PF',
        ex: ['MOV     AL, 12', 'SHR     AL, 1            ; 6', 'SHR     AL, 1            ; 3', ...DIGIT] },
      { m: 'SAR', s: 'SAR dst, 1 | CL', d: 'Arithmetic shift right: the sign bit is copied in, so signed ÷2.', f: 'CF OF SF ZF PF',
        ex: ['MOV     AL, -8', 'SAR     AL, 1            ; -4 (SHR would give 7Ch)', 'NEG     AL', ...DIGIT] },
      { m: 'ROL / ROR', s: 'ROL dst, 1 | CL', d: 'Rotate left / right; the bit that falls off comes back on the other side and into CF.', f: 'CF OF',
        ex: ['MOV     AL, 81h          ; 1000 0001', 'ROL     AL, 1            ; 0000 0011 = 3', ...DIGIT] },
      { m: 'RCL / RCR', s: 'RCL dst, 1 | CL', d: 'Rotate through the carry: CF is a 17th bit. Multi-word shifts.', f: 'CF OF',
        ex: ['STC                      ; CF = 1', 'MOV     AL, 0', 'RCL     AL, 1            ; the carry comes in: AL = 1', ...DIGIT] },
    ],
  },
  {
    title: 'Control flow',
    note: 'Conditional jumps are SHORT only on the 8086 (±127 bytes); for farther targets jump around a JMP.',
    entries: [
      { m: 'JZ JNZ', s: 'JZ label', d: 'Zero / not zero: the result was 0 (ZF). Same as JE / JNE.',
        ex: ['MOV     CX, 3', 'COUNT:', 'DEC     CX', 'JNZ     COUNT            ; until CX = 0', 'MOV     AL, 0', ...DIGIT] },
      { m: 'JC JNC', s: 'JC label', d: 'Carry set / clear: unsigned overflow, borrow, or the bit shifted out.',
        ex: ['MOV     AL, 0FFh', 'ADD     AL, 1            ; wraps: CF = 1', 'JC      WRAPPED', 'MOV     AL, 0', 'JMP     SHOW', 'WRAPPED:', 'MOV     AL, 1', 'SHOW:', ...DIGIT] },
      { m: 'JS JNS', s: 'JS label', d: 'Sign set / clear: the result was negative / not.',
        ex: ['MOV     AL, 3', 'SUB     AL, 5            ; -2', 'JS      NEG_', 'MOV     AL, 0', 'JMP     SHOW', 'NEG_:', 'MOV     AL, 1', 'SHOW:', ...DIGIT] },
      { m: 'JO JNO', s: 'JO label', d: 'Signed overflow / none.',
        ex: ['MOV     AL, 127', 'ADD     AL, 1            ; 128 does not fit a signed byte', 'JO      OVER', 'MOV     AL, 0', 'JMP     SHOW', 'OVER:', 'MOV     AL, 1', 'SHOW:', ...DIGIT] },
      { m: 'JCXZ', s: 'JCXZ label', d: 'Jump if CX = 0 — guard a LOOP that must not run 65536 times.',
        ex: ['XOR     CX, CX', 'JCXZ    EMPTY', 'MOV     AL, 9', 'JMP     SHOW', 'EMPTY:', 'MOV     AL, 0', 'SHOW:', ...DIGIT] },
      { m: 'LOOPE / LOOPNE', s: 'LOOPE label', d: 'LOOP while CX ≠ 0 and ZF = 1 (equal) / ZF = 0 (not equal): scan until a match.',
        ex: ['MOV     SI, OFFSET LIST', 'MOV     CX, 5', 'FIND:', 'LODSB                    ; AL = [SI], SI + 1', 'CMP     AL, 7', 'LOOPNE  FIND             ; until found or CX = 0', 'MOV     AL, 5', 'SUB     AL, CL           ; index of the 7 (1-based)', ...DIGIT], data: ['LIST    DB      2, 4, 7, 1, 9'] },
      { m: 'RETF / IRET', s: 'IRET', d: 'Return from a FAR call (pops CS:IP) / from an interrupt (also pops the flags).' },
      { m: 'INTO', s: 'INTO', d: 'INT 4 if OF is set: trap signed overflow.' },
    ],
  },
  {
    title: 'Stack and procedures',
    note: 'The stack grows down from SS:SP; a word per PUSH. BP is the frame pointer of choice: [BP+4] is the first argument after CALL and PUSH BP.',
    entries: [
      { m: 'PUSHF / POPF', s: 'PUSHF', d: 'Save / restore the flags register.',
        ex: ['STC', 'PUSHF', 'CLC', 'POPF                     ; CF = 1 again', 'MOV     AL, 0', 'ADC     AL, 0            ; AL = 1', ...DIGIT] },
      { m: 'PROC / ENDP', s: 'name PROC NEAR', d: 'MASM: declare a procedure. NEAR within the segment (RET), FAR across (RETF).',
        ex: ['MOV     AL, 4', 'CALL    SQUARE           ; AL = 16: prints "@"', 'JMP     SHOW', 'SQUARE  PROC    NEAR', 'MUL     AL', 'RET', 'SQUARE  ENDP', 'SHOW:', ...DIGIT] },
      { m: 'Prologue', s: 'push bp / mov bp, sp', d: 'The usual frame: arguments at [bp+4], [bp+6]…; locals below with SUB sp, n. Undo with mov sp, bp / pop bp / ret.',
        ex: ['MOV     AX, 3', 'PUSH    AX               ; argument', 'CALL    ADD2', 'ADD     SP, 2            ; the caller discards it', ...DIGIT, 'JMP     DONE', 'ADD2:', 'PUSH    BP', 'MOV     BP, SP', 'MOV     AX, [BP+4]       ; the argument', 'ADD     AX, 2', 'POP     BP', 'RET', 'DONE:'] },
      { m: 'PUSHA / POPA', s: 'PUSHA', d: '80186 and later: push / pop all eight general registers at once.' },
    ],
  },
  {
    title: 'Strings and blocks',
    note: 'Source DS:SI, destination ES:DI, count CX; DF chooses the direction (CLD = forward). REP in front repeats CX times.',
    entries: [
      { m: 'MOVSB / MOVSW', s: 'REP MOVSB', d: 'Copy a byte / word from DS:SI to ES:DI and advance both: memory copy.',
        ex: ['CLD', 'MOV     SI, OFFSET SRC', 'MOV     DI, OFFSET DST', 'MOV     CX, 6', 'REP     MOVSB            ; DST = "Copied"', 'MOV     DX, OFFSET DST', 'MOV     AH, 09h', 'INT     21h'], data: ['SRC     DB      \'Copied\'', 'DST     DB      \'......\', 13, 10, \'$\''] },
      { m: 'STOSB / STOSW', s: 'REP STOSW', d: 'Store AL / AX at ES:DI and advance: fill memory (clear the screen, zero a buffer).',
        ex: ['CLD', 'MOV     DI, OFFSET BUF', 'MOV     AL, "*"', 'MOV     CX, 10', 'REP     STOSB            ; ten stars', 'MOV     DX, OFFSET BUF', 'MOV     AH, 09h', 'INT     21h'], data: ['BUF     DB      10 DUP(?), 13, 10, \'$\''] },
      { m: 'LODSB / LODSW', s: 'LODSB', d: 'Load AL / AX from DS:SI and advance: walk through a string.',
        ex: ['CLD', 'MOV     SI, OFFSET TXT', 'NEXT:', 'LODSB                    ; AL = next byte', 'CMP     AL, 0', 'JE      DONE', 'MOV     DL, AL', 'MOV     AH, 02h', 'INT     21h', 'JMP     NEXT', 'DONE:'], data: ['TXT     DB      \'byte by byte\', 13, 10, 0'] },
      { m: 'CMPSB / CMPSW', s: 'REPE CMPSB', d: 'Compare DS:SI with ES:DI and advance: string compare (REPE stops at the first difference).',
        ex: ['CLD', 'MOV     SI, OFFSET A_', 'MOV     DI, OFFSET B_', 'MOV     CX, 5', 'REPE    CMPSB', 'JE      SAME', 'MOV     AL, 0            ; differ', 'JMP     SHOW', 'SAME:', 'MOV     AL, 1', 'SHOW:', ...DIGIT], data: ['A_      DB      \'hello\'', 'B_      DB      \'help!\''] },
      { m: 'SCASB / SCASW', s: 'REPNE SCASB', d: 'Compare AL / AX with ES:DI and advance: find a byte (REPNE stops at the first match), e.g. the length of a 0-terminated string.',
        ex: ['CLD', 'MOV     DI, OFFSET TXT', 'MOV     CX, 0FFh', 'XOR     AL, AL', 'REPNE   SCASB            ; stop at the 0', 'MOV     AX, 0FEh', 'SUB     AX, CX           ; length = 5', ...DIGIT], data: ['TXT     DB      \'hello\', 0'] },
      { m: 'CLD / STD', s: 'CLD', d: 'Direction flag off (forward, the normal case) / on (backward, for overlapping copies).' },
    ],
  },
  {
    title: 'Flags and the CPU',
    entries: [
      { m: 'CLC STC CMC', s: 'STC', d: 'Clear, set, complement the carry flag.',
        ex: ['CLC', 'CMC                      ; CF = 1', 'MOV     AL, 0', 'ADC     AL, 0            ; AL = 1', ...DIGIT] },
      { m: 'CLI / STI', s: 'CLI', d: 'Disable / enable maskable interrupts (around stack switches and timing-critical code; keep it short).' },
      { m: 'LAHF / SAHF', s: 'LAHF', d: 'Copy the low flags byte (SF ZF AF PF CF) to AH / back.',
        ex: ['STC', 'LAHF                     ; AH bit 0 = CF', 'AND     AH, 1', 'MOV     AL, AH', ...DIGIT] },
      { m: 'NOP', s: 'NOP', d: 'Do nothing for one byte (90h): padding, patch space, a breakpoint target.' },
      { m: 'HLT', s: 'HLT', d: 'Halt until the next interrupt.' },
      { m: 'WAIT / LOCK', s: 'LOCK XCHG', d: 'WAIT for the 8087; LOCK the bus for the next instruction (atomic on multiprocessors).' },
    ],
  },
  {
    title: 'Addresses and data',
    entries: [
      { m: 'LEA', s: 'LEA bx, table[si]', d: 'Load the effective address (the offset) into a register without reading memory. Also a cheap 3-operand add.',
        ex: ['MOV     SI, 2', 'LEA     BX, [TABLE+SI]   ; BX = address of the 3rd byte', 'MOV     AL, [BX]         ; = 3', ...DIGIT], data: ['TABLE   DB      1, 2, 3, 4'] },
      { m: 'XCHG', s: 'XCHG ax, bx', d: 'Swap two operands.',
        ex: ['MOV     AL, 1', 'MOV     BL, 2', 'XCHG    AL, BL           ; AL = 2', ...DIGIT] },
      { m: 'XLAT', s: 'XLAT', d: 'AL = [BX + AL]: table lookup in one byte.',
        ex: ['MOV     BX, OFFSET HEX', 'MOV     AL, 11', 'XLAT                     ; AL = "B"', 'MOV     DL, AL', 'MOV     AH, 02h', 'INT     21h'], data: ['HEX     DB      \'0123456789ABCDEF\''] },
      { m: 'LDS / LES', s: 'LES di, ptr', d: 'Load a far pointer: the offset into the register, the segment into DS / ES.',
        ex: ['LES     DI, DWORD PTR [SCREEN]  ; ES:DI = B800:0000', 'MOV     AX, 0F41h        ; "A", white on blue', 'MOV     ES:[DI], AX      ; top-left cell of the screen'], data: ['SCREEN  DD      0B8000000h'] },
      { m: 'Addressing', s: '[bx+si+8]', d: 'Base (BX or BP) + index (SI or DI) + displacement, in any combination. BP defaults to SS, the others to DS.',
        ex: ['MOV     BX, OFFSET ROWS', 'MOV     SI, 4            ; second row of 4 bytes', 'MOV     AL, [BX+SI+1]    ; = 6', ...DIGIT], data: ['ROWS    DB      1, 2, 3, 4', '        DB      5, 6, 7, 8'] },
      { m: 'Overrides', s: 'ES:[di]', d: 'A segment prefix uses another segment register for one operand.',
        ex: ['MOV     AX, 0B800h', 'MOV     ES, AX', 'MOV     DI, 160          ; row 1, column 0', 'MOV     WORD PTR ES:[DI], 0E2Ah  ; "*", yellow'] },
      { m: 'DB DW DD', s: 'msg DB "Hi$"', d: 'MASM: define bytes, words, double words. DUP repeats: buf DB 80 DUP(?).',
        ex: ['MOV     AL, BYTE PTR [W]   ; low byte of 0102h = 2', ...DIGIT], data: ['B       DB      5', 'W       DW      0102h', 'D       DD      12345678h', 'BUF     DB      8 DUP(0)'] },
      { m: 'OFFSET / SEG', s: 'MOV dx, OFFSET msg', d: 'MASM: the address of a label (offset within its segment / its segment).',
        ex: [...PRINT], data: MSG('OFFSET gave DX the address') },
      { m: 'BYTE PTR / WORD PTR', s: 'INC BYTE PTR [bx]', d: 'MASM: say the operand size when no register implies it.',
        ex: ['MOV     BX, OFFSET N', 'INC     BYTE PTR [BX]    ; 4 -> 5', 'MOV     AL, [BX]', ...DIGIT], data: ['N       DB      4'] },
    ],
  },
  {
    title: 'Ports',
    entries: [
      { m: 'IN', s: 'IN al, 60h  |  IN ax, dx', d: 'Read a byte / word from a port (immediate ≤ FFh, else via DX). 60h keyboard, 40h timer, 3DAh VGA status.',
        ex: ['IN      AL, 60h          ; the last keyboard scan code', 'AND     AL, 0Fh', 'CMP     AL, 10', 'JB      OK', 'MOV     AL, 9', 'OK:', ...DIGIT] },
      { m: 'OUT', s: 'OUT 43h, al  |  OUT dx, ax', d: 'Write to a port. 61h speaker gate, 42h timer 2 (tone), 3C8h/3C9h VGA palette.',
        ex: ['MOV     AL, 0B6h', 'OUT     43h, AL          ; timer 2: square wave', 'MOV     AX, 1193         ; 1000 Hz', 'OUT     42h, AL', 'MOV     AL, AH', 'OUT     42h, AL', 'IN      AL, 61h', 'OR      AL, 3', 'OUT     61h, AL          ; speaker on', 'MOV     CX, 0FFFFh', 'WAIT1:', 'LOOP    WAIT1', 'IN      AL, 61h', 'AND     AL, 0FCh', 'OUT     61h, AL          ; speaker off'] },
    ],
  },
  {
    title: 'Registers',
    entries: [
      { m: 'AX', s: 'AH:AL', d: 'Accumulator: arithmetic, MUL/DIV, IN/OUT, the function number for interrupts (AH).' },
      { m: 'BX', s: 'BH:BL', d: 'Base: addressing [bx], XLAT table, file handles for DOS.' },
      { m: 'CX', s: 'CH:CL', d: 'Count: LOOP, REP, shift counts (CL).' },
      { m: 'DX', s: 'DH:DL', d: 'Data: ports, the high half of DIV/MUL, pointers for DOS calls (DS:DX).' },
      { m: 'SI / DI', s: 'DS:SI → ES:DI', d: 'Source / destination index for strings; general addressing.' },
      { m: 'BP / SP', s: 'SS:BP, SS:SP', d: 'Frame pointer / stack pointer.' },
      { m: 'CS DS ES SS', s: 'segment:offset', d: 'Code, data, extra, stack segments. Physical = segment × 16 + offset. A .COM has all four equal.' },
      { m: 'Flags', s: 'OF DF IF TF SF ZF AF PF CF', d: 'Overflow, direction, interrupt, trap (single step), sign, zero, auxiliary carry, parity, carry.' },
    ],
  },
]

/** Ready programs: open one, build, run. */
export const PROGRAMS: Program[] = [
  {
    name: 'Minimal .COM', file: 'MINIMAL.ASM', what: 'The smallest program that prints something and exits properly.',
    code: [
      '; The minimal .COM: print a line, exit with code 0.',
      '; Build & Run in the workbench, or: ML /AT MINIMAL.ASM',
      '        .MODEL  TINY',
      '        .CODE',
      '        ORG     100h             ; a .COM starts at 100h, after the PSP',
      'START:',
      '        MOV     AH, 09h          ; DOS: print the "$"-terminated string at DS:DX',
      '        MOV     DX, OFFSET MSG',
      '        INT     21h',
      '        MOV     AX, 4C00h        ; DOS: exit, code 0',
      '        INT     21h',
      'MSG     DB      \'Hello from a .COM\', 13, 10, \'$\'',
      '        END     START',
      '',
    ].join('\r\n'),
  },
  {
    name: 'Read a key, echo it', file: 'KEYS.ASM', what: 'A loop reading keys without echo and printing them until Esc.',
    code: [
      '; Read keys and print them until Esc.',
      '        .MODEL  TINY',
      '        .CODE',
      '        ORG     100h',
      'START:',
      '        MOV     AH, 09h',
      '        MOV     DX, OFFSET HINT',
      '        INT     21h',
      'NEXT:',
      '        MOV     AH, 08h          ; DOS: read a key, no echo',
      '        INT     21h',
      '        CMP     AL, 27           ; Esc?',
      '        JE      DONE',
      '        MOV     DL, AL',
      '        MOV     AH, 02h          ; DOS: print DL',
      '        INT     21h',
      '        JMP     NEXT',
      'DONE:',
      '        MOV     AX, 4C00h',
      '        INT     21h',
      'HINT    DB      \'Type; Esc ends.\', 13, 10, \'$\'',
      '        END     START',
      '',
    ].join('\r\n'),
  },
  {
    name: 'Count 1 to 10', file: 'COUNT.ASM', what: 'A LOOP, a number turned into decimal digits with AAM, a procedure.',
    code: [
      '; Print 1..10, one per line: LOOP, AAM, a procedure.',
      '        .MODEL  TINY',
      '        .CODE',
      '        ORG     100h',
      'START:',
      '        MOV     CX, 10',
      '        MOV     BL, 1            ; the number',
      'AGAIN:',
      '        MOV     AL, BL',
      '        CALL    PRINTNUM',
      '        INC     BL',
      '        LOOP    AGAIN',
      '        MOV     AX, 4C00h',
      '        INT     21h',
      '',
      '; PRINTNUM: print AL (0..99) and a newline. Uses AX, DX.',
      'PRINTNUM PROC   NEAR',
      '        AAM                      ; AH = tens, AL = ones',
      '        PUSH    AX',
      '        CMP     AH, 0',
      '        JE      ONES             ; skip a leading zero',
      '        MOV     DL, AH',
      '        ADD     DL, \'0\'',
      '        MOV     AH, 02h',
      '        INT     21h',
      'ONES:',
      '        POP     AX',
      '        MOV     DL, AL',
      '        ADD     DL, \'0\'',
      '        MOV     AH, 02h',
      '        INT     21h',
      '        MOV     DL, 13',
      '        INT     21h',
      '        MOV     DL, 10',
      '        INT     21h',
      '        RET',
      'PRINTNUM ENDP',
      '        END     START',
      '',
    ].join('\r\n'),
  },
  {
    name: 'Write to the screen directly', file: 'SCREEN.ASM', what: 'Text memory at B800:0000: a coloured line without DOS, then a wait for a key.',
    code: [
      '; Write straight into colour text memory (B800:0000).',
      '        .MODEL  TINY',
      '        .CODE',
      '        ORG     100h',
      'START:',
      '        MOV     AX, 0B800h',
      '        MOV     ES, AX           ; ES:DI -> screen',
      '        MOV     DI, (10*80+30)*2 ; row 10, column 30',
      '        MOV     SI, OFFSET TXT',
      '        MOV     AH, 4Eh          ; yellow on red',
      '        CLD',
      'NEXT:',
      '        LODSB                    ; AL = next character',
      '        CMP     AL, 0',
      '        JE      WAITK',
      '        STOSW                    ; character + attribute',
      '        JMP     NEXT',
      'WAITK:',
      '        MOV     AH, 08h          ; wait for a key',
      '        INT     21h',
      '        MOV     AX, 4C00h',
      '        INT     21h',
      'TXT     DB      \' direct to video \', 0',
      '        END     START',
      '',
    ].join('\r\n'),
  },
  {
    name: 'String length (SCASB)', file: 'STRLEN.ASM', what: 'A procedure returning the length of a 0-terminated string in CX, called twice.',
    code: [
      '; STRLEN with REPNE SCASB; prints the lengths as digits.',
      '        .MODEL  TINY',
      '        .CODE',
      '        ORG     100h',
      'START:',
      '        MOV     DI, OFFSET S1',
      '        CALL    STRLEN           ; CX = 5',
      '        CALL    PRINTCX',
      '        MOV     DI, OFFSET S2',
      '        CALL    STRLEN           ; CX = 3',
      '        CALL    PRINTCX',
      '        MOV     AX, 4C00h',
      '        INT     21h',
      '',
      'STRLEN  PROC    NEAR             ; ES:DI = string -> CX = length',
      '        PUSH    AX',
      '        PUSH    DI',
      '        XOR     AL, AL',
      '        MOV     CX, 0FFFFh',
      '        CLD',
      '        REPNE   SCASB            ; find the 0',
      '        NOT     CX',
      '        DEC     CX',
      '        POP     DI',
      '        POP     AX',
      '        RET',
      'STRLEN  ENDP',
      '',
      'PRINTCX PROC    NEAR             ; one digit (0..9) and a newline',
      '        MOV     DL, CL',
      '        ADD     DL, \'0\'',
      '        MOV     AH, 02h',
      '        INT     21h',
      '        MOV     DL, 13',
      '        INT     21h',
      '        MOV     DL, 10',
      '        INT     21h',
      '        RET',
      'PRINTCX ENDP',
      '',
      'S1      DB      \'hello\', 0',
      'S2      DB      \'dos\', 0',
      '        END     START',
      '',
    ].join('\r\n'),
  },
]
