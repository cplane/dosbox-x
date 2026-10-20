/**
 * The interrupt reference: DOS (INT 21h) and BIOS services by function
 * number, with what goes in, what comes out, and a note. Used by the
 * Interrupts tab, by the machine view when the current instruction is an
 * INT (it knows AH), and by the editor's hover on INT lines.
 */

export interface IntFn {
  /** AH (or AX when `ax` is set), as a number. */
  fn: number
  /** The function is selected by the whole AX, not AH. */
  ax?: boolean
  name: string
  in?: string
  out?: string
  note?: string
}

export interface IntVector {
  int: number
  title: string
  note?: string
  fns: IntFn[]
}

export const INTERRUPTS: IntVector[] = [
  {
    int: 0x21, title: 'DOS services', note: 'Function in AH. Most file functions set CF on error with the error code in AX (2 file not found, 3 path, 4 too many handles, 5 access denied).',
    fns: [
      { fn: 0x01, name: 'Read a key, with echo', out: 'AL = character', note: 'Waits. Ctrl+C aborts the program.' },
      { fn: 0x02, name: 'Print a character', in: 'DL = character' },
      { fn: 0x06, name: 'Direct console I/O', in: 'DL = character to print, or FFh to read', out: 'ZF=1 no key; else AL = key', note: 'No echo, no Ctrl+C check.' },
      { fn: 0x07, name: 'Read a key, no echo, no Ctrl+C', out: 'AL = character' },
      { fn: 0x08, name: 'Read a key, no echo', out: 'AL = character', note: 'Ctrl+C is checked.' },
      { fn: 0x09, name: 'Print a string', in: 'DS:DX = string ending in "$"' },
      { fn: 0x0a, name: 'Buffered line input', in: 'DS:DX = buffer: byte 0 = max length, byte 1 receives the length, text from byte 2', note: 'Editing keys work; ends at Enter (CR stored, not counted).' },
      { fn: 0x0b, name: 'Check for a key', out: 'AL = FFh if a key waits, 0 if not' },
      { fn: 0x0e, name: 'Select the default drive', in: 'DL = drive (0 = A)', out: 'AL = number of drives' },
      { fn: 0x19, name: 'Get the default drive', out: 'AL = drive (0 = A)' },
      { fn: 0x1a, name: 'Set the DTA (for find first/next)', in: 'DS:DX = 128-byte buffer' },
      { fn: 0x25, name: 'Set an interrupt vector', in: 'AL = interrupt number, DS:DX = handler', note: 'Save the old one with 35h and restore it before exiting.' },
      { fn: 0x2a, name: 'Get the date', out: 'CX = year, DH = month, DL = day, AL = weekday (0 = Sunday)' },
      { fn: 0x2c, name: 'Get the time', out: 'CH = hour, CL = minute, DH = second, DL = 1/100 s' },
      { fn: 0x2d, name: 'Set the time', in: 'CH:CL:DH:DL' },
      { fn: 0x2f, name: 'Get the DTA', out: 'ES:BX = DTA' },
      { fn: 0x30, name: 'Get the DOS version', out: 'AL = major, AH = minor' },
      { fn: 0x31, name: 'Terminate and stay resident', in: 'AL = return code, DX = paragraphs to keep' },
      { fn: 0x35, name: 'Get an interrupt vector', in: 'AL = interrupt number', out: 'ES:BX = handler' },
      { fn: 0x36, name: 'Free disk space', in: 'DL = drive (0 = default)', out: 'AX = sectors per cluster, BX = free clusters, CX = bytes per sector, DX = clusters' },
      { fn: 0x39, name: 'Create a directory', in: 'DS:DX = path (ASCIIZ)' },
      { fn: 0x3a, name: 'Remove a directory', in: 'DS:DX = path' },
      { fn: 0x3b, name: 'Change the directory', in: 'DS:DX = path' },
      { fn: 0x3c, name: 'Create (or truncate) a file', in: 'DS:DX = name, CX = attributes (0 normal)', out: 'AX = handle' },
      { fn: 0x3d, name: 'Open a file', in: 'DS:DX = name, AL = 0 read, 1 write, 2 both', out: 'AX = handle' },
      { fn: 0x3e, name: 'Close a handle', in: 'BX = handle' },
      { fn: 0x3f, name: 'Read from a handle', in: 'BX = handle, CX = bytes, DS:DX = buffer', out: 'AX = bytes read (0 at end of file)', note: 'Handle 0 is the keyboard.' },
      { fn: 0x40, name: 'Write to a handle', in: 'BX = handle, CX = bytes, DS:DX = buffer', out: 'AX = bytes written', note: 'Handle 1 is the screen, 2 the error output.' },
      { fn: 0x41, name: 'Delete a file', in: 'DS:DX = name' },
      { fn: 0x42, name: 'Seek', in: 'BX = handle, AL = 0 from start / 1 current / 2 end, CX:DX = offset', out: 'DX:AX = new position' },
      { fn: 0x43, name: 'Get / set file attributes', in: 'DS:DX = name, AL = 0 get / 1 set (CX)', out: 'CX = attributes' },
      { fn: 0x44, name: 'IOCTL', in: 'AL = subfunction, BX = handle', note: 'AL=0: device information in DX (bit 7: a device, not a file).' },
      { fn: 0x45, name: 'Duplicate a handle', in: 'BX = handle', out: 'AX = new handle' },
      { fn: 0x47, name: 'Get the current directory', in: 'DL = drive (0 = default), DS:SI = 64-byte buffer', out: 'the path without the drive and leading backslash' },
      { fn: 0x48, name: 'Allocate memory', in: 'BX = paragraphs (16 bytes each)', out: 'AX = segment; on error BX = largest available' },
      { fn: 0x49, name: 'Free memory', in: 'ES = segment' },
      { fn: 0x4a, name: 'Resize a memory block', in: 'ES = segment, BX = new size in paragraphs', note: 'A .COM owns all free memory at start: shrink it with this before allocating.' },
      { fn: 0x4b, name: 'Load and run a program (EXEC)', in: 'DS:DX = name, ES:BX = parameter block, AL = 0', note: 'Free memory first (4Ah); save SS:SP around it.' },
      { fn: 0x4c, name: 'Exit', in: 'AL = return code (ERRORLEVEL)' },
      { fn: 0x4d, name: 'Get the return code of the last child', out: 'AL = code, AH = how it ended' },
      { fn: 0x4e, name: 'Find the first matching file', in: 'DS:DX = pattern (wildcards), CX = attributes', out: 'the DTA holds the entry: name at offset 1Eh, size at 1Ah', note: 'CF=1 when nothing matches.' },
      { fn: 0x4f, name: 'Find the next matching file', out: 'the DTA again; CF=1 when there are no more' },
      { fn: 0x56, name: 'Rename / move a file', in: 'DS:DX = old name, ES:DI = new name' },
      { fn: 0x57, name: 'Get / set a file\'s time and date', in: 'BX = handle, AL = 0 get / 1 set (CX time, DX date)' },
      { fn: 0x5b, name: 'Create a new file (fails if it exists)', in: 'DS:DX = name, CX = attributes', out: 'AX = handle' },
      { fn: 0x62, name: 'Get the PSP segment', out: 'BX = segment' },
    ],
  },
  {
    int: 0x10, title: 'BIOS video', note: 'Function in AH. Text screens: 80×25, attribute = background × 16 + foreground.',
    fns: [
      { fn: 0x00, name: 'Set the video mode', in: 'AL = mode: 03h text 80×25 16 colours, 13h graphics 320×200×256, 12h 640×480×16, 07h mono text', note: 'Clears the screen.' },
      { fn: 0x01, name: 'Set the cursor shape', in: 'CH = start scanline, CL = end (CH bit 5 set hides it)' },
      { fn: 0x02, name: 'Set the cursor position', in: 'BH = page, DH = row, DL = column' },
      { fn: 0x03, name: 'Get the cursor position', in: 'BH = page', out: 'DH = row, DL = column, CX = shape' },
      { fn: 0x05, name: 'Select the active page', in: 'AL = page' },
      { fn: 0x06, name: 'Scroll a window up', in: 'AL = lines (0 = clear), BH = attribute, CH/CL = top-left row/col, DH/DL = bottom-right', note: 'AH=07h scrolls down.' },
      { fn: 0x08, name: 'Read the character and attribute at the cursor', in: 'BH = page', out: 'AL = character, AH = attribute' },
      { fn: 0x09, name: 'Write a character with an attribute', in: 'AL = character, BL = attribute, BH = page, CX = count', note: 'The cursor does not move.' },
      { fn: 0x0a, name: 'Write a character', in: 'AL = character, BH = page, CX = count' },
      { fn: 0x0b, name: 'Set the palette / border', in: 'BH = 0 border colour in BL; BH = 1 CGA palette BL' },
      { fn: 0x0c, name: 'Write a pixel', in: 'AL = colour, CX = x, DX = y, BH = page' },
      { fn: 0x0d, name: 'Read a pixel', in: 'CX = x, DX = y', out: 'AL = colour' },
      { fn: 0x0e, name: 'Teletype output', in: 'AL = character, BL = colour (graphics modes)', note: 'Moves the cursor, honours CR, LF, BS, BEL.' },
      { fn: 0x0f, name: 'Get the video mode', out: 'AL = mode, AH = columns, BH = page' },
      { fn: 0x10, name: 'Palette and DAC', in: 'AL = 10h set one DAC register (BX = index, DH/CH/CL = R/G/B 0..63); 12h set a block (ES:DX, BX first, CX count)' },
      { fn: 0x11, name: 'Fonts', in: 'AL = 10h load a user font (ES:BP), 12h 8×8 (50 lines), 14h 8×16 (25 lines)' },
      { fn: 0x12, name: 'EGA/VGA information', in: 'BL = 10h', out: 'BH = 0 colour / 1 mono, BL = memory size' },
      { fn: 0x13, name: 'Write a string', in: 'ES:BP = string, CX = length, DH/DL = row/col, BL = attribute, AL = 1 to move the cursor' },
      { fn: 0x1a, name: 'Display combination code', in: 'AL = 0', out: 'BL = active display (8 = VGA colour)' },
    ],
  },
  {
    int: 0x16, title: 'BIOS keyboard',
    fns: [
      { fn: 0x00, name: 'Wait for a key', out: 'AL = ASCII (0 for special keys), AH = scan code' },
      { fn: 0x01, name: 'Check for a key', out: 'ZF=1 none; else AL/AH as above, the key stays in the buffer' },
      { fn: 0x02, name: 'Shift flags', out: 'AL = bits: 0 right Shift, 1 left Shift, 2 Ctrl, 3 Alt, 4 Scroll, 5 Num, 6 Caps, 7 Insert' },
      { fn: 0x10, name: 'Wait for a key (extended keyboard)', out: 'as 00h; F11/F12 and others distinguishable' },
      { fn: 0x11, name: 'Check for a key (extended)', out: 'as 01h' },
    ],
  },
  {
    int: 0x33, title: 'Mouse driver', note: 'Function in AX (whole register). Needs a mouse driver; DOSBox-X has one built in.',
    fns: [
      { fn: 0x0000, ax: true, name: 'Reset and check', out: 'AX = FFFFh if a mouse is present, BX = buttons' },
      { fn: 0x0001, ax: true, name: 'Show the cursor' },
      { fn: 0x0002, ax: true, name: 'Hide the cursor', note: 'Hide before drawing on the screen, show after.' },
      { fn: 0x0003, ax: true, name: 'Position and buttons', out: 'CX = x, DX = y (in pixels, text mode ×8), BX = buttons (bit 0 left, 1 right)' },
      { fn: 0x0004, ax: true, name: 'Set the position', in: 'CX = x, DX = y' },
      { fn: 0x0007, ax: true, name: 'Set the horizontal range', in: 'CX = min, DX = max' },
      { fn: 0x0008, ax: true, name: 'Set the vertical range', in: 'CX = min, DX = max' },
      { fn: 0x000c, ax: true, name: 'Set an event handler', in: 'CX = event mask, ES:DX = handler (gets AX event, BX buttons, CX/DX position)' },
    ],
  },
  {
    int: 0x1a, title: 'BIOS time',
    fns: [
      { fn: 0x00, name: 'Ticks since midnight', out: 'CX:DX = ticks (18.2 per second), AL = 1 if midnight passed', note: 'The usual way to time something or seed a random number.' },
      { fn: 0x02, name: 'Real-time clock time', out: 'CH = hour, CL = minute, DH = second (BCD)' },
      { fn: 0x04, name: 'Real-time clock date', out: 'CH = century, CL = year, DH = month, DL = day (BCD)' },
    ],
  },
  {
    int: 0x13, title: 'BIOS disk', note: 'Low level; DOS programs normally use INT 21h file functions instead.',
    fns: [
      { fn: 0x00, name: 'Reset the disk', in: 'DL = drive (80h = first hard disk)' },
      { fn: 0x02, name: 'Read sectors', in: 'AL = count, CH = cylinder, CL = sector (1-based), DH = head, DL = drive, ES:BX = buffer', out: 'CF=1 on error, AH = status' },
      { fn: 0x03, name: 'Write sectors', in: 'as 02h', note: 'Dangerous on a real disk.' },
    ],
  },
  {
    int: 0x15, title: 'BIOS system',
    fns: [
      { fn: 0x86, name: 'Wait', in: 'CX:DX = microseconds' },
      { fn: 0x88, name: 'Extended memory size', out: 'AX = KB above 1 MB' },
    ],
  },
  {
    int: 0x08, title: 'Timer tick (hardware IRQ 0)', note: 'Fires 18.2 times a second; INT 1Ch is the hook DOS programs chain into (vector 1Ch via INT 21h 25h/35h). A handler must be short, save every register it uses, and end with IRET.',
    fns: [],
  },
  {
    int: 0x09, title: 'Keyboard (hardware IRQ 1)', note: 'Fires on every key press and release with the scan code at port 60h; chain to the old handler or acknowledge with OUT 20h, 20h.',
    fns: [],
  },
]

/** The entry for an INT number and the AH (or AX) value, if known. */
export function lookupInt(int: number, ax: number): { vector: IntVector; fn?: IntFn } | null {
  const vector = INTERRUPTS.find((v) => v.int === int)
  if (!vector) return null
  const fn = vector.fns.find((f) => (f.ax ? f.fn === ax : f.fn === (ax >> 8)))
  return { vector, fn }
}

export const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0') + 'h'
