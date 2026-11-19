import React, { useState, useRef } from "react";
import { MoveAnnotation } from "../../components/chessboard/ResponsiveChessboard";

interface EvalSparklineProps {
  annotations: MoveAnnotation[];
  currentPly: number; // -1 for root FEN, 0..N-1 for played moves
  onSelectPly: (ply: number) => void;
  isLight?: boolean;
}

interface Point {
  ply: number;
  x: number;
  y: number;
  evalCp: number;
  evalStr: string;
  san: string;
}

export function EvalSparkline({
  annotations,
  currentPly,
  onSelectPly,
  isLight = false,
}: EvalSparklineProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  if (!annotations || annotations.length === 0) {
    return null;
  }

  // Check if at least one ply has evaluation data
  const hasAnyEval = annotations.some((a) => a.evalCp !== undefined || a.eval !== undefined);

  // Layout constants
  const svgWidth = 320;
  const svgHeight = 64;
  const padLeft = 28;
  const padRight = 10;
  const padTop = 8;
  const padBottom = 16;
  const chartWidth = svgWidth - padLeft - padRight;
  const chartHeight = svgHeight - padTop - padBottom;
  const baselineY = padTop + chartHeight / 2;

  // Determine dynamic centipawn bounds (clamped between 300 and 1000 cp)
  const maxAbsCp = Math.min(
    1000,
    Math.max(
      300,
      ...annotations.map((a) => Math.abs(a.evalCp ?? 0))
    )
  );

  // Compute points across all plies
  let lastKnownCp = 0;
  const points: Point[] = annotations.map((ann, idx) => {
    let cp = ann.evalCp;
    if (cp === undefined) {
      if (ann.eval && !ann.eval.startsWith("#")) {
        cp = Math.round(parseFloat(ann.eval) * 100);
      } else {
        cp = lastKnownCp;
      }
    } else {
      lastKnownCp = cp;
    }

    const clampedCp = Math.max(-maxAbsCp, Math.min(maxAbsCp, cp));
    // x position distributed across plies
    const x =
      annotations.length > 1
        ? padLeft + (idx / (annotations.length - 1)) * chartWidth
        : padLeft + chartWidth / 2;

    // y position: positive (White winning) maps UP (towards padTop)
    const y = baselineY - (clampedCp / maxAbsCp) * (chartHeight / 2);

    const evalStr =
      ann.eval ||
      (cp >= 0 ? `+${(cp / 100).toFixed(2)}` : `${(cp / 100).toFixed(2)}`);

    return {
      ply: idx,
      x,
      y,
      evalCp: cp,
      evalStr,
      san: ann.san,
    };
  });

  // Calculate mouse hover seek
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (clientX - (padLeft * (rect.width / svgWidth))) / (chartWidth * (rect.width / svgWidth))));
    const targetIdx = Math.round(ratio * (points.length - 1));
    setHoveredIndex(targetIdx);
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
  };

  const handleClick = () => {
    if (hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < points.length) {
      onSelectPly(hoveredIndex);
    }
  };

  // Build SVG path strings
  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Upper polygon for White advantage
  const whiteAreaPath =
    points.length > 0
      ? `M ${points[0].x.toFixed(1)},${baselineY} ` +
        points.map((p) => `L ${p.x.toFixed(1)},${Math.min(baselineY, p.y).toFixed(1)}`).join(" ") +
        ` L ${points[points.length - 1].x.toFixed(1)},${baselineY} Z`
      : "";

  // Lower polygon for Black advantage
  const blackAreaPath =
    points.length > 0
      ? `M ${points[0].x.toFixed(1)},${baselineY} ` +
        points.map((p) => `L ${p.x.toFixed(1)},${Math.max(baselineY, p.y).toFixed(1)}`).join(" ") +
        ` L ${points[points.length - 1].x.toFixed(1)},${baselineY} Z`
      : "";

  const activePoint =
    hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < points.length
      ? points[hoveredIndex]
      : currentPly >= 0 && currentPly < points.length
      ? points[currentPly]
      : null;

  return (
    <div
      className={`rounded-2xl border p-2 relative flex flex-col transition-colors ${
        isLight
          ? "bg-slate-50/90 border-slate-200 text-slate-800"
          : "bg-black/35 border-white/10 text-slate-200"
      }`}
    >
      <div className="flex items-center justify-between px-1 mb-1 text-[10px] font-mono font-bold">
        <span className="flex items-center gap-1.5 opacity-80">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
          <span>Eval Flow</span>
          {hasAnyEval && (
            <span className="opacity-60 text-[9px]">
              (±{(maxAbsCp / 100).toFixed(1)})
            </span>
          )}
        </span>

        {activePoint ? (
          <span className="flex items-center gap-1.5 font-bold">
            <span className="text-[9px] opacity-70">
              Ply {activePoint.ply + 1} ({activePoint.san}):
            </span>
            <span
              className={`font-black ${
                activePoint.evalCp >= 0
                  ? "text-emerald-500 dark:text-emerald-400"
                  : "text-cyan-500 dark:text-cyan-400"
              }`}
            >
              {activePoint.evalStr}
            </span>
          </span>
        ) : (
          <span className="text-[9px] opacity-60">Scrub or click to seek ply</span>
        )}
      </div>

      <div className="relative w-full h-[60px] select-none cursor-crosshair">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          preserveAspectRatio="none"
          className="w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        >
          <defs>
            <linearGradient id="whiteAdvGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.05" />
            </linearGradient>
            <linearGradient id="blackAdvGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.45" />
            </linearGradient>
          </defs>

          {/* 0.00 Baseline Axis */}
          <line
            x1={padLeft}
            y1={baselineY}
            x2={svgWidth - padRight}
            y2={baselineY}
            stroke={isLight ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.2)"}
            strokeDasharray="3 3"
            strokeWidth="1"
          />

          {/* Baseline Label */}
          <text
            x={padLeft - 4}
            y={baselineY + 3}
            textAnchor="end"
            fontSize="8"
            fontFamily="monospace"
            fill={isLight ? "#64748b" : "#94a3b8"}
          >
            0.0
          </text>

          {hasAnyEval ? (
            <>
              {/* White Advantage Fill */}
              <path d={whiteAreaPath} fill="url(#whiteAdvGrad)" />

              {/* Black Advantage Fill */}
              <path d={blackAreaPath} fill="url(#blackAdvGrad)" />

              {/* Curve Stroke */}
              <polyline
                fill="none"
                stroke={isLight ? "#059669" : "#34d399"}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={polylinePoints}
              />

              {/* Current Ply Vertical Marker */}
              {currentPly >= 0 && currentPly < points.length && (
                <g>
                  <line
                    x1={points[currentPly].x}
                    y1={padTop}
                    x2={points[currentPly].x}
                    y2={svgHeight - padBottom}
                    stroke="#10b981"
                    strokeWidth="1.5"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={points[currentPly].x}
                    cy={points[currentPly].y}
                    r="3.5"
                    fill="#10b981"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                </g>
              )}

              {/* Hover Cursor Marker */}
              {hoveredIndex !== null &&
                hoveredIndex >= 0 &&
                hoveredIndex < points.length &&
                hoveredIndex !== currentPly && (
                  <g>
                    <line
                      x1={points[hoveredIndex].x}
                      y1={padTop}
                      x2={points[hoveredIndex].x}
                      y2={svgHeight - padBottom}
                      stroke={isLight ? "#3b82f6" : "#60a5fa"}
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                    <circle
                      cx={points[hoveredIndex].x}
                      cy={points[hoveredIndex].y}
                      r="3"
                      fill={isLight ? "#3b82f6" : "#60a5fa"}
                    />
                  </g>
                )}
            </>
          ) : (
            <text
              x={svgWidth / 2 + 10}
              y={baselineY + 3}
              textAnchor="middle"
              fontSize="9"
              fontFamily="monospace"
              fill={isLight ? "#94a3b8" : "#64748b"}
              fontStyle="italic"
            >
              Awaiting engine evaluation
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
