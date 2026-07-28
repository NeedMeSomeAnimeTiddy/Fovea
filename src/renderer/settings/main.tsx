import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SettingsViewState } from '@shared/contracts/ipc'
import { acceleratorFromKeyInput } from '../../shared/shortcut-accelerator'
import type { ConversationHistorySummary, CustomPrompt, ProviderKind, ProviderModelCapability, ShortcutAction, SpectralEdgeState } from '@shared/types/app'
import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import {
  Badge,
  BrandMark,
  Button,
  Card,
  IconButton,
  Select,
  Spinner,
  StatusBanner,
  Switch,
  TextArea,
  TextInput,
  Toast,
  ToastViewport
} from '../design-system'
import { initialiseAppearance } from '../appearance'
import { AppStatusNotice, appErrorFromUnknown } from '../status/status-presentation'
import { WindowFrame } from '../window-chrome/WindowFrame'
import { OnboardingFlow } from './OnboardingFlow'
import '../design-system/index.css'
import './settings.css'

const CATEGORIES = ['Account', 'Models', 'Prompts', 'Capture', 'Appearance', 'History', 'Privacy', 'About'] as const
type Category = typeof CATEGORIES[number]
const CATEGORY_DETAILS: Record<Category, string> = {
  Account: 'Connect and manage the AI services you trust.',
  Models: 'Choose the visual model used by each profile.',
  Prompts: 'Keep your most useful follow-up questions close.',
  Capture: 'Set shortcuts, local OCR languages, and how Fovea starts.',
  Appearance: 'Make Fovea feel at home on this PC.',
  History: 'Search and reopen conversations stored on this PC.',
  Privacy: 'Review and clear data stored on this device.',
  About: 'Version details, product principles, and help.'
}

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
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyItems, setHistoryItems] = useState<ConversationHistorySummary[]>([])
  const [historyRefresh, setHistoryRefresh] = useState(0)

  useEffect(() => { void initialiseAppearance(); void window.fovea.settings.get().then(setState).catch((reason) => setError(appErrorFromUnknown(reason))); return window.fovea.settings.onChanged(setState) }, [])
  useEffect(() => {
    if (category !== 'History') return
    let active = true
    const timer = window.setTimeout(() => {
      void window.fovea.history.list(historyQuery)
        .then((items) => { if (active) setHistoryItems(items) })
        .catch((reason) => { if (active) setError(appErrorFromUnknown(reason)) })
    }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [category, historyQuery, historyRefresh])
  const run = async (operation: () => Promise<unknown>, success = '', label = 'Saving changes…', edgeState: SpectralEdgeState = 'thinking'): Promise<void> => { setWorking(true); setActivity({ label, edgeState }); setError(null); setNotice(''); try { await operation(); setState(await window.fovea.settings.get()); if (success) setNotice(success) } catch (reason) { setError(appErrorFromUnknown(reason)) } finally { setWorking(false); setActivity(null) } }
  const recover = (recovery: AppRecoveryKind): void => {
    if (recovery === 'authenticate' || recovery === 'choose-provider' || recovery === 'open-settings') setCategory('Account')
    if (recovery === 'retry') { setError(null); void window.fovea.settings.get().then(setState).catch((reason) => setError(appErrorFromUnknown(reason))) }
  }
  if (!state) {
    return (
      <WindowFrame title="Settings" edgeState={error ? 'error' : 'connecting'} showTitlebar={false} showResizeRegions={false}>
        <ToastViewport className="settings-toasts">
          {error && <AppStatusNotice error={error} onDismiss={() => setError(null)} onRecovery={recover} />}
        </ToastViewport>
        <main className="settings-loading">
          <Spinner label="Starting Fovea" size="large" />
          <span>Starting Fovea…</span>
        </main>
      </WindowFrame>
    )
  }

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
    {!onboardingOpen && (
      <ToastViewport className="settings-toasts">
        {chatGptStatus?.state === 'starting' && (
          <Toast
            duration={7000}
            icon={<Spinner />}
            resetKey={chatGptStatus.recovering ? 'recovering-chatgpt' : 'starting-chatgpt'}
            title={chatGptStatus.recovering ? 'Reconnecting local service' : 'Starting local service'}
          >
            ChatGPT features will be available shortly.
          </Toast>
        )}
        {chatGptStatus?.state === 'error' && chatGptStatus.error && (
          <AppStatusNotice error={chatGptStatus.error} onRecovery={recover} />
        )}
        {error && <AppStatusNotice error={error} onDismiss={() => setError(null)} onRecovery={recover} />}
        {notice && (
          <Toast onDismiss={() => setNotice('')} resetKey={notice} title="Done" tone="success">
            {notice}
          </Toast>
        )}
      </ToastViewport>
    )}
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
    <aside className="settings-nav" aria-label="Settings categories"><div className="brand"><BrandMark className="brand-mark" /><div><strong>Fovea</strong><small>Settings</small></div></div><div className="settings-nav__items">{CATEGORIES.map((item) => <button aria-current={category === item ? 'page' : undefined} key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}><SettingsIcon category={item} /><span>{item}</span></button>)}</div><div className="settings-nav__footer"><span>Local-first</span><small>v{state.appVersion}</small></div></aside>
    <section className="settings-content"><header className="settings-header"><div><h1>{category}</h1><p>{CATEGORY_DETAILS[category]}</p></div>{working && <Badge icon={<Spinner size="small" />} role="status" tone="info">{activity?.label ?? 'Working…'}</Badge>}</header>
      {category === 'Account' && <>
        {state.profiles.length === 0 && <StatusBanner title="Connect a provider" tone="warning">Add a ChatGPT subscription or API-key profile before asking questions.</StatusBanner>}
        {state.profiles.length > 0 && (
          <Card as="section" className="settings-section provider-profiles-section">
            <h2>Provider profiles</h2>
            <div className="profile-list">
              {state.profiles.map((profile) => (
                <ProviderProfileRow
                  key={profile.id}
                  profile={profile}
                  working={working}
                  onRun={run}
                  onTest={async (profileId) => {
                    const loaded = await window.fovea.profiles.test(profileId)
                    setModels((current) => ({ ...current, [profileId]: loaded }))
                  }}
                />
              ))}
            </div>
          </Card>
        )}
        <Card as="section" className="settings-section">
          <h2>Add profile</h2>
          <div className="add-grid">
            <Select
              label="Provider"
              value={provider}
              onChange={(event) => {
                const value = event.target.value as typeof provider
                setProvider(value)
                setProfileName(value === 'openrouter' ? 'OpenRouter' : value === 'anthropic' ? 'Anthropic' : 'OpenAI')
              }}
            >
              <option value="openai">OpenAI API</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </Select>
            <TextInput label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} />
            <div className="key-field">
              <TextInput
                autoComplete="off"
                label="API key"
                placeholder="Encrypted by Windows"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            <Button
              disabled={working || !apiKey.trim()}
              onClick={() => void run(async () => {
                await window.fovea.profiles.createApiKey(provider, profileName, apiKey)
                setApiKey('')
              }, 'Encrypted profile added.', 'Checking credentials…', 'authenticating')}
            >
              Add API profile
            </Button>
          </div>
          <div className="divider">or</div>
          <Button
            variant="secondary"
            disabled={working || state.profiles.some((item) => item.provider === 'chatgpt')}
            onClick={() => void run(
              () => window.fovea.profiles.createChatGpt(),
              'ChatGPT profile added. Sign in to authenticate.',
              'Adding ChatGPT…',
              'connecting'
            )}
          >
            Add ChatGPT subscription
          </Button>
        </Card>
      </>}
      {category === 'Models' && <Card as="section" className="settings-section"><h2>Profile defaults</h2>{state.profiles.length === 0 && <StatusBanner title="No provider profiles" tone="warning">Add a provider from the Account page before choosing a model.</StatusBanner>}{state.profiles.map((profile) => { const available = models[profile.id] ?? []; return <div className="model-row" key={profile.id}><div><strong>{profile.name}</strong><small>Only confirmed image-capable models are offered.</small></div><Select label="Default model" value={profile.defaultModelId ?? ''} onFocus={() => { if (!models[profile.id]) void window.fovea.profiles.models(profile.id).then((items) => setModels((current) => ({ ...current, [profile.id]: items }))).catch((reason) => setError(appErrorFromUnknown(reason))) }} onChange={(event) => void run(() => window.fovea.profiles.setDefaults(profile.id, event.target.value || null, null), '', 'Saving model…')}><option value="">Choose automatically</option>{available.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select></div> })}</Card>}
      {category === 'Prompts' && <CustomPromptsSettings prompts={state.customPrompts} working={working} onSave={(id, label, prompt) => run(() => window.fovea.settings.saveCustomPrompt(id, label, prompt), id ? 'Prompt updated.' : 'Prompt added.')} onDelete={(id) => run(() => window.fovea.settings.deleteCustomPrompt(id), 'Prompt deleted.')} />}
      {category === 'Capture' && <><Card as="section" className="settings-section"><h2>Global shortcuts</h2><p className="muted">Click a shortcut then press a key combination. Suggested: Display +D, Window +W, Settings +S, Repeat +R.</p>{state.shortcuts.map((shortcut) => <ShortcutRecorder key={shortcut.action} action={shortcut.action} value={shortcut.accelerator} error={shortcut.error} onSave={(value) => run(() => window.fovea.settings.setShortcut(shortcut.action, value))} />)}<Button variant="secondary" onClick={() => void run(() => window.fovea.settings.resetShortcuts())}>Reset shortcuts</Button></Card><OcrLanguageSettings working={working} onOpen={() => void run(() => window.fovea.settings.openOcrLanguages(), 'Windows language settings opened.')} /><Card as="section" className="settings-section"><Switch label="Launch Fovea when Windows starts" checked={state.launchAtLogin} onChange={(event) => void run(() => window.fovea.settings.setLaunchAtLogin(event.target.checked))} /></Card></>}
      {category === 'Appearance' && <Card as="section" className="settings-section"><h2>Colour mode</h2><div className="appearance-options">{(['light','dark','system'] as const).map((item) => <button className={state.appearance.preference === item ? 'selected' : ''} key={item} onClick={() => void run(() => window.fovea.settings.setAppearance(item))}><span className={`theme-preview ${item}`} />{item[0]!.toUpperCase()+item.slice(1)}</button>)}</div><p className="muted">System follows the Windows app theme. Reduced-motion preferences are respected automatically.</p></Card>}
      {category === 'History' && <HistorySettings items={historyItems} query={historyQuery} working={working} onQuery={setHistoryQuery} onRefresh={() => setHistoryRefresh((value) => value + 1)} onRun={run} />}
      {category === 'Privacy' && <>
        <Card as="section" className="settings-section">
          <h2>Conversation history</h2>
          <Switch label="Private mode — do not save conversations or screenshots" checked={state.history.privateMode} onChange={(event) => void run(() => window.fovea.settings.setPrivateMode(event.target.checked), event.target.checked ? 'Private mode enabled.' : 'Conversation history enabled.')} />
          <Select label="Keep conversation history" value={String(state.history.retentionDays)} disabled={state.history.privateMode} onChange={(event) => void run(() => window.fovea.settings.setHistoryRetention(Number(event.target.value)), 'History retention updated.')}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="3650">10 years</option>
          </Select>
          <Switch label="Keep screenshot copies with history" checked={state.history.retainScreenshots} disabled={state.history.privateMode} onChange={(event) => void run(() => window.fovea.settings.setScreenshotRetention(event.target.checked), event.target.checked ? 'Screenshot history enabled.' : 'Stored screenshot copies removed.')} />
          <p className="muted">Screenshot copies are off by default. Turning this off removes existing history copies; temporary captures still disappear when their panel closes.</p>
        </Card>
        <Card as="section" className="settings-section"><h2>Temporary data</h2><p className="muted">Secrets are encrypted by Windows and never enter renderer state, settings, or diagnostics.</p><code className="path">{state.tempLocation}</code><Button variant="secondary" onClick={() => void run(async () => { const count = await window.fovea.settings.deleteTemporaryFiles(); setNotice(`Deleted ${count} temporary screenshot${count === 1 ? '' : 's'}.`) }, '', 'Cleaning temporary files…')}>Clean temporary files</Button></Card>
      </>}
      {category === 'About' && <AboutSettings appVersion={state.appVersion} onOpenTour={() => setTourOpen(true)} />}
    </section>
  </main>}
  </WindowFrame>
}

interface ProviderProfileRowProps {
  onRun(
    operation: () => Promise<unknown>,
    success?: string,
    label?: string,
    edgeState?: SpectralEdgeState
  ): Promise<void>
  onTest(profileId: string): Promise<void>
  profile: SettingsViewState['profiles'][number]
  working: boolean
}

function ProviderProfileRow({
  onRun,
  onTest,
  profile,
  working
}: ProviderProfileRowProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const signedIn = profile.authenticationState === 'signed-in'
  const needsSignIn = profile.provider === 'chatgpt' && !signedIn

  useEffect(() => {
    if (!menuOpen) return

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !menuRef.current?.contains(target)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const run = (
    operation: () => Promise<unknown>,
    success = '',
    label?: string,
    edgeState?: SpectralEdgeState
  ): void => {
    setMenuOpen(false)
    void onRun(operation, success, label, edgeState)
  }

  return (
    <article className="profile">
      <div className="profile__identity">
        <div className="profile-title">
          <strong>{profile.name}</strong>
          <Badge tone={profile.health === 'available' ? 'success' : profile.health === 'unavailable' ? 'error' : 'neutral'}>
            {providerLabel(profile.provider)}
          </Badge>
          {profile.isDefault && <Badge tone="info">Default</Badge>}
        </div>
        <small>{profile.accountLabel ?? profile.healthMessage ?? profile.authenticationState}</small>
      </div>

      <div className="profile-actions">
        {needsSignIn
          ? (
              <Button
                disabled={working}
                size="compact"
                onClick={() => run(
                  () => window.fovea.profiles.authenticate(profile.id),
                  'ChatGPT connected.',
                  'Signing in…',
                  'authenticating'
                )}
              >
                Sign in
              </Button>
            )
          : (
              <Button
                disabled={working || !signedIn}
                size="compact"
                variant="secondary"
                onClick={() => run(
                  () => onTest(profile.id),
                  'Connection healthy.',
                  'Testing connection…',
                  'connecting'
                )}
              >
                Test
              </Button>
            )}

        <div className="profile-menu" ref={menuRef}>
          <IconButton
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            icon={<MoreIcon />}
            label={`More actions for ${profile.name}`}
            ref={triggerRef}
            size="compact"
            variant="ghost"
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen && (
            <div aria-label={`${profile.name} actions`} className="profile-menu__popover" role="menu">
              <Button
                role="menuitem"
                size="compact"
                variant="ghost"
                onClick={() => {
                  setMenuOpen(false)
                  const name = window.prompt('Profile name', profile.name)
                  if (name) void onRun(() => window.fovea.profiles.rename(profile.id, name), 'Profile renamed.')
                }}
              >
                Rename
              </Button>
              {!profile.isDefault && (
                <Button
                  role="menuitem"
                  size="compact"
                  variant="ghost"
                  onClick={() => run(() => window.fovea.profiles.setDefault(profile.id), 'Default profile updated.')}
                >
                  Make default
                </Button>
              )}
              {signedIn && (
                <Button
                  role="menuitem"
                  size="compact"
                  variant="ghost"
                  onClick={() => run(() => window.fovea.profiles.signOut(profile.id), 'Profile signed out.')}
                >
                  Sign out
                </Button>
              )}
              <Button
                role="menuitem"
                size="compact"
                variant="danger"
                onClick={() => run(() => window.fovea.profiles.delete(profile.id), 'Profile deleted.')}
              >
                Delete profile
              </Button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function MoreIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="currentColor" focusable="false" viewBox="0 0 20 20">
      <circle cx="4" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="16" cy="10" r="1.4" />
    </svg>
  )
}

function providerLabel(provider: ProviderKind): string {
  return ({
    anthropic: 'Anthropic',
    chatgpt: 'ChatGPT',
    openai: 'OpenAI',
    openrouter: 'OpenRouter'
  })[provider]
}

export function AboutSettings({ appVersion, onOpenTour }: { appVersion: string; onOpenTour(): void }): React.JSX.Element {
  return <Card as="section" className="settings-section about-card"><div className="about-hero"><BrandMark className="about-hero__mark" /><div><h2>Fovea</h2><span>Version {appVersion}</span></div></div><p>Ask questions about any part of your screen with the provider profile you choose.</p><p className="muted">MIT licensed · No analytics · Official provider APIs only</p><Button variant="secondary" onClick={onOpenTour}>Run welcome tour again</Button></Card>
}

export function OcrLanguageSettings({
  working,
  onOpen
}: {
  working: boolean
  onOpen(): void
}): React.JSX.Element {
  return (
    <Card as="section" className="settings-section">
      <h2>Text recognition languages</h2>
      <p className="muted">
        Fovea uses OCR languages installed in Windows. Add a Windows language pack to recognise more languages locally.
      </p>
      <Button disabled={working} variant="secondary" onClick={onOpen}>
        Manage OCR languages
      </Button>
    </Card>
  )
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
function HistorySettings({ items, query, working, onQuery, onRefresh, onRun }: { items: ConversationHistorySummary[]; query: string; working: boolean; onQuery(value: string): void; onRefresh(): void; onRun(operation: () => Promise<unknown>, success?: string, label?: string, edgeState?: SpectralEdgeState): Promise<void> }): React.JSX.Element {
  return <Card as="section" className="settings-section history-section">
    <div className="history-section__heading"><h2>Saved conversations</h2><Button size="compact" variant="ghost" onClick={onRefresh}>Refresh</Button></div>
    <TextInput label="Search history" placeholder="Search questions and answers" value={query} onChange={(event) => onQuery(event.target.value)} />
    {items.length === 0
      ? <p className="muted">{query ? 'No saved conversations match this search.' : 'No conversations have been saved yet.'}</p>
      : <div className="history-list">{items.map((item) => <div className="history-row" key={item.id}><div><strong>{item.title}</strong><small>{formatHistoryDate(item.updatedAt)} · {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}{item.hasScreenshots ? ' · screenshots retained' : ''}</small></div><div className="history-row__actions"><Button disabled={working} size="compact" variant="secondary" onClick={() => void onRun(() => window.fovea.history.open(item.id), '', 'Opening conversation…')}>Open</Button><Button disabled={working} size="compact" variant="danger" onClick={() => void onRun(async () => { await window.fovea.history.delete(item.id); onRefresh() }, 'Conversation deleted.')}>Delete</Button></div></div>)}</div>}
    <Button disabled={working || items.length === 0} variant="danger" onClick={() => { if (window.confirm('Delete all saved conversation history? This cannot be undone.')) void onRun(async () => { const count = await window.fovea.history.clear(); onRefresh(); return count }, 'All conversation history deleted.', 'Clearing history…') }}>Clear all history</Button>
  </Card>
}
function formatHistoryDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString() }
function SettingsIcon({ category }: { category: Category }): React.JSX.Element {
  const paths: Record<Category, React.JSX.Element> = {
    Account: <><circle cx="12" cy="8" r="3.25" /><path d="M5.5 19c.7-3.8 2.8-5.7 6.5-5.7s5.8 1.9 6.5 5.7" /></>,
    Models: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /><circle cx="12" cy="12" r="2.5" /></>,
    Prompts: <><path d="M4 5.5h16v11H9l-5 4v-15Z" /><path d="M8 9h8m-8 3.5h6" /></>,
    Capture: <><path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><rect x="7.5" y="7.5" width="9" height="9" rx="2" /></>,
    Appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
    History: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6M12 7.5V12l3 2" /></>,
    Privacy: <><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" /><circle cx="12" cy="15" r="1" /></>,
    About: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>
  }
  return <svg aria-hidden="true" className="settings-nav__icon" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24">{paths[category]}</svg>
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><SettingsApp /></StrictMode>)
