"""
DSD-46 - Polyglot-to-SQLite Ingestion & Candidate Book Query Service.

Parses standard 16-byte Polyglot opening book entries, decodes UCI moves
from the packed bitfield encoding, and writes them to a SQLite `book_moves`
table for fast FEN-keyed lookups during live sparring sessions.
"""

import struct
import sqlite3
import os
import chess
from typing import Optional


# ---------------------------------------------------------------------------
# Polyglot binary constants
# ---------------------------------------------------------------------------

POLY_ENTRY_SIZE = 16  # 8 (key) + 2 (move) + 2 (weight) + 4 (learn)
PROMO_PIECES = {1: "n", 2: "b", 3: "r", 4: "q"}


# ---------------------------------------------------------------------------
# Polyglot move decoding
# ---------------------------------------------------------------------------

def _decode_poly_move_uci(raw_move: int) -> Optional[str]:
    """Decode a 16-bit Polyglot move bitfield into a UCI string.

    Bit layout (from LSB):
      [2:0]   to_file      (0=a .. 7=h)
      [5:3]   to_row       (0=rank1 .. 7=rank8)
      [8:6]   from_file
      [11:9]  from_row
      [14:12] promotion    (0=none, 1=n, 2=b, 3=r, 4=q)
    """
    to_file   = (raw_move)       & 0x7
    to_row    = (raw_move >> 3)  & 0x7
    from_file = (raw_move >> 6)  & 0x7
    from_row  = (raw_move >> 9)  & 0x7
    promo_idx = (raw_move >> 12) & 0x7

    from_sq = chess.square(from_file, from_row)
    to_sq   = chess.square(to_file, to_row)

    uci = chess.square_name(from_sq) + chess.square_name(to_sq)
    if promo_idx in PROMO_PIECES:
        uci += PROMO_PIECES[promo_idx]
    return uci


def _normalize_fen(fen: str) -> str:
    """Strip halfmove clock and fullmove number from FEN, keeping the first 4 fields."""
    parts = fen.split()
    return " ".join(parts[:4])


# ---------------------------------------------------------------------------
# SQLite connection & schema initialiser
# ---------------------------------------------------------------------------

def _get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout = 10000;")
        conn.execute("PRAGMA synchronous = NORMAL;")
    except Exception:
        pass
    return conn


def _init_book_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS book_moves (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            zobrist_key   TEXT NOT NULL,
            fen_normalized TEXT,
            move_uci      TEXT NOT NULL,
            move_san      TEXT,
            weight        INTEGER NOT NULL DEFAULT 0,
            eval_cp       INTEGER,
            acpl          INTEGER,
            avg_elo       INTEGER
        );
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_book_fen ON book_moves(fen_normalized);"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_book_zobrist ON book_moves(zobrist_key);"
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Polyglot to SQLite ingestion
# ---------------------------------------------------------------------------

def import_bin_to_sqlite(bin_path: str, db_path: str) -> dict:
    """Read a Polyglot .bin file and write all entries into a SQLite `book_moves` table.

    Args:
        bin_path: Absolute path to a Polyglot .bin opening book.
        db_path:  Absolute path to the target SQLite database (created if absent).

    Returns:
        A summary dict: {"imported": int, "skipped": int, "db_path": str}
    """
    if not os.path.exists(bin_path):
        raise FileNotFoundError(f"Polyglot book not found: {bin_path}")

    file_size = os.path.getsize(bin_path)
    total_entries = file_size // POLY_ENTRY_SIZE

    rows = []
    skipped = 0

    with open(bin_path, "rb") as fh:
        for _ in range(total_entries):
            raw = fh.read(POLY_ENTRY_SIZE)
            if len(raw) < POLY_ENTRY_SIZE:
                break

            key, raw_move, weight, learn = struct.unpack(">QHHI", raw)

            if weight == 0:
                skipped += 1
                continue

            uci = _decode_poly_move_uci(raw_move)
            if not uci:
                skipped += 1
                continue

            rows.append((
                str(key),   # zobrist_key (stored as text for portability)
                None,       # fen_normalized - populated by the query endpoint
                uci,        # move_uci
                None,       # move_san - resolved at probe time
                weight,     # weight
                None,       # eval_cp - unanalyzed
                None,       # acpl    - unanalyzed
                None,       # avg_elo - unanalyzed
            ))

    conn = _get_connection(db_path)
    try:
        _init_book_schema(conn)
        conn.executemany(
            """INSERT INTO book_moves
                   (zobrist_key, fen_normalized, move_uci, move_san, weight, eval_cp, acpl, avg_elo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "imported": len(rows),
        "skipped": skipped,
        "db_path": db_path,
    }


# ---------------------------------------------------------------------------
# FEN-keyed candidate lookup (used by the /candidates endpoint)
# ---------------------------------------------------------------------------

def query_candidates(db_path: str, fen: str) -> list:
    """Return all book_moves rows matching the normalised FEN, with popularity %.

    Args:
        db_path: Absolute path to the SQLite book_moves database.
        fen:     Raw FEN string (halfmove/fullmove fields are stripped internally).

    Returns:
        List of candidate dicts sorted by weight descending:
          {move_uci, move_san, weight, popularity_pct, eval_cp, acpl, avg_elo}
    """
    if not os.path.exists(db_path):
        return []

    normalized = _normalize_fen(fen)

    conn = _get_connection(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT move_uci, move_san, weight, eval_cp, acpl, avg_elo "
            "FROM book_moves WHERE fen_normalized = ? ORDER BY weight DESC",
            (normalized,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return []

    total_weight = sum(r["weight"] for r in rows)

    candidates = []
    for r in rows:
        pop_pct = round((r["weight"] / total_weight) * 100, 1) if total_weight > 0 else 0.0
        candidates.append({
            "move_uci":      r["move_uci"],
            "move_san":      r["move_san"],
            "weight":        r["weight"],
            "popularity_pct": pop_pct,
            "eval_cp":       r["eval_cp"],
            "acpl":          r["acpl"],
            "avg_elo":       r["avg_elo"],
        })

    return candidates