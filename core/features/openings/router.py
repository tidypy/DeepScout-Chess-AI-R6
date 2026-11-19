from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
import os
import sqlite3
import chess
from core.features.openings.fashion_service import OpeningFashionService
from core.features.openings.opening_book_service import OpeningBookService
from core.features.openings.polyglot_service import query_candidates

router = APIRouter(prefix="/api/v1/openings", tags=["Opening Fashion & Polyglot Books"])

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_DB = os.path.join(ROOT_DIR, "patriciaTourny.sqlite")

book_service = OpeningBookService(ROOT_DIR)

class SetActiveBookRequest(BaseModel):
    book_name: str = Field(..., description="Filename or name of opening book (.bin)")

class ImportBookTextRequest(BaseModel):
    filename: str = Field(..., description="Target filename (e.g. MyRepertoire.bin)")
    base64_data: Optional[str] = Field(None, description="Base64 encoded binary data")

def get_fashion_service(db_name: Optional[str] = None) -> OpeningFashionService:
    db_path = os.path.join(ROOT_DIR, db_name) if db_name else DEFAULT_DB
    if not os.path.exists(db_path):
        candidates = [os.path.join(ROOT_DIR, f) for f in os.listdir(ROOT_DIR) if f.endswith((".sqlite", ".db"))]
        if candidates:
            db_path = candidates[0]
        else:
            alt = os.path.join(ROOT_DIR, "Resources", "IntFiles", db_name or "Miniatures.sqlite")
            if os.path.exists(alt):
                db_path = alt
    return OpeningFashionService(db_path)

@router.get("/fashion")
def get_fashion_index(
    eco: Optional[str] = Query("B20"),
    system_name: Optional[str] = Query(None),
    time_range: str = Query("full"),
    db_name: Optional[str] = None,
):
    try:
        service = get_fashion_service(db_name)
        return service.get_fashion_index(eco=eco, system_name=system_name, time_range=time_range)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/pioneer")
def get_opening_pioneer(
    fen: Optional[str] = Query(None),
    db_name: Optional[str] = None,
):
    try:
        service = get_fashion_service(db_name)
        return service.get_opening_pioneer(fen=fen)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# =========================================================================
# Polyglot Opening Books Management & Probing
# =========================================================================

@router.get("/books/list")
def list_opening_books() -> List[Dict[str, Any]]:
    """Lists all available built-in and user-imported Polyglot opening books."""
    try:
        return book_service.list_books()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/books/active")
def get_active_opening_book() -> Dict[str, Any]:
    """Retrieves the currently active opening book."""
    try:
        return book_service.get_active_book()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/books/active")
def set_active_opening_book(req: SetActiveBookRequest) -> Dict[str, Any]:
    """Sets the active opening book."""
    try:
        return book_service.set_active_book(req.book_name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/books/import")
async def import_opening_book(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Uploads and saves a Polyglot .bin opening book into user storage."""
    try:
        content = await file.read()
        return await run_in_threadpool(book_service.import_book, file.filename or "custom_book.bin", content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import opening book: {str(e)}")

@router.get("/books/probe")
def probe_opening_book(
    fen: str = Query(..., description="Board FEN to probe"),
    book_name: Optional[str] = Query(None, description="Optional specific book name"),
) -> Dict[str, Any]:
    """Probes the opening book for candidate moves on a position."""
    try:
        board = chess.Board(fen)
        res = book_service.probe_book(board, book_name=book_name)
        if not res:
            return {"in_book": False, "candidates": []}
        return {"in_book": True, **res}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid FEN or probe failure: {str(e)}")

# =========================================================================
# DSD-46: SQLite Candidate Book Query
# =========================================================================

class BookCandidateResponse(BaseModel):
    move_uci: str
    move_san: Optional[str] = None
    weight: int
    popularity_pct: float
    eval_cp: Optional[int] = None
    acpl: Optional[int] = None
    avg_elo: Optional[int] = None


@router.get("/candidates", response_model=List[BookCandidateResponse])
def get_book_candidates(
    fen: str = Query(..., description="Board FEN to query (halfmove/fullmove stripped internally)"),
    book_db: str = Query(..., description="Filename of the SQLite book database (in ROOT_DIR)"),
) -> List[BookCandidateResponse]:
    """Query the SQLite book_moves table for candidate moves at the given FEN.

    Returns all matching moves ordered by weight, annotated with popularity
    percentage computed as (move_weight / total_weight) * 100.
    """
    db_path = os.path.join(ROOT_DIR, book_db)
    try:
        candidates = query_candidates(db_path, fen)
        return candidates
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Candidate query failed: {str(e)}")


# =========================================================================
# DSD-44: Non-Destructive Takeback & Repertoire Edge Ingestion
# =========================================================================

class SaveRepertoireEdgeRequest(BaseModel):
    book_db: str
    fen: str
    move_uci: str
    move_san: str
    source: str = "USER"
    is_provocation: bool = False
    commentary: Optional[str] = None


@router.post("/repertoire/edge")
def save_repertoire_edge(req: SaveRepertoireEdgeRequest) -> Dict[str, Any]:
    """Inserts or increments a repertoire candidate move edge in the specified SQLite book."""
    try:
        parts = req.fen.strip().split()
        norm_fen = " ".join(parts[:4]) if len(parts) >= 4 else req.fen.strip()

        db_path = req.book_db if os.path.isabs(req.book_db) else os.path.join(ROOT_DIR, req.book_db)
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

        conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
        try:
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS book_moves (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    zobrist_key   TEXT,
                    fen_normalized TEXT,
                    move_uci      TEXT NOT NULL,
                    move_san      TEXT,
                    weight        INTEGER NOT NULL DEFAULT 0,
                    eval_cp       INTEGER,
                    acpl          INTEGER,
                    avg_elo       INTEGER
                );
            """)
            try:
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_book_fen_move ON book_moves(fen_normalized, move_uci);")
                conn.execute("""
                    INSERT INTO book_moves (fen_normalized, move_uci, move_san, weight)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT(fen_normalized, move_uci) DO UPDATE SET weight = weight + 1
                """, (norm_fen, req.move_uci, req.move_san))
            except sqlite3.OperationalError:
                cur = conn.execute("SELECT id FROM book_moves WHERE fen_normalized = ? AND move_uci = ?", (norm_fen, req.move_uci))
                row = cur.fetchone()
                if row:
                    conn.execute("UPDATE book_moves SET weight = weight + 1 WHERE id = ?", (row[0],))
                else:
                    conn.execute("INSERT INTO book_moves (fen_normalized, move_uci, move_san, weight) VALUES (?, ?, ?, 1)", (norm_fen, req.move_uci, req.move_san))
            conn.commit()
        finally:
            conn.close()

        return {"success": True, "message": "Edge saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save repertoire edge: {str(e)}")


