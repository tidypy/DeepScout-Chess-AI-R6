# CANONICAL-SPARRING-DB — Standardize Canonical Sparring Database to `Sparring_Games.sqlite`

**Spec Revision:** 2026-09-08 v1  
**Target Files (2):**
- `src/App.tsx` (Frontend Shell & Fallback Chain)
- `core/api/main.py` (Backend Default Database Route)

**Audited & Already Aligned Files (Confirmed Invariant):**
- `src/features/sparring/SparView.tsx` (`SPARRING_DB_NAME = "Sparring_Games.sqlite"`, autosave & manual save both route here)
- `core/persistence/companion_repositories.py` (`CompanionDataManager` points `sparring_repo` to `Sparring_Games.sqlite`)

**Scope:** Surgical, atomic. Standardize all legacy `sparring.sqlite` fallbacks to canonical `Sparring_Games.sqlite`.  
**Pass Target:** Zero-iteration, 1-turn completion by Cline (GLM-5.3).

---

## Status Block (fill after execution)
* **Epic / Domain:** Data Integrity & Canonical Storage Architecture
* **Status:** Pending Execution
* **Pass on First Attempt:** —
* **Debug Iterations:** —
* **Verification:** `tsc --noEmit` exits 0; backend endpoint returns `db_name: "Sparring_Games.sqlite"`; initial/fallback loads query `Sparring_Games.sqlite`.

---

## 1. Context & Architecture Invariant

### 1-A. Single Source of Truth for Sparring Archive
- Upstream specifications and the companion engine subsystem (`core/persistence/companion_repositories.py:358`) establish `Sparring_Games.sqlite` as the primary sparring match repository.
- `src/features/sparring/SparView.tsx:157` defines:
  ```ts
  const SPARRING_DB_NAME = "Sparring_Games.sqlite";
  ```
  All sparring autosaves (`autoSaveGame`) and manual saves (`saveMutation`) write to `Sparring_Games.sqlite`.
- Recent fallback code in `src/App.tsx` and `core/api/main.py` introduced `sparring.sqlite` as a fallback name. This created a dual-database split where fallback initialization created or looked for `sparring.sqlite`, while the sparring view saved games into `Sparring_Games.sqlite`.
- **Target Standard:** Eliminate `sparring.sqlite` from all fallback chains and backend provisioning endpoints. Canonical sparring database is strictly `Sparring_Games.sqlite`.

### 1-B. Fallback Chain Invariant (`src/App.tsx`)
When a user launches the app:
1. **Hydration:** Read `deepscout_last_opened_db` and `deepscout_last_game_id` from `localStorage`.
2. **Primary:** If `storedDb` exists in `dbList`, mount `storedDb` and restore `storedGameId`.
3. **Fallback 1:** If missing or no valid stored DB, look for canonical `Sparring_Games.sqlite` in `dbList`. If present, mount it and reset game to 1.
4. **Fallback 2 (Self-Healing):** If `Sparring_Games.sqlite` is also absent, call `ensureDefaultDatabase()` to provision `Sparring_Games.sqlite`, mount it, and trigger `deepscout:db-healed`.
5. **Initial Default State:** `activeGameDb` lazy initializer defaults to `"Sparring_Games.sqlite"` when no previous session is in `localStorage`. This guarantees initial queries (`GET /api/v1/games/1?db_name=Sparring_Games.sqlite`) query the canonical archive.

---

## 2. Targeted Changes

### Component 1: Backend (`core/api/main.py`)

#### Edit 1.1: Provision `Sparring_Games.sqlite` in `ensure-default` Route
- **File:** `core/api/main.py`
- **Location:** Lines 85–98
- **Current Code:**
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
- **Replacement Code:**
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

---

### Component 2: Frontend (`src/App.tsx`)

#### Edit 2.1: Update `activeGameDb` Initial Fallback to `Sparring_Games.sqlite`
- **File:** `src/App.tsx`
- **Location:** Lines 48–50
- **Current Code:**
  ```tsx
    const [activeGameDb, setActiveGameDb] = useState<string>(
      () => localStorage.getItem("deepscout_last_opened_db") || "patriciaTourny.sqlite"
    );
  ```
- **Replacement Code:**
  ```tsx
    const [activeGameDb, setActiveGameDb] = useState<string>(
      () => localStorage.getItem("deepscout_last_opened_db") || "Sparring_Games.sqlite"
    );
  ```

#### Edit 2.2: Update Mount Validation `useEffect` to Target `Sparring_Games.sqlite`
- **File:** `src/App.tsx`
- **Location:** Lines 102–145
- **Current Code:**
  ```tsx
    // --- Analysis DB Persistence & Self-Healing Fallback ---
    // Runs once when dbList resolves. Validates stored db against live list,
    // falls back to sparring.sqlite, and self-heals if sparring.sqlite is also absent.
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

      if (inList("sparring.sqlite")) {
        // Fallback 1: sparring.sqlite exists — mount it, reset game to 1
        setActiveGameDb("sparring.sqlite");
        setGameId(1);
        localStorage.setItem("deepscout_last_opened_db", "sparring.sqlite");
        localStorage.setItem("deepscout_last_game_id", "1");
        logActionRef.current("SYSTEM", "Fallback 1: mounted sparring.sqlite (last_db not found)");
        return;
      }

      // Fallback 2 (Self-Healing): neither stored db nor sparring.sqlite present
      // Call backend to create an empty sparring.sqlite, then re-invalidate dbList
      ensureDefaultDatabase()
        .then(() => {
          setActiveGameDb("sparring.sqlite");
          setGameId(1);
          localStorage.setItem("deepscout_last_opened_db", "sparring.sqlite");
          localStorage.setItem("deepscout_last_game_id", "1");
          logActionRef.current("SYSTEM", "Fallback 2: self-healed — created sparring.sqlite via backend");
          window.dispatchEvent(new CustomEvent("deepscout:db-healed"));
        })
        .catch((err) => {
          logActionRef.current("ERROR", "Self-heal failed — could not create sparring.sqlite", String(err));
        });
    }, [dbList]); // eslint-disable-line react-hooks/exhaustive-deps
  ```
- **Replacement Code:**
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

---

## 3. Verification & Acceptance Checklist

### 3-A. Static & Type Checks
- [ ] Run `& "C:\Program Files\nodejs\node.exe" "node_modules/typescript/bin/tsc" --noEmit` from project root. Must exit with code 0.
- [ ] Confirm no occurrences of `"sparring.sqlite"` remain in `src/App.tsx` or `core/api/main.py`.

### 3-B. Backend Verification
- [ ] Execute Python backend import check:
  ```powershell
  .\.venv\Scripts\python.exe -c "from core.api.main import app; print('Backend syntax check: OK')"
  ```
- [ ] Test `ensure_default_database()` endpoint logic:
  ```powershell
  .\.venv\Scripts\python.exe -c "import os; from core.services.game_service import GameService; from core.persistence.database import GameRepository; ROOT='.'; p=os.path.join(ROOT, 'Sparring_Games.sqlite'); print('Sparring_Games exists:', os.path.exists(p))"
  ```

### 3-C. Runtime State Behavior
- [ ] Clear `localStorage` (`localStorage.clear()`) in browser/webview.
- [ ] On refresh, verify default `activeGameDb` initial state evaluates to `"Sparring_Games.sqlite"`.
- [ ] Verify `fetchGame(1, "Sparring_Games.sqlite")` is triggered for initial analysis view load.
- [ ] Verify that saving a match in `SparView.tsx` records into `Sparring_Games.sqlite` and the game is immediately browsable from the Analysis view database dropdown under `Sparring_Games.sqlite`.
