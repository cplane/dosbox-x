import { useCallback, useEffect, useState } from 'react'
import { restoreSession, signOut, type Session } from './api/auth'
import { Boxes } from './screens/Boxes'
import { Catalog } from './screens/Catalog'
import { Files } from './screens/Files'
import { Player } from './screens/Player'
import { SignIn } from './screens/SignIn'

// Routes live in the hash so a box link survives a reload and the static
// server needs no rewrites: #/ boxes, #/box/<id> player, #/box/<id>/files,
// #/catalog (admins).
type Route = { screen: 'boxes' | 'catalog' } | { screen: 'player' | 'files'; id: string }

function parse(hash: string): Route {
  if (hash === '#/catalog') return { screen: 'catalog' }
  const m = hash.match(/^#\/box\/([0-9a-f-]{36})(\/files)?$/)
  if (!m) return { screen: 'boxes' }
  return { screen: m[2] ? 'files' : 'player', id: m[1] }
}

const go = (hash: string) => { window.location.hash = hash }

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))

  useEffect(() => {
    restoreSession().then(setSession)
    const onHash = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const signedOut = useCallback(() => setSession({ authenticated: false }), [])

  if (session === null) return <div className="menu-screen"><p className="muted">Loading…</p></div>
  if (!session.authenticated) {
    return <SignIn onSignedIn={setSession} reason={route.screen !== 'boxes' ? 'Sign in to open this box' : undefined} />
  }

  switch (route.screen) {
    case 'player':
      return <Player key={route.id} boxId={route.id} onBack={() => go('#/')} onSignedOut={signedOut} />
    case 'files':
      return <Files key={route.id} boxId={route.id} onBack={() => go('#/')} onOpen={() => go(`#/box/${route.id}`)} onSignedOut={signedOut} />
    case 'catalog':
      return <Catalog onBack={() => go('#/')} onSignedOut={signedOut} />
    default:
      return (
        <Boxes
          username={session.username ?? ''}
          isAdmin={session.role === 'admin'}
          onOpen={(id) => go(`#/box/${id}`)}
          onFiles={(id) => go(`#/box/${id}/files`)}
          onCatalog={() => go('#/catalog')}
          onSignOut={() => signOut().finally(signedOut)}
          onSignedOut={signedOut}
        />
      )
  }
}
