import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SettingsViewState } from '@shared/contracts/ipc'
import { acceleratorFromKeyInput } from '../../shared/shortcut-accelerator'
import type { CustomPrompt, ProviderKind, ProviderModelCapability, ShortcutAction, SpectralEdgeState } from '@shared/types/app'
import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import { Badge, Button, Card, Select, Spinner, StatusBanner, Switch, TextArea, TextInput } from '../design-system'
import { initialiseAppearance } from '../appearance'
import { AppStatusNotice, appErrorFromUnknown } from '../status/status-presentation'
import { WindowFrame } from '../window-chrome/WindowFrame'
import { OnboardingFlow } from './OnboardingFlow'
import '../design-system/index.css'
import './settings.css'

const CATEGORIES = ['Account', 'Models', 'Prompts', 'Capture', 'Appearance', 'Privacy', 'About'] as const
type Category = typeof CATEGORIES[number]

function SettingsApp(): React.JSX.Element {
  const [state, setState] = useState<SettingsViewState | null>(null)
  const [category, setCategory] = useState<Category>('Account')
  const [provider, setProvider] = useState<Exclude<ProviderKind, 'chatgpt'>>('openai')
  const [profileName, setProfileName] = useState('OpenAI')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<Record<string, ProviderModelCapability[]>>({})
  const [error, setError] = useState<AppError | null>(null)
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [activity, setActivity] = useState<{ label: string; edgeState: SpectralEdgeState } | null>(null)
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => { void initialiseAppearance(); void window.fovea.settings.get().then(setState).catch((reason) => setError(appErrorFromUnknown(reason))); return window.fovea.settings.onChanged(setState) }, [])
  const run = async (operation: () => Promise<unknown>, success = '', label = 'Saving changes…', edgeState: SpectralEdgeState = 'thinking'): Promise<void> => { setWorking(true); setActivity({ label, edgeState }); setError(null); setNotice(''); try { await operation(); setState(await window.fovea.settings.get()); if (success) setNotice(success) } catch (reason) { setError(appErrorFromUnknown(reason)) } finally { setWorking(false); setActivity(null) } }
  const recover = (recovery: AppRecoveryKind): void => {
    if (recovery === 'authenticate' || recovery === 'choose-provider' || recovery === 'open-settings') setCategory('Account')
    if (recovery === 'retry') { setError(null); void window.fovea.settings.get().then(setState).catch((reason) => setError(appErrorFromUnknown(reason))) }
  }
  if (!state) return <WindowFrame title="Settings" edgeState={error ? 'error' : 'connecting'} showTitlebar={false} showResizeRegions={false}><main className="settings-loading"><Spinner label="Starting Fovea" size="large" /><span>Starting Fovea…</span>{error && <AppStatusNotice error={error} onRecovery={recover} />}</main></WindowFrame>

  const chatGptStatus = state.profiles.find((profile) => profile.provider === 'chatgpt')?.status
  const runtimeEdge: SpectralEdgeState = chatGptStatus?.state === 'starting' ? (chatGptStatus.recovering ? 'recovering' : 'connecting') : chatGptStatus?.state === 'error' ? 'error' : 'idle'
  const edgeState: SpectralEdgeState = error ? 'error' : activity?.edgeState ?? (notice ? 'completed' : runtimeEdge)
  const onboardingOpen = state.onboardingStatus === 'pending' || tourOpen
  const setOnboardingStatus = async (status: 'skipped' | 'completed'): Promise<void> => {
    await window.fovea.settings.setOnboardingStatus(status)
    setState(await window.fovea.settings.get())
  }
  const signInForOnboarding = async (): Promise<void> => {
    const existing = state.profiles.find((profile) => profile.provider === 'chatgpt')
    if (existing?.authenticationState === 'signed-in') return
    const profile = existing ?? await window.fovea.profiles.createChatGpt()
    await window.fovea.profiles.authenticate(profile.id)
    setState(await window.fovea.settings.get())
  }
  const createApiProfileForOnboarding = async (providerKind: Exclude<ProviderKind, 'chatgpt'>, name: string, key: string): Promise<void> => {
    await window.fovea.profiles.createApiKey(providerKind, name, key)
    setState(await window.fovea.settings.get())
  }
  const setRegionShortcutForOnboarding = async (accelerator: string | null): Promise<void> => {
    await window.fovea.settings.setShortcut('region', accelerator)
    setState(await window.fovea.settings.get())
  }
  const exitOnboarding = (): void => {
    setTourOpen(false)
    setCategory('Account')
  }

  return <WindowFrame title={onboardingOpen ? 'Welcome to Fovea' : 'Settings'} edgeState={edgeState} showTitlebar={false} showResizeRegions={false}>
    {onboardingOpen
      ? <OnboardingFlow
          state={state}
          onExit={exitOnboarding}
          onCreateApiProfile={createApiProfileForOnboarding}
          onSetStatus={setOnboardingStatus}
          onSetShortcut={setRegionShortcutForOnboarding}
          onSignIn={signInForOnboarding}
          onTestCapture={() => window.fovea.settings.testOnboardingCapture()}
        />
      : <main className="settings-shell">
    <aside className="settings-nav" aria-label="Settings categories"><div className="brand"><span className="brand-mark">◉</span><div><strong>Fovea</strong><small>Settings</small></div></div>{CATEGORIES.map((item) => <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</aside>
    <section className="settings-content"><header><div><span className="eyebrow">PREFERENCES</span><h1>{category}</h1></div>{working && <Badge icon={<Spinner size="small" />} role="status" tone="info">{activity?.label ?? 'Working…'}</Badge>}</header>
      {chatGptStatus?.state === 'starting' && <StatusBanner icon={<Spinner />} title={chatGptStatus.recovering ? 'Reconnecting local service' : 'Starting local service'}>ChatGPT features will be available shortly.</StatusBanner>}
      {chatGptStatus?.state === 'error' && chatGptStatus.error && <AppStatusNotice error={chatGptStatus.error} onRecovery={recover} />}
      {error && <AppStatusNotice error={error} onRecovery={recover} />}{notice && <StatusBanner title="Done" tone="success">{notice}</StatusBanner>}
      {category === 'Account' && <>
        {state.profiles.length === 0 && <StatusBanner title="Connect a provider" tone="warning">Add a ChatGPT subscription or API-key profile before asking questions.</StatusBanner>}
        <Card as="section" className="settings-section"><h2>Provider profiles</h2>{state.profiles.length === 0 && <p className="muted">Add a ChatGPT subscription or an API-key profile. Profiles fail independently and Fovea never falls back silently.</p>}{state.profiles.map((profile) => <div className="profile" key={profile.id}><div><div className="profile-title"><strong>{profile.name}</strong><Badge tone={profile.health === 'available' ? 'success' : profile.health === 'unavailable' ? 'error' : 'neutral'}>{profile.provider}</Badge>{profile.isDefault && <Badge tone="info">Default</Badge>}</div><small>{profile.accountLabel ?? profile.healthMessage ?? profile.authenticationState}</small></div><div className="profile-actions">{profile.provider === 'chatgpt' && profile.authenticationState !== 'signed-in' && <Button size="compact" disabled={working} onClick={() => void run(() => window.fovea.profiles.authenticate(profile.id), 'ChatGPT connected.', 'Signing in…', 'authenticating')}>Sign in</Button>}<Button size="compact" variant="secondary" onClick={() => { const name = window.prompt('Profile name', profile.name); if (name) void run(() => window.fovea.profiles.rename(profile.id, name)) }}>Rename</Button>{profile.authenticationState === 'signed-in' && <Button size="compact" variant="secondary" onClick={() => void run(() => window.fovea.profiles.signOut(profile.id), 'Profile signed out.')}>Sign out</Button>}<Button size="compact" variant="secondary" disabled={working || profile.authenticationState !== 'signed-in'} onClick={() => void run(async () => { const loaded = await window.fovea.profiles.test(profile.id); setModels((current) => ({ ...current, [profile.id]: loaded })) }, 'Connection healthy.', 'Testing connection…', 'connecting')}>Test</Button>{!profile.isDefault && <Button size="compact" variant="secondary" onClick={() => void run(() => window.fovea.profiles.setDefault(profile.id))}>Make default</Button>}<Button size="compact" variant="danger" onClick={() => void run(() => window.fovea.profiles.delete(profile.id))}>Delete</Button></div></div>)}</Card>
        <Card as="section" className="settings-section"><h2>Add profile</h2><div className="add-grid"><Select label="Provider" value={provider} onChange={(event) => { const value = event.target.value as typeof provider; setProvider(value); setProfileName(value === 'openrouter' ? 'OpenRouter' : value === 'anthropic' ? 'Anthropic' : 'OpenAI') }}><option value="openai">OpenAI API</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option></Select><TextInput label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} /><TextInput className="key-field" label="API key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Stored with Windows encryption" /><Button disabled={working || !apiKey.trim()} onClick={() => void run(async () => { await window.fovea.profiles.createApiKey(provider, profileName, apiKey); setApiKey('') }, 'Encrypted profile added.', 'Checking credentials…', 'authenticating')}>Add API profile</Button></div><div className="divider">or</div><Button variant="secondary" disabled={working || state.profiles.some((item) => item.provider === 'chatgpt')} onClick={() => void run(() => window.fovea.profiles.createChatGpt(), 'ChatGPT profile added. Sign in to authenticate.', 'Adding ChatGPT…', 'connecting')}>Add ChatGPT subscription</Button></Card>
      </>}
      {category === 'Models' && <Card as="section" className="settings-section"><h2>Profile defaults</h2>{state.profiles.length === 0 && <StatusBanner title="No provider profiles" tone="warning">Add a provider from the Account page before choosing a model.</StatusBanner>}{state.profiles.map((profile) => { const available = models[profile.id] ?? []; return <div className="model-row" key={profile.id}><div><strong>{profile.name}</strong><small>Only confirmed image-capable models are offered.</small></div><Select label="Default model" value={profile.defaultModelId ?? ''} onFocus={() => { if (!models[profile.id]) void window.fovea.profiles.models(profile.id).then((items) => setModels((current) => ({ ...current, [profile.id]: items }))).catch((reason) => setError(appErrorFromUnknown(reason))) }} onChange={(event) => void run(() => window.fovea.profiles.setDefaults(profile.id, event.target.value || null, null), '', 'Saving model…')}><option value="">Choose automatically</option>{available.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select></div> })}</Card>}
      {category === 'Prompts' && <CustomPromptsSettings prompts={state.customPrompts} working={working} onSave={(id, label, prompt) => run(() => window.fovea.settings.saveCustomPrompt(id, label, prompt), id ? 'Prompt updated.' : 'Prompt added.')} onDelete={(id) => run(() => window.fovea.settings.deleteCustomPrompt(id), 'Prompt deleted.')} />}
      {category === 'Capture' && <><Card as="section" className="settings-section"><h2>Global shortcuts</h2><p className="muted">Click a shortcut then press a key combination. Suggested: Display +D, Window +W, Settings +S, Repeat +R.</p>{state.shortcuts.map((shortcut) => <ShortcutRecorder key={shortcut.action} action={shortcut.action} value={shortcut.accelerator} error={shortcut.error} onSave={(value) => run(() => window.fovea.settings.setShortcut(shortcut.action, value))} />)}<Button variant="secondary" onClick={() => void run(() => window.fovea.settings.resetShortcuts())}>Reset shortcuts</Button></Card><Card as="section" className="settings-section"><Switch label="Launch Fovea when Windows starts" checked={state.launchAtLogin} onChange={(event) => void run(() => window.fovea.settings.setLaunchAtLogin(event.target.checked))} /></Card></>}
      {category === 'Appearance' && <Card as="section" className="settings-section"><h2>Colour mode</h2><div className="appearance-options">{(['light','dark','system'] as const).map((item) => <button className={state.appearance.preference === item ? 'selected' : ''} key={item} onClick={() => void run(() => window.fovea.settings.setAppearance(item))}><span className={`theme-preview ${item}`} />{item[0]!.toUpperCase()+item.slice(1)}</button>)}</div><p className="muted">System follows the Windows app theme. Reduced-motion preferences are respected automatically.</p></Card>}
      {category === 'Privacy' && <Card as="section" className="settings-section"><h2>Local data</h2><p className="muted">Secrets are encrypted by Windows and never enter renderer state, settings, or diagnostics. Screenshots are temporary.</p><code className="path">{state.tempLocation}</code><Button variant="secondary" onClick={() => void run(async () => { const count = await window.fovea.settings.deleteTemporaryFiles(); setNotice(`Deleted ${count} temporary screenshot${count === 1 ? '' : 's'}.`) }, '', 'Cleaning temporary files…')}>Clean temporary files</Button></Card>}
      {category === 'About' && <AboutSettings appVersion={state.appVersion} onOpenTour={() => setTourOpen(true)} />}
    </section>
  </main>}
  </WindowFrame>
}

export function AboutSettings({ appVersion, onOpenTour }: { appVersion: string; onOpenTour(): void }): React.JSX.Element {
  return <Card as="section" className="settings-section"><h2>Fovea {appVersion}</h2><p>Ask questions about any part of your screen with the provider profile you choose.</p><p className="muted">MIT licensed · No analytics · Official provider APIs only</p><Button variant="secondary" onClick={onOpenTour}>Run welcome tour again</Button></Card>
}

export function CustomPromptsSettings({
  prompts,
  working,
  onSave,
  onDelete
}: {
  prompts: CustomPrompt[]
  working: boolean
  onSave(id: string | null, label: string, prompt: string): Promise<void>
  onDelete(id: string): Promise<void>
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')

  const reset = (): void => {
    setEditingId(null)
    setLabel('')
    setPrompt('')
  }
  const edit = (item: CustomPrompt): void => {
    setEditingId(item.id)
    setLabel(item.label)
    setPrompt(item.prompt)
  }
  const save = async (): Promise<void> => {
    if (!label.trim() || !prompt.trim()) return
    await onSave(editingId, label, prompt)
    reset()
  }

  return <>
    <Card as="section" className="settings-section">
      <h2>{editingId ? 'Edit prompt' : 'Add custom prompt'}</h2>
      <p className="muted">Saved prompts appear in the Ask dropdown and are sent as normal follow-up questions.</p>
      <div className="prompt-form">
        <TextInput label="Name" maxLength={80} placeholder="For example: Summarise for Slack" value={label} onChange={(event) => setLabel(event.target.value)} />
        <TextArea label="Prompt" maxLength={2_000} placeholder="Write the question or instruction to send…" resize="vertical" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <div className="prompt-form__actions">
          {editingId && <Button variant="secondary" disabled={working} onClick={reset}>Cancel</Button>}
          <Button disabled={working || !label.trim() || !prompt.trim() || (!editingId && prompts.length >= 20)} onClick={() => void save()}>{editingId ? 'Save changes' : 'Add prompt'}</Button>
        </div>
      </div>
      {!editingId && prompts.length >= 20 && <small className="error-text">You can save up to 20 custom prompts.</small>}
    </Card>
    <Card as="section" className="settings-section">
      <h2>Saved prompts</h2>
      {prompts.length === 0
        ? <p className="muted">No custom prompts yet.</p>
        : <div className="prompt-list">{prompts.map((item) => <div className="prompt-row" key={item.id}><div><strong>{item.label}</strong><small>{item.prompt}</small></div><div className="prompt-row__actions"><Button size="compact" variant="secondary" disabled={working} onClick={() => edit(item)}>Edit</Button><Button size="compact" variant="danger" disabled={working} onClick={() => void onDelete(item.id)}>Delete</Button></div></div>)}</div>}
    </Card>
  </>
}

function ShortcutRecorder({ action, value, error, onSave }: { action: ShortcutAction; value: string | null; error?: string; onSave(value: string | null): Promise<void> }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return <div className="shortcut-row"><div><strong>{actionLabel(action)}</strong>{error && <small className="error-text">{error}</small>}</div><button className={recording ? 'shortcut-input recording' : 'shortcut-input'} onClick={() => setRecording(true)} onBlur={() => setRecording(false)} onKeyDown={(event) => { if (!recording) return; event.preventDefault(); if (event.key === 'Escape') { setRecording(false); return } if (event.key === 'Backspace' || event.key === 'Delete') { void onSave(null); setRecording(false); return } const accelerator = acceleratorFromKeyInput(event); if (!accelerator) return; void onSave(accelerator); setRecording(false) }}>{recording ? 'Press shortcut…' : value ?? 'Unassigned'}</button></div>
}
function actionLabel(action: ShortcutAction): string { return ({ region: 'Region capture', display: 'Current display', window: 'Focused window', 'repeat-last': 'Repeat last', settings: 'Open Settings' })[action] }
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><SettingsApp /></StrictMode>)
