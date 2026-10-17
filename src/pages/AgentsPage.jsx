import { useEffect, useState, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { I } from '../icons'
import { errorMessage, fmt, fmtDuration, initials, mapUrl, relTime, KpiSkeleton, TableSkeleton, PageHeader, SearchInput } from '../components'
import { Pager, usePaged } from '../components/Pager'
import Novu from '../components/Inbox'
import { NewStaffDrawer, StaffDrawer } from '../components/StaffDrawers'

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

// Phones check in every ~15 min while the app is open (devices:heartbeat);
// two missed check-ins and the TPE counts as offline.
const DEVICE_STALE_MS = 35 * 60 * 1000

// Phone clock this far from the server's: what it records offline is mis-dated
const CLOCK_SKEW_ALERT_MS = 5 * 60 * 1000
// Silent this long while holding unsynced operations: cash collected but not on the server
const HELD_OPS_ALERT_MS = 4 * 3600 * 1000

/** Signs of tampering or held cash from the last check-in, most serious first. */
function deviceAlerts(d) {
  const t = d.telemetry
  if (!t || d.status !== "active") return []
  const out = []
  if (t.location?.mocked) out.push({ label: "Position simulée", title: "Une application de faux GPS est active sur le téléphone" })
  if (t.rooted) out.push({ label: "Téléphone modifié", title: "Téléphone rooté : l'application et ses données peuvent être altérées" })
  if (t.emulator) out.push({ label: "Émulateur", title: "L'application tourne sur un émulateur, pas sur un vrai téléphone" })
  if (t.clockSkewMs !== undefined && Math.abs(t.clockSkewMs) > CLOCK_SKEW_ALERT_MS) {
    out.push({
      label: `Horloge ${t.clockSkewMs < 0 ? "en retard" : "en avance"} de ${fmtDuration(t.clockSkewMs)}`,
      title: "L'heure du téléphone ne correspond pas à celle du serveur : les opérations hors ligne peuvent être mal datées",
    })
  }
  const silent = Date.now() - d.lastSync
  if (t.pendingOps > 0 && silent > HELD_OPS_ALERT_MS) {
    out.push({
      label: `${t.pendingOps} non synchronisée${t.pendingOps > 1 ? "s" : ""} depuis ${fmtDuration(silent)}`,
      title: "Opérations encaissées sur le TPE mais pas encore reçues par le serveur",
    })
  }
  if (t.locationDenied) out.push({ label: "Localisation refusée", title: "Les opérations de ce TPE ne sont pas géolocalisées" })
  return out
}

/** The device's alerts as tags, or a dash. */
function AlertsCell({ d }) {
  const alerts = deviceAlerts(d)
  if (alerts.length === 0) return <span className="cell-sub">—</span>
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      {alerts.map(a => <span key={a.label} className="tag alerte" title={a.title}>{a.label}</span>)}
    </div>
  )
}

const NETWORK_LABELS = { wifi: "Wi-Fi", cellular: "Données mobiles", none: "Hors réseau", other: "Réseau" }

/** Device health tag: maintenance, lost, offline (no recent check-in) or online. */
function SyncTag({ d }) {
  if (d.status === "maintenance") return <span className="tag attente">Maintenance</span>
  if (d.status === "lost")        return <span className="tag archive">Perdu</span>
  if (Date.now() - d.lastSync > DEVICE_STALE_MS) return <span className="tag attente">Hors ligne</span>
  return <span className="tag actif">En ligne</span>
}

/** What the phone reported at its last check-in: battery, network, unsynced operations, app version. */
function PhoneCell({ t }) {
  if (!t) return <span className="cell-sub">Pas encore de rapport</span>
  const pct = t.battery !== undefined ? Math.round(t.battery * 100) : null
  const low = pct !== null && pct <= 20 && !t.charging
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
        {pct !== null && (
          <span style={{ color: low ? "var(--neg)" : "var(--ink)", fontWeight: low ? 600 : 500, fontVariantNumeric: "tabular-nums" }}
                title={t.charging ? "En charge" : "Sur batterie"}>
            {t.charging ? "⚡" : "🔋"} {pct}%
          </span>
        )}
        {t.network && <span style={{ color: t.network === "none" ? "var(--neg)" : "var(--ink-2)" }}>{NETWORK_LABELS[t.network]}</span>}
        {t.pendingOps > 0 && (
          <span style={{ color: "var(--warn)", fontWeight: 600 }} title="Opérations enregistrées sur le téléphone, pas encore reçues par le serveur">
            {t.pendingOps} en attente
          </span>
        )}
      </div>
      <div className="cell-sub">
        {[t.appVersion && `App ${t.appVersion}`, t.osVersion && `Android ${t.osVersion}`].filter(Boolean).join(" · ") || "—"}
        {t.location && <> · <a href={mapUrl(t.location)} target="_blank" rel="noreferrer">Position</a></>}
      </div>
    </div>
  )
}

/** Render TPE assignment controls and audit details; mutations enforce devices:bind permission. */
function BindCell({ device, agents, canBind }) {
  const bind   = useMutation(api.devices.bindDevice)
  const unbind = useMutation(api.devices.unbindDevice)
  const [userId, setUserId] = useState("")
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState(null)

  /** Run a binding operation, manage pending/error state, and clear selection on success. */
  const run = async (fn) => {
    setBusy(true); setError(null)
    try { await fn(); setUserId("") }
    catch (e) { setError(errorMessage(e)) }
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
  // The agent whose phone registered this serial, if they can still be bound
  const requester = device.requestedBy ? eligible.find(a => a.id === device.requestedBy) : null

  if (!canBind) {
    return device.assignedTo
      ? <span style={{ fontWeight: 550 }}>{device.assignee}</span>
      : <span className="cell-sub">{device.requester ? `Non affecté · demandé par ${device.requester}` : "Non affecté"}</span>
  }

  return (
    <div>
      {device.assignedTo ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 550 }}>{device.assignee}</span>
          <button className="btn ghost sm" style={{ color: "var(--neg)" }} disabled={busy} onClick={onUnbind}>Délier</button>
        </div>
      ) : device.status !== "active" ? (
        <span className="cell-sub">Non affecté · appareil indisponible</span>
      ) : requester ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="tag attente">Demande de liaison</span>
          <button className="btn brand sm" disabled={busy}
            onClick={() => run(() => bind({ serialNumber: device.serial, userId: requester.id }))}>Lier à {requester.name}</button>
        </div>
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
      {requester && (
        <div className="cell-sub" style={{ marginTop: 2 }}>
          Téléphone enregistré par {requester.name} · {relTime(device.requestedAt)} · vérifiez que le numéro affiché sur son écran est le même
        </div>
      )}
      {device.boundBy && !requester && (
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
  const [creating, setCreating] = useState(false)
  const [staffId, setStaffId]   = useState(null)
  // Re-render every minute: online/offline and the alerts depend on the time
  // since the last check-in, which moves even when the data doesn't
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(n => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])
  const me  = useQuery(api.users.me)
  const can = me?.can ?? {}

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
  // Phones waiting for a binding first, oldest request first
  const pendingTpe  = fleet.filter(d => d.requestedBy).length
  const staffPage = usePaged(filtered)
  const alertedTpe  = fleet.filter(d => deviceAlerts(d).length > 0).length
  // Binding requests first (oldest first), then devices with alerts
  const sortedFleet = [...fleet].sort((a, b) =>
    (a.requestedBy ? 0 : 1) - (b.requestedBy ? 0 : 1) || (a.requestedAt ?? 0) - (b.requestedAt ?? 0) ||
    deviceAlerts(b).length - deviceAlerts(a).length)
  const fleetPage = usePaged(sortedFleet)
  const activeTpe  = fleet.filter(d => d.status === "active").length
  const staleTpe   = fleet.filter(d => d.status === "active" && Date.now() - d.lastSync > DEVICE_STALE_MS).length
  const collected  = AGENTS.reduce((s, a) => s + a.collected, 0)
  const txMonth    = AGENTS.reduce((s, a) => s + a.txMonth, 0)
  const collectors = AGENTS.filter(a => a.txMonth > 0)
  const AGENT_KPIS = [
    { label: "TPE en service",    value: String(activeTpe), unit: `/${fleet.length}`, note: `${fleet.length - activeTpe} hors service · ${staleTpe} hors ligne`, icon: "users" },
    { label: "Collecte du mois",  value: fmt(collected),    unit: "FCFA", note: `${txMonth} transactions`, icon: "wallet" },
    { label: "Agents actifs",     value: String(AGENTS.filter(a => a.status === "active").length), unit: `/${AGENTS.length}`, note: `${branches.length - 1} agences`, icon: "cloud" },
    { label: "Tx / agent · moy.", value: String(collectors.length ? Math.round(txMonth / collectors.length) : 0), unit: "", note: "ce mois, agents collecteurs", icon: "receipt" },
  ]

  return (
    <div className="agents-page">
      <PageHeader
        crumbs={["Admin", "Agents & TPE"]}
        title="Agents & terminaux"
      >
        <Novu />
      </PageHeader>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <SearchInput placeholder="Nom, téléphone, TPE…" value={q} onChange={e => setQ(e.target.value)} />
        {can.manageStaff && (
          <button className="btn brand" onClick={() => setCreating(true)}><I.Plus size={14} stroke="white"/>Nouvel agent</button>
        )}
      </div>
      {rows === undefined || devices === undefined ? <KpiSkeleton /> : (
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
      )}
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
              {staffPage.rows.map(a => {
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
                    <td>
                      {can.manageStaff && (
                        <button className="btn ghost sm" style={{ padding: 4 }} title="Gérer le compte"
                          aria-label={`Gérer le compte de ${a.name}`} onClick={() => setStaffId(a.id)}>
                          <I.More size={14}/>
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows === undefined && <TableSkeleton rows={6} label="Chargement du personnel…" />}
          <Pager paged={staffPage} unit="membres" />
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
            <span className="card-sub" style={{ marginLeft: "auto" }}>Par rôle</span>
          </div>
          <div style={{ padding: "0 14px 14px", overflowX: "auto" }}>
            <table className="perm-table">
              <thead>
                <tr><th></th><th>Agent</th><th>Superv.</th><th>Compta.</th><th>Admin IT</th></tr>
              </thead>
              <tbody>
                {/* Mirrors the role definitions in convex/authz.ts */}
                {[
                  ["Encaisser (TPE)",            1,1,0,0],
                  ["Inscrire un client",         1,1,0,0],
                  ["Demander un décaissement",   1,1,0,0],
                  ["Annuler une transaction",    0,1,0,0],
                  ["Approuver un décaissement",  0,1,0,0],
                  ["Vérifier l'identité client", 0,1,1,0],
                  ["Clôturer la caisse",         0,0,1,0],
                  ["Lier les TPE",               0,0,0,1],
                  ["Gérer le personnel",         0,0,0,1],
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
          {pendingTpe > 0 && <span className="tag attente" style={{ marginLeft: 10 }}>{pendingTpe} demande{pendingTpe > 1 ? "s" : ""} de liaison</span>}
          {alertedTpe > 0 && <span className="tag alerte" style={{ marginLeft: 10 }}>{alertedTpe} TPE en alerte</span>}
          <span className="card-sub" style={{ marginLeft: "auto" }}>{fleet.length} TPE enregistrés · liaison réservée à l'Admin IT</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Numéro de série</th><th>Modèle</th><th>Affecté à</th><th>Statut</th><th>Téléphone</th><th>Alertes</th><th>Dernière activité</th></tr>
            </thead>
            <tbody>
              {fleetPage.rows.map(d => (
                <tr key={d.serial}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 550 }}>{d.serial}</td>
                  <td>{d.model}</td>
                  <td><BindCell device={d} agents={AGENTS} canBind={!!can.bind}/></td>
                  <td><SyncTag d={d}/></td>
                  <td><PhoneCell t={d.telemetry}/></td>
                  <td><AlertsCell d={d}/></td>
                  <td className="cell-sub">{relTime(d.lastSync)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices === undefined && <TableSkeleton rows={6} label="Chargement des terminaux…" />}
          <Pager paged={fleetPage} unit="terminaux" />
        </div>
      </div>
      {creating && (
        <NewStaffDrawer onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); setStaffId(id) }} />
      )}
      {staffId && <StaffDrawer key={staffId} userId={staffId} onClose={() => setStaffId(null)} />}
    </div>
  )
}
