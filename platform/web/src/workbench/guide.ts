/**
 * The 8086 guide shown in the workbench: instructions grouped by what you
 * reach for first, one line each (syntax, what it does, the flags it
 * touches), then the registers, DOS and BIOS calls a small program needs,
 * and the MASM skeleton for a .COM. Reference, not a tutorial.
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
}

export interface Section {
  title: string
  note?: string
  entries: Entry[]
}

export const GUIDE: Section[] = [
  {
    title: 'Start here',
    note: 'The dozen instructions almost every program is made of.',
    entries: [
      { m: 'MOV', s: 'MOV dst, src', d: 'Copy src into dst (register, memory or immediate). Not memory to memory, not immediate to a segment register, not segment to segment.' },
      { m: 'ADD / SUB', s: 'ADD dst, src', d: 'dst = dst + src (or − src).', f: 'OF SF ZF AF PF CF' },
      { m: 'INC / DEC', s: 'INC dst', d: 'dst + 1 or − 1. Leaves CF alone, which loops rely on.', f: 'OF SF ZF AF PF' },
      { m: 'CMP', s: 'CMP a, b', d: 'Compute a − b, keep only the flags; the conditional jumps read them.', f: 'OF SF ZF AF PF CF' },
      { m: 'JMP', s: 'JMP label', d: 'Go to label unconditionally. SHORT reaches ±127 bytes, NEAR the segment, FAR another segment.' },
      { m: 'JE / JNE', s: 'JE label', d: 'Jump if equal (ZF=1) / not equal (ZF=0), after a CMP. Also written JZ / JNZ.' },
      { m: 'JL JLE JG JGE', s: 'JL label', d: 'Signed comparisons: less, less or equal, greater, greater or equal (after CMP a, b).' },
      { m: 'JB JBE JA JAE', s: 'JB label', d: 'Unsigned comparisons: below, below or equal, above, above or equal. JB = JC, JAE = JNC.' },
      { m: 'LOOP', s: 'LOOP label', d: 'CX = CX − 1; jump to label while CX ≠ 0. Set CX before the loop.' },
      { m: 'CALL / RET', s: 'CALL proc', d: 'Push the return address and go to proc; RET pops it and comes back. RET n also discards n bytes of arguments.' },
      { m: 'PUSH / POP', s: 'PUSH ax', d: 'Put a word on the stack (SP − 2) / take it back (SP + 2). Pop in the reverse order of the pushes.' },
      { m: 'INT', s: 'INT 21h', d: 'Call interrupt handler n: DOS (21h), BIOS video (10h), keyboard (16h). The function number goes in AH.' },
      { m: 'XOR reg, reg', s: 'XOR ax, ax', d: 'The idiom for AX = 0: shorter than MOV ax, 0 and sets ZF.', f: 'ZF PF SF; CF=OF=0' },
    ],
  },
  {
    title: 'Arithmetic',
    entries: [
      { m: 'MUL', s: 'MUL src', d: 'Unsigned multiply by AL (8-bit: result AX) or AX (16-bit: result DX:AX).', f: 'CF OF (upper half ≠ 0)' },
      { m: 'IMUL', s: 'IMUL src', d: 'Signed multiply, same registers as MUL.', f: 'CF OF' },
      { m: 'DIV', s: 'DIV src', d: 'Unsigned divide AX by an 8-bit src (AL quotient, AH remainder) or DX:AX by a 16-bit src (AX quotient, DX remainder). Clear DX first! Division by zero raises INT 0.' },
      { m: 'IDIV', s: 'IDIV src', d: 'Signed divide, same registers as DIV; sign-extend with CBW/CWD first.' },
      { m: 'ADC / SBB', s: 'ADC dst, src', d: 'Add / subtract with the carry: the way to do 32-bit sums in 16-bit halves.', f: 'OF SF ZF AF PF CF' },
      { m: 'NEG', s: 'NEG dst', d: 'Two\'s complement: dst = −dst.', f: 'OF SF ZF AF PF CF' },
      { m: 'CBW / CWD', s: 'CBW', d: 'Sign-extend AL into AX / AX into DX:AX (before IDIV).' },
      { m: 'AAA AAS AAM AAD', s: 'AAM', d: 'ASCII/BCD adjustments after ADD, SUB, MUL, DIV on unpacked decimal digits. AAM also splits AL into AH:AL = AL/10, AL mod 10 — handy for printing numbers.' },
      { m: 'DAA / DAS', s: 'DAA', d: 'Decimal adjust AL after adding / subtracting packed BCD.' },
    ],
  },
  {
    title: 'Logic and bits',
    entries: [
      { m: 'AND / OR / XOR', s: 'AND dst, src', d: 'Bitwise and, or, exclusive or. AND masks bits off, OR sets them, XOR flips them.', f: 'SF ZF PF; CF=OF=0' },
      { m: 'NOT', s: 'NOT dst', d: 'Flip every bit. No flags.' },
      { m: 'TEST', s: 'TEST a, b', d: 'AND without storing: only the flags. TEST al, 1 then JNZ odd.', f: 'SF ZF PF; CF=OF=0' },
      { m: 'SHL / SAL', s: 'SHL dst, 1 | CL', d: 'Shift left, zeros in from the right; ×2 per bit. The last bit out lands in CF. Count is 1 or CL on the 8086.', f: 'CF OF SF ZF PF' },
      { m: 'SHR', s: 'SHR dst, 1 | CL', d: 'Logical shift right, zeros in from the left: unsigned ÷2.', f: 'CF OF SF ZF PF' },
      { m: 'SAR', s: 'SAR dst, 1 | CL', d: 'Arithmetic shift right: the sign bit is copied in, so signed ÷2.', f: 'CF OF SF ZF PF' },
      { m: 'ROL / ROR', s: 'ROL dst, 1 | CL', d: 'Rotate left / right; the bit that falls off comes back on the other side and into CF.', f: 'CF OF' },
      { m: 'RCL / RCR', s: 'RCL dst, 1 | CL', d: 'Rotate through the carry: CF is a 17th bit. Multi-word shifts.', f: 'CF OF' },
    ],
  },
  {
    title: 'Control flow',
    note: 'Conditional jumps are SHORT only on the 8086 (±127 bytes); for farther targets jump around a JMP.',
    entries: [
      { m: 'JZ JNZ', s: 'JZ label', d: 'Zero / not zero: the result was 0 (ZF). Same as JE / JNE.' },
      { m: 'JC JNC', s: 'JC label', d: 'Carry set / clear: unsigned overflow, borrow, or the bit shifted out.' },
      { m: 'JS JNS', s: 'JS label', d: 'Sign set / clear: the result was negative / not.' },
      { m: 'JO JNO', s: 'JO label', d: 'Signed overflow / none.' },
      { m: 'JP JNP', s: 'JP label', d: 'Parity even / odd of the low byte (rare).' },
      { m: 'JCXZ', s: 'JCXZ label', d: 'Jump if CX = 0 — guard a LOOP that must not run 65536 times.' },
      { m: 'LOOPE / LOOPNE', s: 'LOOPE label', d: 'LOOP while CX ≠ 0 and ZF = 1 (equal) / ZF = 0 (not equal): scan until a match.' },
      { m: 'RETF / IRET', s: 'IRET', d: 'Return from a FAR call (pops CS:IP) / from an interrupt (also pops the flags).' },
      { m: 'INTO', s: 'INTO', d: 'INT 4 if OF is set: trap signed overflow.' },
    ],
  },
  {
    title: 'Stack and procedures',
    note: 'The stack grows down from SS:SP; a word per PUSH. BP is the frame pointer of choice: [BP+4] is the first argument after CALL and PUSH BP.',
    entries: [
      { m: 'PUSHF / POPF', s: 'PUSHF', d: 'Save / restore the flags register.' },
      { m: 'PROC / ENDP', s: 'name PROC NEAR', d: 'MASM: declare a procedure. NEAR within the segment (RET), FAR across (RETF).' },
      { m: 'Prologue', s: 'push bp / mov bp, sp', d: 'The usual frame: arguments at [bp+4], [bp+6]…; locals below with SUB sp, n. Undo with mov sp, bp / pop bp / ret.' },
      { m: 'PUSHA / POPA', s: 'PUSHA', d: '80186 and later: push / pop all eight general registers at once.' },
    ],
  },
  {
    title: 'Strings and blocks',
    note: 'Source DS:SI, destination ES:DI, count CX; DF chooses the direction (CLD = forward). REP in front repeats CX times.',
    entries: [
      { m: 'MOVSB / MOVSW', s: 'REP MOVSB', d: 'Copy a byte / word from DS:SI to ES:DI and advance both: memory copy.' },
      { m: 'STOSB / STOSW', s: 'REP STOSW', d: 'Store AL / AX at ES:DI and advance: fill memory (clear the screen, zero a buffer).' },
      { m: 'LODSB / LODSW', s: 'LODSB', d: 'Load AL / AX from DS:SI and advance: walk through a string.' },
      { m: 'CMPSB / CMPSW', s: 'REPE CMPSB', d: 'Compare DS:SI with ES:DI and advance: string compare (REPE stops at the first difference).' },
      { m: 'SCASB / SCASW', s: 'REPNE SCASB', d: 'Compare AL / AX with ES:DI and advance: find a byte (REPNE stops at the first match), e.g. the length of a 0-terminated string.' },
      { m: 'CLD / STD', s: 'CLD', d: 'Direction flag off (forward, the normal case) / on (backward, for overlapping copies).' },
    ],
  },
  {
    title: 'Flags and the CPU',
    entries: [
      { m: 'CLC STC CMC', s: 'STC', d: 'Clear, set, complement the carry flag.' },
      { m: 'CLI / STI', s: 'CLI', d: 'Disable / enable maskable interrupts (around stack switches and timing-critical code; keep it short).' },
      { m: 'LAHF / SAHF', s: 'LAHF', d: 'Copy the low flags byte (SF ZF AF PF CF) to AH / back.' },
      { m: 'NOP', s: 'NOP', d: 'Do nothing for one byte (90h): padding, patch space, a breakpoint target.' },
      { m: 'HLT', s: 'HLT', d: 'Halt until the next interrupt.' },
      { m: 'WAIT / LOCK', s: 'LOCK XCHG', d: 'WAIT for the 8087; LOCK the bus for the next instruction (atomic on multiprocessors).' },
    ],
  },
  {
    title: 'Addresses and data',
    entries: [
      { m: 'LEA', s: 'LEA bx, table[si]', d: 'Load the effective address (the offset) into a register without reading memory. Also a cheap 3-operand add.' },
      { m: 'XCHG', s: 'XCHG ax, bx', d: 'Swap two operands.' },
      { m: 'XLAT', s: 'XLAT', d: 'AL = [BX + AL]: table lookup in one byte.' },
      { m: 'LDS / LES', s: 'LES di, ptr', d: 'Load a far pointer: the offset into the register, the segment into DS / ES.' },
      { m: 'Addressing', s: '[bx+si+8]', d: 'Base (BX or BP) + index (SI or DI) + displacement, in any combination. BP defaults to SS, the others to DS.' },
      { m: 'Overrides', s: 'ES:[di]', d: 'A segment prefix uses another segment register for one operand.' },
      { m: 'DB DW DD', s: 'msg DB "Hi$"', d: 'MASM: define bytes, words, double words. DUP repeats: buf DB 80 DUP(?).' },
      { m: 'OFFSET / SEG', s: 'MOV dx, OFFSET msg', d: 'MASM: the address of a label (offset within its segment / its segment).' },
      { m: 'BYTE PTR / WORD PTR', s: 'INC BYTE PTR [bx]', d: 'MASM: say the operand size when no register implies it.' },
    ],
  },
  {
    title: 'Ports',
    entries: [
      { m: 'IN', s: 'IN al, 60h  |  IN ax, dx', d: 'Read a byte / word from a port (immediate ≤ FFh, else via DX). 60h keyboard, 40h timer, 3DAh VGA status.' },
      { m: 'OUT', s: 'OUT 43h, al  |  OUT dx, ax', d: 'Write to a port. 61h speaker gate, 42h timer 2 (tone), 3C8h/3C9h VGA palette.' },
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
  {
    title: 'DOS: INT 21h',
    note: 'Function in AH; most set CF on error with the code in AX.',
    entries: [
      { m: 'AH=02h', s: 'MOV dl, "A" / INT 21h', d: 'Print the character in DL.' },
      { m: 'AH=09h', s: 'MOV dx, OFFSET msg', d: 'Print the "$"-terminated string at DS:DX.' },
      { m: 'AH=01h / 08h', s: 'INT 21h → AL', d: 'Read a key with echo / without.' },
      { m: 'AH=0Ah', s: 'DS:DX → buffer', d: 'Buffered line input: byte 0 = max, byte 1 = length read, then the text.' },
      { m: 'AH=3Ch / 3Dh', s: 'DS:DX name, CX attr / AL mode', d: 'Create / open a file → handle in AX.' },
      { m: 'AH=3Fh / 40h', s: 'BX handle, CX bytes, DS:DX', d: 'Read / write → bytes done in AX. Handle 1 is the screen, 0 the keyboard.' },
      { m: 'AH=3Eh', s: 'BX handle', d: 'Close.' },
      { m: 'AH=42h', s: 'BX handle, AL origin, CX:DX offset', d: 'Seek → position in DX:AX.' },
      { m: 'AH=4Ch', s: 'MOV ax, 4C00h / INT 21h', d: 'Exit with the code in AL (what ERRORLEVEL sees).' },
      { m: 'AH=2Ch / 2Ah', s: 'INT 21h', d: 'Time (CH:CL:DH) / date (CX year, DH month, DL day).' },
      { m: 'AH=25h / 35h', s: 'AL vector, DS:DX', d: 'Set / get an interrupt vector (hooking the timer, the keyboard).' },
      { m: 'AH=48h / 49h', s: 'BX paragraphs', d: 'Allocate / free memory → segment in AX.' },
    ],
  },
  {
    title: 'BIOS and hardware interrupts',
    entries: [
      { m: 'INT 10h AH=0Eh', s: 'AL char', d: 'Teletype: print a character, moving the cursor.' },
      { m: 'INT 10h AH=00h', s: 'AL mode', d: 'Set the video mode: 03h text 80×25, 13h graphics 320×200×256.' },
      { m: 'INT 10h AH=02h', s: 'DH row, DL col, BH page', d: 'Set the cursor position.' },
      { m: 'INT 10h AH=09h', s: 'AL char, BL attr, CX count', d: 'Write a character with an attribute at the cursor.' },
      { m: 'INT 16h AH=00h / 01h', s: 'INT 16h → AX', d: 'Wait for a key (AL ASCII, AH scan code) / check without waiting (ZF=1 none).' },
      { m: 'INT 1Ah AH=00h', s: 'INT 1Ah → CX:DX', d: 'Ticks since midnight (18.2 per second).' },
      { m: 'INT 33h AX=0000h', s: 'INT 33h', d: 'Mouse: reset (AX=FFFFh if present); 0001h show, 0003h position (CX, DX) and buttons (BX).' },
      { m: 'B800:0000', s: 'MOV ax, 0B800h / MOV es, ax', d: 'Text screen memory: 80×25 cells of (char, attribute). A000:0000 is the pixel buffer in mode 13h.' },
    ],
  },
  {
    title: 'A .COM program in MASM',
    note: 'Build: ML /AT /Fl HELLO.ASM — /AT makes the .COM, /Fl writes HELLO.LST, which the debugger uses to step by source line.',
    entries: [
      { m: 'Skeleton', s: '.MODEL TINY / .CODE / ORG 100h', d: 'start: ... MOV ax, 4C00h / INT 21h — then data labels — END start. Code and data in one 64 KB segment; CS=DS=ES=SS; the PSP at offset 0, code from 100h.' },
      { m: 'Strings', s: 'msg DB "Hello", 13, 10, "$"', d: '13, 10 is a newline for DOS; "$" ends an AH=09h string.' },
      { m: 'Labels', s: 'again:', d: 'A name and a colon; jump targets. Procedures: name PROC … name ENDP, called with CALL.' },
      { m: 'Comments', s: '; to the end of the line', d: '' },
    ],
  },
]
