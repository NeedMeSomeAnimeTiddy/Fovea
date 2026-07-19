import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SettingsViewState } from '@shared/contracts/ipc'
import { Badge, Button, Card, Select, StatusBanner, Switch, TextInput, type BadgeTone } from '../design-system'
import '../design-system/index.css'
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

  if (!state) {
    return (
      <main className="settings">
        <p>Starting SnipChat…</p>
        {error ? <StatusBanner role="alert" tone="error">{error}</StatusBanner> : null}
      </main>
    )
  }
  const account = state.provider.account

  return (
    <main className="settings">
      <header className="settings-header">
        <div>
          <span className="eyebrow">SNIPCHAT PROTOTYPE</span>
          <h1>Settings</h1>
        </div>
        <Badge className="provider-status" tone={providerTone(state.provider.state)}>{state.provider.state}</Badge>
      </header>

      {error ? <StatusBanner role="alert" tone="error">{error}</StatusBanner> : null}
      {state.provider.error ? <StatusBanner role="alert" tone="error">{state.provider.error}</StatusBanner> : null}

      <Card as="section" className="settings-section">
        <h2>Authentication</h2>
        {account ? (
          <div className="account-row">
            <div>
              <strong>{account.type === 'chatgpt' ? 'ChatGPT subscription' : 'OpenAI API key'}</strong>
              <div className="settings-muted">{account.email || 'Signed in'}{account.planType ? ` · ${account.planType} plan` : ''}</div>
            </div>
            <Button variant="danger" disabled={working} onClick={() => void run(() => window.snipchat.settings.signOut())}>Log out</Button>
          </div>
        ) : (
          <>
            <Button className="wide" disabled={working || state.provider.state === 'error'} onClick={() => void run(() => window.snipchat.settings.signInWithChatGPT())}>
              Sign in with ChatGPT
            </Button>
            <p className="settings-muted small">Uses the official browser OAuth flow. SnipChat never receives or stores your ChatGPT tokens.</p>
            <div className="divider"><span>or use the API</span></div>
            <div className="api-row">
              <TextInput label="API key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" />
              <Button variant="secondary" disabled={working || !apiKey.trim()} onClick={() => void run(async () => { await window.snipchat.settings.signInWithApiKey(apiKey); setApiKey('') })}>Use API key</Button>
            </div>
            <p className="settings-muted small">API usage is billed separately from a ChatGPT subscription. The key is passed directly to Codex and is not saved by SnipChat.</p>
          </>
        )}
      </Card>

      <Card as="section" className="settings-section">
        <h2>Model</h2>
        <Select id="model" label="Image-capable model" disabled={working || state.models.length === 0} value={state.selectedModelId ?? ''} onChange={(event) => void run(() => window.snipchat.settings.setModel(event.target.value))}>
          {state.models.length === 0 && <option value="">Sign in to load models</option>}
          {state.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}{model.isDefault ? ' — recommended' : ''}</option>)}
        </Select>
        <p className="settings-muted small">Only models reporting image input support are shown. SnipChat prefers low reasoning effort for responsiveness.</p>
      </Card>

      <Card as="section" className="settings-section">
        <h2>Application</h2>
        <div className="setting-row"><span>Global shortcut</span><kbd>{state.shortcut}</kbd></div>
        <div className="application-switch">
          <Switch label="Launch at startup" checked={state.launchAtLogin} onChange={(event) => void run(() => window.snipchat.settings.setLaunchAtLogin(event.target.checked))} />
        </div>
        <div className="path-block"><span className="path-label">Temporary screenshots</span><code>{state.tempLocation}</code></div>
        <div className="cleanup-row">
          <Button variant="secondary" onClick={() => void window.snipchat.settings.deleteTemporaryFiles().then((count) => setCleanupMessage(`Deleted ${count} temporary screenshot${count === 1 ? '' : 's'}.`)).catch((reason) => setError(message(reason)))}>Delete temporary files now</Button>
          {cleanupMessage ? <StatusBanner className="cleanup-status" tone="success">{cleanupMessage}</StatusBanner> : null}
        </div>
      </Card>

      <footer>Codex app-server {state.provider.version} · Local sidecar · No analytics</footer>
    </main>
  )
}

function providerTone(state: SettingsViewState['provider']['state']): BadgeTone {
  if (state === 'ready') return 'success'
  if (state === 'error') return 'error'
  if (state === 'starting') return 'info'
  if (state === 'stopped') return 'warning'
  return 'neutral'
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsApp /></StrictMode>)
