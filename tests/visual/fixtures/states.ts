import type {
  CaptureContext,
  QuestionViewState,
  SettingsViewState,
  WindowChromeState
} from '@shared/contracts/ipc'
import type {
  CaptureAnalysis,
  ConversationExchange,
  ProviderModelCapability,
  ProviderProfileSummary,
  ResolvedAppearance
} from '@shared/types/app'
import type { AppError } from '@shared/types/app-error'
import { syntheticCaptureDataUrl } from './synthetic-captures'

export type VisualRenderer = 'settings' | 'overlay' | 'question' | 'preview'
export type VisualMaterial = 'transparent' | 'solid'

export interface VisualFixtureOptions {
  renderer: VisualRenderer
  scenario: string
  theme: ResolvedAppearance
  material: VisualMaterial
  width: number
  height: number
}

export interface VisualFixture extends VisualFixtureOptions {
  settings: SettingsViewState
  captureContext: CaptureContext
  captureAnalysis: CaptureAnalysis
  captureError: AppError | null
  question: QuestionViewState
  windowChrome: WindowChromeState
  fullImageDataUrl: string
}

const profile: ProviderProfileSummary = {
  id: 'fixture-profile',
  name: 'Visual fixture provider',
  provider: 'openai',
  authentication: 'api-key',
  authenticationState: 'signed-in',
  accountLabel: 'demo@fixture.invalid',
  defaultModelId: 'fixture-vision',
  defaultReasoningEffort: 'medium',
  health: 'available',
  healthMessage: 'Ready for synthetic visual tests',
  lastHealthCheckAt: '2026-01-02T09:30:00.000Z',
  isDefault: true,
  status: {
    state: 'ready',
    version: 'visual-fixture',
    account: { type: 'apiKey' }
  }
}

const model: ProviderModelCapability = {
  id: 'fixture-vision',
  displayName: 'Fixture Vision',
  provider: 'openai',
  inputModalities: ['text', 'image'],
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  isDefault: true
}

const selection = {
  profileId: profile.id,
  provider: profile.provider,
  modelId: model.id,
  reasoningEffort: 'medium'
} as const

export function createVisualFixture(options: VisualFixtureOptions): VisualFixture {
  const settings = settingsState(options.theme, options.scenario === 'onboarding')
  const captureError = options.scenario === 'error'
    ? visualError(
        'capture-failed',
        'Screen image unavailable',
        'Fovea could not prepare the synthetic frozen screen. Try the fixture again.',
        'retry'
      )
    : null
  return {
    ...options,
    settings,
    captureContext: {
      width: options.width,
      height: options.height,
      minSelectionSize: 24,
      displayId: 'fixture-display',
      imageDataUrl: syntheticCaptureDataUrl('desktop', options.width, options.height),
      canEditBeforeSending: true
    },
    captureAnalysis: {
      complete: true,
      stage: 'visual',
      truncated: false,
      features: [
        { id: 'feature-control', kind: 'control', label: 'Synthetic primary action', bounds: { x: 0.12, y: 0.29, width: 0.26, height: 0.08 }, rank: 0.95, role: 'button', enabled: true, visibility: 1 },
        { id: 'feature-text', kind: 'text', label: 'Synthetic report heading', bounds: { x: 0.08, y: 0.08, width: 0.34, height: 0.08 }, rank: 0.9, visibility: 1 },
        { id: 'feature-value', kind: 'value', label: '42 completed items', bounds: { x: 0.6, y: 0.67, width: 0.2, height: 0.08 }, rank: 0.8, visibility: 1 }
      ]
    },
    captureError,
    question: questionState(options.scenario),
    windowChrome: {
      focused: true,
      maximized: false,
      material: options.material,
      canMinimize: options.renderer === 'question',
      canMaximize: false,
      canResize: false
    },
    fullImageDataUrl: syntheticCaptureDataUrl('wide')
  }
}

function settingsState(theme: ResolvedAppearance, onboarding: boolean): SettingsViewState {
  return {
    appearance: { preference: theme, resolved: theme },
    profiles: [profile],
    chatGptRuntime: {
      state: 'installed',
      version: '0.0.0-visual-fixture',
      architecture: 'x64',
      downloadBytes: 341_142_832,
      downloadedBytes: 341_142_832,
      installedBytes: 341_142_832,
      removable: true
    },
    shortcuts: [
      { action: 'region', accelerator: 'Ctrl+Alt+Shift+Space', registered: true },
      { action: 'display', accelerator: 'Ctrl+Alt+Shift+D', registered: true },
      { action: 'window', accelerator: 'Ctrl+Alt+Shift+W', registered: true },
      { action: 'repeat-last', accelerator: 'Ctrl+Alt+Shift+R', registered: true },
      { action: 'settings', accelerator: 'Ctrl+Alt+Shift+S', registered: true }
    ],
    recipeShortcuts: [],
    customPrompts: [
      { id: 'fixture-summary', label: 'Summarise clearly', prompt: 'Summarise this synthetic fixture in three points.' }
    ],
    recipes: [
      {
        id: 'fixture-recipe',
        name: 'Review synthetic interface',
        enabled: true,
        captureMode: 'region',
        prompt: 'Review this synthetic interface for clarity.',
        preferWebSearch: false,
        extractText: false,
        provider: { mode: 'current-default' },
        shortcut: null,
        autoSend: false,
        autoSendConsentVersion: 0
      }
    ],
    launchAtLogin: false,
    shellIntegration: { enabled: true, supported: true, registered: true },
    onboardingStatus: onboarding ? 'pending' : 'completed',
    tempLocation: 'C:\\Synthetic\\Fovea\\Temporary',
    appVersion: '0.1.0-visual-fixture',
    updates: {
      phase: 'available',
      eligible: true,
      unavailableReason: null,
      automaticChecks: true,
      currentVersion: '0.1.0-visual-fixture',
      lastCheckedAt: '2026-01-02T09:30:00.000Z',
      availableUpdate: {
        version: '0.2.0-visual-fixture',
        releaseName: 'Fovea synthetic visual release',
        releaseDate: '2026-01-02T08:00:00.000Z',
        releaseNotes: [
          'Improves the synthetic capture review layout.',
          'Keeps all visual-test content local and deterministic.'
        ]
      },
      downloadProgress: null,
      failure: null
    },
    history: { privateMode: false, retentionDays: 30, retainScreenshots: false },
    ocrLanguageCode: 'en-GB'
  }
}

function questionState(scenario: string): QuestionViewState {
  const base = {
    sessionId: 'visual-session',
    attachments: [attachment('wide', syntheticCaptureDataUrl('wide'))],
    capturePending: false,
    profiles: [profile],
    models: [model],
    selection,
    segments: [{ id: 'fixture-segment', selection, startedAt: '2026-01-02T09:30:00.000Z', disclosure: null }],
    disclosure: null,
    pinned: false,
    draft: null,
    launchError: null
  } satisfies Omit<QuestionViewState, 'phase' | 'exchanges' | 'busy'>

  if (scenario === 'initial') {
    return {
      ...base,
      phase: 'connecting',
      busy: true,
      exchanges: [exchange({ phase: 'connecting', answer: '' })]
    }
  }
  if (scenario === 'streaming') {
    return {
      ...base,
      phase: 'streaming',
      busy: true,
      exchanges: [exchange({
        phase: 'streaming',
        answer: 'The synthetic confirmation dialog is asking whether to keep the reviewed changes. The highlighted action will',
        automatic: true
      })]
    }
  }
  if (scenario === 'error') {
    return {
      ...base,
      phase: 'failed',
      busy: false,
      exchanges: [exchange({
        phase: 'failed',
        answer: '',
        error: visualError(
          'provider-unavailable',
          'The answer could not be completed',
          'The synthetic provider stopped before returning an answer. Your capture and question are still available, so you can safely try again.',
          'retry'
        )
      })]
    }
  }
  if (scenario === 'long-answer') {
    return {
      ...base,
      phase: 'completed',
      busy: false,
      exchanges: [exchange({
        phase: 'completed',
        answer: longAnswer
      })]
    }
  }
  if (scenario === 'attachments') {
    return {
      ...base,
      attachments: [
        attachment('wide', syntheticCaptureDataUrl('wide')),
        attachment('tall', syntheticCaptureDataUrl('tall')),
        attachment('tiny', syntheticCaptureDataUrl('tiny'), true)
      ],
      phase: 'completed',
      busy: false,
      exchanges: [completedExchange]
    }
  }
  if (scenario === 'empty') {
    return { ...base, phase: 'idle', busy: false, exchanges: [] }
  }
  return { ...base, phase: 'completed', busy: false, exchanges: [completedExchange] }
}

const completedExchange = exchange({
  phase: 'completed',
  answer: 'The selected synthetic screen shows a report card with a clear primary action and a short progress summary.',
  metadata: {
    category: 'interface-review',
    summary: 'This is a privacy-safe synthetic report with a clear primary action.',
    suggestedQuestions: ['Explain the primary action', 'Check the visual hierarchy', 'Summarise the report', 'What should I do next?']
  }
})

function exchange(overrides: Partial<ConversationExchange>): ConversationExchange {
  return {
    id: 'fixture-exchange',
    question: 'Analyse this synthetic capture',
    answer: '',
    phase: 'completed',
    segmentId: 'fixture-segment',
    createdAt: '2026-01-02T09:30:00.000Z',
    completedAt: '2026-01-02T09:30:01.000Z',
    source: 'ai',
    automatic: true,
    ...overrides
  }
}

function attachment(id: string, thumbnailDataUrl: string, edited = false): QuestionViewState['attachments'][number] {
  return { id: `fixture-${id}`, thumbnailDataUrl, status: 'sent', edited, ocr: { status: 'idle' } }
}

function visualError(
  code: AppError['code'],
  title: string,
  message: string,
  recovery: AppError['recovery']
): AppError {
  return { code, title, message, recovery, technicalDetails: 'Synthetic fixture failure; no external request was made.' }
}

const longAnswer = `
## Recommended interpretation

The selected panel is a synthetic status report. Its hierarchy is intentionally simple: a heading, a primary action, supporting progress, and quiet secondary information.

### What is working

- The primary action is visually distinct.
- Supporting text stays concise and readable.
- Status colour is paired with visible wording.
- The layout remains understandable without animation.

### Example output

\`\`\`text
Fixture status: ready
Items reviewed: 42
External requests: 0
\`\`\`

Continue reviewing the remaining rows before accepting any intentional baseline update. This paragraph is deliberately long enough to exercise scrolling, wrapping, code presentation, and the lower action dock without including private or live information.
`
