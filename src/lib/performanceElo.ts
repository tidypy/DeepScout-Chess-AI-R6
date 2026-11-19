/**
 * Performance-Elo estimation from Average Centipawn Loss (ACPL).
 *
 * This is an engine-evaluation based estimate (not the Elo found in PGN headers or app settings):
 *   Elo ≈ 3100 · e^(−0.01 · ACPL), clamped to [400, 3200].
 * Requires a minimum number of analysed moves, otherwise returns undefined.
 */
export const MIN_MOVES_FOR_PERF_ELO = 4;

export function estimatePerformanceElo(acpl: number | undefined | null, analysedMoves = MIN_MOVES_FOR_PERF_ELO): number | undefined {
  if (acpl === undefined || acpl === null || !isFinite(acpl)) return undefined;
  if (analysedMoves < MIN_MOVES_FOR_PERF_ELO) return undefined;
  const elo = 3100 * Math.exp(-0.01 * Math.max(0, acpl));
  return Math.round(Math.max(400, Math.min(3200, elo)));
}
