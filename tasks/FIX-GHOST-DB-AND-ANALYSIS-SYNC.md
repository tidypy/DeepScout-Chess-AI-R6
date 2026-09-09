# Task Specification: Kill Ghost DB Auto-Provisioning & Fix Analysis Notation Hydration

**Ticket:** `FIX-GHOST-DB-AND-ANALYSIS-SYNC`  
**Domain:** State Hydration, Companion Database Integrity & Notation Rendering  
**Target Files:**  
- `core/api/main.py`
- `core/persistence/database.py`
- `src/App.tsx`
- `src/components/chessboard/ResponsiveChessboard.tsx`

---

## 1. Problem Diagnosis & Root Causes

### 1.1 Ghost DB Auto-Provisioning (`sparring.sqlite`)
- **Backend Root Cause (`core/api/main.py:85-98`):** The endpoint `POST /api/v1/databases/ensure-default` creates `sparring.sqlite` if absent. When the frontend's fallback fires, it calls this endpoint, resurrecting `sparring.sqlite` in the root workspace even though the canonical database name has been standardized to `Sparring_Games.sqlite`.
- **Frontend Root Cause (`src/App.tsx:102-145`):** `src/App.tsx` checks `inList("sparring.sqlite")` in Fallback 1 and Fallback 2, persisting `"sparring.sqlite"` to `localStorage` and calling `ensureDefaultDatabase()`.
- **Requirement:** Update backend `ensure_default_database()` to provision `Sparring_Games.sqlite` (with canonical schema), update frontend Fallback 1 & 2 to target `Sparring_Games.sqlite`, and guarantee only canonical companion files (`Sparring_Games.sqlite`, `Tutor_Games.sqlite`, `Kibitzer_Analysis.sqlite`) are initialized.

### 1.2 Database Hub -> Analysis Navigation Sync
- **Root Cause (`src/App.tsx:553-558`):**
  - In `src/App.tsx:553-558`, `onLoadGame={(id, dbName) => { ... }}` calls `setGameId(id)`, `setActiveGameDb(dbName)`, `setActiveView("Analysis")`, but **omits** synchronous writes to `localStorage.setItem("deepscout_last_opened_db", ...)` and `localStorage.setItem("deepscout_last_game_id", ...)`. If the user switches views, reloads, or triggers secondary effects, the hydration falls back to stale `localStorage` values.
- **Requirement:** Synchronously commit `deepscout_last_opened_db` and `deepscout_last_game_id` to `localStorage` inside `onLoadGame` in `src/App.tsx`.

### 1.3 Analysis Notation Hydration (`Ply 0 / 0`)
- **Root Cause (`src/components/chessboard/ResponsiveChessboard.tsx:638-662`):**
  - Games from companion databases (e.g., `Tutor_Games.sqlite` ID #9, `Kibitzer_Analysis.sqlite`) contain `[SetUp "1"]` and `[FEN "..."]` headers because they start from mid-game tactical positions.
  - In `ResponsiveChessboard.tsx:640`, `chess.loadPgn(cleaned)` successfully parses the PGN and extracts moves via `chess.history()`.
  - However, in `line 643`: `const runner = new Chess();` starts from the **standard initial position** (`rnbqkbnr/...`) instead of the starting FEN specified by the PGN (`chess.header().SetUp === "1" ? chess.header().FEN : ...`).
  - When `runner.move(m)` executes (e.g. move 41 `gxh3`), it fails because `gxh3` is illegal from the standard opening board! This throws an exception inside `loadPgn` try-block, dropping into the fallback catch block `lines 668-709`.
  - The fallback token parser (`lines 673-686`) also instantiates `const runner = new Chess();` without the setup FEN, causing `runner.move(tok)` to fail on the very first token. The resulting `moves` array is empty (`[]`).
  - In addition, in `line 656`: `const startFen = new Chess().fen();` always resets `currentPosition` to the standard opening board, wiping out the initial position FEN.
- **Companion PGN Builder Root Cause (`core/persistence/database.py:274-289`):**
  - When loading from standard `Games` tables or `Sparring_Games.sqlite`, if `_DATA_` contains PGN, `row_dict.get("pgn")` should also be checked as a fallback column if `_DATA_` is empty.

---

## 2. Surgical Implementation Plan

### Step 1: Backend Ghost DB Elimination & Canonical Default
**File:** `core/api/main.py`
- In `ensure_default_database()` (`lines 85-99`):
  - Replace `sparring.sqlite` with `Sparring_Games.sqlite`.
  - Provision `Sparring_Games.sqlite` if absent.
  - Return `{"created": created, "db_name": "Sparring_Games.sqlite"}`.

### Step 2: Database Persistence & Self-Healing Fallback Alignment
**File:** `src/App.tsx`
- In the `useEffect` on `dbList` (`lines 102-145`):
  - Replace all occurrences of `"sparring.sqlite"` with `"Sparring_Games.sqlite"`.
  - Fallback 1: check `inList("Sparring_Games.sqlite")` -> mount `"Sparring_Games.sqlite"`.
  - Fallback 2: `ensureDefaultDatabase()` -> mount `"Sparring_Games.sqlite"`.

### Step 3: Database Hub -> Analysis Navigation Sync
**File:** `src/App.tsx`
- In `onLoadGame` prop passed to `<DatabaseBrowserView ... />` (`lines 553-558`):
  ```tsx
  onLoadGame={(id, dbName) => {
    const targetDb = dbName || activeGameDb;
    setGameId(id);
    if (dbName) setActiveGameDb(dbName);
    localStorage.setItem("deepscout_last_opened_db", targetDb);
    localStorage.setItem("deepscout_last_game_id", String(id));
    setActiveView("Analysis");
    logAction("NAV", `Loaded Game #${id} from ${targetDb} into Analysis Workspace`);
  }}
  ```

### Step 4: FEN-Aware Board & Move Tree Hydration
**File:** `src/components/chessboard/ResponsiveChessboard.tsx`
- In the PGN-loading `useEffect` (`lines 633-710`):
  1. Parse header from `chess`:
     ```ts
     const headers = chess.header();
     const isCustomSetup = headers.SetUp === "1" && !!headers.FEN;
     const startFen = isCustomSetup
       ? headers.FEN
       : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
     ```
  2. Initialize `runner` with `startFen`:
     ```ts
     const runner = new Chess(startFen);
     const fens: string[] = [];
     for (const m of moves) {
       runner.move(m);
       fens.push(runner.fen());
     }
     ```
  3. Initialize board position with `startFen`:
     ```ts
     setInitialFen(startFen);
     setHistory(moves);
     setPositions(fens);
     setHistoryIndex(-1);
     setCurrentPosition(startFen);
     if (onPositionChangeRef.current) onPositionChangeRef.current(startFen);
     ```
  4. In `updateToMove` (`lines 712-742`):
     - Replace hardcoded standard start FEN with stored `initialFen`.
  5. In fallback token parser (`lines 670-686`):
     - Extract `[FEN "..."]` from `pgn` string if present, and initialize `new Chess(extractedFen)`.

### Step 5: Companion PGN Generation Fallback
**File:** `core/persistence/database.py`
- In `get_game_by_rowid` (`lines 274-289`):
  - If `data` is empty/null, fall back to checking `row_dict.get("pgn")` or `row_dict.get("PGN")`.

---

## 3. Step-by-Step Code Instructions for Cline

### Edit 1: `core/api/main.py`
**Lines 85-99:**
Replace:
```python
@app.post("/api/v1/databases/ensure-default")
async def ensure_default_database():
    """Create sparring.sqlite as an empty database if it does not already exist on disk."""
    if not game_service:
        raise HTTPException(status_code=500, detail="GameService not initialized.")
    sparring_path = os.path.join(game_service.root_dir, "sparring.sqlite")
    created = False
    if not os.path.exists(sparring_path):
        try:
            GameRepository.create_empty_db(sparring_path)
            created = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create sparring.sqlite: {e}")
    return {"created": created, "db_name": "sparring.sqlite"}
```
With:
```python
@app.post("/api/v1/databases/ensure-default")
async def ensure_default_database():
    """Create Sparring_Games.sqlite as an empty database if it does not already exist on disk."""
    if not game_service:
        raise HTTPException(status_code=500, detail="GameService not initialized.")
    sparring_path = os.path.join(game_service.root_dir, "Sparring_Games.sqlite")
    created = False
    if not os.path.exists(sparring_path):
        try:
            GameRepository.create_empty_db(sparring_path)
            created = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create Sparring_Games.sqlite: {e}")
    return {"created": created, "db_name": "Sparring_Games.sqlite"}
```

### Edit 2: `src/App.tsx`
**Lines 102-145:**
Replace `sparring.sqlite` references with `Sparring_Games.sqlite`:
```tsx
  // --- Analysis DB Persistence & Self-Healing Fallback ---
  // Runs once when dbList resolves. Validates stored db against live list,
  // falls back to Sparring_Games.sqlite, and self-heals if Sparring_Games.sqlite is also absent.
  useEffect(() => {
    if (!dbList || dbList.length === 0) return; // Wait for sidecar to respond

    const storedDb = localStorage.getItem("deepscout_last_opened_db");
    const storedGameId = parseInt(localStorage.getItem("deepscout_last_game_id") || "1", 10) || 1;

    const inList = (name: string) => dbList.some((d) => d.name === name);

    if (storedDb && inList(storedDb)) {
      // Primary: restore last session exactly
      setActiveGameDb(storedDb);
      setGameId(storedGameId);
      logActionRef.current("SYSTEM", `Restored last session: ${storedDb} game #${storedGameId}`);
      return;
    }

    if (inList("Sparring_Games.sqlite")) {
      // Fallback 1: Sparring_Games.sqlite exists — mount it, reset game to 1
      setActiveGameDb("Sparring_Games.sqlite");
      setGameId(1);
      localStorage.setItem("deepscout_last_opened_db", "Sparring_Games.sqlite");
      localStorage.setItem("deepscout_last_game_id", "1");
      logActionRef.current("SYSTEM", "Fallback 1: mounted Sparring_Games.sqlite (last_db not found)");
      return;
    }

    // Fallback 2 (Self-Healing): neither stored db nor Sparring_Games.sqlite present
    // Call backend to create an empty Sparring_Games.sqlite, then re-invalidate dbList
    ensureDefaultDatabase()
      .then(() => {
        setActiveGameDb("Sparring_Games.sqlite");
        setGameId(1);
        localStorage.setItem("deepscout_last_opened_db", "Sparring_Games.sqlite");
        localStorage.setItem("deepscout_last_game_id", "1");
        logActionRef.current("SYSTEM", "Fallback 2: self-healed — created Sparring_Games.sqlite via backend");
        window.dispatchEvent(new CustomEvent("deepscout:db-healed"));
      })
      .catch((err) => {
        logActionRef.current("ERROR", "Self-heal failed — could not create Sparring_Games.sqlite", String(err));
      });
  }, [dbList]); // eslint-disable-line react-hooks/exhaustive-deps
```

**Lines 553-558 in `src/App.tsx`:**
Replace:
```tsx
                  onLoadGame={(id, dbName) => {
                    setGameId(id);
                    if (dbName) setActiveGameDb(dbName);
                    setActiveView("Analysis");
                    logAction("NAV", `Loaded Game #${id} from ${dbName || activeGameDb} into Analysis Workspace`);
                  }}
```
With:
```tsx
                  onLoadGame={(id, dbName) => {
                    const targetDb = dbName || activeGameDb;
                    setGameId(id);
                    if (dbName) setActiveGameDb(dbName);
                    localStorage.setItem("deepscout_last_opened_db", targetDb);
                    localStorage.setItem("deepscout_last_game_id", String(id));
                    setActiveView("Analysis");
                    logAction("NAV", `Loaded Game #${id} from ${targetDb} into Analysis Workspace`);
                  }}
```

### Edit 3: `src/components/chessboard/ResponsiveChessboard.tsx`
1. Add state for initial starting FEN (after line 372):
```tsx
  const [initialFen, setInitialFen] = useState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
```

2. Update `updateToMove` (`lines 712-740`):
```tsx
  const updateToMove = useCallback(
    (index: number) => {
      if (index < -1 || index >= history.length) return;

      let newFen: string;
      if (index === -1) {
        newFen = initialFen;
      } else if (positions[index]) {
        newFen = positions[index];
      } else {
        const tempGame = new Chess(initialFen);
        for (let i = 0; i <= index; i++) {
          tempGame.move(history[i]);
        }
        newFen = tempGame.fen();
      }

      setCurrentPosition(newFen);
      setHistoryIndex(index);
      if (onPositionChangeRef.current) onPositionChangeRef.current(newFen);
      const moveText =
        index >= 0 ? `${Math.floor(index / 2) + 1}${index % 2 === 0 ? "." : "..."} ${history[index]}` : "Start Position";
      logActionRef.current("NAV", `Navigated to Move ${index + 1}/${history.length}`, moveText);

      if (isKibitzerOpen && kibitzerContinuous) {
        handleRequestKibitzerAdvice(newFen);
      }
    },
    [history, positions, initialFen, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]
  );
```

3. Update PGN `useEffect` (`lines 633-710`):
```tsx
  useEffect(() => {
    if (!pgn || pgn === lastLoadedPgnRef.current) return;
    lastLoadedPgnRef.current = pgn;

    try {
      const chess = new Chess();
      const cleaned = cleanPgnForChessJs(pgn);
      chess.loadPgn(cleaned);
      const moves = chess.history();

      const headers = chess.header();
      const isCustomSetup = headers.SetUp === "1" && !!headers.FEN;
      const startFen = isCustomSetup
        ? headers.FEN
        : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

      const runner = new Chess(startFen);
      const fens: string[] = [];
      for (const m of moves) {
        runner.move(m);
        fens.push(runner.fen());
      }

      const { annotations, stats } = parsePgnAnnotationsAndStats(pgn, moves);
      setMoveAnnotations(annotations);
      if (onStatsChangeRef.current) {
        onStatsChangeRef.current(stats);
      }

      setInitialFen(startFen);
      setHistory(moves);
      setPositions(fens);
      setHistoryIndex(-1);
      setCurrentPosition(startFen);

      if (onPositionChangeRef.current) onPositionChangeRef.current(startFen);
      logActionRef.current("BOARD", `Loaded Game with ${moves.length} moves`, `Start FEN: ${startFen}`);

      if (isKibitzerOpen && kibitzerContinuous) {
        handleRequestKibitzerAdvice(startFen);
      }
    } catch (e) {
      console.warn("Primary loadPgn failed, attempting token fallback...", e);
      try {
        const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
        const startFen = fenMatch
          ? fenMatch[1]
          : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

        const noHeaders = pgn.replace(/\[[^\]]*\]/g, "").replace(/\{[^}]*\}/g, "").replace(/\[%[^\]]*\]/g, "");
        const tokens = noHeaders.split(/\s+/).filter((t) => t && !t.includes(".") && !["1-0", "0-1", "1/2-1/2", "*"].includes(t));
        const runner = new Chess(startFen);
        const moves: string[] = [];
        const fens: string[] = [];
        for (const tok of tokens) {
          try {
            const mv = runner.move(tok);
            if (mv) {
              moves.push(mv.san);
              fens.push(runner.fen());
            }
          } catch {
            break;
          }
        }
        const { annotations, stats } = parsePgnAnnotationsAndStats(pgn, moves);
        setMoveAnnotations(annotations);
        if (onStatsChangeRef.current) {
          onStatsChangeRef.current(stats);
        }

        setInitialFen(startFen);
        setHistory(moves);
        setPositions(fens);
        setHistoryIndex(-1);
        setCurrentPosition(startFen);

        if (onPositionChangeRef.current) onPositionChangeRef.current(startFen);
        logActionRef.current("BOARD", `Loaded Game via fallback with ${moves.length} moves`, `Start FEN: ${startFen}`);

        if (isKibitzerOpen && kibitzerContinuous) {
          handleRequestKibitzerAdvice(startFen);
        }
      } catch (err2) {
        console.error("Failed to load PGN with fallback", err2);
        logActionRef.current("BOARD", "Error loading PGN", String(err2));
      }
    }
  }, [pgn, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]);
```

### Edit 4: `core/persistence/database.py`
**Lines 274-289:**
Add support for reading from the `pgn` column in addition to `_DATA_`:
```python
        data = row_dict.get("_DATA_") or row_dict.get("pgn") or row_dict.get("PGN")
        xpv = row_dict.get("XPV")
        pgn_text = ""

        if data:
            if isinstance(data, bytes):
                if data.startswith(b"BODY "):
                    pgn_text = data[5:].decode("utf-8", errors="replace")
                else:
                    pgn_text = data.decode("utf-8", errors="replace")
            elif isinstance(data, str):
                if data.startswith("BODY "):
                    pgn_text = data[5:]
                else:
                    pgn_text = data
```

---

## 4. Verification & QA Checks

1. **TypeScript Check:**
   ```powershell
   & "C:\Program Files\nodejs\node.exe" "node_modules/typescript/bin/tsc" --noEmit
   ```
   Must exit with code 0.

2. **Python Import Check:**
   ```powershell
   .\.venv\Scripts\python.exe -c "from core.api.main import app; from core.persistence.database import GameRepository; print('OK')"
   ```
   Must print `OK` without errors.

3. **Database Endpoint Check:**
   ```powershell
   .\.venv\Scripts\python.exe -c "import urllib.request, json; res = json.loads(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/databases/ensure-default', data=b'{}').read()); print(res)"
   ```
   Must return `{"created": ..., "db_name": "Sparring_Games.sqlite"}` and never create `sparring.sqlite`.

4. **Tutor Game Hydration Verification:**
   Verify `GET /api/v1/games/9?db_name=Tutor_Games.sqlite` returns a PGN with `[SetUp "1"]` and `[FEN "..."]`. Verify that feeding that PGN into `cleanPgnForChessJs` and `chess.loadPgn` creates `history: ['gxh3']` and `runner = new Chess(startFen)` executes cleanly without throwing, ensuring the notation table renders plies properly.
