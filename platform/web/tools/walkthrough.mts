// Make walkthroughs of the guide's runnable examples: each is assembled on a box, run under the debugger one
// instruction at a time, and the machine's state before every instruction is saved as JSON in
// src/workbench/walks/ (see src/workbench/walks.ts for the format).
//
//   KUBECTL_PORT_FORWARD_WEBSOCKETS=true kubectl -n dosbox port-forward pod/dosbox-test 18099:8080
//   npx esbuild tools/walkthrough.mts --bundle --platform=node --format=esm --outfile=tools/.walkthrough.mjs
//   node tools/.walkthrough.mjs MOV            # the article's runnable examples
//   node tools/.walkthrough.mjs MOV:9          # one snippet (its index in the article's body)
//   node tools/.walkthrough.mjs                # every runnable example (FORCE=1 remakes walks that are current)
//
// An example that runs longer than LIMIT instructions is walked that far, then left to run to its own end (so it
// puts back whatever it hooked). Code outside the program (an interrupt handler the BIOS runs) is stepped over.
// The box's sidecar (POD, default http://localhost:18099) runs the assembler and answers the debugger's RPC.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ARTICLES, findArticle, type Block } from '../src/workbench/articles'
import { wrapExample } from '../src/workbench/guide'
import { parseListing } from '../src/workbench/listing'
import { walkName, walkSource, type Walk, type WalkState, type WalkVar } from '../src/workbench/walks'

const POD = process.env.POD ?? 'http://localhost:18099'
const OUT = new URL('../src/workbench/walks/', import.meta.url)
const LIMIT = Number(process.env.LIMIT ?? 400) // states kept at most
const OUTSIDE = 3000 // instructions outside the program before the walk gives up and lets it run
const PASSES = Number(process.env.PASSES ?? 12) // passes of a loop recorded before the rest runs at full speed
const DIR = 'WALK'

let rpcId = Math.floor(Math.random() * 1e9)
async function A<T = any>(method: string, params: object = {}): Promise<T> {
  const r = await fetch(`${POD}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
  const j = await r.json() as { result?: T; error?: { message: string; data?: { state?: string } } }
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data })
  return j.result as T
}
const run = async (cmd: string, ms = 60000) => {
  const r = await fetch(`${POD}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, timeout_ms: ms }) })
  return r.json() as Promise<{ output?: string; error?: string; errorlevel?: number }>
}
const enter = () => fetch(`${POD}/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ combo: 'enter' }) })
const put = async (name: string, body: string | Buffer) => {
  const r = await fetch(`${POD}/files/${DIR}/${name}`, { method: 'PUT', body })
  if (!r.ok) throw new Error(`upload ${name}: HTTP ${r.status}`)
}
const get = async (name: string) => {
  const r = await fetch(`${POD}/files/${DIR}/${name}`)
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
const seg4 = (n: number) => '0x' + (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')
const off8 = (n: number) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
const at = (seg: number, off: number) => ({ space: 'segmented', segment: seg4(seg), offset: off8(off) })
const read = async (sid: string, seg: number, off: number, len: number) =>
  len <= 0 ? Buffer.alloc(0) : Buffer.from((await A<{ data_base64: string }>('memory.read', { session_id: sid, address: at(seg, off), length: len })).data_base64, 'base64')
const hex = (b: Buffer) => b.toString('hex')

interface Registers { general: Record<string, string>; segments: Record<string, string>; instruction_pointer: string; flags: string }
const regsOf = (r: Registers) => {
  const g = (k: string) => parseInt(r.general[k] ?? '0', 16) & 0xffff
  const s = (k: string) => parseInt(r.segments[k] ?? '0', 16) & 0xffff
  return [g('eax'), g('ebx'), g('ecx'), g('edx'), g('esi'), g('edi'), g('ebp'), g('esp'), s('cs'), s('ds'), s('es'), s('ss'), parseInt(r.instruction_pointer, 16) & 0xffff, parseInt(r.flags, 16) & 0xffff]
}

async function endSessions() {
  try {
    const s = await A<{ session_id: string; state: string }>('session.status')
    if (s.state === 'running') { try { const op = await A<{ operation_id: string }>('execution.pause', { session_id: s.session_id }); await A('execution.wait', { session_id: s.session_id, operation_id: op.operation_id, timeout_ms: 3000 }) } catch { /* stopped anyway */ } }
    if (s.state === 'running' || s.state === 'stopped') {
      const op = await A<{ operation_id: string }>('session.stop', { session_id: s.session_id })
      await A('execution.wait', { session_id: s.session_id, operation_id: op.operation_id, timeout_ms: 5000 }).catch(() => undefined)
    }
  } catch { /* no session */ }
}

/** What an INT about to run prints (DOS 02h, 06h, 09h, 40h to handles 1 and 2; BIOS teletype 0Eh). */
async function printed(sid: string, int: number, r: number[]): Promise<string> {
  const [ax, bx, cx, dx, , , , , , ds] = r
  const ah = ax >> 8
  if (int === 0x10 && ah === 0x0e) return String.fromCharCode(ax & 0xff)
  if (int !== 0x21) return ''
  if (ah === 0x02 || (ah === 0x06 && (dx & 0xff) !== 0xff)) return String.fromCharCode(dx & 0xff)
  if (ah === 0x09) { const b = await read(sid, ds, dx, Math.min(1024, 0x10000 - dx)); const end = b.indexOf(0x24); return b.subarray(0, end < 0 ? 0 : end).toString('latin1') }
  if (ah === 0x40 && (bx === 1 || bx === 2)) return (await read(sid, ds, dx, Math.min(cx, 1024))).toString('latin1')
  return ''
}

async function walk(key: string, index: number, b: Extract<Block, { code: string[] }>, title: string): Promise<Walk> {
  const source = wrapExample(title, b.code, b.data)
  const lines = source.split('\r\n')
  // Wrapped line (1-based) -> the snippet's line as shown: code from line 6, two exit lines, then the data.
  const shown = (w: number) => {
    const i = w - 6
    if (i >= 0 && i < b.code.length) return i
    const j = i - b.code.length - 2
    return j >= 0 && j < (b.data?.length ?? 0) ? b.code.length + 1 + j : -1
  }
  await put('W.ASM', source)
  await fetch(`${POD}/rescan`, { method: 'POST' })
  await run('C:')
  await run(`CD \\${DIR}`)
  // ML finds LINK through PATH: set here, not left to whatever the box's shell has (a restarted box has none).
  await run('SET PATH=C:\\MASM611\\BIN;C:\\MASM611\\BINR;Z:\\')
  const asm = await run('C:\\MASM611\\BIN\\ML.EXE /AT /Fl /nologo W.ASM', 120000)
  if (asm.errorlevel) throw new Error(`assembly failed: ${asm.output ?? asm.error}`)
  const map = parseListing((await get('W.LST')).toString('latin1'), source)
  const end = 0x100 + (await get('W.COM')).length

  // The variables: the names the data lines define, at the offsets the listing gives them.
  const vars: WalkVar[] = []
  lines.forEach((l, i) => {
    const m = /^([A-Za-z_][\w]*)\s+(DB|DW|DD)\b/i.exec(l)
    const off = m && map.offsetOf.get(i + 1)
    if (m && off !== undefined) vars.push({ name: m[1], offset: off, unit: { DB: 1, DW: 2, DD: 4 }[m[2].toUpperCase() as 'DB'] ?? 1, length: 0 })
  })
  vars.sort((x, y) => x.offset - y.offset)
  vars.forEach((v, i) => { v.length = (vars[i + 1]?.offset ?? end) - v.offset })
  const dataAt = vars[0]?.offset ?? end

  await endSessions()
  const s = await A<{ session_id: string }>('session.start', { target: { command: 'W.COM', arguments: [] }, mounts: [{ drive: 'C', host_path: '/data/c' }], break_at: 'entry' })
  const sid = s.session_id
  const states: WalkState[] = []
  let out = ''
  let acc: WalkState['acc'] = []
  let how = 'limit'
  let seg = 0
  let outside = 0
  // A machine state seen again: the program waits in a loop for something outside it (the timer, a key). The
  // state's key -> the first state it was.
  let seen = new Map<string, number>()
  let waited = false
  // A loop that counts (a delay, a long copy): after PASSES passes the rest at full speed. Per instruction, how
  // often it ran and the state it last was; the loops skipped so far, by their first instruction: one met again
  // (an inner loop inside an outer one) is skipped on its second pass.
  const visits = new Map<number, number>()
  const lastAt = new Map<number, number>()
  const skipped = new Set<number>()
  const step = async (mode: 'into' | 'over') => {
    try {
      await A('execution.step', { session_id: sid, mode })
      return true
    } catch (err) {
      if ((err as { data?: { state?: string } }).data?.state === 'exited') return false
      throw err
    }
  }
  // Past the limit: the rest of the program at full speed, to its own end.
  const runOut = async () => {
    const op = await A<{ operation_id: string }>('execution.continue', { session_id: sid })
    for (let i = 0; i < 30; i++) {
      const w = await A<{ running: boolean; state?: string }>('execution.wait', { session_id: sid, operation_id: op.operation_id, timeout_ms: 1000 }).catch((e) => ({ running: false, state: (e as { data?: { state?: string } }).data?.state ?? 'exited' }))
      if (!w.running) return
    }
    throw new Error('did not end within 30 s of running on')
  }
  // Out of a waiting loop at full speed: a breakpoint on every instruction of the example outside the loop, run to
  // the first one reached. False when the program ended meanwhile.
  const skipLoop = async (loop: Set<number>) => {
    const ids: string[] = []
    for (const off of map.lineOf.keys()) {
      if (off < dataAt && !loop.has(off)) ids.push((await A<{ breakpoint_id: string }>('breakpoints.create', { session_id: sid, kind: 'execution', address: at(seg, off) })).breakpoint_id)
    }
    const op = await A<{ operation_id: string }>('execution.continue', { session_id: sid })
    let running = true, ended = false
    for (let i = 0; i < 30 && running; i++) {
      const w = await A<{ running: boolean; state?: string; session?: { state?: string } }>('execution.wait', { session_id: sid, operation_id: op.operation_id, timeout_ms: 1000 })
        .catch((e) => ({ running: false, state: (e as { data?: { state?: string } }).data?.state ?? 'exited' }) as { running: boolean; state?: string; session?: { state?: string } })
      running = w.running
      ended = !running && (w.session?.state ?? w.state) === 'exited'
    }
    if (running) throw new Error('still waiting after 30 s')
    if (!ended) for (const id of ids) await A('breakpoints.delete', { session_id: sid, breakpoint_id: id }).catch(() => undefined)
    return !ended
  }
  try {
    for (;;) {
      const r = regsOf(await A<Registers>('state.get_registers', { session_id: sid }))
      const [cs, ip, sp, ss] = [r[8], r[12], r[7], r[11]]
      if (!states.length) seg = cs
      if (cs !== seg) {
        // An interrupt handler outside the program (the timer's, the keyboard's): over it, unrecorded.
        if (++outside > OUTSIDE) { await runOut(); how = 'limit'; break }
        if (!await step('over')) { how = 'exited'; break }
        continue
      }
      outside = 0
      if (states.length >= LIMIT) { await runOut(); break }
      const data = hex(await read(sid, seg, dataAt, Math.min(512, end - dataAt)))
      const stack = hex(await read(sid, ss, sp, Math.min(32, 0x10000 - sp)))
      const key = `${r.join(',')}|${data}|${stack}`
      const first = seen.get(key)
      if (first !== undefined && states.length - first >= 1) {
        // Round the loop once with nothing changed: the rest of its passes at full speed.
        const loop = new Set(states.slice(first).map((x) => x.r[12]))
        if (!await skipLoop(loop)) { how = 'exited'; break }
        seen = new Map()
        waited = true
        acc = []
        continue
      }
      seen.set(key, states.length)
      const v = (visits.get(ip) ?? 0) + 1
      const prev = lastAt.get(ip)
      // (Not a loop that calls DOS or the BIOS: what it prints is worked out step by step, all of it is kept.)
      const body = prev !== undefined ? states.slice(prev) : []
      if (prev !== undefined && !body.some((x) => /^int\s/i.test(x.text)) && (v > PASSES || (skipped.has(ip) && states.length - prev < 64))) {
        const loop = new Set(body.map((x) => x.r[12]))
        if (!await skipLoop(loop)) { how = 'exited'; break }
        skipped.add(ip)
        // Its instructions start afresh (entered again, it gets one pass); the counts of an outer loop go on.
        for (const x of loop) lastAt.delete(x)
        seen = new Map()
        waited = true
        acc = []
        continue
      }
      visits.set(ip, v)
      lastAt.set(ip, states.length)
      const d = (await A<{ lines: { bytes: string; text: string }[] }>('code.disassemble', { session_id: sid, address: at(cs, ip), count: 1 })).lines[0]
      const wl = cs === seg ? map.lineOf.get(ip) : undefined
      states.push({
        r, line: wl !== undefined ? shown(wl) : -1, text: d?.text.trim() ?? '', bytes: d?.bytes ?? '',
        data, stack, out, acc, ...(waited ? { waited: true } : {}),
      })
      waited = false
      // Into the program's own code; over a call into DOS or the BIOS (INT), which is one step here.
      const int = /^int\s+([0-9a-f]+)/i.exec(d?.text.trim() ?? '')
      if (int) out += await printed(sid, parseInt(int[1], 16), r)
      if (!await step(int ? 'over' : 'into')) { how = 'exited'; break }
      // What it touched in the program's segment. Over an INT only the example's data counts (DOS reading the string
      // it prints, a buffer it fills): its own bookkeeping on the stack and in the PSP is not the example's.
      const a = await A<{ accesses: { address: string; size: number; kind: string }[] }>('memory.accesses', { session_id: sid }).catch(() => ({ accesses: [] }))
      const [lo, hi] = int ? [seg * 16 + dataAt, seg * 16 + end] : [seg * 16, seg * 16 + 0x10000]
      acc = a.accesses.map((x) => [parseInt(x.address, 16), x.size, x.kind === 'write' ? 1 : 0] as [number, number, number])
        .filter(([lin]) => lin >= lo && lin < hi).slice(0, 16)
    }
  } finally {
    await endSessions()
    await enter() // a fresh DOS prompt for the next run
  }
  return { v: 1, src: walkSource(b.code, b.data), seg, dataAt, vars, states, end: how }
}

mkdirSync(OUT, { recursive: true })
const wanted = process.argv.slice(2)
const targets = (wanted.length ? wanted : ARTICLES.map((a) => a.key)).flatMap((w) => {
  const [k, i] = w.split(':')
  const a = findArticle(k)
  if (!a) { console.log(`?? ${k}`); return [] }
  return a.body.flatMap((b, j) => ('code' in b && b.run && (i === undefined || Number(i) === j) ? [{ a, j, b }] : []))
})
for (const { a, j, b } of targets) {
  const name = walkName(a.key, j)
  const file = new URL(`${name}.json`, OUT)
  if (!process.env.FORCE && existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as Walk).src === walkSource(b.code, b.data)) { console.log(`${name}: current`); continue }
  const t0 = Date.now()
  try {
    const w = await walk(a.key, j, b, a.title)
    writeFileSync(file, JSON.stringify(w))
    console.log(`${name}: ${w.states.length} states, ${w.end}, ${((Date.now() - t0) / 1000).toFixed(0)} s, printed ${JSON.stringify((w.states.at(-1)?.out ?? '').slice(0, 60))}`)
  } catch (err) {
    console.log(`${name}: FAILED ${err instanceof Error ? err.message : err}`)
  }
}
