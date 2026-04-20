"use client";

import { useEffect, useRef, useState } from "react";

/** Minimal type — compatible with both DiffLine and DiffLineLocal */
type MinimapLine = { type: "added" | "removed" | "context" };

/** Bird's-eye overview of a diff with a draggable viewport indicator. */
export function DiffMinimap({
  lines,
  scrollRef,
}: {
  lines: MinimapLine[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const [vp, setVp]  = useState({ top: 0, height: 1 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function update() {
      const { scrollHeight, clientHeight, scrollTop } = el!;
      setVp({
        top:    scrollTop / Math.max(1, scrollHeight),
        height: clientHeight / Math.max(1, scrollHeight),
      });
    }
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [scrollRef]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;
    function draw() {
      const w = container!.clientWidth;
      const h = container!.clientHeight;
      if (w === 0 || h === 0) return;
      canvas!.width  = w;
      canvas!.height = h;
      const ctx = canvas!.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      const lineH = h / Math.max(1, lines.length);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].type;
        ctx.fillStyle =
          t === "added"   ? "rgba(52,211,153,0.85)" :
          t === "removed" ? "rgba(248,113,113,0.85)" :
                            "rgba(100,116,139,0.15)";
        ctx.fillRect(2, i * lineH, w - 4, Math.max(0.5, lineH));
      }
    }
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [lines]);

  function seek(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return;
    const el        = scrollRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const rect  = container.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    el.scrollTop = ratio * el.scrollHeight - el.clientHeight / 2;
  }

  return (
    <div
      ref={containerRef}
      className="relative shrink-0 w-14 bg-slate-950 border-l border-slate-800 cursor-pointer select-none overflow-hidden"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
      onPointerMove={seek}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div
        className="absolute inset-x-0 bg-slate-300/10 border-y border-slate-400/25 pointer-events-none"
        style={{ top: `${vp.top * 100}%`, height: `${vp.height * 100}%` }}
      />
    </div>
  );
}
