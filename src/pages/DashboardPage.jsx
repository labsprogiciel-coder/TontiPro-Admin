import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import {
  Topbar, KPI, ClientsCard, TransactionsCard,
  VolumeChart, QuickActionsCard, Loading, fmt,
} from '../components'
import Novu from '../components/Inbox'

function greeting() {
  const h = new Date().getHours()
  return h < 18 ? "Bonjour" : "Bonsoir"
}

export default function DashboardPage() {
  const data = useQuery(api.admin.dashboard)

  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })

  return (
    <>
      <Topbar inbox={<Novu />} />
      <h1 className="h1">{greeting()}</h1>
      <div className="h1-sub mb-6" style={{ textTransform: "capitalize" }}>
        {today}{data && ` · ${data.branchCount} agences · ${data.agentCount} utilisateurs`}
      </div>

      {data === undefined ? <Loading /> : (
        <>
          <section className="kpi-row">
            {[
              { label: "Clients actifs", value: String(data.kpis.activeClients), unit: "", delta: `+${data.kpis.newClientsMonth}`, dir: "up", note: "nouveaux ce mois", icon: "users" },
              { label: "Épargne totale", value: fmt(data.kpis.totalSavings), unit: "FCFA", delta: "cumul", dir: "up", note: "collectes validées", icon: "wallet" },
              { label: "Transactions", value: String(data.kpis.txMonth), unit: "",
                delta: (data.kpis.txMonth - data.kpis.txPrevMonth >= 0 ? "+" : "−") + Math.abs(data.kpis.txMonth - data.kpis.txPrevMonth),
                dir: data.kpis.txMonth >= data.kpis.txPrevMonth ? "up" : "down", note: "ce mois vs. précédent", icon: "receipt" },
              { label: "Décaissements en attente", value: String(data.kpis.pendingDisbursements), unit: "",
                delta: fmt(data.kpis.pendingDisbursementsAmount) + " FCFA", dir: data.kpis.pendingDisbursements ? "down" : "up", note: "à approuver", icon: "coin" },
            ].map(k => <KPI key={k.label} k={k} />)}
          </section>

          <div className="row cols-2" style={{ marginBottom: 14 }}>
            <VolumeChart data={data.volume} />
            <QuickActionsCard />
          </div>

          <div className="row cols-2">
            <ClientsCard clients={data.clients} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <TransactionsCard tx={data.recent} />
            </div>
          </div>
        </>
      )}
    </>
  )
}
