# DeepScout Architecture

## DeepScout Analysis Tier & Statistical Modeling Contracts

DeepScout separates chess evaluation and rating estimation into three distinct operational tiers to balance interactive precision with database-scale throughput:

### 1. Tier 1 (Direct UCI Compute)
* **Scope**: Interactive, single-game depth-20 Stockfish analysis (`ResponsiveChessboard.tsx`, `/api/v1/engine/evaluate`, `/api/v1/engine/variations`).
* **Contract**: Executes live UCI engine evaluation per position for interactive move-by-move inspection, Kibitzer Multi-PV variations, and Tutor reinforcement flags.

### 2. Tier 2 (Telemetry Conversion)
* **Scope**: Converts real engine centipawn evaluations (ACPL) into UX performance ratings (`src/lib/performanceElo.ts`, Companion Telemetry adjudication).
* **Contract**: Uses the Kimi empirical curve:
  ```
  Elo = 3100 * exp(-0.01 * ACPL)
  ```
  clamped to `[600, 3200]`.

### 3. Tier 3 (Batch Database Heuristics)
* **Scope**: Fast statistical approximation for bulk database ingestion and mass analysis pipelines (`core/features/database/mass_analysis_service.py`).
* **Contract**: Uses deterministic statistical heuristics derived from game metadata and player Elo ratings to prevent SQLite WAL locks and CPU starvation on multi-thousand game files.

> **Explicit Directive for Future Agents**: Do **NOT** replace Tier 2 or Tier 3 mathematical formulas with blocking UCI subprocess loops.

---

## Parallel Analysis & Hardware CPU Guardrail Contracts

### 1. Safe Hardware Ceiling
All parallel UCI analysis pipelines must compute a runtime hardware ceiling to reserve headroom for the OS, Tauri UI webview, and SQLite WAL I/O:
```python
safe_ceiling = max(1, (os.cpu_count() or 4) - 2)
```
* **Auto (Hardware Safe) Mode:** Defaults active parallel compute to `<= safe_ceiling` logical threads (`worker_count * threads_per_worker <= safe_ceiling`), capped cleanly to prevent desktop stalls.
* **GPU / Neural Engine Guardrail (`Lc0`, `Maia`):** Engines backed by GPU/BLAS neural networks automatically cap at `worker_count = 1` so multiple processes never contend for VRAM or BLAS thread pools.
* **Manual Override:** Advanced users may override `Workers` and `Threads per Worker` intentionally; whenever `Workers * Threads > safe_ceiling`, the UI surfaces a non-blocking warning banner with a one-click **Auto-Balance** action.

### 2. Single-Game vs. Batch Parallelism Strategy
* **Single-Game Analysis (Contiguous Ply Slicing):** Splits a single game's positions (including Ply 0 / `initial_fen`) into contiguous ply blocks dispatched across `W` isolated UCI worker processes (`Threads = 1` per worker, per-worker Hash budgeted from total Hash). Contiguous slicing achieves near-linear core scaling without Lazy SMP synchronization overhead while preserving Transposition Table (Hash) reuse across adjacent moves. All results are reassembled in strict ply order and committed in a single atomic SQLite WAL write.
* **Batch / Multi-Game Analysis (1 Full Game per Worker):** Assigns one complete game per worker rather than slicing individual games, keeping each worker's Hash table warm from move 1 through the endgame with zero chunk-boundary resets.
* **Lifecycle & Resource Guarantees:** Every UCI worker closes inside `try ... finally: engine.quit()`, and every SQLite connection sets `PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;` and closes inside `try ... finally: conn.close()`.
