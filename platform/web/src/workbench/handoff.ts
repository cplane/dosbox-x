// The handoff between the two views. Screen: the file open in the workbench's editor goes to its IDE on the box
// (Turbo Pascal, Turbo C++, QBX). Workbench: an IDE on the box is saved and quit, and the file it had open comes
// to the editor, so nothing on the box keeps the keyboard from the workbench's own build and debug.
import { listFiles, pressKeys, runCommand, screenText, typeText } from '../api/client'

export interface Ide {
  /** What the box reports as the running program. */
  program: string
  exe: string
  /** Keys that save the file, then keys that quit (each pressed in turn). */
  save: string[]
  quit: string[]
}

const IDES: Ide[] = [
  { program: 'TURBO', exe: 'C:\\TP70\\TURBO.EXE', save: ['f2', 'esc'], quit: ['alt+x'] },
  { program: 'TC', exe: 'C:\\TCC\\TC.EXE', save: ['f2', 'esc'], quit: ['alt+x'] },
  { program: 'QBX', exe: 'C:\\QBX\\BIN\\QBX.EXE', save: ['alt+f', 's', 'esc'], quit: ['alt+f', 'x'] },
]

const IDE_BY_EXT: Record<string, string> = { pas: 'TURBO', c: 'TC', cpp: 'TC', h: 'TC', bas: 'QBX' }

export function ideFor(path: string): Ide | undefined {
  const ext = path.toLowerCase().replace(/^.*\./, '')
  const program = IDE_BY_EXT[ext]
  return IDES.find((i) => i.program === program)
}

export const ideByProgram = (program: string | undefined): Ide | undefined =>
  program ? IDES.find((i) => i.program === program.toUpperCase()) : undefined

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The DOS prompt, when DOS is at one within `ms` (e.g. "C:\TP70>"); null otherwise. */
export async function promptWithin(boxId: string, ms: number): Promise<string | null> {
  const until = Date.now() + ms
  do {
    try {
      const r = await runCommand(boxId, 'ECHO.', 4000)
      if (!r.timed_out) return r.prompt
    } catch { /* a program has the keyboard */ }
    await wait(400)
  } while (Date.now() < until)
  return null
}

/**
 * Opens `path` (a workbench path like "TP70/QSORT.PAS") in its IDE on the box. Resolves to a message when it
 * could not (no IDE for the file, the IDE is not installed, DOS not at a prompt), else null.
 */
export async function openInIde(boxId: string, path: string): Promise<string | null> {
  const ide = ideFor(path)
  if (!ide) return `no IDE on the box for ${path.split('/').pop()}`
  const dir = ide.exe.slice(3, ide.exe.lastIndexOf('\\')).replace(/\\/g, '/')
  const exeName = ide.exe.slice(ide.exe.lastIndexOf('\\') + 1)
  try {
    const entries = await listFiles(boxId, dir)
    if (!entries.some((e) => e.name.toUpperCase() === exeName)) return `${ide.exe} is not on the box`
  } catch {
    return `${ide.exe} is not on the box`
  }
  if (!(await promptWithin(boxId, 1500))) return 'DOS is not at a prompt: the IDE was not opened'
  await typeText(boxId, `${ide.exe} C:\\${path.replace(/\//g, '\\')}\n`)
  return null
}

const FILE_RE = /([A-Z0-9_$~!#%&()@^'{}-]+(?:\\[A-Z0-9_$~!#%&()@^'{}-]+)*\.(?:PAS|CPP|C|H|BAS|ASM|INC))\b/i

/**
 * Saves and quits the IDE that has the keyboard and returns the workbench path of the file it had open
 * (from its title row), or null when there was none to tell. Throws when the IDE did not quit.
 */
export async function leaveIde(boxId: string, ide: Ide): Promise<string | null> {
  let title: string | null = null
  try {
    // Every window's frame names its file; the active one is drawn with double lines (╔═ … ═╗), the others
    // single, so it wins when several are open.
    let fallback: string | null = null
    for (const row of (await screenText(boxId)).split('\n')) {
      const m = FILE_RE.exec(row)
      if (!m || /NONAME/i.test(m[1])) continue
      if (row.includes('╔')) { title = m[1].toUpperCase(); break }
      fallback ??= m[1].toUpperCase()
    }
    title ??= fallback
  } catch { /* graphics mode or no screen: no file to carry over */ }
  for (const combo of [...ide.save, ...ide.quit]) {
    await pressKeys(boxId, combo)
    await wait(500)
  }
  let prompt = await promptWithin(boxId, 2500)
  if (!prompt) {
    // A "save changes?" question in the way: no, the save keys already ran.
    await pressKeys(boxId, 'n')
    prompt = await promptWithin(boxId, 2500)
  }
  if (!prompt) throw new Error(`${ide.program} did not quit: close it in the Screen view`)
  if (!title) return null
  // The title is a bare name or a path without the drive (TURBO shows "TP70\QSORT.PAS"); bare names are in
  // DOS's current directory, which the prompt names.
  const cwd = prompt.replace(/^[A-Z]:\\?/i, '').replace(/>$/, '')
  const rel = title.includes('\\') ? title : (cwd ? `${cwd}\\${title}` : title)
  return rel.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** Ends a loose program with Ctrl+C / Ctrl+Break; true when DOS is at a prompt afterwards. */
export async function breakProgram(boxId: string): Promise<boolean> {
  for (const combo of ['ctrl+c', 'ctrl+pause', 'ctrl+c']) {
    try { await pressKeys(boxId, combo) } catch { /* keep trying */ }
    if (await promptWithin(boxId, 900)) return true
  }
  return false
}
