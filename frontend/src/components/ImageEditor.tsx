import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Circle } from "../api";

export interface EditorCircle extends Circle {
  id: string;
  color: string;
  label?: string;
  /** "move" drags the circle, "resize" only shows the radius handle. */
  edit?: "move" | "resize" | "both" | "none";
  dashed?: boolean;
  fill?: string;
}

interface Props {
  src: string;
  width: number;
  height: number;
  circles: EditorCircle[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (id: string, c: Circle) => void;
  /** When set, clicking on the background calls it with image coordinates. */
  onBackgroundClick?: (x: number, y: number) => void;
  cursor?: string;
}

/** The visible part of the image (the SVG viewBox); it keeps the aspect ratio of the image. */
interface View { x: number; y: number; w: number; h: number }
/** Screen position of the view origin and screen pixels per image pixel, when a gesture starts. */
interface Frame { ox: number; oy: number; s: number; view: View }

type Gesture =
  | { kind: "drag"; pointer: number; id: string; mode: "move" | "resize"; dx: number; dy: number }
  | { kind: "pan"; pointer: number; frame: Frame; ix: number; iy: number; sx: number; sy: number; moved: boolean }
  | { kind: "pinch"; frame: Frame; d0: number; ix: number; iy: number }
  | null;

const MAX_ZOOM = 10;
const TAP_SLOP = 8; // screen pixels a tap may move
const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export default function ImageEditor({
  src, width, height, circles, selectedId, onSelect, onChange, onBackgroundClick, cursor,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const full: View = { x: 0, y: 0, w: width, h: height };
  const [view, setView] = useState<View>(full);
  const gesture = useRef<Gesture>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [dragging, setDragging] = useState(false);
  // Screen pixels per image pixel, to keep strokes, labels and handles at a usable size on screen.
  const [scale, setScale] = useState(1);
  const [touch, setTouch] = useState(coarsePointer);

  useEffect(() => setView({ x: 0, y: 0, w: width, h: height }), [width, height]);

  useLayoutEffect(() => {
    const svg = svgRef.current!;
    const update = () => setScale(svg.getScreenCTM()?.a || 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [view.w]);

  const zoomed = view.w < width - 0.5;
  // Image-pixel sizes: at least these many screen pixels (larger for fingers).
  const px = (screen: number) => screen / scale;
  const unit = Math.max((Math.max(width, height) / 400) * (view.w / width), px(1)); // stroke width
  const handleR = Math.max(unit * 5, px(touch ? 14 : 7));
  const grab = px(touch ? 26 : 8); // distance from a disk border that still grabs it

  // Bring the selected circle into view when zoomed in.
  useEffect(() => {
    const c = circles.find((x) => x.id === selectedId);
    if (!c || !zoomed) return;
    if (c.cx > view.x && c.cx < view.x + view.w && c.cy > view.y && c.cy < view.y + view.h) return;
    setView((v) => clampView({ ...v, x: c.cx - v.w / 2, y: c.cy - v.h / 2 }));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function clampView(v: View): View {
    const w = Math.min(width, Math.max(width / MAX_ZOOM, v.w));
    const h = (w * height) / width;
    return { x: clamp(v.x, 0, width - w), y: clamp(v.y, 0, height - h), w, h };
  }

  function frame(): Frame {
    const m = svgRef.current!.getScreenCTM()!;
    return { ox: m.e + m.a * view.x, oy: m.f + m.d * view.y, s: m.a, view };
  }

  function toImage(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  /** New view where image point (ix, iy) is under screen point (sx, sy), zoomed by `k` from `f`. */
  function viewAt(f: Frame, ix: number, iy: number, sx: number, sy: number, k: number): View {
    const w = clamp(f.view.w / k, width / MAX_ZOOM, width);
    const s = (f.s * f.view.w) / w;
    return clampView({ x: ix - (sx - f.ox) / s, y: iy - (sy - f.oy) / s, w, h: (w * height) / width });
  }

  function zoomBy(k: number, clientX?: number, clientY?: number) {
    const r = svgRef.current!.getBoundingClientRect();
    const sx = clientX ?? r.left + r.width / 2, sy = clientY ?? r.top + r.height / 2;
    const p = toImage(sx, sy);
    setView(viewAt(frame(), p.x, p.y, sx, sy, k));
  }

  /** Among the circles under the pointer or whose border is within `grab` of it, the one
   * with the nearest centre (a disk rather than the zone around it). */
  function hit(x: number, y: number): EditorCircle | null {
    let best: EditorCircle | null = null, bestD = Infinity;
    for (const c of circles) {
      const edit = c.edit ?? "none";
      if (c.dashed || (edit !== "move" && edit !== "both" && !onSelect)) continue;
      const d = Math.hypot(x - c.cx, y - c.cy);
      if (d - c.r > grab) continue;
      if (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && c.r < best!.r)) { best = c; bestD = d; }
    }
    return best;
  }

  function startDrag(e: React.PointerEvent, c: EditorCircle, mode: "move" | "resize") {
    onSelect?.(c.id);
    const edit = c.edit ?? "none";
    if (!onChange || (mode === "move" && edit !== "move" && edit !== "both")) return;
    const p = toImage(e.clientX, e.clientY);
    gesture.current = { kind: "drag", pointer: e.pointerId, id: c.id, mode, dx: p.x - c.cx, dy: p.y - c.cy };
    setDragging(true);
  }

  function down(e: React.PointerEvent) {
    setTouch(e.pointerType === "touch" || (e.pointerType !== "mouse" && coarsePointer()));
    try { svgRef.current!.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // Second finger: pinch to zoom (cancels a drag that has just started).
      const [a, b] = [...pointers.current.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, p = toImage(mx, my);
      gesture.current = { kind: "pinch", frame: frame(), d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, ix: p.x, iy: p.y };
      setDragging(false);
      return;
    }
    if (pointers.current.size > 2) return;
    const handle = (e.target as Element).getAttribute("data-handle");
    const c = handle ? circles.find((x) => x.id === handle) : null;
    if (c) return startDrag(e, c, "resize");
    const p = toImage(e.clientX, e.clientY);
    const near = onBackgroundClick ? null : hit(p.x, p.y);
    if (near) return startDrag(e, near, "move");
    gesture.current = { kind: "pan", pointer: e.pointerId, frame: frame(), ix: p.x, iy: p.y, sx: e.clientX, sy: e.clientY, moved: false };
  }

  function move(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setView(viewAt(g.frame, g.ix, g.iy, (a.x + b.x) / 2, (a.y + b.y) / 2, d / g.d0));
    } else if (g.kind === "pan" && g.pointer === e.pointerId) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > TAP_SLOP) g.moved = true;
      if (g.moved && zoomed) setView(viewAt(g.frame, g.ix, g.iy, e.clientX, e.clientY, 1));
    } else if (g.kind === "drag" && g.pointer === e.pointerId && onChange) {
      const c = circles.find((x) => x.id === g.id);
      if (!c) return;
      const p = toImage(e.clientX, e.clientY);
      if (g.mode === "move") {
        onChange(c.id, { cx: clamp(p.x - g.dx, 0, width), cy: clamp(p.y - g.dy, 0, height), r: c.r });
      } else {
        onChange(c.id, { cx: c.cx, cy: c.cy, r: Math.max(3, Math.hypot(p.x - c.cx, p.y - c.cy)) });
      }
    }
  }

  function up(e: React.PointerEvent) {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === "pan" && g.pointer === e.pointerId && !g.moved && e.type === "pointerup") {
      if (onBackgroundClick) onBackgroundClick(g.ix, g.iy);
      else onSelect?.(null);
    }
    // After a pinch, the remaining finger does nothing until it is lifted.
    if (g?.kind === "pinch" || (g && "pointer" in g && g.pointer === e.pointerId)) {
      gesture.current = null;
      setDragging(false);
    }
  }

  function wheel(e: React.WheelEvent) {
    // Trackpad pinch (reported as ctrl + wheel) or ctrl/⌘ + wheel zooms; plain wheel scrolls the page.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
  }

  // React registers wheel listeners as passive: preventDefault needs a native listener.
  const wheelRef = useRef(wheel);
  wheelRef.current = wheel;
  useEffect(() => {
    const svg = svgRef.current!;
    const fn = (e: WheelEvent) => wheelRef.current(e as unknown as React.WheelEvent);
    svg.addEventListener("wheel", fn, { passive: false });
    return () => svg.removeEventListener("wheel", fn);
  }, []);

  const fontSize = Math.max(unit * 9, px(12));

  return (
    <div className="editor">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{ cursor: dragging ? "grabbing" : cursor ?? (zoomed ? "grab" : "default"), touchAction: "none" }}
      >
        <image href={src} x={0} y={0} width={width} height={height} />
        {circles.map((c) => {
          const selected = c.id === selectedId;
          const edit = c.edit ?? "none";
          const canMove = edit === "move" || edit === "both";
          const canResize = edit === "resize" || edit === "both";
          return (
            <g key={c.id}>
              <circle
                cx={c.cx} cy={c.cy} r={c.r}
                fill={c.fill ?? (canMove ? "rgba(255,255,255,0.01)" : "none")}
                stroke={c.color}
                strokeWidth={unit * (selected ? 2.2 : 1.3)}
                strokeDasharray={c.dashed ? `${unit * 4} ${unit * 3}` : undefined}
                style={{ cursor: canMove ? "move" : "pointer", pointerEvents: "none" }}
              />
              {c.label && (
                <text
                  x={c.cx} y={c.cy - c.r - fontSize * 0.3} textAnchor="middle" fontSize={fontSize} fontWeight={700}
                  fill="#fff" stroke="#000" strokeWidth={fontSize / 6} paintOrder="stroke"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {c.label}
                </text>
              )}
              {canResize && (selected || edit === "resize") && (
                <>
                  <circle
                    cx={c.cx + c.r} cy={c.cy} r={handleR} fill={c.color} stroke="#fff" strokeWidth={unit}
                    style={{ pointerEvents: "none" }}
                  />
                  {/* Invisible, larger target for the handle. */}
                  <circle data-handle={c.id} cx={c.cx + c.r} cy={c.cy} r={handleR + px(touch ? 10 : 3)} fill="transparent" style={{ cursor: "ew-resize" }} />
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="zoom-buttons">
        <button type="button" aria-label="Zoom in" title="Zoom in (or pinch / ctrl + wheel)" onClick={() => zoomBy(1.6)}>+</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.6)} disabled={!zoomed}>−</button>
        <button type="button" aria-label="Fit the whole image" title="Whole image" onClick={() => setView(full)} disabled={!zoomed}>⤢</button>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
