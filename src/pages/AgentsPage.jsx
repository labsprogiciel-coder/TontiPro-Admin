import { useState, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { I } from '../icons'
import { fmt, initials, relTime, Loading, PageHeader } from '../components'
import Novu from '../components/Inbox'

const ROLE_TAGS = {
  "Admin IT":      { bg: "oklch(0.94 0.04 50)",  fg: "var(--brand-ink)" },
  "Superviseur":   { bg: "oklch(0.94 0.05 270)", fg: "oklch(0.4 0.13 270)" },
  "Agent terrain": { bg: "var(--surface-inset)", fg: "var(--ink-2)" },
  "Comptable":     { bg: "oklch(0.95 0.04 190)", fg: "oklch(0.4 0.1 190)" },
}

const STATUS_DOT = {
  active:    "var(--pos)",
  suspended: "var(--warn)",
}
const STATUS_LABEL = { active: "actif", suspended: "suspendu" }

const DEVICE_STALE_MS = 60 * 60 * 1000

function SyncTag({ d }) {
  if (d.status === "maintenance") return <span className="tag attente">Maintenance</span>
  if (d.status === "lost")        return <span className="tag archive">Perdu</span>
  if (Date.now() - d.lastSync > DEVICE_STALE_MS) return <span className="tag attente">Sync ancienne</span>
  return <span className="tag actif">À jour</span>
}

/** Render TPE assignment controls and audit details; mutations enforce devices:bind permission. */
function BindCell({ device, agents }) {
  const bind   = useMutation(api.devices.bindDevice)
  const unbind = useMutation(api.devices.unbindDevice)
  const [userId, setUserId] = useState("")
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState(null)

  /** Run a binding operation, manage pending/error state, and clear selection on success. */
  const run = async (fn) => {
    setBusy(true); setError(null)
    try { await fn(); setUserId("") }
    catch (e) { setError(e.data ?? e.message) }
    finally { setBusy(false) }
  }

  /** Ask for confirmation before removing the displayed device's assignment. */
  const onUnbind = () => {
    if (window.confirm(`Délier ${device.serial} de ${device.assignee} ? L'agent ne pourra plus encaisser avec ce TPE.`)) {
      run(() => unbind({ serialNumber: device.serial }))
    }
  }

  // Mirrors bindDevice: active field agents / supervisors without a terminal
  const eligible = agents.filter(a => a.status === "active" && a.canCollect && !a.device)

  return (
    <div>
      {device.assignedTo ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 550 }}>{device.assignee}</span>
          <button className="btn ghost sm" style={{ color: "var(--neg)" }} disabled={busy} onClick={onUnbind}>Délier</button>
        </div>
      ) : device.status !== "active" ? (
        <span className="cell-sub">Non affecté · appareil indisponible</span>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <select className="filter-select" value={userId} onChange={e => setUserId(e.target.value)} disabled={busy}>
            <option value="">{eligible.length ? "Choisir un agent…" : "Aucun agent disponible"}</option>
            {eligible.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn sm" disabled={busy || !userId}
            onClick={() => run(() => bind({ serialNumber: device.serial, userId }))}>Lier</button>
        </div>
      )}
      {device.boundBy && (
        <div className="cell-sub" style={{ marginTop: 2 }}>
          {device.assignedTo ? "Lié" : "Délié"} par {device.boundBy} · {relTime(device.boundAt)}
        </div>
      )}
      {error && <div style={{ color: "var(--neg)", fontSize: 11.5, marginTop: 4 }}>{String(error)}</div>}
    </div>
  )
}

/** Render agent filters, collection summaries, and the terminal fleet with binding controls. */
export default function AgentsPage() {
  const [q, setQ] = useState("")
  const [branch, setBranch] = useState("toutes")
  const [role, setRole] = useState("tous")
  const [online, setOnline] = useState(true)

  const rows = useQuery(api.admin.listAgents)
  const devices = useQuery(api.admin.listDevices)
  const AGENTS = rows ?? []

  const branches = useMemo(() => ["toutes", ...Array.from(new Set(AGENTS.map(a => a.branch)))], [rows])
  const roles    = useMemo(() => ["tous",   ...Array.from(new Set(AGENTS.map(a => a.role)))],   [rows])

  const filtered = useMemo(() => AGENTS.filter(a => {
    if (branch !== "toutes" && a.branch !== branch) return false
    if (role   !== "tous"   && a.role   !== role)   return false
    if (q && !a.name.toLowerCase().includes(q.toLowerCase()) && !a.phone.includes(q) && !(a.device?.serial ?? "").toLowerCase().includes(q.toLowerCase())) return false
    return true
  }), [rows, q, branch, role])

  const fleet      = devices ?? []
  const activeTpe  = fleet.filter(d => d.status === "active").length
  const staleTpe   = fleet.filter(d => d.status === "active" && Date.now() - d.lastSync > DEVICE_STALE_MS).length
  const collected  = AGENTS.reduce((s, a) => s + a.collected, 0)
  const txMonth    = AGENTS.reduce((s, a) => s + a.txMonth, 0)
  const collectors = AGENTS.filter(a => a.txMonth > 0)
  const AGENT_KPIS = [
    { label: "TPE en service",    value: String(activeTpe), unit: `/${fleet.length}`, note: `${fleet.length - activeTpe} hors service · ${staleTpe} sync ancienne`, icon: "users" },
    { label: "Collecte du mois",  value: fmt(collected),    unit: "FCFA", note: `${txMonth} transactions`, icon: "wallet" },
    { label: "Agents actifs",     value: String(AGENTS.filter(a => a.status === "active").length), unit: `/${AGENTS.length}`, note: `${branches.length - 1} agences`, icon: "cloud" },
    { label: "Tx / agent · moy.", value: String(collectors.length ? Math.round(txMonth / collectors.length) : 0), unit: "", note: "ce mois, agents collecteurs", icon: "receipt" },
  ]

  return (
    <div className="agents-page">
      <PageHeader
        crumbs={["Admin", "Agents & TPE"]}
        title="Agents & terminaux"
        sub={`${AGENTS.length} agents · ${fleet.length} TPE · ${branches.length - 1} agences`}
      >
        <button className={"status-pill" + (online ? "" : " offline")} onClick={() => setOnline(!online)}>
          <span className="status-dot"></span>{online ? "En ligne · synchronisé" : "Hors ligne · 4 en file"}
        </button>
        <Novu />
      </PageHeader>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button className="btn"><I.Cloud size={14}/>Forcer sync</button>
        <button className="btn brand"><I.Plus size={14} stroke="white"/>Nouvel agent</button>
      </div>
      <section className="kpi-row">
        {AGENT_KPIS.map(k => (
          <div className="kpi" key={k.label}>
            <div className="kpi-label">
              {k.icon === "users"   && <I.Users/>}
              {k.icon === "wallet"  && <I.Wallet/>}
              {k.icon === "receipt" && <I.Receipt/>}
              {k.icon === "cloud"   && <I.Cloud/>}
              {k.label}
            </div>
            <div className="kpi-value">{k.value}{k.unit && <span className="unit">{k.unit}</span>}</div>
            <div className="kpi-foot">
              <span>{k.note}</span>
            </div>
          </div>
        ))}
      </section>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div className="card-title">Flotte d'agents · TPE en service</div>
          <div className="filter-spacer"/>
          <div className="filter-group">
            <label className="filter-label">Agence</label>
            <select className="filter-select" value={branch} onChange={e => setBranch(e.target.value)}>
              {branches.map(b => <option key={b} value={b}>{b === "toutes" ? "Toutes" : b}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label className="filter-label">Rôle</label>
            <select className="filter-select" value={role} onChange={e => setRole(e.target.value)}>
              {roles.map(r => <option key={r} value={r}>{r === "tous" ? "Tous" : r}</option>)}
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Rôle</th>
                <th>Zone / Agence</th>
                <th>TPE</th>
                <th>Sync</th>
                <th style={{ textAlign: "right" }}>Collecte mois</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => {
                const tag = ROLE_TAGS[a.role] || ROLE_TAGS["Agent terrain"]
                return (
                  <tr key={a.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="avatar sm" style={{ position: "relative" }}>
                          {initials(a.name)}
                          <span style={{ position: "absolute", right: -1, bottom: -1, width: 8, height: 8, borderRadius: "50%", background: STATUS_DOT[a.status], border: "1.5px solid var(--surface)" }}/>
                        </div>
                        <div>
                          <div style={{ fontWeight: 550 }}>{a.name}</div>
                          <div className="cell-sub">{a.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="chip" style={{ background: tag.bg, color: tag.fg, borderColor: "transparent" }}>{a.role}</span></td>
                    <td>
                      <div>{a.branch}</div>
                      <div className="cell-sub">{a.clients} client{a.clients > 1 ? "s" : ""}</div>
                    </td>
                    <td>
                      {a.device ? (
                        <>
                          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 550 }}>{a.device.serial}</div>
                          <div className="cell-sub">{a.device.model}</div>
                        </>
                      ) : <span className="cell-sub">—</span>}
                    </td>
                    <td>
                      {a.device ? (
                        <>
                          <SyncTag d={a.device}/>
                          <div className="cell-sub" style={{ marginTop: 2 }}>{relTime(a.device.lastSync)}</div>
                        </>
                      ) : <span className="cell-sub">—</span>}
                    </td>
                    <td style={{ textAlign: "right", minWidth: 130 }}>
                      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {a.collected ? fmt(a.collected) : "—"}
                      </div>
                      {a.txMonth > 0 && <div className="cell-sub" style={{ marginTop: 2 }}>{a.txMonth} tx</div>}
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_DOT[a.status] }}/>
                        {STATUS_LABEL[a.status]}
                      </span>
                    </td>
                    <td><button className="btn ghost sm" style={{ padding: 4 }}><I.More size={14}/></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows === undefined && <Loading />}
        </div>
      </div>

      <div className="row cols-2 agents-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <div className="card-title">Top collecteurs · ce mois</div>
            <span className="card-sub" style={{ marginLeft: "auto" }}>Sur le terrain</span>
          </div>
          <div style={{ padding: "4px 14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {[...AGENTS].filter(a => a.collected).sort((a,b) => b.collected - a.collected).slice(0,4).map((a, i) => {
              const pct = collected ? Math.round((a.collected / collected) * 100) : 0
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 18, fontWeight: 600, color: "var(--ink-3)", fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{i+1}</div>
                  <div className="avatar sm">{initials(a.name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 550, fontSize: 13 }}>{a.name}</div>
                    <div className="cell-sub" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{a.device?.serial ?? "—"} · {a.branch}</div>
                    <div className="goal-bar" style={{ marginTop: 4 }}>
                      <div className="goal-fill" style={{ width: Math.min(100, pct) + "%" }}/>
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{fmt(a.collected)}</div>
                    <div className="cell-sub">{pct}% du total</div>
                  </div>
                </div>
              )
            })}
            {rows && !AGENTS.some(a => a.collected) && <div className="cell-sub">Aucune collecte ce mois</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">Permissions · matrice</div>
            <span className="card-action" style={{ marginLeft: "auto" }}>Modifier <I.Arrow size={12}/></span>
          </div>
          <div style={{ padding: "0 14px 14px", overflowX: "auto" }}>
            <table className="perm-table">
              <thead>
                <tr><th></th><th>Admin</th><th>Superv.</th><th>Agent</th><th>Caisse</th></tr>
              </thead>
              <tbody>
                {[
                  ["Voir clients",            1,1,1,1],
                  ["Inscrire (KYC sur TPE)",  1,1,1,0],
                  ["Encaisser dépôt",         1,1,1,1],
                  ["Valider retrait",         1,1,0,1],
                  ["Mode hors-ligne",         1,1,1,1],
                  ["Modifier objectifs",      1,1,0,0],
                  ["Gérer agents & TPE",      1,0,0,0],
                ].map(([label, ...vals]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    {vals.map((v, i) => (
                      <td key={i} style={{ textAlign: "center" }}>
                        {v ? <span className="perm-yes"><I.Check size={11} stroke="white"/></span> : <span className="perm-no">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Parc de terminaux</div>
          <span className="card-sub" style={{ marginLeft: "auto" }}>{fleet.length} TPE enregistrés · liaison réservée à l'Admin IT</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Numéro de série</th><th>Modèle</th><th>Affecté à</th><th>Statut</th><th>Dernière sync</th></tr>
            </thead>
            <tbody>
              {fleet.map(d => (
                <tr key={d.serial}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 550 }}>{d.serial}</td>
                  <td>{d.model}</td>
                  <td><BindCell device={d} agents={AGENTS}/></td>
                  <td><SyncTag d={d}/></td>
                  <td className="cell-sub">{relTime(d.lastSync)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices === undefined && <Loading />}
        </div>
      </div>
    </div>
  )
}
