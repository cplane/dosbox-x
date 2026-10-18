import { refresh } from './auth'

/** The server said "sign in" (as opposed to "no"). */
export class NeedsSignIn extends Error {}

export type BoxState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface Box {
  id: string
  owner: string
  name: string
  createdAt: string
  lastActiveAt: string
  diskLimitMB: number
  usedBytes: number
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

export async function createBox(name: string): Promise<Box> {
  return json<Box>(await request('/api/boxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
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

const filePath = (id: string, path: string) =>
  `${box(id)}/files/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`

export const listFiles = async (id: string, dir: string) => json<FileEntry[]>(await request(filePath(id, dir)))
export const downloadURL = (id: string, path: string) => `${filePath(id, path)}?download=1`

export async function uploadFile(id: string, path: string, file: Blob): Promise<void> {
  await json(await request(filePath(id, path), { method: 'PUT', body: file }))
}

export async function deleteFile(id: string, path: string, recursive: boolean): Promise<void> {
  await json(await request(filePath(id, path) + (recursive ? '?recursive=1' : ''), { method: 'DELETE' }))
}

/** The player's WebSocket URL; the session cookie authenticates it. */
export function wsURL(id: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${box(id)}/ws`
}
