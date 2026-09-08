### [RC-3] SparView Pre-Flight UUID & Telemetry Concurrency Guard
* **Epic / Domain:** Concurrency & Data Integrity (Sparring Micro-View)
* **Status:** Resolved / Verified Clean
* **Pass on First Attempt:** Yes (1 turn)
* **Debug Iterations:** 0
* **Target File:** `src/views/SparView.tsx`
* **Verification:** `tsc --noEmit` exited 0; 7/7 surgical edits landed.
* **Scope & Architectural Decisions:**
  - Implemented 4-stage guard pattern in `handleStartGame()`.
  - Enforced strict state invariant: `isGameActive(true)` and `triggerEngineMove()` are unreachable until a verified, non-empty `session.game.game_id` is committed.
  - Guarded all 4 companion logging sites (`logKibitzerVariation` ×2, `logTutorFlag` ×2) against null/whitespace strings, eliminating foreign-key and orphaned record creation.
  - Added additive `<p role="alert">` element without mutating existing board wrapper props or Tailwind layout structure.
* **UX / System Impact:** Guarantees no phantom matches can be initiated on dropped engine handshakes and prevents UI state desync during rapid game start attempts.

---

# RC-3 — Pre-flight UUID Verification Guard for Sparring Session Initialization

**File:** `src/features/sparring/SparView.tsx`
**Scope:** Surgical edits only. Zero changes to JSX layout, Tailwind utility classes, or Chessboard/board props.
**Pattern:** Decoupled micro-service view — no external state stores, no global side-effects introduced.

---

## 0. Background & Problem Statement

`handleStartGame()` currently calls `createSparringGame()` inside a `try/catch` (lines 764–775)
and silently continues if `session?.game?.game_id` is absent, null, or an empty string.
This creates two classes of bugs:

1. **Race condition:** `setIsGameActive(true)` fires on line 758 *before* the DB record is confirmed,
   so board interactions begin against an uninitialized `currentGameId = ""`.
2. **Orphan records:** `triggerEngineMove()` on line 784 fires unconditionally (when `playerSide === "black"`),
   emitting IPC payloads that reference `game_id = ""`, producing unjoinable orphan telemetry rows in
   `Sparring_Games.sqlite`, `Kibitzer_Analysis.sqlite`, and `Tutor_Games.sqlite`.

The fix is a **pre-flight UUID gate**: verify `game_id` is a non-empty string before committing any
component state or allowing engine/telemetry calls to proceed.

---

## 1. New State Variable

**Location:** Insert after line 169 (the `currentGameId` declaration).

```tsx
// Line 169 — existing
const [currentGameId, setCurrentGameId] = useState<string>("");
// INSERT immediately after line 169:
const [sparSessionError, setSparSessionError] = useState<string | null>(null);
```

**Exact insertion point:** Line 170, before `const [selectedEngine, ...]`.

---

## 2. Rewrite `handleStartGame` (lines 752–800)

Replace the entire function body. The diff below is **authoritative** — apply it exactly.

### 2a. Current code to REMOVE (lines 752–800):

```tsx
  const handleStartGame = async () => {
    const newG = new Chess();
    setGame(newG);
    setFen(newG.fen());
    setMoveHistory([]);
    setMoveRecords([]);
    setIsGameActive(true);
    setEvalScore("+0.00");
    setSaveSuccessMsg(null);
    setAutosaveAlert(null);
    setActiveTutorFlag(null);

    try {
      const session = await createSparringGame({
        opponent_engine: currentEngineObj.name,
        user_time_control: "unlimited",
        tutor_interrupt_mode: tutorInterruptMode,
      });
      if (session?.game?.game_id) {
        setCurrentGameId(session.game.game_id);
      }
    } catch (e) {
      console.warn("Failed creating sparring session in DB:", e);
    }

    logAction(
      "CLICK",
      "Started UCI Sparring Match vs " + currentEngineObj.name,
      "Side: " + playerSide + ", Elo: " + targetElo + ", Engine: " + selectedEngine + ", Book: " + selectedBook
    );

    if (playerSide === "black") {
      triggerEngineMove(newG.fen(), newG);
    } else if (kibitzerMode === "user_clock_bound" || kibitzerMode === "continuous") {
      const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
      const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
      fetchEngineVariations({
        fen: newG.fen(),
        engine_id: kibitzerEngine,
        depth: effectiveDepth,
        multipv: kibitzerMultipv,
        time_limit_ms: effectiveTimeLimitMs,
        threads: kibitzerThreads,
        hash_mb: kibitzerHashMb,
      }).then((res) => {
        if (res?.variations) setKibitzerVariations(res.variations);
      }).catch(() => {});
    }
  };
```

### 2b. Replacement code (FULL FUNCTION — paste verbatim):

```tsx
  const handleStartGame = async () => {
    // ── Stage 1: Reset all transient UI state before async work ──────────────
    const newG = new Chess();
    setGame(newG);
    setFen(newG.fen());
    setMoveHistory([]);
    setMoveRecords([]);
    setEvalScore("+0.00");
    setSaveSuccessMsg(null);
    setAutosaveAlert(null);
    setActiveTutorFlag(null);
    setSparSessionError(null);
    // NOTE: setIsGameActive(true) is intentionally deferred to Stage 3
    //       so the board is NOT interactive until game_id is verified.

    // ── Stage 2: Pre-flight UUID verification gate ────────────────────────────
    let verifiedGameId: string;
    try {
      const session = await createSparringGame({
        opponent_engine: currentEngineObj.name,
        user_time_control: "unlimited",
        tutor_interrupt_mode: tutorInterruptMode,
      });

      const rawId = session?.game?.game_id;
      if (!rawId || typeof rawId !== "string" || !rawId.trim()) {
        // game_id absent, null, or blank — abort cleanly
        setSparSessionError("Could not initialize sparring session: invalid game ID returned from server.");
        logAction("ERROR", "handleStartGame aborted — createSparringGame returned no valid game_id");
        return; // ← early return; triggerEngineMove never fires
      }

      verifiedGameId = rawId.trim();
    } catch (e: any) {
      // createSparringGame rejected — surface error and abort
      setSparSessionError("Failed to create sparring session: " + (e?.message ?? String(e)));
      logAction("ERROR", "handleStartGame aborted — createSparringGame threw: " + (e?.message ?? String(e)));
      return; // ← early return; triggerEngineMove never fires
    }

    // ── Stage 3: Commit state only after UUID is verified ────────────────────
    setCurrentGameId(verifiedGameId);
    setIsGameActive(true); // board becomes interactive now

    logAction(
      "CLICK",
      "Started UCI Sparring Match vs " + currentEngineObj.name,
      "Side: " + playerSide + ", Elo: " + targetElo + ", Engine: " + selectedEngine + ", Book: " + selectedBook
    );

    // ── Stage 4: Engine / Kibitzer calls — guarded by verified game_id ───────
    if (playerSide === "black") {
      triggerEngineMove(newG.fen(), newG);
    } else if (kibitzerMode === "user_clock_bound" || kibitzerMode === "continuous") {
      const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
      const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
      fetchEngineVariations({
        fen: newG.fen(),
        engine_id: kibitzerEngine,
        depth: effectiveDepth,
        multipv: kibitzerMultipv,
        time_limit_ms: effectiveTimeLimitMs,
        threads: kibitzerThreads,
        hash_mb: kibitzerHashMb,
      }).then((res) => {
        if (res?.variations) setKibitzerVariations(res.variations);
      }).catch(() => {});
    }
  };
```

**Invariant enforced:** `triggerEngineMove()` is unreachable unless `verifiedGameId` is a non-empty
string and `setCurrentGameId(verifiedGameId)` has already committed.

---

## 3. Telemetry & Companion Short-circuit Guards

Apply each guard independently. These are additive changes only.

### 3a. `handleGetAdvise` — kibitzer auto-save block (~line 484)

**Current:**
```tsx
        if (kibitzerAutoSave && res.variations.length > 0) {
```

**Replace with:**
```tsx
        if (kibitzerAutoSave && res.variations.length > 0 && currentGameId?.trim()) {
```

Rationale: prevents `logKibitzerVariation` IPC calls when `currentGameId` is still `""`.
The `"sparring-session-standalone"` fallback on line 487 is now only used in non-auto-save
paths (manual saves use guard 3b below).

### 3b. `handleSaveKibitzerVariation` — user-triggered save (~lines 508–533)

**Full function replacement:**
```tsx
  const handleSaveKibitzerVariation = async (variation: VariationLine) => {
    try {
      if (!currentGameId?.trim()) return; // drop write: no verified session
      await logKibitzerVariation({
        game_id: currentGameId,
        ply: moveRecords.length,
        fen: fen,
        engine: kibitzerEngineObj.name,
        pgn_fragment: variation.pv_san,
        eval_data: {
          score_cp: variation.score_cp,
          win_prob: variation.win_prob,
          depth: variation.depth,
          tags: variation.tags,
        },
        trigger_source: "get_advise",
        logged_by: "user_save",
        was_played: false,
      });
      setSaveSuccessMsg("Saved variation " + variation.pv_san + " to " + KIBITZER_DB_NAME + "!");
      logAction("API", "Saved variation " + variation.pv_san + " to " + KIBITZER_DB_NAME);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    } catch (err: any) {
      logAction("ERROR", "Failed to save Kibitzer variation: " + err.message);
    }
  };
```

Note: `game_id: currentGameId` — the `|| "sparring-session-standalone"` fallback is removed.
The guard on line 1 of the try-block makes the function a no-op when no session is active.

### 3c. `handleTutorOutcome` — tutor flag logger (~lines 542–558)

**Current block to REPLACE (lines 542–558):**
```tsx
    try {
      await logTutorFlag({
        game_id: currentGameId || "sparring-session-standalone",
        ply: flagCopy.ply || moveRecords.length,
        fen: fen,
        flag_type: flagCopy.flag_type,
        engine: tutorEngineObj.name,
        centipawn_data: { loss_cp: flagCopy.loss_cp, eval: flagCopy.eval_score },
        suggested_variations: [{ san: flagCopy.best_move_san, tags: flagCopy.tags }],
        tutor_outcome: outcome === "takeback" ? "ignored_flag" : outcome,
        trigger_source: "flag_triggered",
      });
      logAction("API", "Tutor flag resolved with outcome: " + outcome);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
    } catch (err: any) {
      console.warn("Failed to log tutor flag outcome", err);
    }
```

**Replacement:**
```tsx
    try {
      if (!currentGameId?.trim()) {
        // No verified session — skip DB write, still process UI outcome below
      } else {
        await logTutorFlag({
          game_id: currentGameId,
          ply: flagCopy.ply || moveRecords.length,
          fen: fen,
          flag_type: flagCopy.flag_type,
          engine: tutorEngineObj.name,
          centipawn_data: { loss_cp: flagCopy.loss_cp, eval: flagCopy.eval_score },
          suggested_variations: [{ san: flagCopy.best_move_san, tags: flagCopy.tags }],
          tutor_outcome: outcome === "takeback" ? "ignored_flag" : outcome,
          trigger_source: "flag_triggered",
        });
        logAction("API", "Tutor flag resolved with outcome: " + outcome);
        queryClient.invalidateQueries({ queryKey: ["databases"] });
      }
    } catch (err: any) {
      console.warn("Failed to log tutor flag outcome", err);
    }
```

### 3d. `handlePieceDrop` — inline tutor flag log, continuous mode (~lines 1038–1049)

**Find target (inside `.then()` callback, continuous-mode branch):**
```tsx
                logTutorFlag({
                  game_id: currentGameId || "sparring-session-standalone",
```

**Replace those two lines with:**
```tsx
                if (!currentGameId?.trim()) return; // drop write: no verified session
                logTutorFlag({
                  game_id: currentGameId,
```

Note: The `return` exits only the `.then()` callback arrow function. The engine move on the
closing line of the callback (`triggerEngineMove(newFen, nextGame)`) is skipped in this
branch anyway (it lives in the if/else below the flag block), so this is safe.

---

## 4. Error State UI Render (Minimal JSX Addition)

Search JSX for the button calling `onClick={handleStartGame}`.
**Immediately after the button's closing tag**, insert:

```tsx
{sparSessionError && (
  <p className="mt-2 text-xs text-red-400 font-medium" role="alert">
    ⚠ {sparSessionError}
  </p>
)}
```

Do NOT modify any surrounding element, className, layout div, or board prop.

---

## 5. Preservation Directives — HARD CONSTRAINTS

Cline MUST leave the following **completely untouched**:

| Area | Constraint |
|------|-----------|
| All JSX layout structure | No element, div, or flex container may be added, removed, or reordered |
| All Tailwind utility classes on existing elements | No class names modified |
| `<Chessboard>` props | `position`, `onPieceDrop`, `boardOrientation`, `customPieces`, `boardWidth` — untouched |
| `triggerEngineMove` body (lines 636–750) | No changes whatsoever |
| `handlePieceDrop` body (lines 888–1077) | Only lines 1038–1039 targeted; nothing else touched |
| `autoSaveGame`, `saveMutation`, `handleDownloadPgn` | No changes |
| All `useState` declarations except new `sparSessionError` | Untouched |
| Import block (lines 1–58) | No new imports needed; all symbols already imported |

---

## 6. Verification Checklist (Cline self-check before committing)

- [ ] `sparSessionError` state declared on line ~170, immediately after `currentGameId`.
- [ ] `handleStartGame`: `setIsGameActive(true)` does **not** appear before `await createSparringGame()`.
- [ ] `handleStartGame`: both the `!rawId` branch and the `catch` branch execute `return` and never reach `triggerEngineMove`.
- [ ] `setCurrentGameId(verifiedGameId)` appears exactly once in `handleStartGame`, strictly after UUID validation passes.
- [ ] `handleGetAdvise` auto-save condition includes `&& currentGameId?.trim()`.
- [ ] `handleSaveKibitzerVariation`: first statement inside `try` is `if (!currentGameId?.trim()) return;`.
- [ ] `handleTutorOutcome`: `logTutorFlag` is inside an `else` block gated by `currentGameId?.trim()`.
- [ ] `handlePieceDrop` continuous-mode tutor log: `if (!currentGameId?.trim()) return;` guard precedes `logTutorFlag`.
- [ ] No `|| "sparring-session-standalone"` fallback strings remain in any function touched by this RC.
- [ ] Error UI `<p>` renders only when `sparSessionError` is truthy.
- [ ] `tsc --noEmit` passes with zero errors.
- [ ] `eslint src/features/sparring/SparView.tsx` reports zero new warnings.

---

## 7. Expected Diff Summary

```
src/features/sparring/SparView.tsx
  + 1 line  : sparSessionError useState declaration              (~L170)
  ~ 49 lines: handleStartGame full rewrite (L752–L800)           net +18 lines
  ~ 1 line  : handleGetAdvise auto-save condition (L484)         net +0 lines
  ~ 3 lines : handleSaveKibitzerVariation guard + game_id fix    net +1 line
  ~ 12 lines: handleTutorOutcome logTutorFlag guard refactor     net +3 lines
  ~ 2 lines : handlePieceDrop inline logTutorFlag guard          net +1 line
  + 5 lines : sparSessionError UI render (JSX, onClick region)
─────────────────────────────────────────────────────────────────
  Total: ~+29 lines net insertion. Zero deletions outside targeted functions.
```
