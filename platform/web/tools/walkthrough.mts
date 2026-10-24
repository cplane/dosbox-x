// Make walkthroughs of the guide's runnable examples: each is assembled on a box, run under the debugger one
// instruction at a time, and the machine's state before every instruction is saved as JSON in
// src/workbench/walks/ (see src/workbench/walks.ts for the format).
//
//   KUBECTL_PORT_FORWARD_WEBSOCKETS=true kubectl -n dosbox port-forward pod/dosbox-test 18099:8080
//   npx esbuild tools/walkthrough.mts --bundle --platform=node --format=esm --outfile=tools/.walkthrough.mjs
//   node tools/.walkthrough.mjs MOV            # the article's runnable examples
//   node tools/.walkthrough.mjs MOV:9          # one snippet (its index in the article's body)
//
// The box's sidecar (POD, default http://localhost:18099) runs the assembler and answers the debugger's RPC.
import { mkdirSync, writeFileSync } from 'node:fs'
import { ARTICLES, findArticle, type Block } from '../src/workbench/articles'
import { wrapExample } from '../src/workbench/guide'
import { parseListing } from '../src/workbench/listing'
import { walkName, walkSource, type Walk, type WalkState, type WalkVar } from '../src/workbench/walks'

const POD = process.env.POD ?? 'http://localhost:18099'
const OUT = new URL('../src/workbench/walks/', import.meta.url)
const LIMIT = Number(process.env.LIMIT ?? 400) // states kept at most
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
  try {
    while (states.length < LIMIT) {
      const r = regsOf(await A<Registers>('state.get_registers', { session_id: sid }))
      const [cs, ip, sp, ss] = [r[8], r[12], r[7], r[11]]
      if (!states.length) seg = cs
      const d = (await A<{ lines: { bytes: string; text: string }[] }>('code.disassemble', { session_id: sid, address: at(cs, ip), count: 1 })).lines[0]
      const wl = cs === seg ? map.lineOf.get(ip) : undefined
      states.push({
        r, line: wl !== undefined ? shown(wl) : -1, text: d?.text.trim() ?? '', bytes: d?.bytes ?? '',
        data: hex(await read(sid, seg, dataAt, Math.min(512, end - dataAt))),
        stack: hex(await read(sid, ss, sp, Math.min(32, 0x10000 - sp))),
        out, acc,
      })
      // Into the program's own code; over a call into DOS or the BIOS (INT), which is one step here.
      const int = /^int\s+([0-9a-f]+)/i.exec(d?.text.trim() ?? '')
      if (int) out += await printed(sid, parseInt(int[1], 16), r)
      try {
        await A('execution.step', { session_id: sid, mode: int ? 'over' : 'into' })
      } catch (err) {
        if ((err as { data?: { state?: string } }).data?.state === 'exited') { how = 'exited'; break }
        throw err
      }
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
  try {
    const w = await walk(a.key, j, b, a.title)
    writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(w))
    console.log(`${name}: ${w.states.length} states, ${w.end}, printed ${JSON.stringify(w.states.at(-1)?.out ?? '')}`)
  } catch (err) {
    console.log(`${name}: FAILED ${err instanceof Error ? err.message : err}`)
  }
}
