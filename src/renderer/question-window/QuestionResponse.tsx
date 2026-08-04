import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type {
  ConversationExchange,
  OcrEntity,
  OcrExternalActionKind,
  ResponsePhase
} from '@shared/types/app'
import { Button, Spinner } from '../design-system'

export interface ConversationTimelineProps {
  exchanges: ConversationExchange[]
  onCopy(value: string, label?: string): Promise<void>
  onOpenOcrEntity?(entity: OcrEntity): void
  onManageOcrLanguages?(): void
  onResolveWebSearch(requestId: string, approved: boolean): void
}

export function ConversationTimeline(props: ConversationTimelineProps): React.JSX.Element {
  return (
    <div className="conversation-thread" role="log" aria-label="Conversation" aria-live="polite">
      {props.exchanges.map((exchange) => (
        <ConversationTurn
          exchange={exchange}
          key={exchange.id}
          onCopy={props.onCopy}
          onManageOcrLanguages={props.onManageOcrLanguages}
          onOpenOcrEntity={props.onOpenOcrEntity}
          onResolveWebSearch={props.onResolveWebSearch}
        />
      ))}
    </div>
  )
}

interface ConversationTurnProps extends Omit<ConversationTimelineProps, 'exchanges'> {
  exchange: ConversationExchange
}

const ConversationTurn = memo(function ConversationTurn({
  exchange,
  onCopy,
  onOpenOcrEntity,
  onManageOcrLanguages,
  onResolveWebSearch
}: ConversationTurnProps): React.JSX.Element {
  return (
    <section className="conversation-turn">
      {!exchange.automatic && !exchange.retryOf && (
        <div className="conversation-message conversation-message--user">
          <span className="fui-sr-only">You asked: </span>
          {exchange.question}
        </div>
      )}
      {exchange.retryOf && <small className="conversation-retry-label">Regenerated reply</small>}
      <div className={`conversation-message conversation-message--assistant${exchange.automatic ? ' conversation-message--opening' : ''}`}>
        <span className="fui-sr-only">{exchange.source === 'ocr' ? 'Extracted text: ' : 'AI response: '}</span>
        <ResponseBody
          exchange={exchange}
          onCopy={onCopy}
          onOpenOcrEntity={onOpenOcrEntity}
          onManageOcrLanguages={onManageOcrLanguages}
          onResolveWebSearch={onResolveWebSearch}
        />
      </div>
    </section>
  )
}, (previous, next) => previous.exchange === next.exchange)

export function FriendlyStatus({ phase, source }: { phase: ResponsePhase; source?: ConversationExchange['source'] }): React.JSX.Element {
  const busy = ['connecting', 'thinking', 'streaming'].includes(phase)
  const label = source === 'ocr'
    ? phase === 'completed' ? 'Text extracted' : phase === 'failed' ? 'Extraction failed' : 'Extracting text…'
    : friendlyPhaseLabel(phase)
  return (
    <div className="friendly-status" role="status">
      {busy && <Spinner />}
      <span>{label}</span>
    </div>
  )
}

function ResponseBody({
  exchange,
  onCopy,
  onOpenOcrEntity,
  onManageOcrLanguages,
  onResolveWebSearch
}: ConversationTurnProps): React.JSX.Element {
  const summary = exchange.metadata?.summary
  const detail = exchange.answer.trim()
  const waiting = ['connecting', 'thinking'].includes(exchange.phase) && !summary && !detail
  if (exchange.source === 'ocr') {
    const ocr = exchange.ocr
    return (
      <article className="answer-card answer-card--ocr">
        {waiting && <TypingIndicator label="Recognising text" />}
        {ocr && (
          <div className="ocr-response-meta">
            <span>{ocr.language.label}</span>
            <span>{ocr.engine === 'windows' ? 'Windows OCR' : ocr.engine === 'paddle' ? `PaddleOCR ${ocr.paddleProfile ?? ''}`.trim() : 'Tesseract OCR'}</span>
            {ocr.engine !== 'windows' && <span>{ocr.confidence}% confidence</span>}
            {ocr.durationMs > 0 && <span>{formatOcrDuration(ocr.durationMs)}</span>}
            {ocr.preprocessing === 'upscaled-contrast' && <span>Enhanced</span>}
            {ocr.preprocessing === 'high-contrast' && <span>High contrast</span>}
            {ocr.geometryCorrection === 'deskewed' && <span>Deskewed</span>}
            {ocr.geometryCorrection === 'perspective-corrected' && <span>Perspective corrected</span>}
            {ocr.cached && <span>Cached</span>}
            {onManageOcrLanguages && <button type="button" onClick={onManageOcrLanguages}>Manage languages</button>}
          </div>
        )}
        {detail && <pre className="ocr-response-text">{detail}</pre>}
        {ocr?.entities.length ? (
          <div className="ocr-response-entities" aria-label="Detected text actions">
            {ocr.entities.map((entity) => {
              const action = ocrEntityExternalAction(entity)
              return (
                <div className="ocr-response-entity" key={entity.id}>
                  <button
                    aria-label={`Copy ${ocrEntityLabel(entity.kind)}: ${entity.value}`}
                    className="ocr-response-entity__value"
                    title={`Copy ${entity.kind}`}
                    type="button"
                    onClick={() => void onCopy(entity.value, `${ocrEntityLabel(entity.kind)} copied`)}
                  >
                    <span>{ocrEntityLabel(entity.kind)}</span>
                    <strong>{entity.value}</strong>
                  </button>
                  {onOpenOcrEntity && action && (
                    <button
                      aria-label={`${action.label} ${entity.value}`}
                      className="ocr-response-entity__action"
                      type="button"
                      onClick={() => onOpenOcrEntity(entity)}
                    >
                      {action.label}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </article>
    )
  }
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
    </article>
  )
}

function TypingIndicator({ label = 'AI is writing' }: { label?: string }): React.JSX.Element {
  return (
    <div className="typing-indicator" aria-label={label} role="status">
      <span />
      <span />
      <span />
    </div>
  )
}

export function AnswerSkeleton(): React.JSX.Element {
  return (
    <div className="answer-skeleton" aria-label="Looking at your capture" role="status">
      <span />
      <span />
      <span />
    </div>
  )
}

const Markdown = memo(function Markdown({
  text,
  onCopy
}: {
  text: string
  onCopy(value: string, label?: string): Promise<void>
}): React.JSX.Element {
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
})

export function exchangeText(exchange: ConversationExchange): string {
  return [exchange.metadata?.summary, exchange.answer].filter(Boolean).join('\n\n').trim()
}

function ocrEntityLabel(kind: 'url' | 'email' | 'phone' | 'qr' | 'barcode'): string {
  if (kind === 'url') return 'URL'
  if (kind === 'email') return 'Email'
  if (kind === 'phone') return 'Phone'
  return kind === 'qr' ? 'QR code' : 'Barcode'
}

export function ocrEntityExternalAction(entity: OcrEntity): {
  kind: OcrExternalActionKind
  label: 'Open' | 'Email' | 'Call'
  confirmation: string
} | null {
  if (entity.kind === 'url' || (entity.kind === 'qr' && /^(?:https?:\/\/|www\.)/i.test(entity.value.trim()))) {
    return { kind: 'url', label: 'Open', confirmation: 'Open this link in your default browser?' }
  }
  if (entity.kind === 'email') return { kind: 'email', label: 'Email', confirmation: 'Open this address in your email app?' }
  if (entity.kind === 'phone') return { kind: 'phone', label: 'Call', confirmation: 'Open this number in your calling app?' }
  return null
}

function formatOcrDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
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
