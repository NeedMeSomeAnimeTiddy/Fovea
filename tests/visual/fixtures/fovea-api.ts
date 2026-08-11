import type { FoveaApi } from '@shared/contracts/ipc'
import type { VisualFixture } from './states'

export function createVisualFoveaApi(fixture: VisualFixture): FoveaApi {
  const api: FoveaApi = {
    profiles: {
      list: async () => clone(fixture.settings.profiles),
      createApiKey: async () => clone(fixture.settings.profiles[0]!),
      createChatGpt: async () => clone(fixture.settings.profiles[0]!),
      rename: async () => undefined,
      authenticate: async () => undefined,
      test: async () => clone(fixture.question.models),
      signOut: async () => undefined,
      delete: async () => undefined,
      setDefault: async () => undefined,
      setDefaults: async () => undefined,
      models: async () => clone(fixture.question.models)
    },
    chatGptRuntime: {
      install: async () => clone(fixture.settings.chatGptRuntime),
      remove: async () => clone(fixture.settings.chatGptRuntime)
    },
    settings: {
      get: async () => clone(fixture.settings),
      openOcrLanguages: async () => undefined,
      setAppearance: async () => undefined,
      setLaunchAtLogin: async () => undefined,
      setShellIntegration: async () => undefined,
      setShortcut: async () => undefined,
      resetShortcuts: async () => undefined,
      saveCustomPrompt: async () => undefined,
      deleteCustomPrompt: async () => undefined,
      saveRecipe: async () => undefined,
      duplicateRecipe: async () => undefined,
      deleteRecipe: async () => undefined,
      reorderRecipes: async () => undefined,
      exportRecipes: async () => true,
      importRecipes: async () => 0,
      setOnboardingStatus: async () => undefined,
      setPrivateMode: async () => undefined,
      setHistoryRetention: async () => undefined,
      setScreenshotRetention: async () => undefined,
      testOnboardingCapture: async () => ({ status: 'captured', thumbnailDataUrl: fixture.fullImageDataUrl }),
      deleteTemporaryFiles: async () => 0,
      onChanged: () => () => undefined,
      onAppearanceChanged: () => () => undefined
    },
    capture: {
      start: async () => undefined,
      getContext: async () => {
        if (fixture.captureError) throw clone(fixture.captureError)
        return clone(fixture.captureContext)
      },
      analyze: async (onProgress) => {
        const analysis = clone(fixture.captureAnalysis)
        onProgress?.(analysis)
        return analysis
      },
      cancelAnalysis: async () => undefined,
      getOcrLanguages: async () => [
        { code: 'en-GB', label: 'English (United Kingdom)', source: 'configured' },
        { code: 'ja-JP', label: 'Japanese', source: 'configured' }
      ],
      setOcrLanguage: async () => undefined,
      select: async () => undefined,
      cancel: async () => undefined
    },
    question: {
      get: async () => clone(fixture.question),
      getFullImage: async () => fixture.fullImageDataUrl,
      runOcr: async () => { throw new Error('OCR is not exercised by visual fixtures.') },
      getOcrResult: async () => null,
      setOcrSelection: async () => clone(fixture.question),
      setSelection: async () => clone(fixture.question),
      setPinned: async () => undefined,
      setPreviewOpen: async () => undefined,
      removeAttachment: async () => clone(fixture.question),
      applyAttachmentEdits: async () => clone(fixture.question),
      importClipboardImage: async () => ({ added: 0, failures: [], cancelled: false }),
      pickImages: async () => ({ added: 0, failures: [], cancelled: true }),
      importDroppedFiles: async () => ({ added: 0, failures: [], cancelled: false }),
      exportPreview: async () => exportPreview,
      exportConversation: async () => false,
      send: async () => undefined,
      retry: async () => undefined,
      resolveWebSearch: async () => clone(fixture.question),
      stop: async () => undefined,
      close: async () => undefined,
      addSnip: async () => undefined,
      newChat: async () => undefined,
      onEvent: () => () => undefined,
      onChanged: () => () => undefined
    },
    history: {
      list: async () => [
        {
          id: 'fixture-history',
          title: 'Synthetic interface review',
          createdAt: '2026-01-02T09:30:00.000Z',
          updatedAt: '2026-01-02T09:31:00.000Z',
          messageCount: 2,
          hasScreenshots: false
        }
      ],
      open: async () => undefined,
      delete: async () => undefined,
      clear: async () => 0,
      exportPreview: async () => exportPreview,
      exportConversation: async () => false
    },
    updates: {
      setAutomaticChecks: async (enabled) => ({ ...clone(fixture.settings.updates), automaticChecks: enabled }),
      check: async () => clone(fixture.settings.updates),
      download: async () => ({
        ...clone(fixture.settings.updates),
        phase: 'downloading',
        downloadProgress: { percent: 42, transferred: 42_000_000, total: 100_000_000, bytesPerSecond: 5_000_000 }
      }),
      install: async () => ({ ...clone(fixture.settings.updates), phase: 'installing' })
    },
    application: { openSettings: async () => undefined },
    clipboard: { writeText: async () => undefined },
    windowChrome: {
      getState: async () => clone(fixture.windowChrome),
      ready: () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      beginResize: async () => undefined,
      updateResize: () => undefined,
      endResize: () => undefined,
      onStateChanged: () => () => undefined
    },
    openExternal: async () => undefined,
    openOcrEntity: async () => undefined
  }
  return api
}

const exportPreview = {
  title: 'Synthetic interface review',
  messageCount: 2,
  screenshotCount: 0,
  ocrCharacterCount: 0,
  providerTransitionCount: 0,
  excerpt: 'Privacy-safe visual fixture content.'
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
