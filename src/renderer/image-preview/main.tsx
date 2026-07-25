import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppError } from '@shared/types/app-error'
import { initialiseAppearance } from '../appearance'
import { appErrorFromUnknown } from '../status/status-presentation'
import '../design-system/index.css'
import './preview.css'

function ImagePreview(): React.JSX.Element {
  const parameters = useMemo(() => new URLSearchParams(location.search), [])
  const sessionId = parameters.get('session') ?? ''
  const attachmentId = parameters.get('attachment') ?? ''
  const [image, setImage] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    void initialiseAppearance()
    void window.fovea.question.getFullImage(sessionId, attachmentId).then(setImage).catch((reason) => setError(appErrorFromUnknown(reason)))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void window.fovea.question.setPreviewOpen(sessionId, null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [attachmentId, sessionId])

  const close = (): void => { void window.fovea.question.setPreviewOpen(sessionId, null) }

  return (
    <main
      aria-busy={!image && !error}
      aria-label="Full-quality screenshot preview"
      className="image-preview"
      onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}
      role="dialog"
    >
      {image ? <img alt="Full-quality selected screenshot" className="image-preview__image" draggable={false} src={image} /> : null}
      {error ? <div className="image-preview__error" role="alert"><strong>{error.title}</strong><span>{error.message}</span></div> : null}
      <span className="image-preview__instructions">Press Escape or click outside the image to close.</span>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<ImagePreview />)
