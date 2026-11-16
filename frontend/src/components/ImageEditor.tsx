import { useRef, useState } from "react";
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

type Drag = { id: string; mode: "move" | "resize"; dx: number; dy: number } | null;

export default function ImageEditor({
  src, width, height, circles, selectedId, onSelect, onChange, onBackgroundClick, cursor,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const unit = Math.max(width, height) / 400; // stroke width in image pixels

  function toImage(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  function start(e: React.PointerEvent, c: EditorCircle, mode: "move" | "resize") {
    e.stopPropagation();
    onSelect?.(c.id);
    if (!onChange) return;
    const p = toImage(e);
    svgRef.current!.setPointerCapture(e.pointerId);
    setDrag({ id: c.id, mode, dx: p.x - c.cx, dy: p.y - c.cy });
  }

  function move(e: React.PointerEvent) {
    if (!drag || !onChange) return;
    const c = circles.find((x) => x.id === drag.id);
    if (!c) return;
    const p = toImage(e);
    if (drag.mode === "move") {
      onChange(c.id, { cx: clamp(p.x - drag.dx, 0, width), cy: clamp(p.y - drag.dy, 0, height), r: c.r });
    } else {
      onChange(c.id, { cx: c.cx, cy: c.cy, r: Math.max(3, Math.hypot(p.x - c.cx, p.y - c.cy)) });
    }
  }

  function end(e: React.PointerEvent) {
    if (drag) svgRef.current!.releasePointerCapture(e.pointerId);
    setDrag(null);
  }

  function background(e: React.PointerEvent) {
    if (onBackgroundClick) {
      const p = toImage(e);
      onBackgroundClick(p.x, p.y);
    } else {
      onSelect?.(null);
    }
  }

  return (
    <div className="editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        style={{ cursor: cursor ?? "default", touchAction: "none" }}
      >
        <image href={src} x={0} y={0} width={width} height={height} onPointerDown={background} />
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
                style={{ cursor: canMove ? "move" : "pointer", pointerEvents: canMove || onSelect ? "auto" : "none" }}
                onPointerDown={(e) => (canMove ? start(e, c, "move") : (e.stopPropagation(), onSelect?.(c.id)))}
              />
              {c.label && (
                <text
                  x={c.cx} y={c.cy - c.r - unit * 3} textAnchor="middle" fontSize={unit * 9} fontWeight={700}
                  fill="#fff" stroke="#000" strokeWidth={unit * 1.6} paintOrder="stroke"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {c.label}
                </text>
              )}
              {canResize && (selected || edit === "resize") && (
                <circle
                  cx={c.cx + c.r} cy={c.cy} r={unit * 5} fill={c.color} stroke="#fff" strokeWidth={unit}
                  style={{ cursor: "ew-resize" }}
                  onPointerDown={(e) => start(e, c, "resize")}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
