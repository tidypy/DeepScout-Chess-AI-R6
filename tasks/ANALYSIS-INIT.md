# ANALYSIS-INIT — Click Logger Removal, Hybrid DB Persistence & Self-Healing Fallback

**Spec Revision:** 2026-09-08 v2
**Target Files (3):**
- `src/App.tsx`               — primary React changes (5 surgical edits)
- `src/lib/api.ts`            — 1 new export added
- `core/api/main.py`          — 1 new route added (backend, Python)

**Scope:** Atomic. Zero JSX layout shifts. Zero CSS regressions.
**Pass Target:** Zero-iteration, one turn in Cline (GLM-5.3).

---

## Status Block (fill after execution)
* **Epic / Domain:** UX Housekeeping & Analysis Initialization — Shell + Analysis View + Backend
* **Status:** Pending
* **Pass on First Attempt:** —
* **Debug Iterations:** —
* **Verification:** `tsc --noEmit` exits 0; sidecar health check passes; no layout regression.

---

## 0. Context Map

### 0-A ClickLogConsole viewport removal
`<ClickLogConsole />` renders unconditionally at **App.tsx:570** (inside workspace `<div>`).
Its header alone is ~44 px; expanded is ~280 px. All internal hook telemetry (`logAction`,
global click/error listeners, context state) must remain live. Only the visual render
is removed. The Wing's Bug-icon toggle button at **Wing.tsx:194–208** is retained as-is.

### 0-B Hardcoded initial database
`activeGameDb` is set on **App.tsx:47** to the static literal `"patriciaTourny.sqlite"`.
There is no `localStorage` hydration, no `last_game_id` persistence, and no fallback when
the db is deleted or the user had previously opened another database.

### 0-C Self-healing fallback chain
The existing `POST /api/v1/databases/import` endpoint explicitly rejects empty `pgn_text`
with HTTP 400 (**main.py:243–244**), so it cannot be used to create a blank database.
The Python layer exposes `GameRepository.create_empty_db(path)` (**database.py:58**) which
is already called at sidecar startup (**main.py:47**), but there is no HTTP route for it.
A new thin route `POST /api/v1/databases/ensure-default` will be added to `main.py` and
a corresponding `ensureDefaultDatabase()` export will be added to `api.ts`.

### 0-D localStorage keys
| Key | Type | Purpose |
|-----|------|---------|
| `deepscout_last_opened_db` | `string` | Last successfully mounted database filename |
| `deepscout_last_game_id`   | `string` | Last active game ID (stored as string, parsed as int) |

---

## 1. Edit 1 — Python Backend: New `ensure-default` Route

**File:** `core/api/main.py`

**Insert after line 83** (after the `list_databases` route's closing brace), before
the blank line at 84:

```python
@app.post("/api/v1/databases/ensure-default")
async def ensure_default_database():
    """Create sparring.sqlite as an empty database if it does not already exist on disk."""
    if not game_service:
        raise HTTPException(status_code=500, detail="GameService not initialized.")
    sparring_path = os.path.join(game_service.db_dir, "sparring.sqlite")
    if not os.path.exists(sparring_path):
        try:
            GameRepository.create_empty_db(sparring_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create sparring.sqlite: {e}")
    return {"created": not os.path.exists(sparring_path), "db_name": "sparring.sqlite"}

```

**Preservation:** All existing routes untouched. No new imports needed — `os`,
`GameRepository`, and `HTTPException` are already imported at the top of `main.py`.

---

## 2. Edit 2 — API Layer: New `ensureDefaultDatabase` export

**File:** `src/lib/api.ts`

**Insert after line 63** (after `fetchDatabases` closing brace), before the blank line
at 64:

```ts
export const ensureDefaultDatabase = async (): Promise<{ created: boolean; db_name: string }> => {
  const res = await fetch(`${API_BASE}/databases/ensure-default`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to ensure default database");
  return res.json();
};
```

**Preservation:** All existing exports untouched. No new imports needed.

---

## 3. Edit 3 — App.tsx: Remove `<ClickLogConsole />` from JSX

**File:** `src/App.tsx`

### 3a. Delete import — line 14

**REMOVE this entire line:**
```tsx
import { ClickLogConsole } from "./components/debug/ClickLogConsole";
```

### 3b. Delete JSX render — lines 569–570

**REMOVE these two lines (leave the surrounding `</div>` on line 571 intact):**
```tsx
          {/* Bottom Click & Debug Logger Console */}
          <ClickLogConsole />
```

**Preservation invariants:**
- **App.tsx:40** — `useClickLogger()` destructuring → **KEEP**
- **App.tsx:127** — `onToggleDebugConsole` Wing prop → **KEEP**
- **App.tsx:128** — `isConsoleOpen` Wing prop → **KEEP**
- All `logAction(...)` call sites throughout App.tsx → **KEEP**
- `src/components/debug/ClickLogConsole.tsx` → **DO NOT TOUCH** (source preserved)
- `src/lib/clickLogger.tsx` → **DO NOT TOUCH**
- `src/main.tsx` → **DO NOT TOUCH**

---

## 4. Edit 4 — App.tsx: Import `ensureDefaultDatabase`

**File:** `src/App.tsx`

**Current line 18:**
```tsx
import { fetchGame, fetchDatabases } from "./lib/api";
```

**Replace with:**
```tsx
import { fetchGame, fetchDatabases, ensureDefaultDatabase } from "./lib/api";
```

---

## 5. Edit 5 — App.tsx: Hybrid State Hydration on `activeGameDb` and `gameId`

**File:** `src/App.tsx`

### 5a. State initializer — line 46 (gameId)

**Current line 46:**
```tsx
  const [gameId, setGameId] = useState<number>(1);
```

**Replace with:**
```tsx
  const [gameId, setGameId] = useState<number>(
    () => parseInt(localStorage.getItem("deepscout_last_game_id") || "1", 10) || 1
  );
```

**Rationale:** The `|| 1` guard outside `parseInt` handles `NaN` (corrupt stored value).

### 5b. State initializer — line 47 (activeGameDb)

**Current line 47:**
```tsx
  const [activeGameDb, setActiveGameDb] = useState<string>("patriciaTourny.sqlite");
```

**Replace with:**
```tsx
  const [activeGameDb, setActiveGameDb] = useState<string>(
    () => localStorage.getItem("deepscout_last_opened_db") || "patriciaTourny.sqlite"
  );
```

---

## 6. Edit 6 — App.tsx: Mount-Time Validation `useEffect` (3-tier fallback)

**File:** `src/App.tsx`

**Insert after line 97** (after the `logActionRef` effect block that ends `});`), before
`handleOpenTheme` on line 99:

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
      // ✅ Primary: restore last session exactly
      setActiveGameDb(storedDb);
      setGameId(storedGameId);
      logActionRef.current("SYSTEM", `Restored last session: ${storedDb} game #${storedGameId}`);
      return;
    }

    if (inList("sparring.sqlite")) {
      // ✅ Fallback 1: sparring.sqlite exists — mount it, reset game to 1
      setActiveGameDb("sparring.sqlite");
      setGameId(1);
      localStorage.setItem("deepscout_last_opened_db", "sparring.sqlite");
      localStorage.setItem("deepscout_last_game_id", "1");
      logActionRef.current("SYSTEM", "Fallback 1: mounted sparring.sqlite (last_db not found)");
      return;
    }

    // ✅ Fallback 2 (Self-Healing): neither stored db nor sparring.sqlite present
    // Call backend to create an empty sparring.sqlite, then re-invalidate dbList
    ensureDefaultDatabase()
      .then(() => {
        setActiveGameDb("sparring.sqlite");
        setGameId(1);
        localStorage.setItem("deepscout_last_opened_db", "sparring.sqlite");
        localStorage.setItem("deepscout_last_game_id", "1");
        logActionRef.current("SYSTEM", "Fallback 2: self-healed — created sparring.sqlite via backend");
        // Force dbList refetch so the select dropdown updates
        window.dispatchEvent(new CustomEvent("deepscout:db-healed"));
      })
      .catch((err) => {
        logActionRef.current("ERROR", "Self-heal failed — could not create sparring.sqlite", String(err));
        // Last resort: keep whatever activeGameDb was (lazy init value)
      });
  }, [dbList]); // eslint-disable-line react-hooks/exhaustive-deps
  // logActionRef is a ref (stable), ensureDefaultDatabase is a stable module import.
  // setActiveGameDb / setGameId are stable setState dispatchers. ESLint exhaustive-deps
  // warning suppressed deliberately — this effect must run only when dbList changes.
```

**Dependency note:** `dbList` is `undefined` while `fetchDatabases` is in-flight (sidecar
offline). The `if (!dbList || dbList.length === 0) return` guard makes this a no-op until
the list arrives. No infinite loop risk. On sidecar reconnect the query refetches
automatically (React Query default retry), re-triggering this effect.

---

## 7. Edit 7 — App.tsx: Persist on Manual Database Switch

**File:** `src/App.tsx`

**Current onChange handler (lines 220–224):**
```tsx
                        onChange={(e) => {
                          setActiveGameDb(e.target.value);
                          setGameId(1);
                          logAction("CLICK", `Switched Analysis Database to ${e.target.value}`);
                        }}
```

**Replace with:**
```tsx
                        onChange={(e) => {
                          const selected = e.target.value;
                          setActiveGameDb(selected);
                          setGameId(1);
                          localStorage.setItem("deepscout_last_opened_db", selected);
                          localStorage.setItem("deepscout_last_game_id", "1");
                          logAction("CLICK", `Switched Analysis Database to ${selected}`);
                        }}
```

---

## 8. Edit 8 — App.tsx: Persist `gameId` on Manual Game Navigation

**File:** `src/App.tsx`

Two game-navigation buttons exist at **App.tsx:252–278**. Each calls `setGameId`. Update
both `onClick` handlers to also persist to `localStorage`.

### 8a. Previous Game button (lines 253–257):

**Current:**
```tsx
                              onClick={() => {
                                const nextId = Math.max(1, gameId - 1);
                                setGameId(nextId);
                                logAction("NAV", `Analysis Navigated to Game #${nextId}`);
                              }}
```

**Replace with:**
```tsx
                              onClick={() => {
                                const nextId = Math.max(1, gameId - 1);
                                setGameId(nextId);
                                localStorage.setItem("deepscout_last_game_id", String(nextId));
                                logAction("NAV", `Analysis Navigated to Game #${nextId}`);
                              }}
```

### 8b. Next Game button (lines 268–271):

**Current:**
```tsx
                              onClick={() => {
                                const nextId = gameId + 1;
                                setGameId(nextId);
                                logAction("NAV", `Analysis Navigated to Game #${nextId}`);
                              }}
```

**Replace with:**
```tsx
                              onClick={() => {
                                const nextId = gameId + 1;
                                setGameId(nextId);
                                localStorage.setItem("deepscout_last_game_id", String(nextId));
                                logAction("NAV", `Analysis Navigated to Game #${nextId}`);
                              }}
```

---

## 9. Verification Checklist (Cline self-check before commit)

### core/api/main.py
- [ ] New `POST /api/v1/databases/ensure-default` route is inserted after `list_databases`.
- [ ] Route calls `GameRepository.create_empty_db(sparring_path)` only when file is absent.
- [ ] Return JSON `{"created": bool, "db_name": "sparring.sqlite"}`.
- [ ] No existing routes or imports modified.

### src/lib/api.ts
- [ ] `ensureDefaultDatabase` exported after `fetchDatabases` (line ~64).
- [ ] Function calls `POST ${API_BASE}/databases/ensure-default`.
- [ ] No existing exports modified.

### src/App.tsx
- [ ] L14: `import { ClickLogConsole }` **deleted**.
- [ ] L18: import line now includes `ensureDefaultDatabase`.
- [ ] L46: `gameId` useState uses lazy `parseInt(localStorage.getItem(...) || "1", 10) || 1`.
- [ ] L47: `activeGameDb` useState uses lazy `localStorage.getItem("deepscout_last_opened_db") || "patriciaTourny.sqlite"`.
- [ ] Mount-time `useEffect` inserted between `logActionRef` effect and `handleOpenTheme`:
  - [ ] Returns early when `dbList` is absent/empty.
  - [ ] Restores stored db+gameId when db exists in list (Primary path).
  - [ ] Falls back to `sparring.sqlite` + resets gameId to 1 (Fallback 1).
  - [ ] Calls `ensureDefaultDatabase()`, then sets state and dispatches `deepscout:db-healed` (Fallback 2).
  - [ ] Error path uses `logActionRef.current("ERROR", ...)` — does NOT crash.
  - [ ] ESLint suppression comment present.
- [ ] Select `onChange` persists **both** `deepscout_last_opened_db` and `deepscout_last_game_id`.
- [ ] Previous Game `onClick` persists `deepscout_last_game_id`.
- [ ] Next Game `onClick` persists `deepscout_last_game_id`.
- [ ] L569–570: `{/* Bottom Click & Debug Logger Console */}` and `<ClickLogConsole />` **deleted**.
- [ ] Surrounding `</div>` (L571) intact.
- [ ] `useClickLogger()` on L40 **intact**.
- [ ] Wing props `onToggleDebugConsole` and `isConsoleOpen` **intact**.
- [ ] All `logAction(...)` calls throughout App.tsx **intact**.

### Type safety
- [ ] `tsc --noEmit` exits 0.
- [ ] No new ESLint warnings (other than the one explicitly suppressed).

---

## 10. Expected Diff Summary

```
core/api/main.py
  + 11 lines : POST /api/v1/databases/ensure-default route     (after L83)

src/lib/api.ts
  + 4 lines  : ensureDefaultDatabase export                    (after L63)

src/App.tsx
  - 1 line   : ClickLogConsole import deleted                  (L14)
  ~ 1 line   : import adds ensureDefaultDatabase               (L18)
  ~ 3 lines  : gameId useState → lazy initializer              (L46)
  ~ 3 lines  : activeGameDb useState → lazy initializer        (L47)
  + 32 lines : mount-time useEffect (3-tier fallback)          (L98~)
  ~ 1 line   : select onChange adds 2x localStorage.setItem   (L222~)
  ~ 1 line   : prev-game onClick adds localStorage.setItem     (L255~)
  ~ 1 line   : next-game onClick adds localStorage.setItem     (L270~)
  - 2 lines  : ClickLogConsole JSX + comment deleted           (L569–570)
────────────────────────────────────────────────────────────────
  Net: +53 lines insertion, -3 lines deletion across 3 files.
  Zero JSX layout changes. Zero Tailwind class mutations.
```

---

## 11. ISSUES_LOG.md Entry (complete after execution)

```
| **ANALYSIS-INIT** | `src/App.tsx`, `src/lib/api.ts`, `core/api/main.py` | 🟡 High |
| (A) Debug console banner consumes viewport on every view. (B) Analysis DB hardcoded to patriciaTourny.sqlite; no localStorage persistence, no last-game restoration, no fallback if db deleted. |
| (A) <ClickLogConsole /> unconditionally rendered in workspace div. (B) activeGameDb and gameId use static literal initializers; no mount-time validation; manual switches not persisted. |
| (A) Deleted <ClickLogConsole /> JSX and its import; all telemetry hooks, Wing toggle, and ClickLoggerProvider untouched. (B) Lazy useState initializers read localStorage on mount; mount useEffect validates storedDb against live dbList (Primary → Fallback 1: sparring.sqlite → Fallback 2: POST ensure-default self-heals); all navigation and db-switch handlers persist both localStorage keys. New backend route POST /api/v1/databases/ensure-default + ensureDefaultDatabase() ts export added. |
| ✅ Fixed & Verified |
```
