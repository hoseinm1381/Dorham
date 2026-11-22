import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Picture, Stroke } from '../../../../packages/contracts/src/games';
import { t } from '../i18n';
import './party-games.css';

const canvasWidth = 1000;
const canvasHeight = 700;
const maxPoints = 1000;
const maxStrokes = 160;
const maxSegment = 100;
const colors = [
  ['#20232b', 'Black'], ['#ffffff', 'Eraser'], ['#e45b63', 'Red'], ['#4a86e8', 'Blue'],
  ['#43a477', 'Green'], ['#ecc64c', 'Yellow'], ['#9a69d5', 'Purple'], ['#e78e48', 'Orange'],
] as const;
type CanvasProps = {
  picture: Picture;
  editable?: boolean;
  onStroke?: (stroke: Stroke) => Promise<boolean>;
  onClear?: () => Promise<boolean>;
  onUndo?: () => Promise<boolean>;
};

function paintLine(canvas: CanvasRenderingContext2D, stroke: Stroke) {
  const [[x, y], ...tail] = stroke.points;
  canvas.strokeStyle = stroke.color;
  canvas.fillStyle = stroke.color;
  canvas.lineWidth = stroke.width;
  canvas.lineCap = 'round';
  canvas.lineJoin = 'round';
  canvas.beginPath();
  if (!tail.length) {
    canvas.arc(x, y * .7, stroke.width / 2, 0, Math.PI * 2);
    canvas.fill();
  } else {
    canvas.moveTo(x, y * .7);
    for (const [left, top] of tail) canvas.lineTo(left, top * .7);
    canvas.stroke();
  }
}

export default function DrawingCanvas({ picture, editable = false, onStroke, onClear, onUndo }: CanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const draft = useRef<{ pointer: number; stroke: Stroke; continued: boolean } | null>(null);
  const pending = useRef(new Map<number, Stroke>());
  const strokeCount = useRef(0);
  const pendingPoints = useRef(0);
  const frame = useRef(0);
  const alive = useRef(true);
  const latest = useRef(picture);
  const [color, setColor] = useState<string>(colors[0][0]);
  const [width, setWidth] = useState(7);
  const [confirmClear, setConfirmClear] = useState(false);
  const [, refresh] = useState(0);
  latest.current = picture;

  function paint() {
    frame.current = 0;
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    for (const stroke of latest.current.strokes) if (stroke.points.length) paintLine(context, stroke);
    for (const stroke of pending.current.values()) paintLine(context, stroke);
    if (draft.current) paintLine(context, draft.current.stroke);
  }
  function queuePaint() {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancelAnimationFrame(frame.current); frame.current = 0; };
  }, []);
  useEffect(queuePaint, [picture]);
  useEffect(() => {
    if (editable) return;
    const target = canvas.current;
    const pointer = draft.current?.pointer;
    draft.current = null;
    if (pointer !== undefined && target?.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
    setConfirmClear(false);
    queuePaint();
  }, [editable]);

  function submitStroke(stroke: Stroke) {
    if (!onStroke) return;
    const id = strokeCount.current++;
    pending.current.set(id, stroke);
    pendingPoints.current += stroke.points.length;
    refresh(number => number + 1);
    void onStroke(stroke).finally(() => {
      pending.current.delete(id);
      pendingPoints.current -= stroke.points.length;
      if (alive.current) {
        queuePaint();
        refresh(number => number + 1);
      }
    }).catch(() => { /* The room displays command errors. */ });
  }
  function finish(target: HTMLCanvasElement, pointer: number) {
    const current = draft.current;
    if (!current || current.pointer !== pointer) return;
    draft.current = null;
    if (!current.continued || current.stroke.points.length > 1) submitStroke(current.stroke);
    if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
    queuePaint();
  }
  function toPoint(x: number, y: number, bounds: DOMRect): [number, number] {
    return [
      Math.max(0, Math.min(1000, Math.round((x - bounds.left) / bounds.width * 1000))),
      Math.max(0, Math.min(1000, Math.round((y - bounds.top) / bounds.height * 1000))),
    ];
  }
  function usedPoints() {
    return latest.current.points + pendingPoints.current;
  }
  function usedStrokes() {
    return latest.current.strokes.length + pending.current.size;
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    const current = draft.current;
    if (!editable || !current || current.pointer !== event.pointerId) return;
    const box = event.currentTarget.getBoundingClientRect();
    const coalesced = event.nativeEvent.getCoalescedEvents?.();
    for (const sample of coalesced?.length ? coalesced : [event]) {
      const point = toPoint(sample.clientX, sample.clientY, box);
      const latest = current.stroke.points.at(-1)!;
      if (Math.abs(point[0] - latest[0]) + Math.abs(point[1] - latest[1]) < 4) continue;
      if (usedPoints() + current.stroke.points.length >= maxPoints || usedStrokes() >= maxStrokes) {
        finish(event.currentTarget, event.pointerId);
        return;
      }
      current.stroke.points.push(point);
      if (current.stroke.points.length === maxSegment) {
        submitStroke(current.stroke);
        current.stroke = { color: current.stroke.color, width: current.stroke.width, points: [point] };
        current.continued = true;
      }
    }
    queuePaint();
  }
  const full = usedPoints() >= maxPoints || usedStrokes() >= maxStrokes;
  const toolBusy = pending.current.size > 0;
  const ink = Math.max(0, Math.floor((1 - Math.max(usedPoints() / maxPoints, usedStrokes() / maxStrokes)) * 100));

  return <div className={`drawing-surface party-canvas ${editable ? 'editable' : ''}`}>
    <canvas ref={canvas} width={canvasWidth} height={canvasHeight}
      aria-label={t(editable ? 'Drawing canvas' : 'Drawing')}
      onPointerDown={event => {
        if (!editable || draft.current || !event.isPrimary || event.button !== 0 || full) return;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const point = toPoint(event.clientX, event.clientY, target.getBoundingClientRect());
        draft.current = { pointer: event.pointerId, stroke: { color, width, points: [point] }, continued: false };
        queuePaint();
      }}
      onPointerMove={move}
      onPointerUp={event => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={event => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={event => finish(event.currentTarget, event.pointerId)}/>
    {editable && <div className="drawing-tools">
      <div className="drawing-palette" role="group" aria-label={t('Ink color')}>
        {colors.map(([paint, name]) => <button type="button" key={paint} className={name === 'Eraser' ? 'eraser' : ''}
          aria-label={name === 'Eraser' ? t(name) : t('Ink {color}', { color: t(name) })}
          title={name === 'Eraser' ? t(name) : t('Ink {color}', { color: t(name) })}
          aria-pressed={color === paint} style={{ background: paint }} onClick={() => setColor(paint)}>
          {name === 'Eraser' && <span aria-hidden="true">▱</span>}
        </button>)}
      </div>
      <label>{t('Brush size')}
        <select aria-label={t('Brush size')} value={width} onChange={event => setWidth(Number(event.target.value))}>
          <option value={3}>{t('Fine')}</option><option value={7}>{t('Medium')}</option><option value={14}>{t('Thick')}</option>
        </select>
      </label>
      <div className="drawing-edit-actions">
        <button type="button" className="secondary" disabled={!onUndo || !picture.strokes.length || toolBusy}
          onClick={() => { void onUndo?.(); }}>{t('Undo')}</button>
        <button type="button" className="secondary" disabled={!onClear || !picture.strokes.length || toolBusy}
          onClick={() => setConfirmClear(true)}>{t('Clear drawing')}</button>
      </div>
      {confirmClear && <div className="drawing-confirm" role="group" aria-label={t('Clear this drawing?')}>
        <span>{t('Clear this drawing?')}</span>
        <button type="button" className="primary" disabled={toolBusy} onClick={() => {
          setConfirmClear(false);
          void onClear?.();
        }}>{t('Clear drawing')}</button>
        <button type="button" className="secondary" onClick={() => setConfirmClear(false)}>{t('Cancel')}</button>
      </div>}
      <label className="drawing-ink">{t('Ink remaining')}
        <meter min={0} max={100} value={ink}/><span>{ink}%</span>
      </label>
      {full && <p role="status">{t('Drawing full. Undo, clear, or submit your drawing.')}</p>}
    </div>}
  </div>;
}
