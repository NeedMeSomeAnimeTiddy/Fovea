import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SettingsViewState } from '@shared/contracts/ipc'
import '../shared.css'
import './settings.css'

function SettingsApp(): React.JSX.Element {
  const [state, setState] = useState<SettingsViewState | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [cleanupMessage, setCleanupMessage] = useState('')

  useEffect(() => {
    void window.snipchat.settings.get().then(setState).catch((reason) => setError(message(reason)))
    return window.snipchat.settings.onChanged(setState)
  }, [])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setWorking(true)
    setError('')
    try {
      await operation()
      setState(await window.snipchat.settings.get())
    } catch (reason) {
      setError(message(reason))
    } finally {
      setWorking(false)
    }
  }

  if (!state) return <main className="settings"><p>Starting SnipChat…</p>{error && <p className="error">{error}</p>}</main>
  const account = state.provider.account

  return (
    <main className="settings">
      <header>
        <div><span className="eyebrow">SNIPCHAT PROTOTYPE</span><h1>Settings</h1></div>
        <span className={`status ${state.provider.state}`}>{state.provider.state}</span>
      </header>

      {error && <p className="error">{error}</p>}
      {state.provider.error && <p className="error">{state.provider.error}</p>}

      <section>
        <h2>Authentication</h2>
        {account ? (
          <div className="account-row">
            <div>
              <strong>{account.type === 'chatgpt' ? 'ChatGPT subscription' : 'OpenAI API key'}</strong>
              <div className="muted">{account.email || 'Signed in'}{account.planType ? ` · ${account.planType} plan` : ''}</div>
            </div>
            <button className="button danger" disabled={working} onClick={() => void run(() => window.snipchat.settings.signOut())}>Log out</button>
          </div>
        ) : (
          <>
            <button className="button primary wide" disabled={working || state.provider.state === 'error'} onClick={() => void run(() => window.snipchat.settings.signInWithChatGPT())}>
              Sign in with ChatGPT
            </button>
            <p className="muted small">Uses the official browser OAuth flow. SnipChat never receives or stores your ChatGPT tokens.</p>
            <div className="divider"><span>or use the API</span></div>
            <div className="api-row">
              <input className="field" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" />
              <button className="button" disabled={working || !apiKey.trim()} onClick={() => void run(async () => { await window.snipchat.settings.signInWithApiKey(apiKey); setApiKey('') })}>Use API key</button>
            </div>
            <p className="muted small">API usage is billed separately from a ChatGPT subscription. The key is passed directly to Codex and is not saved by SnipChat.</p>
          </>
        )}
      </section>

      <section>
        <h2>Model</h2>
        <label className="label" htmlFor="model">Image-capable model</label>
        <select id="model" className="field" disabled={working || state.models.length === 0} value={state.selectedModelId ?? ''} onChange={(event) => void run(() => window.snipchat.settings.setModel(event.target.value))}>
          {state.models.length === 0 && <option value="">Sign in to load models</option>}
          {state.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}{model.isDefault ? ' — recommended' : ''}</option>)}
        </select>
        <p className="muted small">Only models reporting image input support are shown. SnipChat prefers low reasoning effort for responsiveness.</p>
      </section>

      <section>
        <h2>Application</h2>
        <div className="setting-row"><span>Global shortcut</span><kbd>{state.shortcut}</kbd></div>
        <label className="setting-row"><span>Launch at startup</span><input type="checkbox" checked={state.launchAtLogin} onChange={(event) => void run(() => window.snipchat.settings.setLaunchAtLogin(event.target.checked))} /></label>
        <div className="path-block"><span className="label">Temporary screenshots</span><code>{state.tempLocation}</code></div>
        <button className="button" onClick={() => void window.snipchat.settings.deleteTemporaryFiles().then((count) => setCleanupMessage(`Deleted ${count} temporary screenshot${count === 1 ? '' : 's'}.`)).catch((reason) => setError(message(reason)))}>Delete temporary files now</button>
        {cleanupMessage && <span className="success cleanup">{cleanupMessage}</span>}
      </section>

      <footer>Codex app-server {state.provider.version} · Local sidecar · No analytics</footer>
    </main>
  )
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsApp /></StrictMode>)
