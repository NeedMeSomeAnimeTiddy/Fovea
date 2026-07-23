import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { QuestionViewState } from '@shared/contracts/ipc'
import type { ConversationExchange, ConversationSelection, ResponsePhase } from '@shared/types/app'
import type { ProviderEvent } from '@shared/types/provider'
import type { AppError, AppRecoveryKind } from '@shared/types/app-error'
import { Badge, Button, Select, Spinner, StatusBanner, TextArea, Tooltip } from '../design-system'
import { initialiseAppearance } from '../appearance'
import { AppStatusNotice, ResponseStatus, appErrorFromUnknown, spectralStateForPhase } from '../status/status-presentation'
import { WindowFrame } from '../window-chrome/WindowFrame'
import '../design-system/index.css'
import 'highlight.js/styles/github-dark.css'
import './question.css'

const SUGGESTED_QUESTIONS = [
  { icon: 'spark', label: 'Explain what I’m looking at' },
  { icon: 'identify', label: 'Identify the main subject' },
  { icon: 'alert', label: 'What appears to be wrong?' },
  { icon: 'fix', label: 'How can I fix this?' },
  { icon: 'steps', label: 'What should I do next?' },
  { icon: 'summary', label: 'Summarise the important details' },
  { icon: 'text', label: 'Extract all visible text' },
  { icon: 'compare', label: 'Compare the visible options' }
]

function QuestionApp(): React.JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(location.search).get('session') ?? '', [])
  const [state, setState] = useState<QuestionViewState | null>(null); const [text, setText] = useState(''); const [error, setError] = useState<AppError | null>(null); const [enlarged, setEnlarged] = useState(false); const [copied, setCopied] = useState(''); const [nearBottom, setNearBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null); const pendingDelta = useRef(''); const animation = useRef<number | null>(null)

  // The subscription intentionally remains stable for the lifetime of this session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void initialiseAppearance(); void window.fovea.question.get(sessionId).then(setState).catch((reason) => setError(appErrorFromUnknown(reason))); return window.fovea.question.onEvent((eventSessionId, event) => { if (eventSessionId === sessionId) consume(event) }) }, [sessionId])
  useEffect(() => { if (!nearBottom) return; const node = scrollRef.current; node?.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, [state?.exchanges, nearBottom])

  const updateLatest = (update: (exchange: ConversationExchange) => ConversationExchange): void => setState((current) => current ? { ...current, exchanges: current.exchanges.map((item, index) => index === current.exchanges.length - 1 ? update(item) : item) } : current)
  const consume = (event: ProviderEvent): void => {
    if (event.type === 'web-search-requested') { void refresh(); return }
    if (event.type === 'delta') { pendingDelta.current += event.text; if (animation.current === null) animation.current = requestAnimationFrame(() => { const delta = pendingDelta.current; pendingDelta.current = ''; animation.current = null; updateLatest((item) => ({ ...item, answer: item.answer + delta, phase: 'streaming' })); setState((current) => current ? { ...current, phase: 'streaming' } : current) }); return }
    if (event.type === 'started') setPhase('thinking')
    if (event.type === 'completed' || event.type === 'cancelled') { setPhase(event.type === 'completed' ? 'completed' : 'stopped'); void refresh() }
    if (event.type === 'error') { setPhase('failed'); void refresh() }
  }
  const setPhase = (phase: ResponsePhase): void => { updateLatest((item) => ({ ...item, phase })); setState((current) => current ? { ...current, phase, busy: ['connecting','thinking','streaming'].includes(phase) } : current) }
  const refresh = async (): Promise<void> => setState(await window.fovea.question.get(sessionId))
  const send = async (override?: string): Promise<void> => { const question = (override ?? text).trim(); if (!state || !question || state.busy || !state.selection) return; setText(''); setError(null); const optimistic: ConversationExchange = { id: `pending-${Date.now()}`, question, answer: '', phase: 'connecting', segmentId: state.segments.at(-1)?.id ?? '' }; setState({ ...state, busy: true, phase: 'connecting', exchanges: [...state.exchanges, optimistic] }); void window.fovea.question.send(sessionId, question).catch((reason) => { setError(appErrorFromUnknown(reason)); setPhase('failed') }) }
  const changeProfile = async (profileId: string): Promise<void> => { if (!state) return; const profile = state.profiles.find((item) => item.id === profileId); if (!profile) return; try { const models = await window.fovea.profiles.models(profileId); const model = models.find((item) => item.id === profile.defaultModelId) ?? models.find((item) => item.isDefault) ?? models[0]; if (!model) throw new Error('No confirmed image-capable model is available.'); await changeSelection({ profileId, provider: profile.provider, modelId: model.id, reasoningEffort: model.defaultReasoningEffort ?? null }) } catch (reason) { setError(appErrorFromUnknown(reason)) } }
  const changeSelection = async (selection: ConversationSelection): Promise<void> => { setError(null); try { setState(await window.fovea.question.setSelection(sessionId, selection)) } catch (reason) { setError(appErrorFromUnknown(reason)) } }
  const resolveWebSearch = (requestId: string, approved: boolean): void => { setError(null); setState((current) => current ? { ...current, busy: approved, phase: approved ? 'connecting' : 'completed', exchanges: current.exchanges.map((exchange) => exchange.webSearch?.id === requestId ? { ...exchange, phase: approved ? 'connecting' : 'completed', webSearch: { ...exchange.webSearch, status: approved ? 'searching' : 'declined' }, answer: approved ? '' : exchange.answer } : exchange) } : current); void window.fovea.question.resolveWebSearch(sessionId, requestId, approved).then(setState).catch((reason) => { setError(appErrorFromUnknown(reason)); void refresh() }) }
  const copy = async (value: string, label: string): Promise<void> => { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(''), 1500) }
  const recover = (recovery: AppRecoveryKind): void => {
    if (recovery === 'open-settings' || recovery === 'authenticate' || recovery === 'choose-provider') void window.fovea.application.openSettings()
    else if (recovery === 'recapture') void window.fovea.question.newSnip(sessionId)
    else if (recovery === 'retry') { setError(null); void refresh().catch((reason) => setError(appErrorFromUnknown(reason))) }
  }
  if (!state) return <WindowFrame title="Fovea" edgeState={error ? 'error' : 'connecting'} showResizeRegions={false}><main className="question-loading"><Spinner label="Preparing capture" size="large" /><span>Preparing capture…</span>{error && <AppStatusNotice error={error} onRecovery={recover} />}</main></WindowFrame>
  const selectedModel = state.models.find((item) => item.id === state.selection?.modelId); const hasSent = state.exchanges.length > 0; const hasPendingWebSearch = state.exchanges.some((exchange) => exchange.webSearch?.status === 'requested'); const missingModels = state.profiles.length > 0 && !state.selection
  return <WindowFrame title="Fovea" edgeState={error || missingModels ? 'error' : spectralStateForPhase(state.phase)} showResizeRegions={false}><main className="panel">
    <div className="selector-bar"><Select label={<span className="fui-sr-only">Profile</span>} value={state.selection?.profileId ?? ''} onChange={(event) => void changeProfile(event.target.value)}><option value="" disabled>Choose profile</option>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider}</option>)}</Select><Select label={<span className="fui-sr-only">Model</span>} value={state.selection?.modelId ?? ''} disabled={!state.selection} onChange={(event) => state.selection && void changeSelection({ ...state.selection, modelId: event.target.value, reasoningEffort: null })}>{state.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select>{selectedModel && selectedModel.supportedReasoningEfforts.length > 0 && <Select label={<span className="fui-sr-only">Reasoning</span>} value={state.selection?.reasoningEffort ?? ''} onChange={(event) => state.selection && void changeSelection({ ...state.selection, reasoningEffort: event.target.value || null })}><option value="">Default reasoning</option>{selectedModel.supportedReasoningEfforts.map((effort) => <option key={effort}>{effort}</option>)}</Select>}</div>
    <div className="content" ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; setNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 72) }}>
      <div className={hasSent ? 'preview-card compact' : 'preview-card'}><img src={state.thumbnailDataUrl} alt="Selected screenshot" /><div className="preview-actions"><Tooltip content="Enlarge preview"><button aria-label="Enlarge preview" onClick={() => setEnlarged(true)}><Icon name="expand" /></button></Tooltip><Tooltip content="Recapture"><button aria-label="Recapture" onClick={() => void window.fovea.question.newSnip(sessionId)}><Icon name="recapture" /></button></Tooltip><Tooltip content="Discard capture"><button aria-label="Discard capture" onClick={() => void window.fovea.question.close(sessionId)}><Icon name="discard" /></button></Tooltip></div></div>
      {state.disclosure && <StatusBanner tone="warning">{state.disclosure}</StatusBanner>}
      {!state.selection && <StatusBanner title={state.profiles.length ? 'No compatible models' : 'Connect a provider'} tone="warning">{state.profiles.length ? 'Test this provider or choose another profile in Settings.' : 'Add and authenticate a provider profile in Settings.'}<div><Button size="compact" variant="secondary" onClick={() => void window.fovea.application.openSettings()}>Open Settings</Button></div></StatusBanner>}
      {!hasSent && <>
        <details className="suggestions">
          <summary><span>Suggested questions</span><small>{SUGGESTED_QUESTIONS.length} prompts</small><Icon name="chevron" /></summary>
          <div className="suggestion-list">{SUGGESTED_QUESTIONS.map((suggestion) => <Button key={suggestion.label} size="compact" variant="secondary" disabled={state.busy || !state.selection} onClick={() => void send(suggestion.label)}><Icon name={suggestion.icon} />{suggestion.label}</Button>)}</div>
        </details>
        <Composer text={text} setText={setText} send={send} busy={state.busy} autoFocus />
      </>}
      {hasSent && <div className="transcript">{state.exchanges.map((exchange) => <article key={exchange.id}><div className="question">{exchange.question}</div><div className="phase-label"><ResponseStatus phase={exchange.phase} /></div>{exchange.webSearch?.status === 'requested' && <div className="web-approval" role="group" aria-label="Web search approval"><strong>Search the web?</strong><p>The AI isn’t confident it can identify or explain this reliably without checking sources.</p><code>{exchange.webSearch.query}</code><div><Button size="compact" variant="secondary" onClick={() => resolveWebSearch(exchange.webSearch!.id, false)}>Continue without browsing</Button><Button size="compact" onClick={() => resolveWebSearch(exchange.webSearch!.id, true)}>Approve search</Button></div></div>}{exchange.webSearch?.status === 'searching' && <StatusBanner tone="info">Searching approved sources…</StatusBanner>}{exchange.webSearch?.status === 'declined' && <StatusBanner tone="info">Web search declined.</StatusBanner>}<div className="answer">{exchange.answer ? <Markdown text={exchange.answer} onCopy={copy} /> : exchange.webSearch?.status !== 'requested' && <span className="thinking">{phaseLabel(exchange.phase)}</span>}{exchange.error && <AppStatusNotice error={exchange.error} onRecovery={exchange.error.recovery === 'retry' ? undefined : recover} />}</div></article>)}</div>}
      {error && <AppStatusNotice error={error} onRecovery={error.recovery === 'retry' ? undefined : recover} />}
    </div>
    {!nearBottom && hasSent && <Button className="jump-latest" size="compact" variant="secondary" onClick={() => { setNearBottom(true); const node = scrollRef.current; node?.scrollTo({ top: node.scrollHeight }) }}>Jump to latest</Button>}
    {hasSent && <footer className="response-footer"><Composer text={text} setText={setText} send={send} busy={state.busy || hasPendingWebSearch} /><div className="toolbar"><Button size="compact" variant="secondary" onClick={() => void window.fovea.question.newSnip(sessionId)}>New capture</Button>{state.busy ? <Button size="compact" variant="danger" onClick={() => void window.fovea.question.stop(sessionId)}>Stop</Button> : <Button size="compact" disabled={!text.trim() || !state.selection || hasPendingWebSearch} onClick={() => void send()}>Send</Button>}{copied && <Badge className="copy-status" tone="success">{copied}</Badge>}<span className="spacer"/><Tooltip content="Copy latest answer"><Button size="compact" variant="secondary" disabled={!state.exchanges.at(-1)?.answer} onClick={() => void copy(state.exchanges.at(-1)?.answer ?? '', 'Answer copied')}>Copy</Button></Tooltip></div></footer>}
    {enlarged && <div className="preview-modal" role="dialog" aria-modal="true" aria-label="Screenshot preview" onClick={() => setEnlarged(false)}><img src={state.thumbnailDataUrl} alt="Enlarged selected screenshot" /></div>}<div className="fui-sr-only" aria-live="polite">{copied}</div>
  </main></WindowFrame>
}

function Composer({ text, setText, send, busy, autoFocus = false }: { text: string; setText(value: string): void; send(): Promise<void>; busy: boolean; autoFocus?: boolean }): React.JSX.Element { const ref = useRef<HTMLTextAreaElement>(null); useEffect(() => { const node = ref.current; if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(150, node.scrollHeight)}px` } }, [text]); return <div className="composer-wrap"><TextArea ref={ref} label={<span className="fui-sr-only">Question</span>} className="composer" resize="none" rows={2} value={text} disabled={busy} autoFocus={autoFocus} placeholder={busy ? 'Waiting for the answer…' : 'Ask about this screenshot…'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><Button className="composer-send" size="compact" disabled={!text.trim() || busy} onClick={() => void send()} aria-label="Send question"><Icon name="send" /></Button></div> }
function Markdown({ text, onCopy }: { text: string; onCopy(value: string, label: string): Promise<void> }): React.JSX.Element { return <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void window.fovea.openExternal(href) }}>{children}</a>, pre: ({ children }) => { const value = nodeText(children); return <div className="code-block"><button onClick={() => void onCopy(value, 'Code copied')}>Copy</button><pre>{children}</pre></div> } }}>{text}</ReactMarkdown> }
function nodeText(node: ReactNode): string { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(nodeText).join(''); if (node && typeof node === 'object' && 'props' in node) return nodeText((node as { props: { children?: ReactNode } }).props.children); return '' }
function phaseLabel(phase: ResponsePhase): string { return ({ idle: 'Ready', connecting: 'Connecting…', thinking: 'Thinking…', streaming: 'Answering…', 'awaiting-approval': 'Needs approval', stopped: 'Stopped', completed: 'Complete', failed: 'Failed' })[phase] }
function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, ReactNode> = {
    expand: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
    recapture: <path d="M20 7v5h-5M4 17v-5h5M6.2 8a7 7 0 0 1 11.2-2l2.6 6M17.8 16a7 7 0 0 1-11.2 2L4 12" />,
    discard: <path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6" />,
    send: <path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 4-4" />,
    spark: <path d="m12 2 1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2Z" />,
    identify: <><circle cx="12" cy="12" r="3" /><path d="M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4" /></>,
    alert: <path d="M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01" />,
    fix: <path d="M14.5 6.5a4 4 0 0 0-5-5L7 4l3 3-6.8 6.8a2.4 2.4 0 0 0 3.4 3.4L13.4 10l3 3 2.5-2.5a4 4 0 0 0-4.4-4Z" />,
    steps: <path d="M4 6h9m-9 6h13M4 18h16m-3-15 3 3-3 3" />,
    summary: <path d="M5 5h14M5 9h14M5 13h9M5 17h11" />,
    text: <path d="M4 5h16M8 9h8M6 13h12M9 17h6" />,
    compare: <path d="M4 5h6v14H4V5Zm10 0h6v14h-6V5Z" />,
    chevron: <path d="m8 10 4 4 4-4" />
  }
  return <svg className="mono-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] ?? paths.spark}</svg>
}
createRoot(document.getElementById('root')!).render(<QuestionApp />)
