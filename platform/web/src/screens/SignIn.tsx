import { useEffect, useState } from 'react'
import { authDoors, signIn, signInWithGoogle, signUp, type Session } from '../api/auth'

interface Props {
  onSignedIn: (session: Session) => void
  /** Shown when sign-in was demanded rather than chosen, e.g. by a box link. */
  reason?: string
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
        }
      }
    }
  }
}

export function SignIn({ onSignedIn, reason }: Props) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [googleAvailable, setGoogleAvailable] = useState(false)

  // The server decides which doors exist; a deployment with no Google client
  // id has no Google route, so rendering the button would be a dead end.
  useEffect(() => {
    authDoors()
      .then((doors) => setGoogleAvailable(doors.google))
      .catch(() => setGoogleAvailable(false))
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const session = mode === 'signup'
        ? await signUp(username.trim(), password, email.trim())
        : await signIn(username.trim(), password)
      onSignedIn(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function google(credential: string) {
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await signInWithGoogle(credential))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="menu-screen">
      <div className="menu-panel">
        <h1 className="title">DOS-BOX</h1>
        {reason
          ? <p className="subtitle">{reason}</p>
          : <p className="subtitle">Sign in to run your DOS boxes</p>}

        <form className="auth-form" onSubmit={submit}>
          <label>
            Name
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="3-24 letters, digits, - or _"
              required
            />
          </label>

          {mode === 'signup' && (
            <label>
              Email <span className="muted">(optional)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
          )}

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {googleAvailable && <GoogleButton onCredential={google} />}

        <button
          className="ghost"
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
        >
          {mode === 'signin' ? 'Create an account' : 'I already have an account'}
        </button>
      </div>
    </div>
  )
}

/**
 * Google Identity Services renders its own button, which needs the script and
 * the client id. Both are fetched rather than bundled so a deployment can
 * change the client id without a rebuild.
 */
function GoogleButton({ onCredential }: { onCredential: (credential: string) => void }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (window.google?.accounts) {
      setReady(true)
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => setReady(true)
    document.head.appendChild(script)
  }, [])

  useEffect(() => {
    if (!ready) return
    const parent = document.getElementById('google-button')
    if (!parent || !window.google) return

    fetch('/auth/config')
      .then((r) => r.json())
      .then((config: { googleClientId?: string }) => {
        if (!config.googleClientId || !window.google) return
        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: (response) => onCredential(response.credential),
        })
        // Match the Sign in button above: full card width (GIS caps it at 400).
        window.google.accounts.id.renderButton(parent, {
          theme: 'filled_black',
          size: 'large',
          shape: 'rectangular',
          text: 'signin_with',
          logo_alignment: 'left',
          width: Math.min(400, Math.floor(parent.clientWidth)),
        })
      })
      .catch(() => undefined)
  }, [ready, onCredential])

  return <div id="google-button" className="google-button" />
}
