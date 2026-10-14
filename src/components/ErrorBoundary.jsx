import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const unauth = String(error.message).includes('Unauthenticated')
    return (
      <div style={{ padding: 40, maxWidth: 560, margin: "60px auto", textAlign: "center" }}>
        <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>
          {unauth ? "Connexion requise" : "Impossible de charger les données"}
        </div>
        <div style={{ color: "var(--ink-3)", fontSize: 13, marginBottom: 16 }}>
          {unauth
            ? "Le serveur Convex refuse les lectures anonymes. Configurez l'authentification ou activez ADMIN_ALLOW_ANONYMOUS sur un déploiement de développement."
            : error.message}
        </div>
        <button className="btn" onClick={() => this.setState({ error: null })}>Réessayer</button>
      </div>
    )
  }
}
