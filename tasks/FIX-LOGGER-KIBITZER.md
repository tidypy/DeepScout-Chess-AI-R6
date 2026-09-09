# FIX-LOGGER-KIBITZER — Viewport Cleanup & Engine Variations Multi-PV Tag Classification Fix

**Spec Date:** 2026-09-08
**Target Files (2):**
- `src/App.tsx` (Frontend Viewport Cleanup)
- `core/features/engine/engine_service.py` (Sidecar Multi-PV Call Site Fix)

**Scope:** Atomic, surgical, zero iterations.
**Pass Target:** 1-turn completion by Cline (GLM-5.3).

---

## 1. Problem Statements & Root Causes

### 1-A. Viewport Hog: Active Mount of `<ClickLogConsole />`
- **Location:** `src/App.tsx:14` (import) and `src/App.tsx:569-570` (JSX render).
- **Issue:** `<ClickLogConsole />` is mounted at the bottom of the main workspace div in `src/App.tsx`. Even when minimized, it takes up ~44px vertical height; when expanded, it consumes ~280px, taking space from chessboard and analysis sidebars across all views.
- **Goal:** Unmount `<ClickLogConsole />` and remove its direct import from `src/App.tsx`.
- **Invariants to Preserve:**
  - Keep `useClickLogger` hook in `src/App.tsx` (L40) and all companion `logAction` calls intact.
  - Keep Wing's `onToggleDebugConsole` and `isConsoleOpen` props on `<Wing />` (L127-128) intact.
  - Do NOT delete `src/components/debug/ClickLogConsole.tsx` or `src/lib/clickLogger.tsx`.
  - Do NOT modify `ClickLoggerProvider` in `src/main.tsx`.

### 1-B. Sidecar Crash: `classify_multipv` Call Site Missing Parameter
- **Location:** `core/features/engine/engine_service.py:1150`.
- **Definition:** `def classify_multipv(board: chess.Board, multipv_data: List[Dict[str, Any]], rules: Optional[List[TagRule]] = None) -> List[VariationLine]:` in `core/features/engine/tag_classifier.py:279`.
- **Issue:** In `engine_service.py` inside `request_variations()`, line 1150 invokes:
  ```python
  classified = classify_multipv(raw_lines)
  ```
  `classify_multipv()` requires `board: chess.Board` as its first parameter and `multipv_data: List[Dict[str, Any]]` as its second parameter (`multipv_data`). Passing only `raw_lines` raises:
  `TypeError: classify_multipv() missing 1 required positional argument: 'multipv_data'` (or fails attempting to access attributes of `board`).
- **Data Shape Alignment:**
  In `tag_classifier.py:299-319`:
  - `score`: parsed by `score_to_cp(raw_score, turn)`.
  - `pv`: list of `chess.Move` objects, or `pv_uci`.
  - `pv_san`: string SAN representation.
  In `engine_service.py:1112-1148`:
  `raw_lines` currently sets `"score_cp"`, `"is_mate"`, `"mate_in"`, but does not include `"score"`. Meanwhile, `analysis_results` items have `"score"`, `"pv"`, `"depth"`, `"nps"`.
  Forwarding `board` and forwarding either enriched `raw_lines` (with `score`: item.get("score") or `{"cp": score_cp, "mate": mate_in}` and `pv`: pv_moves) or properly formatted `multipv_data` ensures `classify_multipv` succeeds cleanly.

---

## 2. Targeted Changes

### Component 1: Frontend (`src/App.tsx`)

#### Change 1.1: Remove `ClickLogConsole` Import
- **File:** `src/App.tsx`
- **Location:** Line 14
- **Action:** Delete line 14:
  ```tsx
  // DELETE:
  import { ClickLogConsole } from "./components/debug/ClickLogConsole";
  ```

#### Change 1.2: Delete `<ClickLogConsole />` JSX Element
- **File:** `src/App.tsx`
- **Location:** Lines 569-570
- **Action:** Delete the comment and component tag:
  ```tsx
  // DELETE:
            {/* Bottom Click & Debug Logger Console */}
            <ClickLogConsole />
  ```
- **Preservation Check:** Surrounding `</div>` closing tags at line 571-572 must remain untouched.

---

### Component 2: Backend (`core/features/engine/engine_service.py`)

#### Change 2.1: Populate `score` and `pv` in `raw_lines`
- **File:** `core/features/engine/engine_service.py`
- **Anchor:** `request_variations()` (lines 1140-1148)
- **Current Code:**
  ```python
                  raw_lines.append({
                      "pv_san": " ".join(pv_san_list),
                      "pv_uci": " ".join(pv_uci_list),
                      "score_cp": score_cp,
                      "is_mate": is_mate,
                      "mate_in": mate_in,
                      "depth": line_depth,
                      "nps": nps_val,
                  })
  ```
- **Replacement Code:**
  ```python
                  raw_lines.append({
                      "pv_san": " ".join(pv_san_list),
                      "pv_uci": " ".join(pv_uci_list),
                      "score": score_obj,
                      "score_cp": score_cp,
                      "is_mate": is_mate,
                      "mate_in": mate_in,
                      "pv": pv_moves,
                      "depth": line_depth,
                      "nps": nps_val,
                  })
  ```

#### Change 2.2: Fix `classify_multipv` Call Signature
- **File:** `core/features/engine/engine_service.py`
- **Anchor:** `request_variations()` (line 1150)
- **Current Code:**
  ```python
              classified = classify_multipv(raw_lines)
  ```
- **Replacement Code:**
  ```python
              classified = classify_multipv(board, raw_lines)
  ```

---

## 3. Verification Checklist

1. **Frontend Viewport:**
   - [ ] Run `npm run build` or `node_modules/.bin/tsc --noEmit` from project root. Must exit code 0.
   - [ ] Verify `ClickLogConsole` does not appear in `src/App.tsx`.
   - [ ] Verify `useClickLogger` and other layout elements remain unaffected in `src/App.tsx`.

2. **Sidecar / Engine Variations:**
   - [ ] Verify `core/features/engine/engine_service.py:1150` passes `(board, raw_lines)`.
   - [ ] Verify `score` and `pv` keys exist in `raw_lines` dict.
   - [ ] Run python tests or linting:
     ```powershell
     python -c "import chess; from core.features.engine.engine_service import EngineService; print('EngineService imports cleanly')"
     ```
   - [ ] Test companion variations call with a dummy board to ensure `classify_multipv(board, raw_lines)` executes without `TypeError`.
