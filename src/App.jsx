import { useState } from 'react'
import { Authenticated, AuthLoading, Unauthenticated, useQuery } from 'convex/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { api } from '../convex/_generated/api'
import { Loading, Sidebar } from './components'
import LoginPage from './pages/LoginPage'
import AppCommandPalette from './components/CommandPalette'
import DashboardPage from './pages/DashboardPage'
import ClientsPage from './pages/ClientsPage'
import TransactionsPage from './pages/TransactionsPage'
import AgentsPage from './pages/AgentsPage'
import ObjectifsPage from './pages/ObjectifsPage'
import SettingsPage from './pages/SettingsPage'
import ProductsPage from './pages/ProductsPage'
import ReconciliationPage from './pages/ReconciliationPage'

const PAGES = {
  dashboard:      DashboardPage,
  clients:        ClientsPage,
  tx:             TransactionsPage,
  agents:         AgentsPage,
  objectifs:      ObjectifsPage,
  produits:       ProductsPage,
  reconciliation: ReconciliationPage,
  settings:       SettingsPage,
}

export default function App() {
  return (
    <>
      <AuthLoading><Loading /></AuthLoading>
      <Unauthenticated><LoginPage /></Unauthenticated>
      <Authenticated><ActiveStaffGate /></Authenticated>
    </>
  )
}

// A session can outlive a suspension: show a sign-out screen instead of a
// shell whose every query would be refused.
function ActiveStaffGate() {
  const me = useQuery(api.users.me)
  const { signOut } = useAuthActions()
  if (me === undefined) return <Loading />
  if (me?.active) return <Shell />
  return (
    <div style={{ padding: 40, maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
      <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>Compte inactif</div>
      <div style={{ color: "var(--ink-3)", fontSize: 13, marginBottom: 16 }}>
        Ce compte est suspendu ou n'existe plus. Contactez l'Admin IT de votre agence.
      </div>
      <button className="btn" onClick={() => signOut()}>Se déconnecter</button>
    </div>
  )
}

function Shell() {
  const [active, setActive] = useState('dashboard')
  const Page = PAGES[active] ?? DashboardPage

  return (
    <div className="app">
      <Sidebar active={active} setActive={setActive} />
      <main className="main">
        <Page />
      </main>
      <AppCommandPalette setActive={setActive} />
    </div>
  )
}
