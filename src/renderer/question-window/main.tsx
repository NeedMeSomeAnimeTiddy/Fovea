import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { QuestionViewState } from '@shared/contracts/ipc'
import type { ConversationExchange, ConversationSelection, ProviderModelCapability, QuestionAttachment, ResponsePhase } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import { Button, IconButton, Spinner, StatusBanner, TextArea, Tooltip } from '../design-system'
import { initialiseAppearance } from '../appearance'
import { AppStatusNotice, appErrorFromUnknown, spectralStateForPhase } from '../status/status-presentation'
import { WindowFrame } from '../window-chrome/WindowFrame'
import { QuestionTitlebarActions } from './QuestionTitlebarActions'
import '../design-system/index.css'
import 'highlight.js/styles/github-dark.css'
import './question.css'

const FALLBACK_SUGGESTIONS = [
  'What do the most important visible details mean?',
  'Is anything in this image unusual or incorrect?',
  'What is the most useful next step based on this image?',
  'What could a web search verify about what is shown?'
]
const TYPING_INTERVAL_MS = 12

type TerminalPhase = Extract<ResponsePhase, 'completed' | 'stopped' | 'failed'>

export function QuestionApp(): React.JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(location.search).get('session') ?? '', [])
  const [state, setState] = useState<QuestionViewState | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<AppError | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [preferWebSearch, setPreferWebSearch] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [captureMenuOpen, setCaptureMenuOpen] = useState(false)
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const askRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  const responseContentRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const stateReady = useRef(false)
  const pendingSummary = useRef('')
  const pendingAnswer = useRef('')
  const pendingTerminal = useRef<TerminalPhase | null>(null)
  const typingTimer = useRef<number | null>(null)

  const updateLatest = (update: (exchange: ConversationExchange) => ConversationExchange): void => {
    setState((current) => current
      ? { ...current, exchanges: current.exchanges.map((item, index) => index === current.exchanges.length - 1 ? update(item) : item) }
      : current)
  }
  const setPhase = (phase: ResponsePhase): void => {
    updateLatest((item) => ({ ...item, phase }))
    setState((current) => current
      ? { ...current, phase, busy: ['connecting', 'thinking', 'streaming'].includes(phase) }
      : current)
  }
  const refresh = async (): Promise<void> => {
    const next = await window.fovea.question.get(sessionId)
    stateReady.current = true
    setState(next)
  }
  const clearTypingQueue = (): void => {
    pendingSummary.current = ''
    pendingAnswer.current = ''
    pendingTerminal.current = null
    if (typingTimer.current !== null) clearTimeout(typingTimer.current)
    typingTimer.current = null
  }
  const finishTyping = (): void => {
    const phase = pendingTerminal.current
    if (!phase) return
    pendingTerminal.current = null
    setPhase(phase)
    void refresh()
  }
  const drainTypingQueue = (): void => {
    typingTimer.current = null
    if (!stateReady.current) {
      typingTimer.current = window.setTimeout(drainTypingQueue, TYPING_INTERVAL_MS)
      return
    }
    let wroteCharacter = false
    const summary = takeNextTypingCharacter(pendingSummary.current)
    if (summary.character) {
      wroteCharacter = true
      pendingSummary.current = summary.remainder
      updateLatest((item) => item.metadata
        ? { ...item, metadata: { ...item.metadata, summary: item.metadata.summary + summary.character }, phase: 'streaming' }
        : item)
    } else {
      const answer = takeNextTypingCharacter(pendingAnswer.current)
      if (answer.character) {
        wroteCharacter = true
        pendingAnswer.current = answer.remainder
        updateLatest((item) => ({ ...item, answer: item.answer + answer.character, phase: 'streaming' }))
      }
    }
    if (wroteCharacter) setState((current) => current ? { ...current, phase: 'streaming', busy: true } : current)
    if (pendingSummary.current || pendingAnswer.current) {
      typingTimer.current = window.setTimeout(drainTypingQueue, TYPING_INTERVAL_MS)
    } else {
      finishTyping()
    }
  }
  const scheduleTyping = (): void => {
    if (typingTimer.current !== null) return
    typingTimer.current = window.setTimeout(drainTypingQueue, TYPING_INTERVAL_MS)
  }
  const queueTerminal = (phase: TerminalPhase): void => {
    pendingTerminal.current = phase
    if (pendingSummary.current || pendingAnswer.current) scheduleTyping()
    else finishTyping()
  }
  const consume = (event: ProviderEvent): void => {
    if (event.type === 'web-search-requested') {
      clearTypingQueue()
      void refresh()
      return
    }
    if (event.type === 'response-metadata') {
      pendingSummary.current += event.metadata.summary
      updateLatest((item) => ({ ...item, metadata: { ...event.metadata, summary: '' }, phase: 'streaming' }))
      scheduleTyping()
      return
    }
    if (event.type === 'delta') {
      pendingAnswer.current += event.text
      scheduleTyping()
      return
    }
    if (event.type === 'started') {
      pendingTerminal.current = null
      setPhase('thinking')
    }
    if (event.type === 'completed' || event.type === 'cancelled') {
      queueTerminal(event.type === 'completed' ? 'completed' : 'stopped')
    }
    if (event.type === 'error') {
      queueTerminal('failed')
    }
  }

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
  useEffect(() => () => clearTypingQueue(), [])

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
    clearTypingQueue()
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
    clearTypingQueue()
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
    await navigator.clipboard.writeText(value)
    setCopyStatus(label)
    setTimeout(() => setCopyStatus(''), 1500)
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
    clearTypingQueue()
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
      <WindowFrame title="Fovea" edgeState={error ? 'error' : 'thinking'} showCompactControls showResizeRegions={false} showTitlebar={false}>
        <main className="response-loading">
          <Spinner label="Looking at your capture" size="large" />
          <strong>Looking at your capture…</strong>
          <span>Finding the most useful answer.</span>
          {error && <AppStatusNotice error={error} onRecovery={recover} />}
        </main>
      </WindowFrame>
    )
  }

  const hasPendingWebSearch = state.exchanges.some((exchange) => exchange.webSearch?.status === 'requested')
  const missingModels = state.profiles.length > 0 && !state.selection
  const suggestions = latestExchange?.metadata?.suggestedQuestions.length
    ? latestExchange.metadata.suggestedQuestions
    : FALLBACK_SUGGESTIONS
  const askDisabled = state.busy || hasPendingWebSearch || !state.selection || !latestExchange
  const selectedModel = state.models.find((model) => model.id === state.selection?.modelId)
  const modelLabel = selectedModel && state.selection
    ? `${selectedModel.displayName} · ${thinkingEffortLabel(state.selection.reasoningEffort)} thinking`
    : 'Choose model and thinking effort'

  return (
    <WindowFrame
      title="Fovea"
      edgeState={error || missingModels ? 'error' : spectralStateForPhase(state.phase)}
      showCompactControls
      showResizeRegions={false}
      showTitlebar={false}
      titlebarActions={<QuestionTitlebarActions pinned={state.pinned} onTogglePinned={() => void togglePinned()} />}
    >
      <main className="response-shell">
        {!state.selection
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
              <section className="response-card" aria-label="AI response">
                <header className="response-card__header">
                  <FriendlyStatus phase={state.phase} />
                  <div className="ask-wrap" ref={askRef}>
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
                        customOpen={customOpen}
                        preferWebSearch={preferWebSearch}
                        suggestions={suggestions}
                        text={text}
                        onCustom={() => setCustomOpen(true)}
                        onSend={send}
                        onTextChange={setText}
                        onToggleWebSearch={() => setPreferWebSearch((preferred) => !preferred)}
                      />
                    )}
                  </div>
                </header>

                {state.disclosure && <StatusBanner tone="info">{state.disclosure}</StatusBanner>}

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
                          onRecover={(exchange, recovery) => recovery === 'retry' ? retryExchange(exchange) : recover(recovery)}
                          onResolveWebSearch={resolveWebSearch}
                        />
                      )
                    : <AnswerSkeleton />}
                  {error && <AppStatusNotice error={error} onRecovery={error.recovery === 'retry' ? undefined : recover} />}
                </div>

                <AttachmentStrip
                  attachments={state.attachments}
                  disabled={state.busy}
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
                  {state.busy
                    ? (
                        <Tooltip content="Stop answering">
                          <IconButton
                            icon={<Icon name="stop" />}
                            label="Stop answering"
                            size="compact"
                            variant="danger"
                            onClick={() => void window.fovea.question.stop(sessionId)}
                          />
                        </Tooltip>
                      )
                    : (
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
        <div className="fui-sr-only" aria-live="polite">{copyStatus}</div>
      </main>
    </WindowFrame>
  )
}

export function AttachmentStrip({
  attachments,
  disabled,
  onPreview,
  onRemove
}: {
  attachments: QuestionAttachment[]
  disabled: boolean
  onPreview(attachmentId: string): void
  onRemove(attachmentId: string): void
}): React.JSX.Element {
  return (
    <section className="attachment-strip" aria-label="Conversation screenshots">
      <span className="attachment-strip__label">{attachments.length} {attachments.length === 1 ? 'screenshot' : 'screenshots'}</span>
      <div className="attachment-strip__items">
        {attachments.map((attachment, index) => (
          <div className="attachment-thumbnail" data-status={attachment.status} key={attachment.id}>
            <button
              aria-label={`Preview screenshot ${index + 1}${attachment.status === 'draft' ? ', not sent yet' : ''}`}
              className="attachment-thumbnail__preview"
              onClick={() => onPreview(attachment.id)}
              type="button"
            >
              <img alt="" draggable={false} src={attachment.thumbnailDataUrl} />
              <span aria-hidden="true">{index + 1}</span>
            </button>
            {attachment.status === 'draft' && (
              <button
                aria-label={`Remove screenshot ${index + 1}`}
                className="attachment-thumbnail__remove"
                disabled={disabled}
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

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

export function AskMenu({
  busy,
  customOpen,
  preferWebSearch,
  suggestions,
  text,
  onCustom,
  onSend,
  onTextChange,
  onToggleWebSearch
}: {
  busy: boolean
  customOpen: boolean
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
      <div className="ask-menu__heading">You could ask…</div>
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

export function ConversationTimeline({
  exchanges,
  onCopy,
  onRecover,
  onResolveWebSearch
}: {
  exchanges: ConversationExchange[]
  onCopy(value: string, label?: string): Promise<void>
  onRecover(exchange: ConversationExchange, recovery: AppRecoveryKind): void
  onResolveWebSearch(requestId: string, approved: boolean): void
}): React.JSX.Element {
  return (
    <div className="conversation-thread" role="log" aria-label="Conversation" aria-live="polite">
      {exchanges.map((exchange) => (
        <section className="conversation-turn" key={exchange.id}>
          {!exchange.automatic && !exchange.retryOf && (
            <div className="conversation-message conversation-message--user">
              <span className="fui-sr-only">You asked: </span>
              {exchange.question}
            </div>
          )}
          {exchange.retryOf && <small className="conversation-retry-label">Regenerated reply</small>}
          <div className={`conversation-message conversation-message--assistant${exchange.automatic ? ' conversation-message--opening' : ''}`}>
            <span className="fui-sr-only">AI response: </span>
            <ResponseBody
              exchange={exchange}
              onCopy={onCopy}
              onRecover={(recovery) => onRecover(exchange, recovery)}
              onResolveWebSearch={onResolveWebSearch}
            />
          </div>
        </section>
      ))}
    </div>
  )
}

function FriendlyStatus({ phase }: { phase: ResponsePhase }): React.JSX.Element {
  const busy = ['connecting', 'thinking', 'streaming'].includes(phase)
  return (
    <div className="friendly-status" role="status">
      {busy && <Spinner />}
      <span>{friendlyPhaseLabel(phase)}</span>
    </div>
  )
}

function ResponseBody({
  exchange,
  onCopy,
  onRecover,
  onResolveWebSearch
}: {
  exchange: ConversationExchange
  onCopy(value: string, label?: string): Promise<void>
  onRecover(recovery: AppRecoveryKind): void
  onResolveWebSearch(requestId: string, approved: boolean): void
}): React.JSX.Element {
  const summary = exchange.metadata?.summary
  const detail = exchange.answer.trim()
  const waiting = ['connecting', 'thinking'].includes(exchange.phase) && !summary && !detail
  return (
    <article className="answer-card">
      {waiting && <TypingIndicator />}
      {summary && <div className="answer-summary"><Markdown text={summary} onCopy={onCopy} /></div>}
      {!summary && detail && <div className="answer answer--primary"><Markdown text={detail} onCopy={onCopy} /></div>}
      {summary && detail && (
        <details className="answer-details">
          <summary>Show details</summary>
          <div className="answer"><Markdown text={detail} onCopy={onCopy} /></div>
        </details>
      )}
      {exchange.webSearch?.status === 'requested' && (
        <div className="web-approval" role="group" aria-label="Web search approval">
          <strong>Should I check the web?</strong>
          <p>The image does not contain enough reliable information for a confident answer.</p>
          <code>{exchange.webSearch.query}</code>
          <div>
            <Button size="compact" variant="secondary" onClick={() => onResolveWebSearch(exchange.webSearch!.id, false)}>Use the image only</Button>
            <Button size="compact" onClick={() => onResolveWebSearch(exchange.webSearch!.id, true)}>Check the web</Button>
          </div>
        </div>
      )}
      {exchange.webSearch?.status === 'searching' && <StatusBanner tone="info">Checking reliable sources…</StatusBanner>}
      {exchange.webSearch?.status === 'declined' && <StatusBanner tone="info">Continuing without a web search.</StatusBanner>}
      {exchange.phase === 'stopped' && !summary && !detail && <StatusBanner tone="warning">Answer stopped.</StatusBanner>}
      {exchange.error && <AppStatusNotice error={exchange.error} onRecovery={onRecover} />}
    </article>
  )
}

function TypingIndicator(): React.JSX.Element {
  return (
    <div className="typing-indicator" aria-label="AI is writing" role="status">
      <span />
      <span />
      <span />
    </div>
  )
}

function AnswerSkeleton(): React.JSX.Element {
  return (
    <div className="answer-skeleton" aria-label="Looking at your capture" role="status">
      <span />
      <span />
      <span />
    </div>
  )
}

function Markdown({ text, onCopy }: { text: string; onCopy(value: string, label?: string): Promise<void> }): React.JSX.Element {
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href) void window.fovea.openExternal(href)
            }}
          >
            {children}
          </a>
        ),
        pre: ({ children }) => {
          const value = nodeText(children)
          return (
            <div className="code-block">
              <button onClick={() => void onCopy(value, 'Code copied')}>Copy</button>
              <pre>{children}</pre>
            </div>
          )
        }
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function exchangeText(exchange: ConversationExchange): string {
  return [exchange.metadata?.summary, exchange.answer].filter(Boolean).join('\n\n').trim()
}

export function takeNextTypingCharacter(value: string): { character: string; remainder: string } {
  if (!value) return { character: '', remainder: '' }
  const codePoint = value.codePointAt(0)
  const length = codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1
  return { character: value.slice(0, length), remainder: value.slice(length) }
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function friendlyPhaseLabel(phase: ResponsePhase): string {
  return ({
    idle: 'Ready',
    connecting: 'Looking at your capture…',
    thinking: 'Working out the answer…',
    streaming: 'Writing the answer…',
    'awaiting-approval': 'Your choice is needed',
    stopped: 'Answer stopped',
    completed: 'Answer',
    failed: 'Couldn’t finish'
  })[phase]
}

function thinkingEffortLabel(effort: string | null | undefined): string {
  if (!effort) return 'Default'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, ReactNode> = {
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    capture: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m7 15 3-3 2.5 2.5L15 12l3 3M8 9h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.5 7 3.5 3.5" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21M12 3C9.8 5.5 8.7 8.5 8.7 12S9.8 18.5 12 21" /></>,
    'new-chat': <><path d="M5 5h14v11H9l-4 3V5Z" /><path d="M12 8v5m-2.5-2.5h5" /></>,
    recapture: <path d="M20 7v5h-5M4 17v-5h5M6.2 8a7 7 0 0 1 11.2-2l2.6 6M17.8 16a7 7 0 0 1-11.2 2L4 12" />,
    regenerate: <><path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></>,
    send: <path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 4-4" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />
  }
  return <svg className="mono-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.arrow}</svg>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<QuestionApp />)
