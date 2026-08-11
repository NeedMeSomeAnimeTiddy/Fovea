import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SettingsViewState, ShellIntegrationState } from '@shared/contracts/ipc'
import { acceleratorFromKeyInput } from '../../shared/shortcut-accelerator'
import {
  PROVIDER_CHOICES,
  PROVIDER_CHOICE_GROUP_LABELS,
  normaliseBaseUrl,
  parseModelIds,
  providerChoice
} from '../../shared/provider-endpoint'
import type { CaptureRecipe, ConversationExportOptions, ConversationExportPreview, ConversationHistorySummary, CustomPrompt, ProviderKind, ProviderModelCapability, ShortcutAction, SpectralEdgeState } from '@shared/types/app'
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
import { ConversationExportDialog } from '../export/ConversationExportDialog'
import '../design-system/index.css'
import './settings.css'

const CATEGORIES = ['Account', 'Models', 'Prompts', 'Recipes', 'Capture', 'Appearance', 'History', 'Privacy', 'Updates', 'About'] as const
type Category = typeof CATEGORIES[number]
const CATEGORY_DETAILS: Record<Category, string> = {
  Account: 'Connect and manage the AI services you trust.',
  Models: 'Choose the visual model used by each profile.',
  Prompts: 'Keep your most useful follow-up questions close.',
  Recipes: 'Combine capture, prompt, provider, and privacy choices into repeatable workflows.',
  Capture: 'Set shortcuts, local OCR languages, and how Fovea starts.',
  Appearance: 'Make Fovea feel at home on this PC.',
  History: 'Search and reopen conversations stored on this PC.',
  Privacy: 'Review and clear data stored on this device.',
  Updates: 'Review signed releases and choose when to download or install.',
  About: 'Version details, product principles, and help.'
}

function SettingsApp(): React.JSX.Element {
  const [state, setState] = useState<SettingsViewState | null>(null)
  const [category, setCategory] = useState<Category>('Account')
  const [choiceId, setChoiceId] = useState('openai')
  const choice = providerChoice(choiceId)
  const [profileName, setProfileName] = useState('OpenAI')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelIds, setModelIds] = useState('')
  const [models, setModels] = useState<Record<string, ProviderModelCapability[]>>({})
  const [error, setError] = useState<AppError | null>(null)
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [activity, setActivity] = useState<{ label: string; edgeState: SpectralEdgeState } | null>(null)
  const [tourOpen, setTourOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyItems, setHistoryItems] = useState<ConversationHistorySummary[]>([])
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [historyExport, setHistoryExport] = useState<{ id: string; preview: ConversationExportPreview } | null>(null)

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
  const run = async (operation: () => Promise<unknown>, success = '', label = 'Saving changes…', edgeState: SpectralEdgeState = 'thinking'): Promise<boolean> => { setWorking(true); setActivity({ label, edgeState }); setError(null); setNotice(''); try { const result = await operation(); setState(await window.fovea.settings.get()); if (success && result !== false && result !== 0) setNotice(success); return true } catch (reason) { setError(appErrorFromUnknown(reason)); return false } finally { setWorking(false); setActivity(null) } }
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
    if (state.chatGptRuntime.state !== 'installed') await window.fovea.chatGptRuntime.install()
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
  const openHistoryExport = async (id: string): Promise<void> => {
    setError(null)
    try { setHistoryExport({ id, preview: await window.fovea.history.exportPreview(id) }) }
    catch (reason) { setError(appErrorFromUnknown(reason)) }
  }
  const exportHistory = async (options: ConversationExportOptions): Promise<void> => {
    if (!historyExport) return
    const id = historyExport.id
    setWorking(true)
    setActivity({ label: 'Exporting conversation…', edgeState: 'thinking' })
    setError(null)
    setNotice('')
    try {
      const exported = await window.fovea.history.exportConversation(id, options)
      if (exported) {
        setHistoryExport(null)
        setNotice('Conversation exported.')
      }
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    } finally {
      setWorking(false)
      setActivity(null)
    }
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
        <Card as="section" className="settings-section runtime-card">
          <div>
            <h2>Optional ChatGPT runtime</h2>
            <p className="muted">
              ChatGPT subscription sign-in uses a pinned, SHA-256 verified local service ({formatBytes(state.chatGptRuntime.downloadBytes)} download and disk use).
              OpenAI, Anthropic, and OpenRouter API profiles do not need it.
            </p>
            {state.chatGptRuntime.state === 'downloading' && (
              <small role="status">Downloaded {formatBytes(state.chatGptRuntime.downloadedBytes)} of {formatBytes(state.chatGptRuntime.downloadBytes)}.</small>
            )}
            {state.chatGptRuntime.state === 'error' && <small role="alert">{state.chatGptRuntime.error}</small>}
            {state.chatGptRuntime.state === 'installed' && <small>Version {state.chatGptRuntime.version} · {formatBytes(state.chatGptRuntime.installedBytes)} installed</small>}
          </div>
          <div className="runtime-card__actions">
            {state.chatGptRuntime.state === 'installed'
              ? state.chatGptRuntime.removable && (
                  <Button
                    disabled={working}
                    variant="secondary"
                    onClick={() => void run(
                      () => window.fovea.chatGptRuntime.remove(),
                      'ChatGPT runtime removed. Profiles, settings, and history were kept.',
                      'Removing ChatGPT runtime…'
                    )}
                  >
                    Remove runtime
                  </Button>
                )
              : (
                  <Button
                    disabled={working || state.chatGptRuntime.state === 'unsupported'}
                    loading={state.chatGptRuntime.state === 'downloading'}
                    loadingLabel="Downloading verified runtime"
                    onClick={() => void run(
                      () => window.fovea.chatGptRuntime.install(),
                      'Verified ChatGPT runtime installed.',
                      'Downloading ChatGPT runtime…',
                      'connecting'
                    )}
                  >
                    {state.chatGptRuntime.state === 'error' ? 'Retry download' : `Install ${formatBytes(state.chatGptRuntime.downloadBytes)}`}
                  </Button>
                )}
          </div>
        </Card>
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
              value={choiceId}
              onChange={(event) => {
                const next = providerChoice(event.target.value)
                setChoiceId(next.id)
                setProfileName(next.name)
                setBaseUrl(next.baseUrl ?? '')
                // Local servers accept any token; showing one beats a confusing empty requirement.
                setApiKey(next.group === 'local' ? 'local' : '')
                setModelIds('')
              }}
            >
              {(['built-in', 'compatible', 'local'] as const).map((group) => (
                <optgroup key={group} label={PROVIDER_CHOICE_GROUP_LABELS[group]}>
                  {PROVIDER_CHOICES.filter((item) => item.group === group).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </optgroup>
              ))}
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
            {choice.kind === 'custom' && (
              <>
                <TextInput
                  autoComplete="off"
                  label="API address"
                  placeholder="https://api.deepseek.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <TextInput
                  autoComplete="off"
                  label="Model IDs (optional)"
                  placeholder="Leave empty to list what the API offers"
                  value={modelIds}
                  onChange={(event) => setModelIds(event.target.value)}
                />
              </>
            )}
            <Button
              disabled={working || !apiKey.trim() || (choice.kind === 'custom' && !baseUrl.trim())}
              onClick={() => void run(async () => {
                await window.fovea.profiles.createApiKey(
                  choice.kind,
                  profileName,
                  apiKey,
                  choice.kind === 'custom'
                    ? { baseUrl: normaliseBaseUrl(baseUrl), modelIds: parseModelIds(modelIds) }
                    : undefined
                )
                setApiKey('')
                setBaseUrl('')
                setModelIds('')
              }, 'Encrypted profile added.', 'Checking credentials…', 'authenticating')}
            >
              Add API profile
            </Button>
          </div>
          {choice.kind === 'custom' && (
            <StatusBanner title="Check the address before adding" tone="warning">
              Your API key and every screenshot you send are delivered to this address. Fovea cannot
              check whether a model at an outside address accepts images, so every model the API
              reports is offered — pick one you know can read pictures.
            </StatusBanner>
          )}
          <div className="divider">or</div>
          <Button
            variant="secondary"
            disabled={working || state.chatGptRuntime.state !== 'installed' || state.profiles.some((item) => item.provider === 'chatgpt')}
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
      {category === 'Recipes' && <RecipeSettings state={state} working={working} onRun={run} />}
      {category === 'Capture' && <><Card as="section" className="settings-section"><h2>Global shortcuts</h2><p className="muted">Click a shortcut then press a key combination. Suggested: Display +D, Window +W, Settings +S, Repeat +R.</p>{state.shortcuts.map((shortcut) => <ShortcutRecorder key={shortcut.action} action={shortcut.action} value={shortcut.accelerator} error={shortcut.error} onSave={(value) => run(() => window.fovea.settings.setShortcut(shortcut.action, value))} />)}<Button variant="secondary" onClick={() => void run(() => window.fovea.settings.resetShortcuts())}>Reset shortcuts</Button></Card><OcrLanguageSettings working={working} onOpen={() => void run(() => window.fovea.settings.openOcrLanguages(), 'Windows language settings opened.')} /><Card as="section" className="settings-section"><Switch label="Launch Fovea when Windows starts" checked={state.launchAtLogin} onChange={(event) => void run(() => window.fovea.settings.setLaunchAtLogin(event.target.checked))} /></Card><ShellIntegrationSettings state={state.shellIntegration} onChange={(enabled) => void run(() => window.fovea.settings.setShellIntegration(enabled))} /></>}
      {category === 'Appearance' && <Card as="section" className="settings-section"><h2>Colour mode</h2><div className="appearance-options">{(['light','dark','system'] as const).map((item) => <button className={state.appearance.preference === item ? 'selected' : ''} key={item} onClick={() => void run(() => window.fovea.settings.setAppearance(item))}><span className={`theme-preview ${item}`} />{item[0]!.toUpperCase()+item.slice(1)}</button>)}</div><p className="muted">System follows the Windows app theme. Reduced-motion preferences are respected automatically.</p></Card>}
      {category === 'History' && <HistorySettings items={historyItems} query={historyQuery} working={working} onQuery={setHistoryQuery} onRefresh={() => setHistoryRefresh((value) => value + 1)} onRun={run} onExport={(id) => void openHistoryExport(id)} />}
      {category === 'Privacy' && <>
        <Card as="section" className="settings-section">
          <h2>How Fovea handles data</h2>
          <p className="muted">Settings, temporary captures, and optional conversation history are stored on this PC. When you send a request, the selected provider receives your prompt, the images shown in the request preview, and any OCR text you chose to include. Fovea has no app account and does not collect analytics or telemetry.</p>
        </Card>
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
      {category === 'Updates' && <UpdateSettings state={state.updates} working={working} onRun={run} />}
      {category === 'About' && <AboutSettings appVersion={state.appVersion} onOpenTour={() => setTourOpen(true)} />}
    </section>
  </main>}
    {historyExport && <ConversationExportDialog preview={historyExport.preview} busy={working} onCancel={() => setHistoryExport(null)} onExport={exportHistory} />}
  </WindowFrame>
}

interface ProviderProfileRowProps {
  onRun(
    operation: () => Promise<unknown>,
    success?: string,
    label?: string,
    edgeState?: SpectralEdgeState
  ): Promise<boolean>
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
        <small>{profile.baseUrl ?? profile.accountLabel ?? profile.healthMessage ?? profile.authenticationState}</small>
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
    openrouter: 'OpenRouter',
    custom: 'Custom'
  })[provider]
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'unknown size'
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function AboutSettings({ appVersion, onOpenTour }: { appVersion: string; onOpenTour(): void }): React.JSX.Element {
  return <Card as="section" className="settings-section about-card"><div className="about-hero"><BrandMark className="about-hero__mark" /><div><h2>Fovea</h2><span>Version {appVersion}</span></div></div><p>Ask questions about any part of your screen with the provider profile you choose.</p><p className="muted">MIT licensed · No analytics · Official provider APIs only</p><Button variant="secondary" onClick={onOpenTour}>Run welcome tour again</Button></Card>
}

export function UpdateSettings({
  state,
  working,
  onRun
}: {
  state: SettingsViewState['updates']
  working: boolean
  onRun(operation: () => Promise<unknown>, success?: string, label?: string, edgeState?: SpectralEdgeState): Promise<boolean>
}): React.JSX.Element {
  if (!state.eligible) {
    const reason = ({
      'development-build': 'Development runs never contact the production update feed.',
      'platform-unsupported': 'Application updates are currently available for Windows only.',
      'architecture-unsupported': 'This release architecture does not have a compatible update channel.',
      'release-unmarked': 'This local package is not a signed, updater-enabled production release.',
      'release-marker-invalid': 'This package does not carry valid production update metadata.',
      'updater-unavailable': 'The application updater is unavailable in this build.'
    })[state.unavailableReason ?? 'updater-unavailable']
    return <StatusBanner title="Updates unavailable in this build" tone="info">{reason} You can keep using Fovea normally.</StatusBanner>
  }

  const update = state.availableUpdate
  const downloading = state.phase === 'downloading'
  const checking = state.phase === 'checking'
  const installing = state.phase === 'installing'
  const downloaded = state.phase === 'downloaded'
  const canRetryDownload = state.phase === 'error' && update !== null && state.failure?.retryable !== false
  const action = downloaded
    ? { label: 'Install and restart', activity: 'Starting signed installer…', run: () => window.fovea.updates.install() }
    : state.phase === 'available' || canRetryDownload
      ? { label: canRetryDownload ? 'Retry download' : 'Download update', activity: 'Downloading signed update…', run: () => window.fovea.updates.download() }
      : { label: state.phase === 'up-to-date' ? 'Check again' : 'Check for updates', activity: 'Checking signed releases…', run: () => window.fovea.updates.check() }

  return <>
    <Card as="section" className="settings-section update-card">
      <div className="update-card__heading">
        <div><h2>Application updates</h2><p className="muted">Installed version {state.currentVersion}{state.lastCheckedAt ? ` · last checked ${formatUpdateDate(state.lastCheckedAt)}` : ''}</p></div>
        <Badge tone={downloaded ? 'success' : update ? 'info' : 'neutral'}>{update ? `Version ${update.version}` : updatePhaseLabel(state.phase)}</Badge>
      </div>
      <Switch
        label="Check automatically for stable updates"
        checked={state.automaticChecks}
        disabled={working}
        onChange={(event) => void onRun(() => window.fovea.updates.setAutomaticChecks(event.target.checked), '', 'Saving update preference…')}
      />
      <p className="muted">Automatic checks are opt-in and only retrieve release metadata. Fovea never downloads or installs an update without your explicit choice.</p>
      {downloading && <div className="update-progress" role="status" aria-label={`Downloaded ${Math.round(state.downloadProgress?.percent ?? 0)} percent`}><progress max={100} value={state.downloadProgress?.percent ?? 0} /><small>{Math.round(state.downloadProgress?.percent ?? 0)}% downloaded</small></div>}
      <div className="update-card__actions">
        <Button
          disabled={working || checking || downloading || installing || (state.phase === 'error' && state.failure?.retryable === false)}
          loading={checking || downloading || installing}
          loadingLabel={checking ? 'Checking for updates' : downloading ? 'Downloading update' : 'Starting installer'}
          onClick={() => void onRun(action.run, '', action.activity, installing ? 'connecting' : 'thinking')}
        >
          {action.label}
        </Button>
      </div>
    </Card>
    {state.failure && <StatusBanner title={state.failure.title} tone="error">{state.failure.message}{state.failure.technicalDetails ? ` ${state.failure.technicalDetails}` : ''}</StatusBanner>}
    {update && <Card as="section" className="settings-section update-notes">
      <h2>{update.releaseName ?? `Fovea ${update.version}`}</h2>
      {update.releaseDate && <small>Released {formatUpdateDate(update.releaseDate)}</small>}
      {update.releaseNotes.length > 0
        ? <ul>{update.releaseNotes.map((note, index) => <li key={`${update.version}-${index}`}>{note}</li>)}</ul>
        : <p className="muted">No release notes were provided.</p>}
      <p className="muted">The installer must match the release SHA-512 metadata and the publisher trusted by this installed build.</p>
    </Card>}
  </>
}

function updatePhaseLabel(phase: SettingsViewState['updates']['phase']): string {
  return ({ unavailable: 'Unavailable', idle: 'Not checked', checking: 'Checking', 'up-to-date': 'Up to date', available: 'Available', downloading: 'Downloading', downloaded: 'Ready', installing: 'Installing', error: 'Action needed' })[phase]
}

function formatUpdateDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'an unknown date' : date.toLocaleString()
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

export function ShellIntegrationSettings({
  state,
  onChange
}: {
  state: ShellIntegrationState
  onChange(enabled: boolean): void
}): React.JSX.Element {
  return (
    <Card as="section" className="settings-section">
      <h2>Windows right-click menu</h2>
      <p className="muted">
        Adds <strong>Analyse with Fovea</strong> when you right-click a picture or a PDF in File Explorer.
        On Windows 11 it appears under <strong>Show more options</strong>.
      </p>
      <Switch
        label="Add Fovea to the Windows right-click menu"
        checked={state.enabled}
        disabled={!state.supported}
        onChange={(event) => onChange(event.target.checked)}
      />
      {!state.supported && (
        <StatusBanner title="Windows only" tone="info">
          The Explorer right-click menu is available on Windows.
        </StatusBanner>
      )}
      {state.supported && state.enabled && !state.registered && (
        <StatusBanner title="Menu entry needs repairing" tone="warning">
          The right-click entry is missing or out of date. Turn this off and on again to rewrite it.
        </StatusBanner>
      )}
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
  onSave(id: string | null, label: string, prompt: string): Promise<unknown>
  onDelete(id: string): Promise<unknown>
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
    if (await onSave(editingId, label, prompt) !== false) reset()
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

const RECIPE_PROMPT_STARTERS = [
  { label: 'Analyse this capture', prompt: 'Analyse this capture' },
  { label: 'Troubleshoot an error', prompt: 'Explain the visible error, identify the most likely cause, and give me the safest next steps.' },
  { label: 'Summarise', prompt: 'Summarise the important information in this capture.' },
  { label: 'Review the interface', prompt: 'Review this interface and point out anything confusing, incorrect, or worth improving.' }
]

function RecipeSettings({
  state,
  working,
  onRun
}: {
  state: SettingsViewState
  working: boolean
  onRun(operation: () => Promise<unknown>, success?: string, label?: string, edgeState?: SpectralEdgeState): Promise<boolean>
}): React.JSX.Element {
  const [draft, setDraft] = useState<CaptureRecipe | null>(null)
  const [availableModels, setAvailableModels] = useState<ProviderModelCapability[]>([])
  const fixedSelection = draft?.provider.mode === 'fixed' ? draft.provider.selection : null
  const fixedModel = fixedSelection ? availableModels.find((model) => model.id === fixedSelection.modelId) : undefined
  const shortcutState = (id: string) => state.recipeShortcuts.find((item) => item.recipeId === id)
  const begin = (recipe?: CaptureRecipe): void => {
    const next = recipe ? structuredClone(recipe) : newRecipe()
    setDraft(next)
    if (next.provider.mode === 'fixed') void loadModels(next.provider.selection.profileId)
    else setAvailableModels([])
  }
  const loadModels = async (profileId: string): Promise<void> => {
    try { setAvailableModels(await window.fovea.profiles.models(profileId)) }
    catch { setAvailableModels([]) }
  }
  const chooseFixedProfile = (profileId: string): void => {
    const profile = state.profiles.find((item) => item.id === profileId)
    if (!profile || !draft) return
    void loadModels(profileId)
    setDraft({
      ...draft,
      provider: {
        mode: 'fixed',
        selection: {
          profileId,
          provider: profile.provider,
          modelId: profile.defaultModelId ?? '',
          reasoningEffort: profile.defaultReasoningEffort
        }
      }
    })
  }
  const save = async (): Promise<void> => {
    if (!draft?.name.trim() || !draft.prompt.trim()) return
    if (draft.provider.mode === 'fixed' && !draft.provider.selection.modelId) return
    if (await onRun(() => window.fovea.settings.saveRecipe(draft), draft.autoSend ? 'Recipe saved with auto-send consent.' : 'Recipe saved.')) setDraft(null)
  }
  const setAutoSend = (enabled: boolean): void => {
    if (!draft) return
    if (enabled && !window.confirm('Auto-send uploads the captured image, selected OCR text, and prompt to this recipe’s chosen provider immediately after capture. Enable it for this recipe?')) return
    setDraft({ ...draft, autoSend: enabled, autoSendConsentVersion: enabled ? 1 : 0 })
  }
  const move = (index: number, offset: number): void => {
    const target = index + offset
    if (target < 0 || target >= state.recipes.length) return
    const ids = state.recipes.map((item) => item.id)
    const [id] = ids.splice(index, 1)
    ids.splice(target, 0, id!)
    void onRun(() => window.fovea.settings.reorderRecipes(ids), 'Recipe order updated.')
  }

  return <>
    <Card as="section" className="settings-section">
      <div className="history-section__heading"><h2>Capture recipes</h2><Button disabled={working || state.recipes.length >= 50} size="compact" onClick={() => begin()}>New recipe</Button></div>
      <p className="muted">Recipes open a fully reviewable draft. Auto-send is optional, recipe-specific, and revoked after material changes.</p>
      {state.recipes.length === 0
        ? <p className="muted">No capture recipes yet.</p>
        : <div className="prompt-list">{state.recipes.map((recipe, index) => {
            const binding = shortcutState(recipe.id)
            return <div className="prompt-row" key={recipe.id}>
              <div><strong>{recipe.name}</strong><small>{captureModeLabel(recipe.captureMode)} · {recipe.shortcut ?? 'No shortcut'} · {recipe.enabled ? binding?.registered ? 'active' : binding?.error ?? 'enabled' : 'disabled'}{recipe.autoSend ? ' · auto-send' : ''}</small></div>
              <div className="prompt-row__actions">
                <Button disabled={working || index === 0} size="compact" variant="ghost" onClick={() => move(index, -1)}>Up</Button>
                <Button disabled={working || index === state.recipes.length - 1} size="compact" variant="ghost" onClick={() => move(index, 1)}>Down</Button>
                <Button disabled={working} size="compact" variant="secondary" onClick={() => begin(recipe)}>Edit</Button>
                <Button disabled={working} size="compact" variant="secondary" onClick={() => void onRun(() => window.fovea.settings.duplicateRecipe(recipe.id), 'Recipe duplicated.')}>Duplicate</Button>
                <Button disabled={working} size="compact" variant={recipe.enabled ? 'ghost' : 'secondary'} onClick={() => void onRun(() => window.fovea.settings.saveRecipe({ ...recipe, enabled: !recipe.enabled }), recipe.enabled ? 'Recipe disabled.' : 'Recipe enabled.')}>{recipe.enabled ? 'Disable' : 'Enable'}</Button>
                <Button disabled={working} size="compact" variant="danger" onClick={() => void onRun(() => window.fovea.settings.deleteRecipe(recipe.id), 'Recipe deleted.')}>Delete</Button>
              </div>
            </div>
          })}</div>}
      <div className="prompt-form__actions">
        <Button disabled={working || state.recipes.length === 0} variant="secondary" onClick={() => void onRun(() => window.fovea.settings.exportRecipes(), 'Recipes exported.')}>Export</Button>
        <Button disabled={working || state.recipes.length >= 50} variant="secondary" onClick={() => void onRun(() => window.fovea.settings.importRecipes(), 'Recipes imported disabled for review.')}>Import</Button>
      </div>
    </Card>
    {draft && <Card as="section" className="settings-section">
      <h2>{state.recipes.some((item) => item.id === draft.id) ? 'Edit recipe' : 'New recipe'}</h2>
      <div className="prompt-form">
        <TextInput label="Name" maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <Select label="Capture mode" value={draft.captureMode} onChange={(event) => setDraft({ ...draft, captureMode: event.target.value as CaptureRecipe['captureMode'] })}>
          <option value="region">Region</option><option value="display">Current display</option><option value="window">Focused window</option><option value="repeat-last">Repeat last capture</option>
        </Select>
        <Select label="Prompt starter" value="" onChange={(event) => { const prompt = [...RECIPE_PROMPT_STARTERS, ...state.customPrompts].find((item) => item.label === event.target.value)?.prompt; if (prompt) setDraft({ ...draft, prompt }) }}>
          <option value="">Choose a built-in or saved prompt…</option>
          {RECIPE_PROMPT_STARTERS.map((item) => <option key={`built-in:${item.label}`} value={item.label}>{item.label}</option>)}
          {state.customPrompts.map((item) => <option key={item.id} value={item.label}>{item.label}</option>)}
        </Select>
        <TextArea label="Prompt" maxLength={10_000} rows={4} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
        <Select label="Provider and model" value={draft.provider.mode === 'current-default' ? '' : draft.provider.selection.profileId} onChange={(event) => event.target.value ? chooseFixedProfile(event.target.value) : setDraft({ ...draft, provider: { mode: 'current-default' } })}>
          <option value="">Use current default when run</option>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </Select>
        {draft.provider.mode === 'fixed' && <Select label="Model" value={draft.provider.selection.modelId} onChange={(event) => setDraft({ ...draft, provider: { mode: 'fixed', selection: { ...(draft.provider as Extract<CaptureRecipe['provider'], { mode: 'fixed' }>).selection, modelId: event.target.value, reasoningEffort: availableModels.find((item) => item.id === event.target.value)?.defaultReasoningEffort ?? null } } })}>
          <option value="">Choose model…</option>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
        </Select>}
        {draft.provider.mode === 'fixed' && fixedSelection && fixedModel && fixedModel.supportedReasoningEfforts.length > 0 && <Select label="Thinking effort" value={fixedSelection.reasoningEffort ?? ''} onChange={(event) => setDraft({ ...draft, provider: { mode: 'fixed', selection: { ...fixedSelection, reasoningEffort: event.target.value || null } } })}>
          <option value="">Default</option>{fixedModel.supportedReasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </Select>}
        <RecipeShortcutRecorder value={draft.shortcut} onChange={(shortcut) => setDraft({ ...draft, shortcut })} />
        <Switch label="Run local OCR and include selected text with the request" checked={draft.extractText} onChange={(event) => setDraft({ ...draft, extractText: event.target.checked, ...(event.target.checked ? {} : { ocrLanguageCode: undefined }) })} />
        {draft.extractText && <TextInput label="OCR language code (optional)" maxLength={35} placeholder="Automatic" value={draft.ocrLanguageCode ?? ''} onChange={(event) => setDraft({ ...draft, ocrLanguageCode: event.target.value || undefined })} />}
        <Switch label="Prefer web search for this request" checked={draft.preferWebSearch} onChange={(event) => setDraft({ ...draft, preferWebSearch: event.target.checked })} />
        <Switch label="Auto-send after capture" checked={draft.autoSend} onChange={(event) => setAutoSend(event.target.checked)} />
        <Switch label="Recipe enabled" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
        <div className="prompt-form__actions"><Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={working || !draft.name.trim() || !draft.prompt.trim() || (draft.provider.mode === 'fixed' && !draft.provider.selection.modelId)} onClick={() => void save()}>Save recipe</Button></div>
      </div>
    </Card>}
  </>
}

function RecipeShortcutRecorder({ value, onChange }: { value: string | null; onChange(value: string | null): void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return <div className="shortcut-row"><div><strong>Global shortcut</strong><small>Optional; built-in shortcuts keep priority.</small></div><button className={recording ? 'shortcut-input recording' : 'shortcut-input'} onClick={() => setRecording(true)} onBlur={() => setRecording(false)} onKeyDown={(event) => { if (!recording) return; event.preventDefault(); if (event.key === 'Escape') { setRecording(false); return } if (event.key === 'Backspace' || event.key === 'Delete') { onChange(null); setRecording(false); return } const accelerator = acceleratorFromKeyInput(event); if (!accelerator) return; onChange(accelerator); setRecording(false) }}>{recording ? 'Press shortcut…' : value ?? 'Unassigned'}</button></div>
}

function newRecipe(): CaptureRecipe {
  return { id: crypto.randomUUID(), name: '', enabled: true, captureMode: 'region', prompt: 'Analyse this capture', preferWebSearch: false, extractText: false, provider: { mode: 'current-default' }, shortcut: null, autoSend: false, autoSendConsentVersion: 0 }
}

function captureModeLabel(mode: CaptureRecipe['captureMode']): string {
  return ({ region: 'Region', display: 'Current display', window: 'Focused window', 'repeat-last': 'Repeat last' })[mode]
}

function ShortcutRecorder({ action, value, error, onSave }: { action: ShortcutAction; value: string | null; error?: string; onSave(value: string | null): Promise<unknown> }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return <div className="shortcut-row"><div><strong>{actionLabel(action)}</strong>{error && <small className="error-text">{error}</small>}</div><button className={recording ? 'shortcut-input recording' : 'shortcut-input'} onClick={() => setRecording(true)} onBlur={() => setRecording(false)} onKeyDown={(event) => { if (!recording) return; event.preventDefault(); if (event.key === 'Escape') { setRecording(false); return } if (event.key === 'Backspace' || event.key === 'Delete') { void onSave(null); setRecording(false); return } const accelerator = acceleratorFromKeyInput(event); if (!accelerator) return; void onSave(accelerator); setRecording(false) }}>{recording ? 'Press shortcut…' : value ?? 'Unassigned'}</button></div>
}
function actionLabel(action: ShortcutAction): string { return ({ region: 'Region capture', display: 'Current display', window: 'Focused window', 'repeat-last': 'Repeat last', settings: 'Open Settings' })[action] }
function HistorySettings({ items, query, working, onQuery, onRefresh, onRun, onExport }: { items: ConversationHistorySummary[]; query: string; working: boolean; onQuery(value: string): void; onRefresh(): void; onRun(operation: () => Promise<unknown>, success?: string, label?: string, edgeState?: SpectralEdgeState): Promise<boolean>; onExport(id: string): void }): React.JSX.Element {
  return <Card as="section" className="settings-section history-section">
    <div className="history-section__heading"><h2>Saved conversations</h2><Button size="compact" variant="ghost" onClick={onRefresh}>Refresh</Button></div>
    <TextInput label="Search history" placeholder="Search questions and answers" value={query} onChange={(event) => onQuery(event.target.value)} />
    {items.length === 0
      ? <p className="muted">{query ? 'No saved conversations match this search.' : 'No conversations have been saved yet.'}</p>
      : <div className="history-list">{items.map((item) => <div className="history-row" key={item.id}><div><strong>{item.title}</strong><small>{formatHistoryDate(item.updatedAt)} · {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}{item.hasScreenshots ? ' · screenshots retained' : ''}</small></div><div className="history-row__actions"><Button disabled={working} size="compact" variant="secondary" onClick={() => void onRun(() => window.fovea.history.open(item.id), '', 'Opening conversation…')}>Open</Button><Button disabled={working} size="compact" variant="secondary" onClick={() => onExport(item.id)}>Export</Button><Button disabled={working} size="compact" variant="danger" onClick={() => void onRun(async () => { await window.fovea.history.delete(item.id); onRefresh() }, 'Conversation deleted.')}>Delete</Button></div></div>)}</div>}
    <Button disabled={working || items.length === 0} variant="danger" onClick={() => { if (window.confirm('Delete all saved conversation history? This cannot be undone.')) void onRun(async () => { const count = await window.fovea.history.clear(); onRefresh(); return count }, 'All conversation history deleted.', 'Clearing history…') }}>Clear all history</Button>
  </Card>
}
function formatHistoryDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString() }
function SettingsIcon({ category }: { category: Category }): React.JSX.Element {
  const paths: Record<Category, React.JSX.Element> = {
    Account: <><circle cx="12" cy="8" r="3.25" /><path d="M5.5 19c.7-3.8 2.8-5.7 6.5-5.7s5.8 1.9 6.5 5.7" /></>,
    Models: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /><circle cx="12" cy="12" r="2.5" /></>,
    Prompts: <><path d="M4 5.5h16v11H9l-5 4v-15Z" /><path d="M8 9h8m-8 3.5h6" /></>,
    Recipes: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h5M8 16h7" /><path d="m15 11 2 2 3-4" /></>,
    Capture: <><path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><rect x="7.5" y="7.5" width="9" height="9" rx="2" /></>,
    Appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
    History: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6M12 7.5V12l3 2" /></>,
    Privacy: <><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" /><circle cx="12" cy="15" r="1" /></>,
    Updates: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
    About: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>
  }
  return <svg aria-hidden="true" className="settings-nav__icon" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24">{paths[category]}</svg>
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><SettingsApp /></StrictMode>)
