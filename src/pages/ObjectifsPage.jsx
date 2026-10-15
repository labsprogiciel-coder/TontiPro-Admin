import { useState, useMemo } from 'react'
import { I } from '../icons'
import { fmt, KPI, PageHeader, SearchInput } from '../components'
import { CLIENTS } from '../data'
import Novu from '../components/Inbox'

const OBJ_STATUSES = {
  atteint:   { label: "Atteint",       tagClass: "actif",   dot: "var(--pos)" },
  enavance:  { label: "En avance",     tagClass: "actif",   dot: "var(--pos)" },
  surrythme: { label: "Sur le rythme", tagClass: "attente", dot: "var(--warn)" },
  enretard:  { label: "En retard",     tagClass: "archive", dot: "var(--neg)" },
  enpause:   { label: "En pause",      tagClass: "archive", dot: "oklch(0.7 0.02 70)" },
}

/** Demo savings goals derived from the sample clients (not persisted yet). */
function buildObjectifs() {
  const base = CLIENTS.filter(c => c.status !== "attente").map((c, i) => {
    const pct      = Math.round((c.balance / c.goal) * 100)
    const days     = [62, 38, 91, 14, 27, 120, 9, 48][i] || 30
    const cat      = ["Pèlerinage", "Scolarité", "Mariage", "Logement", "Tontine", "Soudure agricole", "Logement", "Scolarité"][i] || "Tontine"
    const deadline = ["1 juil. 2026", "12 juin 2026", "5 août 2026", "19 mai 2026", "1 juin 2026", "2 sept. 2026", "14 mai 2026", "22 juin 2026"][i] || "—"
    const status   =
      pct >= 100        ? "atteint"   :
      days < 21 && pct < 80 ? "enretard"  :
      pct >= 80         ? "enavance"  :
                          "surrythme"
    return {
      id: 10 + c.id, client: c.name, initials: c.initials, phone: c.phone,
      agent: c.agent, village: c.village, product: c.product,
      category: cat, target: c.goal, current: c.balance, monthly: c.monthlyAvg,
      pct, daysLeft: days, deadline, created: c.joined, status,
    }
  })
  base.push({
    id: 30, client: "Adèle Sawadogo", initials: "AS", phone: "+226 70 99 11 22",
    agent: "K. Djibril", village: "Bobo-Dioulasso", product: "Plan+",
    category: "Mariage", target: 300000, current: 312000, monthly: 28000,
    pct: 104, daysLeft: 0, deadline: "Atteint le 28 avr.", created: "2024-05-01", status: "atteint",
  })
  base.push({
    id: 31, client: "Yacouba Compaoré", initials: "YC", phone: "+226 76 12 89 04",
    agent: "A. Ouédraogo", village: "Hounde", product: "Carnet",
    category: "Logement", target: 500000, current: 95000, monthly: 0,
    pct: 19, daysLeft: 220, deadline: "12 déc. 2026", created: "2025-09-12", status: "enpause",
  })
  return base
}

const OBJECTIFS = buildObjectifs()

const OBJ_KPIS = [
  { label: "Objectifs actifs",   value: String(OBJECTIFS.filter(o => o.status !== "atteint").length), unit: "",  delta: "+3",    dir: "up", note: "ce mois",         icon: "users" },
  { label: "Épargne cumulée",    value: fmt(OBJECTIFS.reduce((s, o) => s + o.current, 0)),             unit: "FCFA", delta: "+6,1%", dir: "up", note: "vs. avr.",   icon: "wallet" },
  { label: "Atteints (12 mois)", value: "37",                                                           unit: "",  delta: "+5",    dir: "up", note: "vs. 2025",        icon: "coin" },
  { label: "Taux moy. d'atteinte", value: "68",                                                         unit: "%", delta: "+4 pts", dir: "up", note: "objectifs actifs", icon: "receipt" },
]

const CATEGORIES = [
  { name: "Scolarité",        count: 42, sum: 1820000, color: "oklch(0.6 0.13 230)" },
  { name: "Logement",         count: 18, sum: 2640000, color: "var(--brand)" },
  { name: "Pèlerinage",       count: 11, sum: 1490000, color: "oklch(0.55 0.13 280)" },
  { name: "Mariage",          count: 14, sum: 1180000, color: "oklch(0.6 0.13 340)" },
  { name: "Soudure agricole", count: 23, sum: 760000,  color: "oklch(0.6 0.13 130)" },
  { name: "Tontine",          count: 34, sum: 920000,  color: "oklch(0.65 0.06 70)" },
]

/** Colour of a goal category. */
function catColor(name) {
  return (CATEGORIES.find(c => c.name === name) || {}).color || "var(--ink-3)"
}

/** Display metadata for a goal's status. */
function statusOf(o) { return OBJ_STATUSES[o.status] }

/** Highlighted goal with remaining amount and months to completion. */
function SpotlightCard({ o }) {
  if (!o) return null
  const reste = Math.max(0, o.target - o.current)
  const monthsNeeded = o.monthly > 0 ? Math.ceil(reste / o.monthly) : "—"
  return (
    <div className="card spotlight">
      <div className="card-head">
        <div>
          <div className="card-title">Le plus proche du palier</div>
          <div className="card-sub">Objectif client à mettre en avant cette semaine</div>
        </div>
        <span className="card-action">Voir la fiche <I.Arrow size={12}/></span>
      </div>
      <div className="spotlight-body">
        <div className="spotlight-head">
          <div className="avatar lg">{o.initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.015em" }}>{o.client}</div>
            <div className="cell-sub">{o.category} · {o.product} · {o.agent}</div>
          </div>
          <span className="status-chip" data-status={o.status}>
            <span className="status-chip-dot" style={{ background: statusOf(o).dot }}/>
            {statusOf(o).label}
          </span>
        </div>

        <div className="spotlight-prog">
          <div className="spotlight-amount">
            <span className="big">{fmt(o.current)}</span>
            <span className="cell-sub" style={{ fontSize: 12.5, marginLeft: 6 }}>/ {fmt(o.target)} FCFA</span>
          </div>
          <div className="goal-bar" style={{ height: 8, marginTop: 12 }}>
            <div className="goal-fill" style={{ width: Math.min(100, o.pct) + "%" }}/>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
            <span><strong style={{ color: "var(--ink)" }}>{o.pct}%</strong> atteint</span>
            <span>Reste {fmt(reste)} FCFA</span>
          </div>
        </div>

        <div className="spotlight-stats">
          <div>
            <div className="cell-sub">Cadence actuelle</div>
            <div className="ssv">{fmt(o.monthly)} <span className="u">/mois</span></div>
          </div>
          <div>
            <div className="cell-sub">Mois restants</div>
            <div className="ssv">{monthsNeeded} <span className="u">mois</span></div>
          </div>
          <div>
            <div className="cell-sub">Échéance</div>
            <div className="ssv" style={{ fontSize: 14 }}>{o.deadline}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Goal count per category. */
function CategoriesCard({ cats }) {
  const total = cats.reduce((s, c) => s + c.count, 0)
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Répartition par motif</div>
          <div className="card-sub">{total} objectifs sur le portefeuille</div>
        </div>
        <span className="card-action">Détails <I.Arrow size={12}/></span>
      </div>
      <div style={{ padding: "4px 16px 8px" }}>
        <div className="cat-bar">
          {cats.map(c => (
            <span key={c.name} title={`${c.name} · ${c.count}`} style={{ flex: c.count, background: c.color }}/>
          ))}
        </div>
      </div>
      <div className="cat-list">
        {cats.map(c => (
          <div key={c.name} className="cat-row">
            <span className="cat-dot" style={{ background: c.color }}/>
            <span className="cat-name">{c.name}</span>
            <span className="cat-count">{c.count}</span>
            <span className="cat-sum">{fmt(c.sum)} <span className="cell-sub">FCFA</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Savings goals overview (demo data). */
export default function ObjectifsPage() {
  const [q, setQ] = useState("")
  const [seg, setSeg] = useState("tous")
  const [cat, setCat] = useState("toutes")
  const [agent, setAgent] = useState("tous")
  const [sortBy, setSortBy] = useState("pct")
  const [sortDir, setSortDir] = useState("desc")
  
  const agents = useMemo(() => ["tous",    ...Array.from(new Set(OBJECTIFS.map(o => o.agent)))],    [])
  const cats   = useMemo(() => ["toutes",  ...Array.from(new Set(OBJECTIFS.map(o => o.category)))], [])

  const filtered = useMemo(() => {
    let r = OBJECTIFS.filter(o => {
      if (seg === "encours"  && (o.status === "atteint" || o.status === "enpause")) return false
      if (seg === "atteints" && o.status !== "atteint")  return false
      if (seg === "enretard" && o.status !== "enretard") return false
      if (seg === "enpause"  && o.status !== "enpause")  return false
      if (cat !== "toutes"   && o.category !== cat)      return false
      if (agent !== "tous"   && o.agent !== agent)       return false
      if (q && !o.client.toLowerCase().includes(q.toLowerCase()) && !o.category.toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
    r.sort((a, b) => {
      const va = a[sortBy], vb = b[sortBy]
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "fr")
      return sortDir === "asc" ? cmp : -cmp
    })
    return r
  }, [q, seg, cat, agent, sortBy, sortDir])

  const counts = {
    tous:     OBJECTIFS.length,
    encours:  OBJECTIFS.filter(o => o.status !== "atteint" && o.status !== "enpause").length,
    atteints: OBJECTIFS.filter(o => o.status === "atteint").length,
    enretard: OBJECTIFS.filter(o => o.status === "enretard").length,
    enpause:  OBJECTIFS.filter(o => o.status === "enpause").length,
  }

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc")
    else { setSortBy(col); setSortDir("desc") }
  }
  const SortHead = ({ col, children, align }) => (
    <th onClick={() => toggleSort(col)} style={{ textAlign: align || "left", cursor: "pointer", userSelect: "none" }}>
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        {children}
        <span style={{ opacity: sortBy === col ? 1 : 0.25, fontSize: 9 }}>
          {sortBy === col ? (sortDir === "asc" ? "▲" : "▼") : "▾"}
        </span>
      </span>
    </th>
  )

  const spotlight = useMemo(() =>
    [...OBJECTIFS]
      .filter(o => o.status !== "atteint" && o.status !== "enpause")
      .sort((a, b) => b.pct - a.pct)[0]
  , [])

  return (
    <div className="objectifs-page">
      <PageHeader
        crumbs={["Objectifs"]}
        title="Objectifs d'épargne"
        sub={`${counts.tous} objectifs · ${counts.encours} en cours · ${counts.atteints} atteints sur 12 mois`}
      >
        <Novu />
      </PageHeader>

      <section className="kpi-row">
        {OBJ_KPIS.map(k => <KPI key={k.label} k={k}/>)}
      </section>

      <section className="row obj-row" style={{ marginBottom: 14 }}>
        <SpotlightCard o={spotlight} />
        <CategoriesCard cats={CATEGORIES} />
      </section>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button className="btn"><I.Export size={14}/>Exporter</button>
        <button className="btn brand"><I.Plus size={14} stroke="white"/>Nouvel objectif</button>
        </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="filter-bar">
          <div className="seg-tabs">
            {[
              { k: "tous",     label: "Tous",       n: counts.tous },
              { k: "encours",  label: "En cours",   n: counts.encours },
              { k: "atteints", label: "Atteints",   n: counts.atteints },
              { k: "enretard", label: "En retard",  n: counts.enretard },
              { k: "enpause",  label: "En pause",   n: counts.enpause },
            ].map(t => (
              <button key={t.k} className={"seg-tab " + (seg === t.k ? "on" : "")} onClick={() => setSeg(t.k)}>
                {t.label}<span className="seg-count">{t.n}</span>
              </button>
            ))}
          </div>
          <div className="filter-spacer"/>
          <div className="filter-group">
            <label className="filter-label">Catégorie</label>
            <select className="filter-select" value={cat} onChange={e => setCat(e.target.value)}>
              {cats.map(a => <option key={a} value={a}>{a === "toutes" ? "Toutes" : a}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label className="filter-label">Agent</label>
            <select className="filter-select" value={agent} onChange={e => setAgent(e.target.value)}>
              {agents.map(a => <option key={a} value={a}>{a === "tous" ? "Tous les agents" : a}</option>)}
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table obj-table">
            <thead>
              <tr>
                <SortHead col="client">Client</SortHead>
                <SortHead col="category">Catégorie</SortHead>
                <th style={{ width: "26%" }}>Progression</th>
                <SortHead col="current" align="right">Épargne</SortHead>
                <SortHead col="monthly" align="right">Cadence / mois</SortHead>
                <SortHead col="daysLeft">Échéance</SortHead>
                <SortHead col="status">Statut</SortHead>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => {
                const st = statusOf(o)
                return (
                  <tr key={o.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="avatar sm">{o.initials}</div>
                        <div>
                          <div style={{ fontWeight: 550 }}>{o.client}</div>
                          <div className="cell-sub">{o.agent} · {o.village}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="chip cat-chip" data-cat={o.category}>
                        <span className="cat-dot" style={{ background: catColor(o.category) }}/>
                        {o.category}
                      </span>
                    </td>
                    <td>
                      <div className="prog-cell">
                        <div className="prog-row">
                          <span className="prog-pct">{o.pct}%</span>
                          <span className="prog-target">{fmt(o.target)} <span className="cell-sub">FCFA</span></span>
                        </div>
                        <div className="goal-bar">
                          <div className="goal-fill" style={{
                            width: Math.min(100, o.pct) + "%",
                            background:
                              o.status === "atteint"  ? "linear-gradient(90deg, var(--pos), oklch(0.65 0.12 155))" :
                              o.status === "enretard" ? "linear-gradient(90deg, var(--neg), oklch(0.7 0.16 30))" :
                              o.status === "enpause"  ? "linear-gradient(90deg, oklch(0.78 0.01 70), oklch(0.85 0.01 70))" :
                              undefined
                          }}/>
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 550 }}>
                      {fmt(o.current)}<span className="cell-sub" style={{ marginLeft: 4 }}>FCFA</span>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>
                      {o.monthly > 0 ? fmt(o.monthly) : "—"}
                      {o.monthly > 0 && <span className="cell-sub" style={{ marginLeft: 4 }}>FCFA</span>}
                    </td>
                    <td>
                      {o.status === "atteint" ? (
                        <span className="cell-sub">{o.deadline}</span>
                      ) : (
                        <div style={{ lineHeight: 1.25 }}>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>
                            {o.daysLeft > 0 ? `${o.daysLeft} j` : "Aujourd'hui"}
                          </div>
                          <div className="cell-sub">{o.deadline}</div>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="status-chip" data-status={o.status}>
                        <span className="status-chip-dot" style={{ background: st.dot }}/>
                        {st.label}
                      </span>
                    </td>
                    <td><button className="btn ghost sm" style={{ padding: 4 }}><I.Arrow size={12}/></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--ink-3)", fontSize: 13 }}>
              Aucun objectif ne correspond aux filtres.
            </div>
          )}
          <div className="table-foot">
            <span>Affichage de {filtered.length} sur {OBJECTIFS.length} objectifs</span>
            <div className="pager">
              <button className="btn ghost sm" disabled>‹ Précédent</button>
              <span className="page-num on">1</span>
              <span className="page-num">2</span>
              <button className="btn ghost sm">Suivant ›</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
