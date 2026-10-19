import { refresh } from './auth'

/** The server said "sign in" (as opposed to "no"). */
export class NeedsSignIn extends Error {}

export type BoxState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

/** What a box emulates; empty fields are DOSBox-X's defaults (486-class, 16 MB, auto). */
export interface Machine {
  cpu?: '' | 'auto' | '8086' | '186' | '286' | '386' | '486' | 'pentium'
  memoryMB?: number
  cycles?: string
}

export interface Box {
  id: string
  owner: string
  name: string
  createdAt: string
  lastActiveAt: string
  diskLimitMB: number
  usedBytes: number
  machine: Machine
  state: BoxState
  reason?: string
  viewers: number
}

export interface Limits {
  maxBoxesPerUser: number
  maxRunningPerUser: number
  diskLimitMB: number
  idleMinutes: number
}

export interface FileEntry {
  name: string
  size: number
  dir: boolean
  mtime: string
}

/**
 * A request that survives an expired access token: the gateway answers 401
 * to a stale access cookie, so refresh once (single-flight) and retry.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const opts: RequestInit = { credentials: 'include', ...init }
  const response = await fetch(path, opts)
  if (response.status !== 401) return response
  try {
    await refresh()
  } catch {
    return response
  }
  return fetch(path, opts)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }))
    const message = body.error ?? `request failed with ${response.status}`
    throw response.status === 401 ? new NeedsSignIn(message) : new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const box = (id: string) => `/api/boxes/${encodeURIComponent(id)}`

export const limits = async () => json<Limits>(await request('/api/config'))
export const listBoxes = async () => json<Box[]>(await request('/api/boxes'))
export const getBox = async (id: string) => json<Box>(await request(box(id)))

export async function createBox(name: string, items: string[] = [], machine: Machine = {}): Promise<Box> {
  return json<Box>(await request('/api/boxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, items, machine }),
  }))
}

/** Changes what a stopped box emulates (applies at its next start). */
export async function setMachine(id: string, machine: Machine): Promise<Box> {
  return json<Box>(await request(box(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine }),
  }))
}

export const startBox = async (id: string) => json<Box>(await request(`${box(id)}/start`, { method: 'POST' }))
export const stopBox = async (id: string) => json<Box>(await request(`${box(id)}/stop`, { method: 'POST' }))
export const deleteBox = async (id: string) => json<void>(await request(box(id), { method: 'DELETE' }))

/** Types text into the box (US layout; \n = Enter). */
export async function typeText(id: string, text: string): Promise<void> {
  await json(await request(`${box(id)}/ctl/type`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text,
  }))
}

export const snapshotURL = (id: string) => `${box(id)}/ctl/snapshot.png`

export interface RunResult {
  output: string
  errorlevel?: number
  ms: number
  timed_out: boolean
  prompt: string
  /** Where the output came from: DOS's CON writes, or the screen's text. */
  source: 'con' | 'screen'
  /** The console stream was overrun: output is only its tail. */
  truncated?: boolean
}

/** Runs one command line at the DOS prompt and returns what it printed. */
export async function runCommand(id: string, cmd: string, timeoutMs = 120000): Promise<RunResult> {
  return json<RunResult>(await request(`${box(id)}/ctl/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, timeout_ms: timeoutMs }),
  }))
}

/** The text screen as plain text (409 in graphics modes). */
export async function screenText(id: string): Promise<string> {
  const response = await request(`${box(id)}/ctl/screen.txt`)
  if (!response.ok) throw new Error(response.status === 409 ? 'the screen is in a graphics mode' : `screen.txt: ${response.status}`)
  return response.text()
}

const filePath = (id: string, path: string) =>
  `${box(id)}/files/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`

export const listFiles = async (id: string, dir: string) => json<FileEntry[]>(await request(filePath(id, dir)))
export const downloadURL = (id: string, path: string) => `${filePath(id, path)}?download=1`

export async function uploadFile(id: string, path: string, file: Blob): Promise<void> {
  await json(await request(filePath(id, path), { method: 'PUT', body: file }))
}

/**
 * A DOS text file as a string: each byte becomes the character with that
 * code (latin1), so saving it back with writeTextFile keeps every byte,
 * including CP437 box-drawing characters, exactly as it was.
 */
export async function readTextFile(id: string, path: string): Promise<string> {
  const response = await request(filePath(id, path))
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return new TextDecoder('latin1').decode(await response.arrayBuffer())
}

/** Writes a string read with readTextFile (characters above 0xFF become '?'). */
export async function writeTextFile(id: string, path: string, text: string): Promise<void> {
  const bytes = Uint8Array.from(text, (c) => { const n = c.charCodeAt(0); return n > 0xff ? 0x3f : n })
  await uploadFile(id, path, new Blob([bytes]))
}

export async function deleteFile(id: string, path: string, recursive: boolean): Promise<void> {
  await json(await request(filePath(id, path) + (recursive ? '?recursive=1' : ''), { method: 'DELETE' }))
}

/** The player's WebSocket URL; the session cookie authenticates it. */
export function wsURL(id: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${box(id)}/ws`
}

// ---- catalog: ready-made software copied onto a box's C: drive

export type CatalogStatus = 'ready' | 'importing' | 'failed'

export interface CatalogItem {
  slug: string
  title: string
  category: string
  description: string
  dir: string
  run: string
  source: string
  license: string
  sizeBytes: number
  files: number
  status: CatalogStatus
  error?: string
}

export const listCatalog = async () => json<CatalogItem[]>(await request('/api/catalog'))

export async function attachItems(id: string, items: string[]): Promise<void> {
  await json(await request(`${box(id)}/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }))
}

/** Admin: import an archive.org item (finishes in the background). */
export async function importFromArchive(fields: Record<string, string | boolean>): Promise<CatalogItem> {
  return json<CatalogItem>(await request('/api/catalog/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }))
}

/** Admin: upload a zip as an item (finishes in the background). */
export async function uploadItem(slug: string, fields: Record<string, string>, zip: Blob): Promise<CatalogItem> {
  const q = new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== ''))
  return json<CatalogItem>(await request(`/api/catalog/${encodeURIComponent(slug)}?${q}`, { method: 'PUT', body: zip }))
}

export async function editItem(slug: string, fields: Partial<CatalogItem>): Promise<CatalogItem> {
  return json<CatalogItem>(await request(`/api/catalog/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }))
}

export const deleteItem = async (slug: string) =>
  json<void>(await request(`/api/catalog/${encodeURIComponent(slug)}`, { method: 'DELETE' }))
