import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { OnboardingTestCaptureResult, SettingsViewState } from '@shared/contracts/ipc'
import type { AppRecoveryKind } from '@shared/types/app-error'
import type { OnboardingStatus, ProviderKind } from '@shared/types/app'
import { acceleratorFromKeyInput } from '../../shared/shortcut-accelerator'
import {
  Badge,
  BrandMark,
  Button,
  Card,
  Spinner,
  StatusBanner,
  TextInput,
  Toast,
  ToastViewport
} from '../design-system'
import { AppStatusNotice, appErrorFromUnknown } from '../status/status-presentation'

const STEPS = [
  { label: 'How it works', title: 'Ask anything you can see' },
  { label: 'Connect', title: 'Choose how to connect' },
  { label: 'Shortcut & test', title: 'Set your capture shortcut' }
] as const

export interface OnboardingFlowProps {
  state: SettingsViewState
  onExit(): void
  onSetStatus(status: Exclude<OnboardingStatus, 'pending'>): Promise<void>
  onSignIn(): Promise<void>
  onCreateApiProfile(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<void>
  onSetShortcut(accelerator: string | null): Promise<void>
  onTestCapture(): Promise<OnboardingTestCaptureResult>
}

export function OnboardingFlow({
  state,
  onExit,
  onSetStatus,
  onSignIn,
  onCreateApiProfile,
  onSetShortcut,
  onTestCapture
}: OnboardingFlowProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [activity, setActivity] = useState<'provider' | 'capture' | 'shortcut' | 'status' | null>(null)
  const [error, setError] = useState<ReturnType<typeof appErrorFromUnknown> | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRun = state.onboardingStatus === 'pending'
  const chatGptProfile = state.profiles.find((profile) => profile.provider === 'chatgpt')
  const regionShortcut = state.shortcuts.find((shortcut) => shortcut.action === 'region')

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  const moveTo = (nextStep: number): void => {
    setError(null)
    setAnnouncement('')
    setStep(Math.max(0, Math.min(STEPS.length - 1, nextStep)))
  }
  const signIn = async (): Promise<void> => {
    setActivity('provider')
    setError(null)
    setAnnouncement('Opening ChatGPT sign-in in your browser.')
    try {
      await onSignIn()
      setAnnouncement('ChatGPT is connected. You can continue the tour.')
    } catch (reason) {
      setAnnouncement('')
      setError(appErrorFromUnknown(reason))
    } finally {
      setActivity(null)
    }
  }
  const createApiProfile = async (provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<boolean> => {
    setActivity('provider')
    setError(null)
    setAnnouncement(`Connecting ${name}…`)
    try {
      await onCreateApiProfile(provider, name, apiKey)
      setAnnouncement(`${name} is connected. You can continue the tour.`)
      return true
    } catch (reason) {
      setAnnouncement('')
      setError(appErrorFromUnknown(reason))
      return false
    } finally {
      setActivity(null)
    }
  }
  const saveShortcut = async (accelerator: string | null): Promise<void> => {
    setActivity('shortcut')
    setError(null)
    setAnnouncement('Saving shortcut…')
    try {
      await onSetShortcut(accelerator)
      setAnnouncement(accelerator ? `Region capture shortcut set to ${accelerator}.` : 'Region capture shortcut removed.')
    } catch (reason) {
      setAnnouncement('')
      setError(appErrorFromUnknown(reason))
    } finally {
      setActivity(null)
    }
  }
  const testCapture = async (): Promise<void> => {
    setActivity('capture')
    setError(null)
    setAnnouncement('Choose a region. Press Escape to cancel.')
    setPreview(null)
    try {
      const result = await onTestCapture()
      if (result.status === 'captured') {
        setPreview(result.thumbnailDataUrl)
        setAnnouncement('Test capture complete. The temporary file was deleted and nothing was sent to AI.')
      } else {
        setAnnouncement('Test capture cancelled. Nothing was saved or sent.')
      }
    } catch (reason) {
      setAnnouncement('')
      setError(appErrorFromUnknown(reason))
    } finally {
      setActivity(null)
    }
  }
  const finish = async (): Promise<void> => {
    setActivity('status')
    setError(null)
    try {
      if (state.onboardingStatus !== 'completed') await onSetStatus('completed')
      setPreview(null)
      onExit()
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    } finally {
      setActivity(null)
    }
  }
  const skipOrClose = async (): Promise<void> => {
    setActivity('status')
    setError(null)
    try {
      if (firstRun) await onSetStatus('skipped')
      setPreview(null)
      onExit()
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    } finally {
      setActivity(null)
    }
  }
  const recover = (recovery: AppRecoveryKind): void => {
    if (recovery === 'authenticate') void signIn()
    else setError(null)
  }

  return (
    <main className="onboarding-shell">
      <ToastViewport className="onboarding-toasts">
        {error && (
          <AppStatusNotice
            error={error}
            onDismiss={() => setError(null)}
            onRecovery={recover}
          />
        )}
        {announcement && (
          <Toast
            icon={activity ? <Spinner /> : undefined}
            onDismiss={() => setAnnouncement('')}
            resetKey={announcement}
            tone={activity ? 'info' : 'success'}
          >
            {announcement}
          </Toast>
        )}
      </ToastViewport>

      <header className="onboarding-header">
        <div className="onboarding-brand">
          <BrandMark className="brand-mark" />
          <div><strong>Fovea</strong><span>Welcome tour</span></div>
        </div>
        <Badge tone="info">Step {step + 1} of {STEPS.length}</Badge>
      </header>

      <nav aria-label="Onboarding progress" className="onboarding-progress">
        <ol>
          {STEPS.map((item, index) => (
            <li aria-current={index === step ? 'step' : undefined} data-complete={index < step || undefined} key={item.label}>
              <span aria-hidden="true" className="onboarding-progress__number">{index + 1}</span>
              <span>{item.label}</span>
            </li>
          ))}
        </ol>
      </nav>

      <section className="onboarding-content">
        <div className="onboarding-intro">
          <span className="eyebrow">WELCOME TO FOVEA</span>
          <h1 ref={headingRef} tabIndex={-1}>{STEPS[step]!.title}</h1>
        </div>

        {step === 0 && <WorkflowStep />}
        {step === 1 && (
          <PrivacyStep
            busy={activity === 'provider'}
            profile={chatGptProfile}
            profiles={state.profiles}
            onCreateApiProfile={createApiProfile}
            onSignIn={() => void signIn()}
          />
        )}
        {step === 2 && (
          <CaptureStep
            busy={activity === 'capture'}
            preview={preview}
            shortcutBusy={activity === 'shortcut'}
            shortcut={regionShortcut}
            onSaveShortcut={(accelerator) => void saveShortcut(accelerator)}
            onTestCapture={() => void testCapture()}
          />
        )}
      </section>

      <footer className="onboarding-footer">
        <Button disabled={activity === 'status'} variant="ghost" onClick={() => void skipOrClose()}>
          {firstRun ? 'Skip for now' : 'Close tour'}
        </Button>
        <div className="onboarding-footer__navigation">
          {step > 0 && <Button disabled={activity !== null} variant="secondary" onClick={() => moveTo(step - 1)}>Back</Button>}
          {step < STEPS.length - 1
            ? <Button disabled={activity !== null} onClick={() => moveTo(step + 1)}>Next</Button>
            : <Button disabled={activity !== null} onClick={() => void finish()}>{state.onboardingStatus === 'completed' ? 'Done' : 'Finish'}</Button>}
        </div>
      </footer>
    </main>
  )
}

function WorkflowStep(): React.JSX.Element {
  const items = [
    { icon: <CaptureIcon />, title: 'Capture', copy: 'Drag over anything on screen.' },
    { icon: <AskIcon />, title: 'Ask', copy: 'Get one focused visual answer.' },
    { icon: <FollowUpIcon />, title: 'Follow up', copy: 'Keep the same conversation going.' }
  ]
  return (
    <>
      <p className="onboarding-lede">Capture a region. Get an answer. Keep asking.</p>
      <div className="onboarding-workflow">
        {items.map((item, index) => (
          <Card as="article" className="onboarding-workflow__item" key={item.title}>
            <div aria-hidden="true" className="onboarding-illustration">{item.icon}</div>
            <div><span className="onboarding-workflow__index">0{index + 1}</span><h2>{item.title}</h2><p>{item.copy}</p></div>
          </Card>
        ))}
      </div>
    </>
  )
}

function PrivacyStep({
  busy,
  profile,
  profiles,
  onCreateApiProfile,
  onSignIn
}: {
  busy: boolean
  profile: SettingsViewState['profiles'][number] | undefined
  profiles: SettingsViewState['profiles']
  onCreateApiProfile(provider: Exclude<ProviderKind, 'chatgpt'>, name: string, apiKey: string): Promise<boolean>
  onSignIn(): void
}): React.JSX.Element {
  const [method, setMethod] = useState<ProviderKind>('chatgpt')
  const [apiKey, setApiKey] = useState('')
  const connected = profile?.authenticationState === 'signed-in'
  const starting = profile?.status?.state === 'starting'
  const methods: Array<{ id: ProviderKind; label: string; detail: string; name: string }> = [
    { id: 'chatgpt', label: 'ChatGPT', detail: 'Browser sign-in', name: 'ChatGPT' },
    { id: 'openai', label: 'OpenAI API', detail: 'Platform API key', name: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic', detail: 'Claude API key', name: 'Anthropic' },
    { id: 'openrouter', label: 'OpenRouter', detail: 'One key, many models', name: 'OpenRouter' }
  ]
  const selected = methods.find((item) => item.id === method)!
  const configured = profiles.find((item) => item.provider === method)
  const saveApiKey = async (): Promise<void> => {
    if (method === 'chatgpt' || !apiKey.trim()) return
    if (await onCreateApiProfile(method, selected.name, apiKey)) setApiKey('')
  }
  return (
    <>
      <p className="onboarding-lede">Pick one now, or continue and connect later.</p>
      <div aria-label="Connection methods" className="onboarding-provider-grid" role="group">
        {methods.map((item) => {
          const isConfigured = profiles.some((candidate) => candidate.provider === item.id)
          return <button aria-pressed={method === item.id} className="onboarding-provider-option" data-selected={method === item.id || undefined} key={item.id} onClick={() => { setMethod(item.id); setApiKey('') }}><span>{item.label}</span><small>{isConfigured ? 'Configured' : item.detail}</small></button>
        })}
      </div>
      <Card as="section" className="onboarding-connect-card">
        <div className="onboarding-connect-card__heading">
          <div aria-hidden="true" className="onboarding-illustration">{method === 'chatgpt' ? <AccountIcon /> : <KeyIcon />}</div>
          <div><h2>{selected.label}</h2><p>{method === 'chatgpt' ? 'Sign in securely in your browser.' : 'Fovea uses the provider’s standard API endpoint.'}</p></div>
        </div>
        {method === 'chatgpt'
          ? connected
            ? <StatusBanner title="ChatGPT connected" tone="success">{profile.accountLabel ?? 'Ready to use.'}</StatusBanner>
            : starting
              ? <StatusBanner icon={<Spinner />} title="Starting local service">Sign-in will be available shortly.</StatusBanner>
              : <Button loading={busy} loadingLabel="Signing in with ChatGPT" onClick={onSignIn}>Sign in with ChatGPT</Button>
          : configured
            ? <StatusBanner title={`${selected.label} configured`} tone="success">Manage or replace this profile in Settings.</StatusBanner>
            : <div className="onboarding-api-form">
                <TextInput autoComplete="off" label={`${selected.label} API key`} placeholder="Paste key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                <Button disabled={!apiKey.trim()} loading={busy} loadingLabel={`Connecting ${selected.label}`} onClick={() => void saveApiKey()}>Connect</Button>
              </div>}
      </Card>
      <div className="onboarding-privacy-strip">
        <PrivacyPoint title="Temporary">Captures are cleaned up.</PrivacyPoint>
        <PrivacyPoint title="Private test">The next step sends nothing.</PrivacyPoint>
        <PrivacyPoint title="No tracking">No Fovea account or analytics.</PrivacyPoint>
      </div>
    </>
  )
}

function PrivacyPoint({ children, title }: { children: ReactNode; title: string }): React.JSX.Element {
  return <div className="onboarding-privacy-point"><span aria-hidden="true">✓</span><div><h2>{title}</h2><p>{children}</p></div></div>
}

function CaptureStep({
  busy,
  onSaveShortcut,
  onTestCapture,
  preview,
  shortcutBusy,
  shortcut
}: {
  busy: boolean
  onSaveShortcut(accelerator: string | null): void
  onTestCapture(): void
  preview: string | null
  shortcutBusy: boolean
  shortcut: SettingsViewState['shortcuts'][number] | undefined
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return (
    <>
      <p className="onboarding-lede">Set a shortcut, then test it on any region.</p>
      <Card as="section" className="onboarding-shortcut-card">
        <div><span className="eyebrow">REGION CAPTURE</span><h2>Click to record</h2><p className="muted">Press modifiers plus a key. Escape cancels.</p></div>
        <button
          aria-label="Region capture shortcut"
          className={recording ? 'onboarding-shortcut-input recording' : 'onboarding-shortcut-input'}
          disabled={shortcutBusy}
          onBlur={() => setRecording(false)}
          onClick={() => setRecording(true)}
          onKeyDown={(event) => {
            if (!recording) return
            event.preventDefault()
            if (event.key === 'Escape') {
              setRecording(false)
              return
            }
            if (event.key === 'Backspace' || event.key === 'Delete') {
              setRecording(false)
              onSaveShortcut(null)
              return
            }
            const accelerator = acceleratorFromKeyInput(event)
            if (!accelerator) return
            setRecording(false)
            onSaveShortcut(accelerator)
          }}
        >
          {recording ? 'Press shortcut…' : shortcut?.accelerator ?? 'Set shortcut'}
        </button>
        {shortcut?.error && <p className="error-text" role="alert">{shortcut.error}</p>}
      </Card>
      <Card as="section" className="onboarding-test-card">
        <div className="onboarding-test-card__copy">
          <div><h2>Test capture</h2><p>Pick a region. Nothing is sent to AI.</p></div>
          <Button loading={busy} loadingLabel="Waiting for a region selection" variant={preview ? 'secondary' : 'primary'} onClick={onTestCapture}>
            {preview ? 'Retake test capture' : 'Test region capture'}
          </Button>
        </div>
        {preview
          ? <figure className="onboarding-preview"><img alt="Your private test capture" src={preview} /><figcaption>Private preview · temporary file deleted</figcaption></figure>
          : <div aria-hidden="true" className="onboarding-capture-placeholder"><CaptureIcon /><span>Your preview will appear here</span></div>}
      </Card>
    </>
  )
}

function CaptureIcon(): React.JSX.Element {
  return <svg fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><rect height="9" rx="2" width="10" x="7" y="7.5" /></svg>
}

function AskIcon(): React.JSX.Element {
  return <svg fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M4 5h16v12h-9l-5 4v-4H4z" /><path d="M8 9h8M8 13h6" /></svg>
}

function FollowUpIcon(): React.JSX.Element {
  return <svg fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M8 7a7 7 0 1 1-1.2 10.8" /><path d="M8 3v4H4" /><path d="M10 10h6M10 14h4" /></svg>
}

function AccountIcon(): React.JSX.Element {
  return <svg fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M5 21c.6-4.3 2.9-6.5 7-6.5s6.4 2.2 7 6.5" /></svg>
}

function KeyIcon(): React.JSX.Element {
  return <svg fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2M14 9l2 2" /></svg>
}
