import { useState } from 'react'
import { useAuthActions } from '@convex-dev/auth/react'
import { I } from '../icons'

// Staff-only sign-in. "Première connexion" sets the password for a staff
// member an administrator already created; there is no open sign-up.
export default function LoginPage() {
  const { signIn } = useAuthActions()
  const [flow, setFlow]       = useState("signIn")
  const [email, setEmail]     = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState(null)

  const firstLogin = flow === "signUp"

  const onSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (firstLogin) {
      if (password.length < 8) return setError("Le mot de passe doit contenir au moins 8 caractères.")
      if (password !== confirm) return setError("Les mots de passe ne correspondent pas.")
    }
    setBusy(true)
    try {
      await signIn("password", { email: email.trim().toLowerCase(), password, flow })
    } catch {
      // Same message whatever the cause, so the form never reveals which emails are staff
      setError(firstLogin
        ? "Impossible d'activer ce compte. Vérifiez l'email ou contactez l'Admin IT."
        : "Email ou mot de passe incorrect.")
    } finally {
      setBusy(false)
    }
  }

  const switchFlow = () => {
    setFlow(firstLogin ? "signIn" : "signUp")
    setError(null); setPassword(""); setConfirm("")
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--bg)" }}>
      <form onSubmit={onSubmit} className="card" style={{ width: "100%", maxWidth: 380, padding: 28 }}>
        <div className="brand" style={{ padding: 0, marginBottom: 22 }}>
          <div className="brand-mark"><I.KauriDrop stroke="white" /></div>
          <div>
            <div className="brand-name">Kauri</div>
            <div className="brand-sub">Gestion d'épargne</div>
          </div>
        </div>

        <h1 className="h1" style={{ fontSize: 20, marginBottom: 4 }}>
          {firstLogin ? "Première connexion" : "Connexion"}
        </h1>
        <div className="h1-sub" style={{ marginBottom: 20 }}>
          {firstLogin
            ? "Choisissez le mot de passe de votre compte agence."
            : "Accès réservé au personnel de l'agence."}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="field">
            <span className="field-label">Email professionnel</span>
            <input className="input" type="email" autoComplete="username" required
              value={email} onChange={e => setEmail(e.target.value)} placeholder="prenom.nom@kauri.bf" />
          </label>
          <label className="field">
            <span className="field-label">{firstLogin ? "Nouveau mot de passe" : "Mot de passe"}</span>
            <input className="input" type="password" required
              autoComplete={firstLogin ? "new-password" : "current-password"}
              value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          {firstLogin && (
            <label className="field">
              <span className="field-label">Confirmer le mot de passe</span>
              <input className="input" type="password" autoComplete="new-password" required
                value={confirm} onChange={e => setConfirm(e.target.value)} />
            </label>
          )}

          {error && <div role="alert" style={{ color: "var(--neg)", fontSize: 12.5 }}>{error}</div>}

          <button className="btn brand" type="submit" disabled={busy}
            style={{ justifyContent: "center", padding: "9px 12px" }}>
            {busy ? "Patientez…" : firstLogin ? "Activer mon compte" : "Se connecter"}
          </button>
        </div>

        <div style={{ marginTop: 18, fontSize: 12.5, color: "var(--ink-3)", textAlign: "center" }}>
          {firstLogin ? "Déjà un mot de passe ? " : "Pas encore de mot de passe ? "}
          <button type="button" className="btn ghost sm" onClick={switchFlow} style={{ padding: "2px 4px" }}>
            {firstLogin ? "Se connecter" : "Première connexion"}
          </button>
        </div>
      </form>
    </div>
  )
}
