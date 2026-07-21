import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Point, Rectangle } from '@shared/types/geometry'
import { Button } from '../design-system'
import { initialiseAppearance } from '../appearance'
import '../design-system/index.css'
import './overlay.css'

type OverlayPhase = 'idle' | 'selecting' | 'invalid' | 'submitting'
function normalize(start: Point, end: Point): Rectangle { return { x: Math.min(start.x,end.x), y: Math.min(start.y,end.y), width: Math.abs(end.x-start.x), height: Math.abs(end.y-start.y) } }

function Overlay(): React.JSX.Element {
  const [start,setStart]=useState<Point|null>(null); const [current,setCurrent]=useState<Point>({x:innerWidth/2,y:innerHeight/2}); const [phase,setPhase]=useState<OverlayPhase>('idle'); const [feedback,setFeedback]=useState('Drag to select an area · Esc or right-click to cancel'); const root=useRef<HTMLDivElement>(null)
  const rectangle=start?normalize(start,current):null
  useEffect(()=>{void initialiseAppearance(); void window.fovea.capture.getContext().catch((reason)=>setFeedback(message(reason))); const onKey=(event:KeyboardEvent):void=>{if(event.key==='Escape')void window.fovea.capture.cancel()};addEventListener('keydown',onKey);root.current?.focus();return()=>removeEventListener('keydown',onKey)},[])
  const point=(event:React.PointerEvent):Point=>({x:event.clientX,y:event.clientY})
  const complete=async(end:Point):Promise<void>=>{if(!start)return;const next=normalize(start,end);if(next.width<24||next.height<24){setPhase('invalid');setFeedback('Too small — select at least 24 × 24');setStart(null);return}setPhase('submitting');setFeedback('Opening question…');try{await window.fovea.capture.select(next)}catch(reason){setPhase('invalid');setFeedback(message(reason));setStart(null)}}
  return <div ref={root} tabIndex={-1} className={`overlay ${phase}`} onPointerDown={(event)=>{if(event.button!==0||phase==='submitting')return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const p=point(event);setStart(p);setCurrent(p);setPhase('selecting');setFeedback('Release to capture')}} onPointerMove={(event)=>setCurrent(point(event))} onPointerUp={(event)=>{if(start){if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);void complete(point(event))}}} onPointerCancel={()=>{setStart(null);setPhase('idle');setFeedback('Selection cancelled. Drag to try again.')}} onContextMenu={(event)=>{event.preventDefault();void window.fovea.capture.cancel()}}>
    {phase!=='submitting'&&<><div className="crosshair horizontal" style={{top:current.y}}/><div className="crosshair vertical" style={{left:current.x}}/></>}
    {!rectangle&&<div className={`hint ${phase==='invalid'?'error':''}`}>{feedback}</div>}
    <Button className="cancel" variant="secondary" disabled={phase==='submitting'} onPointerDown={(event)=>event.stopPropagation()} onClick={()=>void window.fovea.capture.cancel()}>Cancel · Esc</Button>
    {rectangle&&<div className="selection" style={{left:rectangle.x,top:rectangle.y,width:rectangle.width,height:rectangle.height}}>{['nw','n','ne','e','se','s','sw','w'].map((handle)=><i key={handle} className={`handle ${handle}`}/>)}<span className={rectangle.y<44?'below':'above'}>{Math.round(rectangle.width)} × {Math.round(rectangle.height)}</span></div>}
    {phase==='submitting'&&<div className="submitting-label">Opening question…</div>}
  </div>
}
function message(reason:unknown):string{return reason instanceof Error?reason.message:String(reason)}
createRoot(document.getElementById('root')!).render(<Overlay/>)
