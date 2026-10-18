/**
 * Sign-in against the auth service, which nginx serves from this same origin.
 *
 * There is no token handling here, deliberately. The access and refresh
 * tokens live in httpOnly cookies that script cannot read, so every call
 * below just sends credentials: 'include' and lets the browser carry them.
 * That is what stops an XSS bug from walking away with a 90-day refresh
 * token — and it is only possible because auth is same-origin rather than
 * borrowed from another host.
 */

export interface Session {
  authenticated: boolean
  id?: string
  username?: string
  role?: string
  accessExpiresAt?: string
}

export interface AuthDoors {
  google: boolean
}

async function post(path: string, body?: unknown): Promise<Session> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error ?? `request failed with ${response.status}`)
  }
  return payload as Session
}

export function signUp(username: string, password: string, email: string): Promise<Session> {
  return post('/auth/signup', { username, password, email })
}

export function signIn(username: string, password: string): Promise<Session> {
  return post('/auth/signin', { username, password })
}

export function signInWithGoogle(credential: string): Promise<Session> {
  return post('/auth/google', { credential })
}

export function signOut(): Promise<Session> {
  return post('/auth/signout')
}

/**
 * Asks the server who we are. The page cannot read the httpOnly cookie that
 * holds the answer, so this endpoint exists to tell it.
 */
export async function currentSession(): Promise<Session> {
  const response = await fetch('/auth/session', { credentials: 'include' })
  if (!response.ok) return { authenticated: false }
  return (await response.json()) as Session
}

/**
 * Who we are when the page opens, using BOTH cookies.
 *
 * The access token lives an hour; the refresh token ninety days. Asking only
 * `/auth/session` checks the access token, so a player who came back the
 * next day looked signed out while a perfectly good refresh cookie sat in
 * the jar — every visit after the first hour was a re-login. When the access
 * token is gone, spend the refresh token and take the answer from that.
 * Failure there is just "not signed in": a visitor who never was, or a
 * session that was signed out or aged past ninety days.
 */
export async function restoreSession(): Promise<Session> {
  const session = await currentSession()
  if (session.authenticated) return session
  return refresh().catch(() => ({ authenticated: false }))
}

export async function authDoors(): Promise<AuthDoors> {
  const response = await fetch('/auth/config', { credentials: 'include' })
  if (!response.ok) return { google: false }
  return (await response.json()) as AuthDoors
}

/**
 * Renews the session, single-flight.
 *
 * The single-flight guard is load-bearing rather than an optimisation. The
 * server rotates refresh tokens single-use, so two concurrent calls
 * presenting the same cookie produce one winner and one caller thrown to the
 * login screen. A page that fires several requests at once would generate
 * exactly that, and the server's grace window only covers what this cannot:
 * a second tab, in its own JavaScript context, sharing the same cookie jar.
 */
let inFlight: Promise<Session> | null = null

export function refresh(): Promise<Session> {
  if (!inFlight) {
    inFlight = post('/auth/refresh').finally(() => {
      inFlight = null
    })
  }
  return inFlight
}
