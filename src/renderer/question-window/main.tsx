import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import type { QuestionViewState } from '@shared/contracts/ipc'
import type { ConversationExchange, ConversationSelection, CustomPrompt, OcrEntity, ProviderModelCapability, QuestionAttachment, ResponsePhase } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import {
  Button,
  IconButton,
  Spinner,
  StatusBanner,
  TextArea,
  Toast,
  ToastViewport,
  Tooltip
} from '../design-system'
import { initialiseAppearance } from '../appearance'
import { AppStatusNotice, appErrorFromUnknown, spectralStateForPhase } from '../status/status-presentation'
import { WindowFrame } from '../window-chrome/WindowFrame'
import { QuestionTitlebarActions } from './QuestionTitlebarActions'
import {
  AnswerSkeleton,
  ConversationTimeline,
  FriendlyStatus,
  exchangeText,
  ocrEntityExternalAction
} from './QuestionResponse'
import { ScreenshotEditor } from './ScreenshotEditor'
import { ResponseStreamBuffer } from './response-stream-buffer'
import '../design-system/index.css'
import 'highlight.js/styles/github-dark.css'
import './question.css'

/**
 * Shown before anything has been asked, where the model has never seen the file and so cannot
 * offer grounded follow-ups. These have to work for whatever someone right-clicked, so they open
 * the subject rather than assuming there is a task in it.
 */
const OPENING_SUGGESTIONS = [
  'What is this?',
  'Describe what this shows.',
  'Summarise any text in it.',
  'What is worth noticing here?'
]
/** Used after an answer that carried no suggestions of its own. */
const FOLLOW_UP_SUGGESTIONS = [
  'What do the most important visible details mean?',
  'Is anything in this image unusual or incorrect?',
  'What is the most useful next step based on this image?',
  'What could a web search verify about what is shown?'
]

/**
 * A reply names its own follow-ups; these lists only fill the gap when it did not, or when
 * nothing has been asked yet.
 */
export function suggestionsFor(latestExchange?: ConversationExchange): string[] {
  if (latestExchange?.metadata?.suggestedQuestions.length) return latestExchange.metadata.suggestedQuestions
  return latestExchange ? FOLLOW_UP_SUGGESTIONS : OPENING_SUGGESTIONS
}
export function QuestionApp(): React.JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(location.search).get('session') ?? '', [])
  const [state, setState] = useState<QuestionViewState | null>(null)
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<AppError | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [preferWebSearch, setPreferWebSearch] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [captureMenuOpen, setCaptureMenuOpen] = useState(false)
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ attachmentId: string; imageDataUrl: string } | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const askRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  const responseContentRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const stateReady = useRef(false)
  const updateLatest = useCallback((update: (exchange: ConversationExchange) => ConversationExchange): void => {
    setState((current) => current
      ? { ...current, exchanges: current.exchanges.map((item, index) => index === current.exchanges.length - 1 ? update(item) : item) }
      : current)
  }, [])
  const setPhase = useCallback((phase: ResponsePhase): void => {
    setState((current) => current
      ? {
          ...current,
          phase,
          busy: ['connecting', 'thinking', 'streaming'].includes(phase),
          exchanges: current.exchanges.map((item, index) => (
            index === current.exchanges.length - 1 ? { ...item, phase } : item
          ))
        }
      : current)
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.fovea.question.get(sessionId)
    stateReady.current = true
    setState(next)
  }, [sessionId])
  const responseStream = useMemo(() => new ResponseStreamBuffer({
    isReady: () => stateReady.current,
    prefersReducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    onBatch: ({ summary, answer }) => {
      setState((current) => current
        ? {
            ...current,
            phase: 'streaming',
            busy: true,
            exchanges: current.exchanges.map((item, index) => {
              if (index !== current.exchanges.length - 1) return item
              return {
                ...item,
                phase: 'streaming',
                answer: item.answer + answer,
                metadata: item.metadata && summary
                  ? { ...item.metadata, summary: item.metadata.summary + summary }
                  : item.metadata
              }
            })
          }
        : current)
    },
    onMetadata: (metadata) => updateLatest((item) => ({ ...item, metadata, phase: 'streaming' })),
    onPhase: setPhase,
    onRefresh: () => { void refresh() }
  }), [refresh, setPhase, updateLatest])
  const consume = useCallback((event: ProviderEvent): void => responseStream.consume(event), [responseStream])

  useEffect(() => {
    void initialiseAppearance()
    void refresh().catch((reason) => setError(appErrorFromUnknown(reason)))
    const unsubscribeEvents = window.fovea.question.onEvent((eventSessionId, event) => {
      if (eventSessionId === sessionId) consume(event)
    })
    const unsubscribeChanges = window.fovea.question.onChanged((next) => {
      if (next.sessionId === sessionId) setState(next)
    })
    return () => {
      unsubscribeEvents()
      unsubscribeChanges()
    }
    // The subscription intentionally remains stable for the lifetime of this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  useEffect(() => {
    void window.fovea.settings.get().then((settings) => setCustomPrompts(settings.customPrompts)).catch(() => undefined)
    return window.fovea.settings.onChanged((settings) => setCustomPrompts(settings.customPrompts))
  }, [])
  useEffect(() => () => responseStream.dispose(), [responseStream])

  const latestExchange = state?.exchanges.at(-1)
  const latestVisibleLength = (latestExchange?.metadata?.summary.length ?? 0) + (latestExchange?.answer.length ?? 0)

  useEffect(() => {
    if (!stickToBottom.current) return
    const frame = requestAnimationFrame(() => {
      const content = responseContentRef.current
      if (content) content.scrollTop = content.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [latestExchange?.id, latestVisibleLength])

  useEffect(() => {
    if (!askOpen && !modelOpen && !captureMenuOpen) return
    const closeOnPointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (askOpen && !askRef.current?.contains(target)) {
        setAskOpen(false)
        setCustomOpen(false)
      }
      if (modelOpen && !modelRef.current?.contains(target)) {
        setModelOpen(false)
        setExpandedModelId(null)
      }
      if (captureMenuOpen && !captureRef.current?.contains(target)) setCaptureMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setAskOpen(false)
      setCustomOpen(false)
      setModelOpen(false)
      setExpandedModelId(null)
      setCaptureMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnPointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [askOpen, captureMenuOpen, modelOpen])

  const send = async (override?: string): Promise<void> => {
    const question = (override ?? text).trim()
    if (!state || !question || state.busy || !state.selection) return
    const searchPreferred = preferWebSearch
    setText('')
    setError(null)
    setAskOpen(false)
    setCustomOpen(false)
    setModelOpen(false)
    setExpandedModelId(null)
    setPreferWebSearch(false)
    responseStream.reset()
    stickToBottom.current = true
    const optimistic: ConversationExchange = {
      id: `pending-${Date.now()}`,
      question,
      answer: '',
      phase: 'connecting',
      segmentId: state.segments.at(-1)?.id ?? '',
      attachmentIds: state.attachments.filter((attachment) => attachment.status === 'draft').map((attachment) => attachment.id),
      ...(searchPreferred ? { webSearch: { id: `preferred-${Date.now()}`, query: question, status: 'searching' as const } } : {})
    }
    setState({ ...state, attachments: state.attachments.map((attachment) => attachment.status === 'draft' ? { ...attachment, status: 'sent' } : attachment), busy: true, phase: 'connecting', exchanges: [...state.exchanges, optimistic] })
    void window.fovea.question.send(sessionId, question, searchPreferred).catch((reason) => {
      setError(appErrorFromUnknown(reason))
      setPhase('failed')
    })
  }
  const resolveWebSearch = (requestId: string, approved: boolean): void => {
    setError(null)
    responseStream.reset()
    stickToBottom.current = true
    setState((current) => current
      ? {
          ...current,
          busy: approved,
          phase: approved ? 'connecting' : 'completed',
          exchanges: current.exchanges.map((exchange) => exchange.webSearch?.id === requestId
            ? {
                ...exchange,
                phase: approved ? 'connecting' : 'completed',
                webSearch: { ...exchange.webSearch, status: approved ? 'searching' : 'declined' },
                answer: approved ? '' : exchange.answer
              }
            : exchange)
        }
      : current)
    void window.fovea.question.resolveWebSearch(sessionId, requestId, approved).then(setState).catch((reason) => {
      setError(appErrorFromUnknown(reason))
      void refresh()
    })
  }
  const copy = async (value: string, label = 'Answer copied'): Promise<void> => {
    try {
      await window.fovea.clipboard.writeText(value)
      setCopyStatus(label)
      setTimeout(() => setCopyStatus(''), 1500)
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    }
  }
  const openPreview = async (attachmentId: string): Promise<void> => {
    try {
      await window.fovea.question.setPreviewOpen(sessionId, attachmentId)
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    }
  }
  const addSnip = async (): Promise<void> => {
    setError(null)
    setCaptureMenuOpen(false)
    try {
      await window.fovea.question.addSnip(sessionId)
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
      void refresh()
    }
  }
  const newChat = async (): Promise<void> => {
    setError(null)
    setCaptureMenuOpen(false)
    try {
      await window.fovea.question.newChat(sessionId)
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    }
  }
  const removeAttachment = async (attachmentId: string): Promise<void> => {
    setError(null)
    try {
      setState(await window.fovea.question.removeAttachment(sessionId, attachmentId))
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
      void refresh()
    }
  }
  const editAttachment = async (attachmentId: string): Promise<void> => {
    setError(null)
    try {
      const imageDataUrl = await window.fovea.question.getFullImage(sessionId, attachmentId)
      setEditor({ attachmentId, imageDataUrl })
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
    }
  }
  const openOcrEntity = (entity: OcrEntity): void => {
    const action = ocrEntityExternalAction(entity)
    if (!action) return
    if (!window.confirm(`${action.confirmation} This will leave Fovea.`)) return
    void window.fovea.openOcrEntity(action.kind, entity.value).catch((reason) => {
      setError(appErrorFromUnknown(reason))
    })
  }
  const changeModel = async (modelId: string, reasoningEffort: string | null): Promise<void> => {
    if (!state?.selection || state.busy || state.exchanges.some((exchange) => exchange.webSearch?.status === 'requested')) return
    const selection: ConversationSelection = { ...state.selection, modelId, reasoningEffort }
    setError(null)
    setModelOpen(false)
    setExpandedModelId(null)
    try {
      setState(await window.fovea.question.setSelection(sessionId, selection))
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
      void refresh()
    }
  }
  const retryExchange = (exchange: ConversationExchange): void => {
    if (!state || state.busy || state.exchanges.at(-1)?.id !== exchange.id) return
    setError(null)
    responseStream.reset()
    stickToBottom.current = true
    const optimistic: ConversationExchange = {
      id: `retry-${Date.now()}`,
      question: exchange.question,
      answer: '',
      phase: 'connecting',
      segmentId: state.segments.at(-1)?.id ?? '',
      automatic: exchange.automatic,
      retryOf: exchange.id
    }
    setState({ ...state, busy: true, phase: 'connecting', exchanges: [...state.exchanges, optimistic] })
    void window.fovea.question.retry(sessionId, exchange.id).catch((reason) => {
      setError(appErrorFromUnknown(reason))
      void refresh()
    })
  }
  const togglePinned = async (): Promise<void> => {
    if (!state) return
    const pinned = !state.pinned
    setState({ ...state, pinned })
    try {
      await window.fovea.question.setPinned(sessionId, pinned)
    } catch (reason) {
      setError(appErrorFromUnknown(reason))
      void refresh()
    }
  }
  const recover = (recovery: AppRecoveryKind): void => {
    if (recovery === 'open-settings' || recovery === 'authenticate' || recovery === 'choose-provider') {
      void window.fovea.application.openSettings()
    } else if (recovery === 'recapture') {
      void addSnip()
    } else if (recovery === 'retry') {
      setError(null)
      void refresh().catch((reason) => setError(appErrorFromUnknown(reason)))
    }
  }

  if (!state) {
    return (
      <WindowFrame compactControlsIntegrated title="Fovea" edgeState={error ? 'error' : 'thinking'} showCompactControls showResizeRegions={false} showTitlebar={false}>
        <ToastViewport className="question-toasts" placement="top">
          {error && <AppStatusNotice error={error} onDismiss={() => setError(null)} onRecovery={recover} />}
        </ToastViewport>
        <main className="response-loading">
          <Spinner label="Looking at your capture" size="large" />
          <strong>Looking at your capture…</strong>
          <span>Finding the most useful answer.</span>
        </main>
      </WindowFrame>
    )
  }

  const hasPendingWebSearch = state.exchanges.some((exchange) => exchange.webSearch?.status === 'requested')
  const showingLocalOcr = latestExchange?.source === 'ocr'
  const missingModels = state.profiles.length > 0 && !state.selection && !showingLocalOcr
  const suggestions = suggestionsFor(latestExchange)
  // A conversation opened from Explorer's "Ask a question..." starts with nothing asked yet, so
  // asking must not depend on an exchange already existing.
  const askDisabled = state.busy || hasPendingWebSearch || !state.selection
  const selectedModel = state.models.find((model) => model.id === state.selection?.modelId)
  const modelLabel = selectedModel && state.selection
    ? `${selectedModel.displayName} · ${thinkingEffortLabel(state.selection.reasoningEffort)} thinking`
    : 'Choose model and thinking effort'

  return (
    <WindowFrame
      compactControlsIntegrated
      title="Fovea"
      edgeState={error || missingModels ? 'error' : spectralStateForPhase(state.phase)}
      showCompactControls
      showResizeRegions={false}
      showTitlebar={false}
      titlebarActions={<QuestionTitlebarActions pinned={state.pinned} onTogglePinned={() => void togglePinned()} />}
    >
      <main className="response-shell">
        <ToastViewport className="question-toasts" placement="top">
          {state.disclosure && (
            <Toast duration={8000} resetKey={state.disclosure} title="Provider changed">
              {state.disclosure}
            </Toast>
          )}
          {latestExchange?.webSearch?.status === 'searching' && (
            <Toast
              duration={7000}
              icon={<Spinner />}
              resetKey={`searching:${latestExchange.webSearch.id}`}
              title="Searching the web"
            >
              Checking reliable sources…
            </Toast>
          )}
          {latestExchange?.webSearch?.status === 'declined' && (
            <Toast
              duration={4500}
              resetKey={`declined:${latestExchange.webSearch.id}`}
              title="Web search skipped"
            >
              Continuing with the capture only.
            </Toast>
          )}
          {latestExchange?.phase === 'stopped' && !latestExchange.metadata?.summary && !latestExchange.answer.trim() && (
            <Toast
              duration={4500}
              resetKey={`stopped:${latestExchange.id}`}
              title="Answer stopped"
              tone="warning"
            >
              You can ask again whenever you’re ready.
            </Toast>
          )}
          {latestExchange?.error && (
            <AppStatusNotice
              error={latestExchange.error}
              resetKey={`${latestExchange.id}:${latestExchange.error.code}:${latestExchange.error.message}`}
              onRecovery={(recovery) => recovery === 'retry' ? retryExchange(latestExchange) : recover(recovery)}
            />
          )}
          {error && !latestExchange?.error && (
            <AppStatusNotice
              error={error}
              onDismiss={() => setError(null)}
              onRecovery={error.recovery === 'retry' ? undefined : recover}
            />
          )}
        </ToastViewport>

        {!state.selection && !showingLocalOcr
          ? (
              <section className="setup-card">
                <StatusBanner title={state.profiles.length ? 'No compatible AI model' : 'Connect an AI provider'} tone="warning">
                  {state.profiles.length
                    ? 'Choose an image-capable model in Settings.'
                    : 'Connect a provider once, then every capture can be answered automatically.'}
                </StatusBanner>
                <Button onClick={() => void window.fovea.application.openSettings()}>Open Settings</Button>
              </section>
            )
          : (
              <section className="response-card" aria-label={showingLocalOcr ? 'Extracted text' : 'AI response'}>
                <header className="response-card__header">
                  <FriendlyStatus phase={state.phase} source={latestExchange?.source} />
                  {state.selection && <div className="ask-wrap" ref={askRef}>
                    <Button
                      aria-controls="ask-menu"
                      aria-expanded={askOpen}
                      aria-haspopup="menu"
                      className="ask-trigger"
                      disabled={askDisabled}
                      size="compact"
                      variant="ghost"
                      onClick={() => {
                        setModelOpen(false)
                        setExpandedModelId(null)
                        setAskOpen((open) => !open)
                        setCustomOpen(false)
                      }}
                    >
                      Ask <Icon name="chevron" />
                    </Button>
                    {askOpen && (
                      <AskMenu
                        busy={state.busy}
                        customPrompts={customPrompts}
                        customOpen={customOpen}
                        opening={!latestExchange}
                        preferWebSearch={preferWebSearch}
                        suggestions={suggestions}
                        text={text}
                        onCustom={() => setCustomOpen(true)}
                        onSend={send}
                        onTextChange={setText}
                        onToggleWebSearch={() => setPreferWebSearch((preferred) => !preferred)}
                      />
                    )}
                  </div>}
                </header>

                <div
                  className="response-content"
                  ref={responseContentRef}
                  onScroll={(event) => {
                    const content = event.currentTarget
                    stickToBottom.current = content.scrollHeight - content.scrollTop - content.clientHeight < 48
                  }}
                >
                  {state.exchanges.length
                    ? (
                        <ConversationTimeline
                          exchanges={state.exchanges}
                          onCopy={copy}
                          onOpenOcrEntity={openOcrEntity}
                          onManageOcrLanguages={() => void window.fovea.settings.openOcrLanguages()}
                          onResolveWebSearch={resolveWebSearch}
                        />
                      )
                    : state.busy
                      ? <AnswerSkeleton />
                      : <EmptyConversation disabled={askDisabled} onAsk={() => { setModelOpen(false); setCustomOpen(false); setAskOpen(true) }} />}
                </div>

                <AttachmentStrip
                  attachments={state.attachments}
                  disabled={state.busy}
                  onEdit={(attachmentId) => void editAttachment(attachmentId)}
                  onPreview={(attachmentId) => void openPreview(attachmentId)}
                  onRemove={(attachmentId) => void removeAttachment(attachmentId)}
                />

                <footer className="response-actions">
                  <div className="capture-wrap" ref={captureRef}>
                    <Tooltip content={state.capturePending ? 'Select a screen region' : 'Capture options'}>
                      <IconButton
                        aria-expanded={captureMenuOpen}
                        aria-haspopup="menu"
                        disabled={state.capturePending}
                        icon={<Icon name="recapture" />}
                        label={state.capturePending ? 'Screen region selection is open' : 'Capture options'}
                        size="compact"
                        onClick={() => {
                          setAskOpen(false)
                          setCustomOpen(false)
                          setModelOpen(false)
                          setExpandedModelId(null)
                          setCaptureMenuOpen((open) => !open)
                        }}
                      />
                    </Tooltip>
                    {captureMenuOpen && (
                      <CaptureMenu
                        addDisabled={state.busy || hasPendingWebSearch}
                        onAdd={() => void addSnip()}
                        onNewChat={() => void newChat()}
                      />
                    )}
                  </div>
                  {state.selection && (
                    <div className="model-wrap" ref={modelRef}>
                      <Tooltip content={modelLabel}>
                        <IconButton
                          aria-expanded={modelOpen}
                          aria-haspopup="menu"
                          aria-pressed={modelOpen}
                          disabled={state.busy || hasPendingWebSearch || state.models.length === 0}
                          icon={<Icon name="chip" />}
                          label="Choose model and thinking effort"
                          size="compact"
                          onClick={() => {
                            setAskOpen(false)
                            setCustomOpen(false)
                            setModelOpen((open) => {
                              const next = !open
                              setExpandedModelId(next ? state.selection?.modelId ?? state.models[0]?.id ?? null : null)
                              return next
                            })
                          }}
                        />
                      </Tooltip>
                      {modelOpen && (
                        <ModelMenu
                          expandedModelId={expandedModelId}
                          models={state.models}
                          selection={state.selection}
                          onExpand={setExpandedModelId}
                          onSelect={(modelId, effort) => void changeModel(modelId, effort)}
                        />
                      )}
                    </div>
                  )}
                  <span className="response-actions__spacer" />
                  {state.busy && (
                    <Tooltip content={latestExchange?.source === 'ocr' ? 'Stop extracting text' : 'Stop answering'}>
                      <IconButton
                        icon={<Icon name="stop" />}
                        label={latestExchange?.source === 'ocr' ? 'Stop extracting text' : 'Stop answering'}
                        size="compact"
                        variant="danger"
                        onClick={() => void window.fovea.question.stop(sessionId)}
                      />
                    </Tooltip>
                  )}
                  {!state.busy && latestExchange?.source !== 'ocr' && (
                    <Tooltip content="Generate a fresh answer">
                      <IconButton
                        disabled={!latestExchange || hasPendingWebSearch}
                        icon={<Icon name="regenerate" />}
                        label="Generate a fresh answer"
                        size="compact"
                        onClick={() => latestExchange && retryExchange(latestExchange)}
                      />
                    </Tooltip>
                  )}
                  <Tooltip content={copyStatus || 'Copy answer'}>
                    <IconButton
                      disabled={!latestExchange || !exchangeText(latestExchange)}
                      icon={<Icon name={copyStatus ? 'check' : 'copy'} />}
                      label={copyStatus || 'Copy answer'}
                      size="compact"
                      onClick={() => latestExchange && void copy(exchangeText(latestExchange))}
                    />
                  </Tooltip>
                </footer>
              </section>
            )}
        {editor && (
          <ScreenshotEditor
            imageDataUrl={editor.imageDataUrl}
            saving={editorSaving}
            onCancel={() => setEditor(null)}
            onSave={(operations) => {
              setEditorSaving(true)
              setError(null)
              void (async () => {
                try {
                  const next = await window.fovea.question.applyAttachmentEdits(sessionId, editor.attachmentId, operations)
                  setState(next)
                  setEditor(null)
                } catch (reason) {
                  setError(appErrorFromUnknown(reason))
                } finally {
                  setEditorSaving(false)
                }
              })()
            }}
          />
        )}
        <div className="fui-sr-only" aria-live="polite">{copyStatus}</div>
      </main>
    </WindowFrame>
  )
}

export function AttachmentStrip({
  attachments,
  disabled,
  onEdit,
  onPreview,
  onRemove
}: {
  attachments: QuestionAttachment[]
  disabled: boolean
  onEdit(attachmentId: string): void
  onPreview(attachmentId: string): void
  onRemove(attachmentId: string): void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ attachmentId: string; index: number; left: number; top: number } | null>(null)
  const selected = menu ? attachments.find((attachment) => attachment.id === menu.attachmentId) : null
  useEffect(() => {
    if (!menu) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [menu])
  const openMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, attachmentId: string, index: number): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const menuWidth = 172
    const menuHeight = 132
    const left = Math.max(12, Math.min(innerWidth - menuWidth - 12, bounds.left))
    const above = bounds.top - menuHeight - 8
    const top = above >= 12 ? above : Math.min(innerHeight - menuHeight - 12, bounds.bottom + 8)
    setMenu({ attachmentId, index, left, top })
  }, [])
  // Attachments can now be imported pictures or PDF pages, so the wording stays neutral.
  return (
    <section className="attachment-strip" aria-label="Conversation images">
      <span className="attachment-strip__label">{attachments.length} {attachments.length === 1 ? 'image' : 'images'}</span>
      <div className="attachment-strip__items">
        {attachments.map((attachment, index) => (
          <AttachmentThumbnail
            attachment={attachment}
            expanded={menu?.attachmentId === attachment.id}
            index={index}
            key={attachment.id}
            onOpen={openMenu}
          />
        ))}
      </div>
      {menu && selected && createPortal(
        <div className="attachment-menu-layer" onPointerDown={() => setMenu(null)}>
          <div
            aria-label={`Screenshot ${menu.index + 1} actions`}
            className="attachment-menu"
            role="menu"
            style={{ left: menu.left, top: menu.top }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button role="menuitem" type="button" onClick={() => { setMenu(null); onPreview(selected.id) }}><Icon name="view" />View Full</button>
            <button disabled={disabled || selected.status !== 'draft'} role="menuitem" type="button" onClick={() => { setMenu(null); onEdit(selected.id) }}><Icon name="edit" />Edit</button>
            <button className="danger" disabled={disabled || selected.status !== 'draft'} role="menuitem" type="button" onClick={() => { setMenu(null); onRemove(selected.id) }}><Icon name="remove" />Remove</button>
          </div>
        </div>,
        document.body
      )}
    </section>
  )
}

interface AttachmentThumbnailProps {
  attachment: QuestionAttachment
  expanded: boolean
  index: number
  onOpen(event: React.MouseEvent<HTMLButtonElement>, attachmentId: string, index: number): void
}

export const AttachmentThumbnail = memo(function AttachmentThumbnail({
  attachment,
  expanded,
  index,
  onOpen
}: AttachmentThumbnailProps): React.JSX.Element {
  return (
    <div className="attachment-thumbnail" data-status={attachment.status}>
      <button
        aria-expanded={expanded}
        aria-haspopup="menu"
        aria-label={`Screenshot ${index + 1} options${attachment.status === 'draft' ? ', not sent yet' : ''}`}
        className="attachment-thumbnail__preview"
        onClick={(event) => onOpen(event, attachment.id, index)}
        type="button"
      >
        <img alt="" draggable={false} src={attachment.thumbnailDataUrl} />
        <span aria-hidden="true">{index + 1}</span>
      </button>
      {attachment.edited && <span className="attachment-thumbnail__edited">Edited</span>}
    </div>
  )
}, (previous, next) => (
  previous.expanded === next.expanded &&
  previous.index === next.index &&
  previous.attachment.id === next.attachment.id &&
  previous.attachment.status === next.attachment.status &&
  previous.attachment.edited === next.attachment.edited &&
  previous.attachment.thumbnailDataUrl === next.attachment.thumbnailDataUrl
))

export function CaptureMenu({
  addDisabled,
  onAdd,
  onNewChat
}: {
  addDisabled: boolean
  onAdd(): void
  onNewChat(): void
}): React.JSX.Element {
  return (
    <div className="capture-menu" role="menu" aria-label="Capture options">
      <button disabled={addDisabled} onClick={onAdd} role="menuitem" type="button">
        <Icon name="capture" />
        <span><strong>Add a screenshot</strong><small>Attach it to this chat</small></span>
      </button>
      <button onClick={onNewChat} role="menuitem" type="button">
        <Icon name="new-chat" />
        <span><strong>New chat</strong><small>Start with a new capture</small></span>
      </button>
    </div>
  )
}

/**
 * Shown when a conversation has been opened but nothing asked yet, which only happens for the
 * Explorer "Ask a question..." action. Every other entry point starts with an exchange already
 * running, where a loading skeleton is the right thing to show instead.
 */
export function EmptyConversation({
  disabled,
  onAsk
}: {
  disabled: boolean
  onAsk(): void
}): React.JSX.Element {
  return (
    <div className="empty-conversation">
      <p>This file is attached and ready.</p>
      <Button disabled={disabled} size="compact" onClick={onAsk}>Ask a question</Button>
    </div>
  )
}

export function AskMenu({
  busy,
  customPrompts = [],
  customOpen,
  opening = false,
  preferWebSearch,
  suggestions,
  text,
  onCustom,
  onSend,
  onTextChange,
  onToggleWebSearch
}: {
  busy: boolean
  customPrompts?: CustomPrompt[]
  customOpen: boolean
  /** True before anything has been asked, where the list opens the subject rather than following on. */
  opening?: boolean
  preferWebSearch: boolean
  suggestions: string[]
  text: string
  onCustom(): void
  onSend(question?: string): Promise<void>
  onTextChange(value: string): void
  onToggleWebSearch(): void
}): React.JSX.Element {
  return (
    <div className="ask-menu" id="ask-menu" role="menu" aria-label="Questions about this capture">
      {customPrompts.length > 0 && <>
        <div className="ask-menu__heading">{opening ? 'Your saved prompts' : 'Saved prompts'}</div>
        <div className="ask-menu__suggestions ask-menu__saved">
          {customPrompts.map((item) => (
            <button
              disabled={busy}
              key={item.id}
              role="menuitem"
              onClick={() => void onSend(item.prompt)}
            >
              <span className="ask-menu__saved-copy"><strong>{item.label}</strong><small>{item.prompt}</small></span>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
      </>}
      <div className="ask-menu__heading">{opening ? 'Start with…' : 'You could ask…'}</div>
      <div className="ask-menu__suggestions">
        {suggestions.map((suggestion) => (
          <button
            disabled={busy}
            key={suggestion}
            role="menuitem"
            onClick={() => void onSend(suggestion)}
          >
            <span>{suggestion}</span>
            <Icon name="arrow" />
          </button>
        ))}
      </div>
      <div className="ask-menu__search">
        <button
          aria-checked={preferWebSearch}
          className="search-priority"
          disabled={busy}
          role="menuitemcheckbox"
          onClick={onToggleWebSearch}
        >
          <Icon name="globe" />
          <span className="search-priority__copy">
            <strong>Search web</strong>
            <small>Prioritise current sources for this question</small>
          </span>
          <span className="search-priority__state" aria-hidden="true">
            <small>{preferWebSearch ? 'On' : 'Off'}</small>
            <span className="search-priority__track">
              <span className="search-priority__thumb" />
            </span>
          </span>
        </button>
      </div>
      <div className="ask-menu__custom">
        {!customOpen
          ? (
              <button className="custom-trigger" role="menuitem" onClick={onCustom}>
                <Icon name="edit" />
                <span>Custom question</span>
              </button>
            )
          : (
              <div className="custom-composer">
                <TextArea
                  autoFocus
                  className="custom-composer__input"
                  disabled={busy}
                  label={<span className="fui-sr-only">Custom question</span>}
                  placeholder="Ask in your own words…"
                  resize="none"
                  rows={2}
                  value={text}
                  onChange={(event) => onTextChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void onSend()
                    }
                  }}
                />
                <IconButton
                  className="custom-composer__send"
                  disabled={!text.trim() || busy}
                  icon={<Icon name="send" />}
                  label="Send custom question"
                  size="compact"
                  onClick={() => void onSend()}
                />
              </div>
            )}
      </div>
    </div>
  )
}

export function ModelMenu({
  expandedModelId,
  models,
  selection,
  onExpand,
  onSelect
}: {
  expandedModelId: string | null
  models: ProviderModelCapability[]
  selection: ConversationSelection
  onExpand(modelId: string | null): void
  onSelect(modelId: string, reasoningEffort: string | null): void
}): React.JSX.Element {
  return (
    <div className="model-menu" role="menu" aria-label="Model and thinking effort">
      <div className="model-menu__heading">Model &amp; thinking</div>
      {models.map((model) => {
        const expanded = model.id === expandedModelId
        const selected = model.id === selection.modelId
        const options: Array<string | null> = [null, ...model.supportedReasoningEfforts]
        return (
          <div className="model-menu__model" key={model.id}>
            <button
              aria-expanded={expanded}
              aria-haspopup="menu"
              className="model-menu__model-trigger"
              role="menuitem"
              onClick={() => onExpand(expanded ? null : model.id)}
            >
              <Icon name="chip" />
              <span>{model.displayName}</span>
              {selected && <small>{thinkingEffortLabel(selection.reasoningEffort)}</small>}
              <Icon name="chevron" />
            </button>
            {expanded && (
              <div className="model-effort-menu" role="menu" aria-label={`${model.displayName} thinking effort`}>
                {options.map((effort) => {
                  const current = selected && selection.reasoningEffort === effort
                  return (
                    <button
                      aria-checked={current}
                      key={effort ?? 'default'}
                      role="menuitemradio"
                      onClick={() => onSelect(model.id, effort)}
                    >
                      <span>{thinkingEffortLabel(effort)}</span>
                      {current && <Icon name="check" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function thinkingEffortLabel(effort: string | null | undefined): string {
  if (!effort) return 'Default'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export { ConversationTimeline, ocrEntityExternalAction } from './QuestionResponse'

function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, ReactNode> = {
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    capture: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m7 15 3-3 2.5 2.5L15 12l3 3M8 9h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.5 7 3.5 3.5" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21M12 3C9.8 5.5 8.7 8.5 8.7 12S9.8 18.5 12 21" /></>,
    'new-chat': <><path d="M5 5h14v11H9l-4 3V5Z" /><path d="M12 8v5m-2.5-2.5h5" /></>,
    recapture: <path d="M20 7v5h-5M4 17v-5h5M6.2 8a7 7 0 0 1 11.2-2l2.6 6M17.8 16a7 7 0 0 1-11.2 2L4 12" />,
    regenerate: <><path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></>,
    remove: <><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13" /><path d="M10 11v5m4-5v5" /></>,
    send: <path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 4-4" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
    text: <><path d="M5 6h14M9 6v12m6-12v12M7 18h4m2 0h4" /></>,
    view: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>
  }
  return <svg className="mono-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.arrow}</svg>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<QuestionApp />)
