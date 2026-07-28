import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaptureContext } from '@shared/contracts/ipc'
import type { ImageEditOperation, OcrLanguage } from '@shared/types/app'
import type { AppError } from '@shared/types/app-error'
import type { Point, Rectangle } from '@shared/types/geometry'
import { initialiseAppearance } from '../appearance'
import { appErrorFromUnknown } from '../status/status-presentation'
import { CaptureEditor } from './CaptureEditor'
import { resizeCaptureRectangle, type ResizeCorner } from './editor-geometry'
import '../design-system/index.css'
import './overlay.css'

type OverlayPhase = 'idle' | 'selecting' | 'editing' | 'invalid' | 'submitting'
const MINIMUM_SELECTION = 24
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const

function Overlay(): React.JSX.Element {
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point>({ x: innerWidth / 2, y: innerHeight / 2 })
  const [phase, setPhase] = useState<OverlayPhase>('idle')
  const [feedback, setFeedback] = useState('Select any part of the frozen screen')
  const [context, setContext] = useState<CaptureContext | null>(null)
  const [captureError, setCaptureError] = useState<AppError | null>(null)
  const [editBeforeSending, setEditBeforeSending] = useState(false)
  const [preferWebSearch, setPreferWebSearch] = useState(false)
  const [extractText, setExtractText] = useState(false)
  const [ocrLanguageCode, setOcrLanguageCode] = useState('')
  const [ocrLanguages, setOcrLanguages] = useState<OcrLanguage[]>([])
  const [resizing, setResizing] = useState<{ corner: ResizeCorner; original: Rectangle } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const rectangle = start ? normalize(start, current) : null

  const loadContext = useCallback((): void => {
    setCaptureError(null)
    setPhase('idle')
    setFeedback('Select any part of the frozen screen')
    void window.fovea.capture.getContext().then(setContext).catch((reason) => {
      const error = appErrorFromUnknown(reason)
      setPhase('invalid')
      setCaptureError(error)
      setFeedback(error.message)
    })
  }, [])

  useEffect(() => {
    void initialiseAppearance()
    loadContext()
    void Promise.all([
      window.fovea.capture.getOcrLanguages(),
      window.fovea.settings.get()
    ]).then(([languages, settings]) => {
      setOcrLanguages(languages)
      const remembered = settings.ocrLanguageCode ?? ''
      const available = remembered && languages.some(({ code }) => code === remembered) ? remembered : ''
      setOcrLanguageCode(available)
      if (remembered && !available) void window.fovea.capture.setOcrLanguage('').catch(() => undefined)
    }).catch(() => setOcrLanguages([]))
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') void window.fovea.capture.cancel() }
    addEventListener('keydown', onKey)
    root.current?.focus()
    return () => removeEventListener('keydown', onKey)
  }, [loadContext])

  const submit = async (next: Rectangle, operations: ImageEditOperation[]): Promise<void> => {
    setPhase('submitting')
    try { await window.fovea.capture.select(next, operations, preferWebSearch, extractText, extractText && ocrLanguageCode ? ocrLanguageCode : undefined) }
    catch (reason) {
      const error = appErrorFromUnknown(reason)
      setPhase(editBeforeSending ? 'editing' : 'invalid')
      setCaptureError(error)
      setFeedback(error.message)
      if (!editBeforeSending) setStart(null)
    }
  }

  const complete = async (end: Point): Promise<void> => {
    if (!start) return
    const next = normalize(start, end)
    if (next.width < MINIMUM_SELECTION || next.height < MINIMUM_SELECTION) {
      setPhase('invalid')
      setFeedback(`Minimum selection is ${MINIMUM_SELECTION} × ${MINIMUM_SELECTION}`)
      setStart(null)
      return
    }
    if (editBeforeSending) {
      setCaptureError(null)
      setCurrent(end)
      setPhase('editing')
      return
    }
    await submit(next, [])
  }
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>, corner: ResizeCorner, original: Rectangle): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing({ corner, original })
  }
  const updateResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!resizing || !context) return
    const next = resizeCaptureRectangle(resizing.original, resizing.corner, pointer(event), context, MINIMUM_SELECTION)
    setStart({ x: next.x, y: next.y })
    setCurrent({ x: next.x + next.width, y: next.y + next.height })
  }
  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setResizing(null)
  }

  return <div
    ref={root}
    tabIndex={-1}
    className={`overlay ${phase}`}
    onPointerDown={(event) => {
      if (!context || event.button !== 0 || phase === 'editing' || phase === 'submitting') return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const next = pointer(event)
      setStart(next)
      setCurrent(next)
      setPhase('selecting')
    }}
    onPointerMove={(event) => { if (phase === 'selecting') setCurrent(pointer(event)) }}
    onPointerUp={(event) => {
      if (!start || phase !== 'selecting') return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      void complete(pointer(event))
    }}
    onPointerCancel={() => {
      if (phase === 'editing') return
      setStart(null)
      setPhase('idle')
      setFeedback('Select any part of the frozen screen')
    }}
    onContextMenu={(event) => { event.preventDefault(); void window.fovea.capture.cancel() }}
  >
    {context && <img className="frozen-frame" src={context.imageDataUrl} alt="" draggable={false} style={captureImageStyle(context)} />}
    <div className="capture-scrim" />

    {phase === 'selecting' && <>
      <div className="capture-guide horizontal" style={{ top: current.y }} />
      <div className="capture-guide vertical" style={{ left: current.x }} />
    </>}

    {rectangle && (rectangle.width > 0 || rectangle.height > 0) && context && <div className={`selection-root ${phase === 'submitting' ? 'confirming' : ''} ${phase === 'editing' ? 'editing' : ''}`} style={rectangleStyle(rectangle)}>
      <div className="selection-viewport">
        <img className="selection-frame" src={context.imageDataUrl} alt="" draggable={false} style={selectionImageStyle(rectangle, context)} />
      </div>
      {phase === 'editing' && (
        <CaptureEditor
          context={context}
          rectangle={rectangle}
          submitting={false}
          onCancel={() => void window.fovea.capture.cancel()}
          onSend={(operations) => void submit(rectangle, operations)}
        />
      )}
      <div className="selection-outline" />
      {CORNERS.map((corner) => phase === 'editing'
        ? (
            <button
              aria-label={resizeLabel(corner)}
              className={`corner-handle ${corner}`}
              data-resizing={resizing?.corner === corner}
              key={corner}
              title={resizeLabel(corner)}
              type="button"
              onPointerCancel={finishResize}
              onPointerDown={(event) => beginResize(event, corner, rectangle)}
              onPointerMove={updateResize}
              onPointerUp={finishResize}
            />
          )
        : <i key={corner} className={`corner-handle ${corner}`} />)}
      <output className={`dimensions ${dimensionPosition(rectangle)}`}>{Math.round(rectangle.width)} × {Math.round(rectangle.height)}</output>
    </div>}

    {!rectangle && phase !== 'submitting' && <CaptureHud
      error={phase === 'invalid'}
      detail={feedback}
      title={captureError?.title}
      canEditBeforeSending={context?.canEditBeforeSending ?? false}
      editBeforeSending={editBeforeSending}
      extractText={extractText}
      ocrLanguageCode={ocrLanguageCode}
      ocrLanguages={ocrLanguages}
      preferWebSearch={preferWebSearch}
      onOcrLanguageChange={(code) => {
        setOcrLanguageCode(code)
        void window.fovea.capture.setOcrLanguage(code).catch(() => undefined)
      }}
      onToggleEdit={() => setEditBeforeSending((enabled) => !enabled)}
      onToggleExtractText={() => setExtractText((enabled) => {
        const next = !enabled
        if (next) setPreferWebSearch(false)
        return next
      })}
      onToggleWebSearch={() => setPreferWebSearch((enabled) => {
        const next = !enabled
        if (next) setExtractText(false)
        return next
      })}
      onCancel={() => void window.fovea.capture.cancel()}
      onRetry={captureError ? loadContext : undefined}
    />}
    {phase === 'submitting' && <div className="capture-status" role="status"><span className="status-dot" />{editBeforeSending ? 'Applying edits…' : extractText ? 'Opening text extraction…' : 'Opening Fovea…'}</div>}
  </div>
}

export function CaptureHud({
  error,
  detail,
  title,
  canEditBeforeSending,
  editBeforeSending,
  extractText,
  ocrLanguageCode,
  ocrLanguages,
  preferWebSearch,
  onOcrLanguageChange,
  onToggleEdit,
  onToggleExtractText,
  onToggleWebSearch,
  onCancel,
  onRetry
}: {
  error: boolean
  detail: string
  title?: string
  canEditBeforeSending: boolean
  editBeforeSending: boolean
  extractText: boolean
  ocrLanguageCode: string
  ocrLanguages: OcrLanguage[]
  preferWebSearch: boolean
  onOcrLanguageChange(value: string): void
  onToggleEdit(): void
  onToggleExtractText(): void
  onToggleWebSearch(): void
  onCancel(): void
  onRetry?: () => void
}): React.JSX.Element {
  return <div className={`capture-hud ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite" onPointerDown={(event) => event.stopPropagation()}>
    <span className="hud-symbol" aria-hidden="true">{error ? '!' : <svg viewBox="0 0 20 20"><path d="M6 2H2v4M14 2h4v4M6 18H2v-4m12 4h4v-4" /></svg>}</span>
    <span className="hud-copy">
      <strong>{error ? title ?? 'Try a larger area' : 'Drag to capture'}</strong>
      <small>{detail}</small>
    </span>
    {canEditBeforeSending && !error && (
      <>
        <button
          aria-label={editBeforeSending ? 'Edit before sending enabled' : 'Edit before sending'}
          aria-pressed={editBeforeSending}
          className="hud-icon-button hud-edit-control"
          data-active={editBeforeSending}
          title={editBeforeSending ? 'Edit before sending is on' : 'Edit before sending'}
          type="button"
          onClick={onToggleEdit}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z" />
            <path d="m13.8 6.7 3.5 3.5" />
          </svg>
        </button>
        <span className="hud-ocr-control">
          <button
            aria-label={extractText ? 'Extract text instead of AI analysis enabled' : 'Extract text instead of AI analysis'}
            aria-pressed={extractText}
            className="hud-icon-button hud-text-control"
            data-active={extractText}
            title={extractText ? 'Local text extraction is on' : 'Extract text locally instead of using AI'}
            type="button"
            onClick={onToggleExtractText}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M5 6h14M5 12h14M5 18h10" />
            </svg>
          </button>
          {extractText && (
            <label className="hud-ocr-language">
              <span>OCR language</span>
              <select
                aria-label="OCR language"
                value={ocrLanguageCode}
                onChange={(event) => onOcrLanguageChange(event.currentTarget.value)}
              >
                <option value="">Automatic</option>
                {ocrLanguages.map((language) => (
                  <option key={language.code} value={language.code}>{language.label}</option>
                ))}
              </select>
            </label>
          )}
        </span>
        <button
          aria-label={preferWebSearch ? 'Search web for first answer enabled' : 'Search web for first answer'}
          aria-pressed={preferWebSearch}
          className="hud-icon-button hud-browser-control"
          data-active={preferWebSearch}
          title={preferWebSearch ? 'Search web for the first answer is on' : 'Search web for the first answer'}
          type="button"
          onClick={onToggleWebSearch}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21M12 3C9.8 5.5 8.7 8.5 8.7 12S9.8 18.5 12 21" />
          </svg>
        </button>
      </>
    )}
    {onRetry && <button className="hud-retry" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onRetry}>Try again</button>}
    <button aria-label="Cancel capture" className="hud-icon-button" title="Cancel capture (Esc)" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onCancel}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </div>
}

function normalize(start: Point, end: Point): Rectangle {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
function pointer(event: ReactPointerEvent): Point { return { x: event.clientX, y: event.clientY } }
function rectangleStyle(rectangle: Rectangle): CSSProperties { return { left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height } }
function captureImageStyle(context: CaptureContext): CSSProperties { return { width: context.width, height: context.height } }
function selectionImageStyle(rectangle: Rectangle, context: CaptureContext): CSSProperties { return { left: -rectangle.x, top: -rectangle.y, width: context.width, height: context.height } }
function resizeLabel(corner: ResizeCorner): string {
  return `Resize capture from ${corner === 'nw' ? 'top left' : corner === 'ne' ? 'top right' : corner === 'sw' ? 'bottom left' : 'bottom right'}`
}
function dimensionPosition(rectangle: Rectangle): string {
  const vertical = rectangle.y >= 48 ? 'above' : innerHeight - rectangle.y - rectangle.height >= 48 ? 'below' : 'inside'
  const horizontal = innerWidth - rectangle.x < 112 ? 'edge-right' : 'edge-left'
  return `${vertical} ${horizontal}`
}
const applicationRoot = document.getElementById('root')
if (applicationRoot) createRoot(applicationRoot).render(<Overlay />)
