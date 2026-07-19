import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import type { ProviderEvent } from '@shared/types/provider'
import { Button, StatusBanner, TextArea, WindowControls } from '../design-system'
import '../design-system/index.css'
import './question.css'

interface Exchange { question: string; answer: string }
const PRESETS = ['Explain this', 'What is wrong here?', 'What should I do next?', 'Extract the text']

function QuestionApp(): React.JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(location.search).get('session') ?? '', [])
  const [thumbnail, setThumbnail] = useState('')
  const [text, setText] = useState('')
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.snipchat.question.get(sessionId).then((state) => { setThumbnail(state.thumbnailDataUrl); setBusy(state.busy) }).catch((reason) => setError(message(reason)))
    return window.snipchat.question.onEvent((eventSessionId, event) => {
      if (eventSessionId !== sessionId) return
      consume(event)
    })
  }, [sessionId])

  useEffect(() => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior })
  }, [exchanges])

  const consume = (event: ProviderEvent): void => {
    if (event.type === 'started') setBusy(true)
    if (event.type === 'delta') setExchanges((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, answer: entry.answer + event.text } : entry))
    if (event.type === 'completed' || event.type === 'cancelled') setBusy(false)
    if (event.type === 'error') { setBusy(false); setError(event.message) }
  }

  const send = async (override?: string): Promise<void> => {
    const question = (override ?? text).trim()
    if (!question || busy) return
    setError('')
    setText('')
    setBusy(true)
    setExchanges((current) => [...current, { question, answer: '' }])
    try {
      await window.snipchat.question.send(sessionId, question)
    } catch (reason) {
      setBusy(false)
      setError(message(reason))
    }
  }

  const latestAnswer = exchanges.at(-1)?.answer ?? ''
  const hasSent = exchanges.length > 0

  return (
    <main className="panel">
      <header className="titlebar">
        <strong>SnipChat</strong>
        <WindowControls closeLabel="Close" onClose={() => void window.snipchat.question.close(sessionId)} />
      </header>
      <div className="content" ref={scrollRef}>
        {thumbnail && <img className={`thumbnail ${hasSent ? 'compact' : ''}`} src={thumbnail} alt="Selected screenshot" />}

        {!hasSent && <>
          <div className="presets">{PRESETS.map((preset) => <Button className="preset-button" key={preset} size="compact" variant="secondary" onClick={() => void send(preset)}>{preset}</Button>)}</div>
          <Composer text={text} setText={setText} send={send} busy={busy} autoFocus />
          <div className="initial-actions"><Button variant="secondary" onClick={() => void window.snipchat.question.close(sessionId)}>Cancel</Button><Button disabled={!text.trim() || busy} onClick={() => void send()}>Send</Button></div>
        </>}

        {hasSent && <div className="transcript">{exchanges.map((exchange, index) => <article key={index}><div className="question">{exchange.question}</div><div className="answer">{exchange.answer ? <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void window.snipchat.openExternal(href) }}>{children}</a> }}>{exchange.answer}</ReactMarkdown> : <span className="thinking">Thinking…</span>}</div></article>)}</div>}
        {error ? <StatusBanner role="alert" tone="error">{error}</StatusBanner> : null}
      </div>

      {hasSent && <footer className="response-footer">
        <Composer text={text} setText={setText} send={send} busy={busy} />
        <div className="toolbar">
          <Button size="compact" variant="secondary" onClick={() => void window.snipchat.question.newSnip(sessionId)}>New snip</Button>
          {busy ? <Button size="compact" variant="danger" onClick={() => void window.snipchat.question.stop(sessionId)}>Stop</Button> : <Button size="compact" disabled={!text.trim()} onClick={() => void send()}>Send</Button>}
          <span className="spacer" />
          <Button size="compact" variant="secondary" disabled={!latestAnswer} onClick={() => void navigator.clipboard.writeText(latestAnswer)}>Copy</Button>
          <Button size="compact" variant="secondary" onClick={() => void window.snipchat.question.close(sessionId)}>Close</Button>
        </div>
      </footer>}
    </main>
  )
}

function Composer({ text, setText, send, busy, autoFocus = false }: { text: string; setText(value: string): void; send(): Promise<void>; busy: boolean; autoFocus?: boolean }): React.JSX.Element {
  return <TextArea label={<span className="fui-sr-only">Question</span>} className="composer" resize="none" rows={3} value={text} disabled={busy} autoFocus={autoFocus} placeholder={busy ? 'Waiting for the answer…' : 'Ask about this screenshot…'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }

createRoot(document.getElementById('root')!).render(<QuestionApp />)
