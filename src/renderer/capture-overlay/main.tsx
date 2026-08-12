import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaptureContext, CaptureFreezeReason, FrozenCaptureContext } from '@shared/contracts/ipc'
import type { CaptureAnalysis, CaptureFeature, ImageEditOperation, OcrLanguage } from '@shared/types/app'
import type { AppError } from '@shared/types/app-error'
import type { Point, Rectangle } from '@shared/types/geometry'
import { initialiseAppearance } from '../appearance'
import { appErrorFromUnknown } from '../status/status-presentation'
import { CaptureEditor } from './CaptureEditor'
import { resizeCaptureRectangle, type ResizeCorner } from './editor-geometry'
import '../design-system/index.css'
import './overlay.css'

type OverlayPhase = 'idle' | 'selecting' | 'editing' | 'analyzing' | 'invalid' | 'submitting'
const MINIMUM_SELECTION = 24
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const

function Overlay(): React.JSX.Element {
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point>({ x: innerWidth / 2, y: innerHeight / 2 })
  const [phase, setPhase] = useState<OverlayPhase>('idle')
  const [feedback, setFeedback] = useState('Drag over anything on screen')
  const [context, setContext] = useState<CaptureContext | null>(null)
  const [captureError, setCaptureError] = useState<AppError | null>(null)
  const [editBeforeSending, setEditBeforeSending] = useState(false)
  const [preferWebSearch, setPreferWebSearch] = useState(false)
  const [extractText, setExtractText] = useState(false)
  const [ocrLanguageCode, setOcrLanguageCode] = useState('')
  const [ocrLanguages, setOcrLanguages] = useState<OcrLanguage[]>([])
  const [analysis, setAnalysis] = useState<CaptureAnalysis | null>(null)
  const [analyzeHoldInFlight, setAnalyzeHoldInFlight] = useState(false)
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null)
  const [resizing, setResizing] = useState<{ corner: ResizeCorner; original: Rectangle } | null>(null)
  const [appearanceReady, setAppearanceReady] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const analysisRevision = useRef(0)
  const liveSurface = useRef(false)
  const rectangle = start ? normalize(start, current) : null
  const selectedFeature = analysis?.features.find(({ id }) => id === selectedFeatureId) ?? null

  const warmVideoFrame = useCallback((): void => {
    if (!liveSurface.current || !window.fovea?.capture) return
    void window.fovea.capture.prepareVideoFrame().catch(() => undefined)
  }, [])

  const cancelCapture = useCallback((): void => {
    analysisRevision.current += 1
    if (!window.fovea?.capture) {
      window.close()
      return
    }
    void window.fovea.capture.cancelVideoFrame()
      .catch(() => undefined)
      .finally(() => window.fovea.capture.cancel().catch(() => undefined))
  }, [])

  const loadContext = useCallback((): void => {
    if (!window.fovea?.capture) {
      setPhase('invalid')
      setFeedback('The secure capture bridge did not start. Close and reopen Fovea.')
      return
    }
    setCaptureError(null)
    setAnalysis(null)
    setSelectedFeatureId(null)
    liveSurface.current = false
    analysisRevision.current += 1
    setPhase('idle')
    setFeedback('Preparing capture controls…')
    void window.fovea.capture.getContext().then((next) => {
      liveSurface.current = next.surface === 'live'
      setContext(next)
      setFeedback(surfaceFeedback(next))
    }).catch((reason) => {
      const error = appErrorFromUnknown(reason)
      setPhase('invalid')
      setCaptureError(error)
      setFeedback(error.message)
    })
  }, [])

  const announceCaptureReady = useCallback((): void => {
    void window.fovea.capture.readyToShow().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!window.fovea?.capture || !window.fovea.settings) {
      setPhase('invalid')
      setFeedback('The secure capture bridge did not start. Close and reopen Fovea.')
      return
    }
    let disposed = false
    let stopAppearanceUpdates: (() => void) | undefined
    void initialiseAppearance().then((stop) => {
      if (disposed) stop()
      else {
        stopAppearanceUpdates = stop
        setAppearanceReady(true)
      }
    }).catch(() => {
      if (!disposed) setAppearanceReady(true)
    })
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
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancelCapture() }
    addEventListener('keydown', onKey)
    root.current?.focus()
    return () => {
      disposed = true
      stopAppearanceUpdates?.()
      removeEventListener('keydown', onKey)
      void window.fovea.capture.cancelVideoFrame().catch(() => undefined)
    }
  }, [cancelCapture, loadContext])

  const submit = async (next: Rectangle, operations: ImageEditOperation[]): Promise<void> => {
    setPhase('submitting')
    try {
      if (context?.surface === 'live') await window.fovea.capture.captureVideoFrame(next).catch(() => false)
      await window.fovea.capture.select(next, operations, preferWebSearch, extractText, extractText && ocrLanguageCode ? ocrLanguageCode : undefined)
    }
    catch (reason) {
      const error = appErrorFromUnknown(reason)
      setPhase(editBeforeSending ? 'editing' : 'invalid')
      setCaptureError(error)
      setFeedback(error.message)
      if (!editBeforeSending) setStart(null)
    }
  }

  const toggleAnalyze = async (): Promise<void> => {
    if (analyzeHoldInFlight) return
    if (analysis || phase === 'analyzing') {
      analysisRevision.current += 1
      if (phase === 'analyzing') void window.fovea.capture.cancelAnalysis().catch(() => undefined)
      setAnalysis(null)
      setSelectedFeatureId(null)
      setPhase('idle')
      setFeedback(context ? surfaceFeedback(context) : 'Drag over anything on screen')
      return
    }
    if (!context) return
    const revision = ++analysisRevision.current
    setCaptureError(null)
    setSelectedFeatureId(null)
    setPhase('analyzing')
    setFeedback(context.surface === 'live' ? 'Holding this moment for Analyze…' : 'Finding identifiable features across the frozen screen…')
    try {
      if (context.surface === 'live') {
        setAnalyzeHoldInFlight(true)
        let frozen: FrozenCaptureContext | null = null
        try {
          frozen = await holdLiveSurfaceForAnalyze(
            window.fovea.capture,
            () => analysisRevision.current === revision
          )
        } finally {
          setAnalyzeHoldInFlight(false)
        }
        if (!frozen) return
        liveSurface.current = false
        setContext(frozen)
        if (analysisRevision.current !== revision) {
          setPhase('idle')
          setFeedback(surfaceFeedback(frozen))
          return
        }
        setFeedback('Finding identifiable features across the frozen screen…')
      }
      const result = await window.fovea.capture.analyze((progress) => {
        if (analysisRevision.current !== revision) return
        setAnalysis(progress)
        setFeedback(analysisProgressFeedback(progress))
      })
      if (analysisRevision.current !== revision) return
      setAnalysis(result)
      setPhase('idle')
      setFeedback(result.features.length
        ? `Choose one of ${result.features.length} identified features`
        : 'No distinct features were found on this screen')
    } catch (reason) {
      if (analysisRevision.current !== revision) return
      const error = appErrorFromUnknown(reason)
      setPhase('invalid')
      setCaptureError(error)
      setFeedback(error.message)
    }
  }

  const submitFeature = async (
    feature: CaptureFeature,
    options: { question?: string; preferWebSearch?: boolean; extractText?: boolean } = {}
  ): Promise<void> => {
    if (!context) return
    setPhase('submitting')
    try {
      await window.fovea.capture.select(
        captureRectangleForFeature(feature, context),
        [],
        options.preferWebSearch === true,
        options.extractText === true,
        undefined,
        options.question
      )
    } catch (reason) {
      const error = appErrorFromUnknown(reason)
      setPhase('idle')
      setCaptureError(error)
      setFeedback(error.message)
    }
  }

  const complete = async (end: Point): Promise<void> => {
    if (!start) return
    const next = normalize(start, end)
    if (next.width < MINIMUM_SELECTION || next.height < MINIMUM_SELECTION) {
      void window.fovea.capture.cancelVideoFrame().catch(() => undefined)
      setPhase('invalid')
      setFeedback(`Minimum selection is ${MINIMUM_SELECTION} × ${MINIMUM_SELECTION}`)
      setStart(null)
      return
    }
    if (editBeforeSending) {
      setCaptureError(null)
      setCurrent(end)
      if (context?.surface === 'frozen') {
        setPhase('editing')
        return
      }
      setPhase('submitting')
      setFeedback('Holding this moment for editing…')
      try {
        await window.fovea.capture.captureVideoFrame().catch(() => false)
        const frozen = await window.fovea.capture.freeze('edit')
        liveSurface.current = false
        setContext(frozen)
        setPhase('editing')
        setFeedback('Edit the captured area, then send it')
      } catch (reason) {
        const error = appErrorFromUnknown(reason)
        setPhase('invalid')
        setCaptureError(error)
        setFeedback(error.message)
      }
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
    className={`overlay ${overlaySurfaceClass(context, captureError)} ${phase} ${analysis ? 'analyze-active' : ''}`}
    onPointerDown={(event) => {
      if (!context || event.button !== 0 || phase === 'editing' || phase === 'analyzing' || phase === 'submitting') return
      if (analysis) {
        setSelectedFeatureId(null)
        return
      }
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      if (context.surface === 'live') warmVideoFrame()
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
      setFeedback(context ? surfaceFeedback(context) : 'Drag over anything on screen')
      void window.fovea.capture.cancelVideoFrame().catch(() => undefined)
    }}
    onContextMenu={(event) => { event.preventDefault(); cancelCapture() }}
  >
    {context?.surface === 'frozen' && (
      <FrozenFrame
        appearanceReady={appearanceReady}
        context={context}
        onReady={announceCaptureReady}
      />
    )}
    {context?.surface === 'live' && (
      <LiveSurfaceReady
        appearanceReady={appearanceReady}
        onReady={announceCaptureReady}
      />
    )}
    <div className="capture-scrim" />

    {context && analysis && (
      <div
        className="analyze-features"
        aria-label="Identified screen features"
        role="region"
        onClick={(event) => {
          const matches = featuresAtPoint(
            analysis.features,
            { x: event.clientX / context.width, y: event.clientY / context.height }
          )
          if (!matches.length) {
            setSelectedFeatureId(null)
            return
          }
          const selectedIndex = matches.findIndex(({ id }) => id === selectedFeatureId)
          const next = matches[(selectedIndex + 1) % matches.length]!
          setSelectedFeatureId(next.id)
          if (matches.length > 1) {
            setFeedback(`Target ${matches.indexOf(next) + 1} of ${matches.length} here · click again to cycle`)
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <AnalyzeLegend />
        {analysis.features.map((feature) => (
          <button
            aria-label={`Ask about ${displayFeatureLabel(feature)}`}
            aria-pressed={selectedFeatureId === feature.id}
            className={`analyze-feature analyze-feature--${feature.kind}`}
            key={feature.id}
            style={featureStyle(feature, selectedFeatureId === feature.id)}
            title={displayFeatureLabel(feature)}
            type="button"
            onClick={(event) => {
              if (event.detail !== 0) return
              event.stopPropagation()
              setSelectedFeatureId((selected) => selected === feature.id ? null : feature.id)
            }}
          >
            <span>{featureKindLabel(feature)}</span>
          </button>
        ))}
      </div>
    )}

    {context && selectedFeature && (
      <FeatureAskMenu
        feature={selectedFeature}
        context={context}
        onAsk={(question) => void submitFeature(selectedFeature, { question })}
        onClose={() => setSelectedFeatureId(null)}
        onCopy={() => {
          void window.fovea.clipboard.writeText(displayFeatureLabel(selectedFeature)).then(() => {
            setFeedback('Detected text copied')
            setSelectedFeatureId(null)
          }).catch((reason) => {
            const error = appErrorFromUnknown(reason)
            setCaptureError(error)
            setFeedback(error.message)
          })
        }}
        onExtractText={() => void submitFeature(selectedFeature, { extractText: true })}
        onSearchWeb={() => void submitFeature(selectedFeature, {
          question: webQuestionForFeature(selectedFeature),
          preferWebSearch: true
        })}
      />
    )}

    {phase === 'selecting' && <>
      <div className="capture-guide horizontal" style={{ top: current.y }} />
      <div className="capture-guide vertical" style={{ left: current.x }} />
    </>}

    {rectangle && (rectangle.width > 0 || rectangle.height > 0) && context && <div className={`selection-root ${phase === 'submitting' ? 'confirming' : ''} ${phase === 'editing' ? 'editing' : ''}`} style={rectangleStyle(rectangle)}>
      {context.surface === 'frozen' && (
        <div className="selection-viewport">
          <img className="selection-frame" src={context.imageDataUrl} alt="" draggable={false} style={selectionImageStyle(rectangle, context)} />
        </div>
      )}
      {phase === 'editing' && context.surface === 'frozen' && (
        <CaptureEditor
          context={context}
          rectangle={rectangle}
          submitting={false}
          onCancel={cancelCapture}
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
      analyzeActive={analysis !== null}
      analyzeBusy={phase === 'analyzing'}
      analyzeHoldInFlight={analyzeHoldInFlight}
      ocrLanguageCode={ocrLanguageCode}
      ocrLanguages={ocrLanguages}
      preferWebSearch={preferWebSearch}
      onToggleAnalyze={() => void toggleAnalyze()}
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
      onCancel={cancelCapture}
      onRetry={captureError ? loadContext : undefined}
    />}
    {phase === 'submitting' && <div className="capture-status" role="status"><span className="status-dot" />{editBeforeSending ? 'Preparing editor…' : extractText ? 'Opening text extraction…' : 'Opening Fovea…'}</div>}
  </div>
}

export function LiveSurfaceReady({
  appearanceReady = true,
  onReady
}: {
  appearanceReady?: boolean
  onReady(): void
}): null {
  const announced = useRef(false)
  useEffect(() => {
    if (!appearanceReady || announced.current) return
    let cancelled = false
    void waitForRenderedFrame().then(() => {
      if (cancelled || announced.current) return
      announced.current = true
      onReady()
    })
    return () => { cancelled = true }
  }, [appearanceReady, onReady])
  return null
}

export function FrozenFrame({
  appearanceReady = true,
  context,
  onReady
}: {
  appearanceReady?: boolean
  context: FrozenCaptureContext
  onReady(): void
}): React.JSX.Element {
  const announcedSource = useRef<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [decodedSource, setDecodedSource] = useState<string | null>(null)

  useEffect(() => {
    if (!appearanceReady || decodedSource !== context.imageDataUrl || announcedSource.current === context.imageDataUrl) return
    let cancelled = false
    void waitForRenderedFrame().then(() => {
      const image = imageRef.current
      if (cancelled || image?.getAttribute('src') !== context.imageDataUrl || announcedSource.current === context.imageDataUrl) return
      announcedSource.current = context.imageDataUrl
      onReady()
    })
    return () => { cancelled = true }
  }, [appearanceReady, context.imageDataUrl, decodedSource, onReady])

  return (
    <img
      alt=""
      className="frozen-frame"
      draggable={false}
      ref={imageRef}
      src={context.imageDataUrl}
      style={captureImageStyle(context)}
      onLoad={(event) => {
        const source = context.imageDataUrl
        if (announcedSource.current === source) return
        const image = event.currentTarget
        const decoded = typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve()
        void decoded.then(() => {
          if (image.getAttribute('src') === source) setDecodedSource(source)
        })
      }}
    />
  )
}

export function CaptureHud({
  error,
  detail,
  title,
  canEditBeforeSending,
  editBeforeSending,
  extractText,
  analyzeActive = false,
  analyzeBusy = false,
  analyzeHoldInFlight = false,
  ocrLanguageCode,
  ocrLanguages,
  preferWebSearch,
  onToggleAnalyze = () => undefined,
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
  analyzeActive?: boolean
  analyzeBusy?: boolean
  analyzeHoldInFlight?: boolean
  ocrLanguageCode: string
  ocrLanguages: OcrLanguage[]
  preferWebSearch: boolean
  onToggleAnalyze?(): void
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
      <strong>{error ? title ?? 'Try a larger area' : analyzeHoldInFlight ? 'Holding current screen' : analyzeBusy ? 'Analyzing screen' : analyzeActive ? 'Analyze mode' : 'Drag to capture'}</strong>
      <small>{detail}</small>
    </span>
    {canEditBeforeSending && !error && (
      <button
        aria-label={analyzeHoldInFlight ? 'Holding current screen for Analyze' : analyzeBusy ? 'Stop finding screen features' : analyzeActive ? 'Exit Analyze mode' : 'Analyze full screen'}
        aria-pressed={analyzeActive || analyzeBusy}
        className="hud-icon-button hud-analyze-control"
        data-active={analyzeActive || analyzeBusy}
        data-busy={analyzeBusy}
        disabled={analyzeHoldInFlight}
        title={analyzeActive ? 'Exit Analyze mode' : 'Find things to ask about'}
        type="button"
        onClick={onToggleAnalyze}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5" />
          <path d="m12 7 1.1 3.9L17 12l-3.9 1.1L12 17l-1.1-3.9L7 12l3.9-1.1L12 7Z" />
        </svg>
      </button>
    )}
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

export function FeatureAskMenu({
  feature,
  context,
  onAsk,
  onClose,
  onCopy,
  onExtractText,
  onSearchWeb
}: {
  feature: CaptureFeature
  context: CaptureContext
  onAsk(question: string): void
  onClose(): void
  onCopy(): void
  onExtractText(): void
  onSearchWeb(): void
}): React.JSX.Element {
  const canCopy = feature.kind !== 'visual' && feature.kind !== 'face'
  const isFace = feature.kind === 'face'
  const label = displayFeatureLabel(feature)
  return (
    <div
      aria-label={`Ask about ${label}`}
      className="analyze-ask-menu"
      role="dialog"
      style={featureMenuStyle(feature, context)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="analyze-ask-menu__heading">
        <span>
          <small>{feature.role ? `${feature.enabled === false ? 'Disabled ' : ''}${feature.role}` : 'Ask about'}</small>
          <strong>{label}</strong>
          {feature.description && feature.description !== label && <p>{feature.description}</p>}
        </span>
        <button aria-label="Close feature questions" type="button" onClick={onClose}>×</button>
      </div>
      <div aria-label="Feature actions" className="analyze-ask-menu__actions" role="toolbar">
        <button aria-label="Extract text from this feature" title="Extract text locally" type="button" onClick={onExtractText}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5" />
            <path d="M8 8h8M12 8v9m-3 0h6" />
          </svg>
        </button>
        <button aria-label="Copy detected text" disabled={!canCopy} title={canCopy ? 'Copy detected text' : 'No detected text to copy'} type="button" onClick={onCopy}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        </button>
        <button
          aria-label={isFace ? 'Search the web for this person' : 'Search the web about this feature'}
          title={isFace ? 'Identify this person with web search' : 'Identify or verify with web search'}
          type="button"
          onClick={onSearchWeb}
        >
          {isFace
            ? <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="9" cy="7.5" r="3.5" />
                <path d="M3.5 17c.6-3.2 2.4-4.8 5.5-4.8 2 0 3.5.7 4.5 2" />
                <circle cx="16.5" cy="16.5" r="3.5" />
                <path d="m19 19 2.5 2.5" />
              </svg>
            : <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" />
                <path d="M4 11h14M11 4c1.7 1.9 2.5 4.2 2.5 7S12.7 16.1 11 18M11 4C9.3 5.9 8.5 8.2 8.5 11s.8 5.1 2.5 7m5.5-1.5L21 21" />
              </svg>}
        </button>
      </div>
      <div aria-label="Preset questions" className="analyze-ask-menu__questions" role="menu">
        {questionsForFeature(feature).map((question) => (
          <button key={question} role="menuitem" type="button" onClick={() => onAsk(question)}>
            <span>{question}</span>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h11m-4-4 4 4-4 4" /></svg>
          </button>
        ))}
      </div>
    </div>
  )
}

export function AnalyzeLegend(): React.JSX.Element {
  return (
    <div aria-label="Analyze color key" className="analyze-legend" role="list">
      <span className="analyze-legend__control" role="listitem"><i aria-hidden="true" />Controls</span>
      <span className="analyze-legend__text" role="listitem"><i aria-hidden="true" />Text</span>
      <span className="analyze-legend__link" role="listitem"><i aria-hidden="true" />Links</span>
      <span className="analyze-legend__value" role="listitem"><i aria-hidden="true" />Values</span>
      <span className="analyze-legend__face" role="listitem"><i aria-hidden="true" />Faces</span>
      <span className="analyze-legend__visual" role="listitem"><i aria-hidden="true" />Visuals</span>
      <span className="analyze-legend__error" role="listitem"><i aria-hidden="true" />Issues</span>
    </div>
  )
}

export function questionsForFeature(feature: Pick<CaptureFeature, 'kind' | 'label'>): string[] {
  if (feature.kind === 'error') return ['Explain this error', 'How do I fix this?', 'What caused this?', 'What should I try first?']
  if (feature.kind === 'link') return ['What is this link for?', 'Is this link safe?', 'Summarise where this leads', 'Should I open this?']
  if (feature.kind === 'control') return ['What does this control do?', 'Should I use this?', 'What happens if I click it?', 'What should I do next?']
  if (feature.kind === 'value') return ['What does this value mean?', 'Is this value unusual?', 'Put this value in context', 'Check whether this looks right']
  if (feature.kind === 'face') return ['Who is this person?', 'Where might I know them from?', 'Tell me about this person', 'Find related information']
  if (feature.kind === 'visual') return ['Identify this', 'Explain what this does', 'Is anything wrong here?', 'What should I do next?']
  return ['Explain this', 'Summarise this', 'Why is this important?', 'What should I do next?']
}

export function webQuestionForFeature(feature: Pick<CaptureFeature, 'kind' | 'label'>): string {
  const label = displayFeatureLabel(feature)
  if (feature.kind === 'error') return `Search for this error and explain the most likely fix: ${label}`
  if (feature.kind === 'link') return `Identify and verify this link: ${label}`
  if (feature.kind === 'control') return `Identify this interface control and explain what it does: ${label}`
  if (feature.kind === 'value') return `Verify and put this visible value in context: ${label}`
  if (feature.kind === 'text') return `Find relevant current context for this visible text: ${label}`
  if (feature.kind === 'face') return 'Search the web to identify this person from the visible face. Explain the evidence and uncertainty, and do not guess when the match is weak.'
  return 'Identify this visible feature and explain what it is used for'
}

export function displayFeatureLabel(feature: Pick<CaptureFeature, 'kind' | 'label'>): string {
  const label = typeof feature.label === 'string' ? feature.label.replace(/\s+/g, ' ').trim() : ''
  if (label && !/^(?:undefined|null|none|unknown|n\/a)$/i.test(label)) return label
  return feature.kind === 'control' ? 'Unlabelled button' : feature.kind === 'face' ? 'Face' : 'Unlabelled feature'
}

function featureKindLabel(feature: CaptureFeature): string {
  if (feature.role) return feature.role.replace(/^\p{L}/u, (character) => character.toLocaleUpperCase())
  return ({ text: 'Text', control: 'Control', link: 'Link', error: 'Issue', value: 'Value', visual: 'Feature', face: 'Face' })[feature.kind]
}

function featureStyle(feature: CaptureFeature, selected = false): CSSProperties {
  return {
    left: `${feature.bounds.x * 100}%`,
    top: `${feature.bounds.y * 100}%`,
    width: `${feature.bounds.width * 100}%`,
    height: `${feature.bounds.height * 100}%`,
    zIndex: (selected ? 10_000 : 0) + Math.round(featureHitPriority(feature) * 10)
  }
}

export function featuresAtPoint(features: CaptureFeature[], point: Point): CaptureFeature[] {
  return features
    .filter(({ bounds }) =>
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    )
    .sort((left, right) =>
      featureHitPriority(right) - featureHitPriority(left) ||
      left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height
    )
}

function featureHitPriority(feature: CaptureFeature): number {
  return (feature.rank ?? 0) - feature.bounds.width * feature.bounds.height * 160
}

function analysisProgressFeedback(analysis: CaptureAnalysis): string {
  if (analysis.stage === 'semantic') {
    return 'Reading visible text from the frozen screen…'
  }
  if (analysis.stage === 'text') {
    return analysis.features.length
      ? `Found ${analysis.features.length} visible text targets · removing duplicates…`
      : 'No confident text targets found yet…'
  }
  return `Found ${analysis.features.length} visible targets`
}

function featureMenuStyle(feature: CaptureFeature, context: CaptureContext): CSSProperties {
  const menuWidth = Math.min(300, context.width - 24)
  const x = feature.bounds.x * context.width
  const y = feature.bounds.y * context.height
  const bottom = (feature.bounds.y + feature.bounds.height) * context.height
  const left = Math.max(12, Math.min(context.width - menuWidth - 12, x))
  const placeAbove = bottom + 300 > context.height && y > 300
  return {
    left,
    top: placeAbove ? Math.max(12, y - 8) : Math.min(context.height - 12, bottom + 8),
    width: menuWidth,
    transform: placeAbove ? 'translateY(-100%)' : undefined
  }
}

export function captureRectangleForFeature(feature: CaptureFeature, context: Pick<CaptureContext, 'width' | 'height' | 'minSelectionSize'>): Rectangle {
  const minimum = context.minSelectionSize
  const rawWidth = feature.bounds.width * context.width
  const rawHeight = feature.bounds.height * context.height
  const width = Math.min(context.width, Math.max(minimum, rawWidth))
  const height = Math.min(context.height, Math.max(minimum, rawHeight))
  const centerX = (feature.bounds.x + feature.bounds.width / 2) * context.width
  const centerY = (feature.bounds.y + feature.bounds.height / 2) * context.height
  return {
    x: Math.max(0, Math.min(context.width - width, centerX - width / 2)),
    y: Math.max(0, Math.min(context.height - height, centerY - height / 2)),
    width,
    height
  }
}
function pointer(event: ReactPointerEvent): Point { return { x: event.clientX, y: event.clientY } }
export async function holdLiveSurfaceForAnalyze(
  capture: {
    captureVideoFrame(rectangle?: Rectangle): Promise<boolean>
    freeze(reason: CaptureFreezeReason): Promise<FrozenCaptureContext>
  },
  isCurrent: () => boolean
): Promise<FrozenCaptureContext | null> {
  await capture.captureVideoFrame().catch(() => false)
  if (!isCurrent()) return null
  return capture.freeze('analyze')
}
/**
 * `loading` keeps the controls hidden and the overlay inert until a surface is ready. A context
 * that failed never gets a surface, so it must not reuse that class: the capture bar is the only
 * thing that renders the error, its title, and Retry, and an inert overlay also swallows the
 * right-click cancel.
 */
export function overlaySurfaceClass(context: CaptureContext | null, captureError: AppError | null): string {
  if (context) return context.surface
  return captureError ? 'failed' : 'loading'
}

function surfaceFeedback(context: CaptureContext): string {
  return context.surface === 'live'
    ? 'Screen stays live until you release'
    : 'Select any part of the frozen screen'
}
function waitForRenderedFrame(): Promise<void> {
  // paintWhenInitiallyHidden keeps this renderer active before the native window is
  // shown. The second callback runs after Chromium had a frame opportunity to paint
  // the decoded image scheduled by the first callback.
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
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
