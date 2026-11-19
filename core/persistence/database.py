import os
import sys
import re
import json
import sqlite3
import chess
import chess.pgn
import io
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Union, Tuple

STANDARD_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
PLACEHOLDER_EVAL_SOURCES = {"", "NONE", "?", "UNKNOWN", "N/A"}


def strip_fake_zero_acpl_comments(pgn_text: str) -> str:
    """
    Removes synthetic zero-eval sparring summary comments such as:
      { [%acpl global="0.0" user="0" engine="0"] [%caps ...] [%stats best="0" ...] [%provenance ...] }
    so unanalyzed sparring saves are never misclassified as Tier 3 Gold.
    """
    if not pgn_text:
        return ""

    def _strip_block(match: re.Match) -> str:
        block = match.group(0)
        has_zero_acpl = bool(
            re.search(r'\[%acpl[^\]]*\buser="0(?:\.0+)?"[^\]]*\bengine="0(?:\.0+)?"', block)
            or re.search(r'\[%acpl[^\]]*\bglobal="0(?:\.0+)?"[^\]]*\buser="0(?:\.0+)?"', block)
        )
        if not has_zero_acpl:
            return block
        # If there are no non-zero move quality stats inside this summary comment, drop it completely.
        stats_m = re.search(
            r'\[%stats\s+best="(\d+)"\s+inaccuracy="(\d+)"\s+mistake="(\d+)"\s+blunder="(\d+)"\]',
            block,
        )
        if stats_m and any(int(v) > 0 for v in stats_m.groups()):
            return block
        return ""

    cleaned = re.sub(r'\s*\{[^}]*\[%acpl[^}]*\}', _strip_block, pgn_text)
    cleaned = re.sub(r'\n?\[%acpl[^\]]*\buser="0(?:\.0+)?"[^\]]*\bengine="0(?:\.0+)?"[^\]]*\]', "", cleaned)
    return cleaned


def count_pgn_plies(pgn_text: str) -> int:
    """Counts mainline half-moves (plies) in a PGN string safely."""
    if not pgn_text or not pgn_text.strip():
        return 0
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is not None:
            plies = sum(1 for _ in game.mainline_moves())
            if plies > 0:
                return plies
    except Exception:
        pass

    # Fallback SAN token counter for truncated/non-standard movetext
    stripped = re.sub(r'\[[^\]]*\]', ' ', pgn_text)
    stripped = re.sub(r'\{[^}]*\}', ' ', stripped)
    tokens = stripped.split()
    move_tokens = []
    for tok in tokens:
        t = tok.strip()
        if not t or t in ("1-0", "0-1", "1/2-1/2", "*", "...") or t.startswith("$"):
            continue
        if re.match(r'^\d+\.+$', t):
            continue
        # Strip inline move number prefix like "1.e4"
        t = re.sub(r'^\d+\.+', '', t)
        if t and re.match(r'^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#!?]*)$', t):
            move_tokens.append(t)
    return len(move_tokens)


def set_pgn_header(pgn_text: str, key: str, value: str) -> str:
    """
    Idempotently sets a PGN header `[Key "value"]`, deduplicating any existing
    occurrences of the same header key without corrupting movetext.
    """
    safe_val = str(value).replace('"', "'").replace("\r", " ").replace("\n", " ").strip()
    tag_line = f'[{key} "{safe_val}"]'
    pattern = re.compile(rf'^\[{re.escape(key)}\s+"[^"]*"\]\s*$', re.MULTILINE | re.IGNORECASE)

    if pattern.search(pgn_text):
        # Replace first occurrence and remove any subsequent duplicates
        replaced = [False]

        def _repl(_m: re.Match) -> str:
            if not replaced[0]:
                replaced[0] = True
                return tag_line
            return ""

        out = pattern.sub(_repl, pgn_text)
        out = re.sub(r'\n{3,}', '\n\n', out)
        return out

    # Insert into existing header block (preferring right after [Result "..."])
    result_m = re.search(r'^(\[Result\s+"[^"]*"\])$', pgn_text, re.MULTILINE)
    if result_m:
        idx = result_m.end()
        return pgn_text[:idx] + "\n" + tag_line + pgn_text[idx:]

    # Otherwise append after the last header line
    lines = pgn_text.splitlines()
    last_header_idx = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("[") and line.strip().endswith("]"):
            last_header_idx = i
        elif line.strip() and last_header_idx >= 0:
            break

    if last_header_idx >= 0:
        lines.insert(last_header_idx + 1, tag_line)
        return "\n".join(lines)

    return f"{tag_line}\n\n{pgn_text.lstrip()}"


def remove_pgn_header(pgn_text: str, key: str) -> str:
    """Removes all occurrences of a PGN header `[Key "..."]`."""
    pattern = re.compile(rf'^\[{re.escape(key)}\s+"[^"]*"\]\r?\n?', re.MULTILINE | re.IGNORECASE)
    return pattern.sub("", pgn_text)


def normalize_pgn_date(raw_date: Optional[str], fallback_today: bool = False) -> str:
    """Normalizes dates into PGN standard `YYYY.MM.DD` format."""
    if not raw_date or not str(raw_date).strip():
        return datetime.now(timezone.utc).strftime("%Y.%m.%d") if fallback_today else "????.??.??"
    d = str(raw_date).strip().replace("-", ".").replace("/", ".")
    parts = d.split(".")
    if len(parts) == 3:
        year = parts[0] if len(parts[0]) == 4 and parts[0].isdigit() else "????"
        month = parts[1].zfill(2) if parts[1].isdigit() and 1 <= int(parts[1]) <= 12 else "??"
        day = parts[2].zfill(2) if parts[2].isdigit() and 1 <= int(parts[2]) <= 31 else "??"
        if year == "????" and fallback_today:
            return datetime.now(timezone.utc).strftime("%Y.%m.%d")
        return f"{year}.{month}.{day}"
    if len(parts) == 1 and len(parts[0]) == 4 and parts[0].isdigit():
        return f"{parts[0]}.??.??"
    return datetime.now(timezone.utc).strftime("%Y.%m.%d") if fallback_today else "????.??.??"


def infer_eco_and_opening(
    pgn_or_moves: str,
    current_eco: Optional[str] = None,
    current_opening: Optional[str] = None,
) -> Tuple[str, str]:
    """Extracts or infers a standard ECO code and clean opening name."""
    eco_clean = (current_eco or "").strip().upper()
    opening_clean = (current_opening or "").strip()
    if re.search(r'\.(bin|ctg|obk)$', opening_clean, re.IGNORECASE):
        opening_clean = ""

    if re.match(r'^[A-E]\d{2}$', eco_clean) and eco_clean != "A00":
        return eco_clean, opening_clean or "Classified System"

    # Strip headers/comments to inspect first moves cleanly
    ms = re.sub(r'\[[^\]]*\]', ' ', pgn_or_moves or "")
    ms = re.sub(r'\{[^}]*\}', ' ', ms)
    ms = re.sub(r'\s+', ' ', ms).strip().lower()

    if "1. e4 c5" in ms or "1.e4 c5" in ms:
        return "B20", opening_clean or "Sicilian Defense"
    if "1. e4 e5" in ms or "1.e4 e5" in ms:
        if "2. nf3 nc6 3. bb5" in ms or "3.bb5" in ms:
            return "C60", opening_clean or "Ruy Lopez"
        if "2. nf3 nc6 3. bc4" in ms or "3.bc4" in ms:
            return "C50", opening_clean or "Italian Game"
        return "C20", opening_clean or "Open Game"
    if "1. e4 e6" in ms or "1.e4 e6" in ms:
        return "C00", opening_clean or "French Defense"
    if "1. e4 c6" in ms or "1.e4 c6" in ms:
        return "B10", opening_clean or "Caro-Kann Defense"
    if "1. d4 d5" in ms or "1.d4 d5" in ms:
        if "2. c4" in ms:
            return "D06", opening_clean or "Queen's Gambit"
        return "D00", opening_clean or "Queen's Pawn Game"
    if "1. d4 nf6" in ms or "1.d4 nf6" in ms:
        if "2. c4 g6" in ms:
            return "E60", opening_clean or "King's Indian Defense"
        if "2. c4 e6" in ms:
            return "E00", opening_clean or "Nimzo/Queen's Indian"
        return "A45", opening_clean or "Indian Defense"
    if "1. c4" in ms or "1.c4" in ms:
        return "A10", opening_clean or "English Opening"
    if "1. nf3" in ms or "1.nf3" in ms:
        return "A04", opening_clean or "Reti Opening"
    return "A00", opening_clean or "Standard Opening"


def has_genuine_gold_eval(pgn_text: str, ply_count: Optional[int] = None) -> bool:
    """
    Returns True ONLY when a game contains genuine engine evaluations and
    non-placeholder telemetry—never fooled by synthetic zero-ACPL sparring
    stubs, clock-only comments, or partial engine-move-only sparring evals.
    """
    if not pgn_text:
        return False

    cleaned = strip_fake_zero_acpl_comments(pgn_text)
    plies = ply_count if (ply_count is not None and ply_count > 0) else count_pgn_plies(cleaned)

    tier_m = re.search(r'\[DataTier\s+"([^"]*)"\]', cleaned, re.IGNORECASE)
    declared_tier = tier_m.group(1).strip().lower() if tier_m else ""

    eval_matches = re.findall(r'\[%eval\s+[+-]?(?:\d+(?:\.\d+)?|#[-+]?\d+)\]', cleaned)
    eval_count = len(eval_matches)

    eval_source_m = re.search(r'\[EvalSource\s+"([^"]*)"\]', cleaned, re.IGNORECASE)
    eval_source_val = eval_source_m.group(1).strip() if eval_source_m else ""
    has_non_placeholder_eval_source = eval_source_val.upper() not in PLACEHOLDER_EVAL_SOURCES

    has_provenance = bool(re.search(r'\[%provenance\s+engine="[^"]+"', cleaned))
    has_nonzero_acpl = bool(
        re.search(r'\[%acpl[^\]]*\bglobal="(?!0(?:\.0+)?")([0-9]+(?:\.[0-9]+)?)"', cleaned)
    )

    is_sparring = bool(
        re.search(r'\[Event\s+"[^"]*Sparring[^"]*"\]', cleaned, re.IGNORECASE)
        or re.search(r'\[Site\s+"DeepScout Arena"\]', cleaned, re.IGNORECASE)
        or "[%sparring" in cleaned
        or declared_tier in ("silver", "gold")
    )

    # Full-game ply coverage threshold: at least 80% of plies (min 2) must carry [%eval ...]
    # This cleanly distinguishes true full-game analysis from unanalyzed sparring games where
    # only the engine's own replies (~50% of plies) carried live move evals.
    full_ply_eval_coverage = plies >= 2 and eval_count >= max(2, int(plies * 0.8))

    if is_sparring:
        if declared_tier == "silver" and not (full_ply_eval_coverage and (has_non_placeholder_eval_source or has_provenance)):
            return False
        return bool(full_ply_eval_coverage and (has_non_placeholder_eval_source or has_provenance))

    # Non-sparring tournament/imported PGNs:
    if full_ply_eval_coverage:
        return True
    if eval_count >= 2 and (has_non_placeholder_eval_source or has_provenance):
        return True
    if has_provenance and has_nonzero_acpl and declared_tier != "silver":
        return True
    return False


def extract_pgn_metadata(
    pgn_text: str,
    fallback_today_date: bool = False,
    is_sparring: bool = False,
) -> Dict[str, Any]:
    """Extracts standardized Seven Tag Roster + SQL column metadata from PGN text."""
    def _hdr(tag: str, default: str = "") -> str:
        m = re.search(rf'^\[{re.escape(tag)}\s+"([^"]*)"\]', pgn_text or "", re.MULTILINE)
        return m.group(1).strip() if m else default

    white = _hdr("White", "")
    black = _hdr("Black", "")
    result = _hdr("Result", "*") or "*"
    event = _hdr("Event", "DeepScout Engine Sparring" if is_sparring else "PGN Game")
    site = _hdr("Site", "DeepScout Arena" if is_sparring else "Local")
    date_val = normalize_pgn_date(_hdr("Date", ""), fallback_today=fallback_today_date)
    raw_round = _hdr("Round", "-")
    if is_sparring and raw_round in ("", "?", "1"):
        round_val = "-"
    else:
        round_val = raw_round or "-"

    raw_eco = _hdr("ECO", "")
    raw_opening = _hdr("Opening", "")
    eco, opening = infer_eco_and_opening(pgn_text, raw_eco, raw_opening)

    white_elo_raw = _hdr("WhiteElo", "")
    black_elo_raw = _hdr("BlackElo", "")
    white_elo = int(white_elo_raw) if white_elo_raw.isdigit() else None
    black_elo = int(black_elo_raw) if black_elo_raw.isdigit() else None

    fen_val = _hdr("FEN", "")
    game_id = _hdr("GameId", "")
    plycount = count_pgn_plies(pgn_text)

    return {
        "WHITE": white,
        "BLACK": black,
        "RESULT": result,
        "EVENT": event,
        "SITE": site,
        "DATE": date_val,
        "ROUND": round_val,
        "ECO": eco,
        "OPENING": opening,
        "WHITEELO": white_elo,
        "BLACKELO": black_elo,
        "PLYCOUNT": plycount,
        "FEN": fen_val,
        "GAME_ID": game_id,
    }

def decode_xpv(xpv_str: str) -> str:
    """Decodes the XPV compact ASCII move encoding (a 2-byte-per-move format originating from the Lucas Chess open-source project) into standard SAN notation."""
    if not xpv_str or not isinstance(xpv_str, str):
        return ""
    if xpv_str.startswith("|"):
        parts = xpv_str.split("|")
        fen = parts[1] if len(parts) > 2 else ""
        xpv = parts[2] if len(parts) > 2 else parts[1]
    else:
        fen = ""
        xpv = xpv_str

    try:
        board = chess.Board(fen) if fen else chess.Board()
        moves = []
        i = 0
        while i < len(xpv) - 1:
            c1, c2 = xpv[i], xpv[i + 1]
            from_idx = ord(c1) - 58
            to_idx = ord(c2) - 58
            if 0 <= from_idx <= 63 and 0 <= to_idx <= 63:
                from_sq = chess.square(from_idx % 8, from_idx // 8)
                to_sq = chess.square(to_idx % 8, to_idx // 8)
                move = chess.Move(from_sq, to_sq)
                if move not in board.legal_moves:
                    for prom in [chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT]:
                        pmove = chess.Move(from_sq, to_sq, promotion=prom)
                        if pmove in board.legal_moves:
                            move = pmove
                            break
                if move in board.legal_moves:
                    san = board.san(move)
                    board.push(move)
                    moves.append(san)
                else:
                    break
            i += 2
        return " ".join([f"{(idx // 2) + 1}. {m}" if idx % 2 == 0 else m for idx, m in enumerate(moves)])
    except Exception:
        return ""

class GameRepository:
    def __init__(self, db_path: str):
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Database not found at {db_path}")
        self.db_path = db_path
        # Ensure WAL mode once during initialization rather than on every connection
        try:
            with sqlite3.connect(self.db_path, timeout=10.0) as init_conn:
                cur = init_conn.cursor()
                cur.execute("PRAGMA journal_mode;")
                row = cur.fetchone()
                if row and str(row[0]).lower() != "wal":
                    init_conn.execute("PRAGMA journal_mode = WAL;")
        except Exception:
            pass

    @classmethod
    def create_empty_db(cls, db_path: str):
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        conn = sqlite3.connect(db_path, timeout=30.0)
        try:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS Games (
                    WHITE TEXT,
                    BLACK TEXT,
                    RESULT TEXT,
                    EVENT TEXT,
                    SITE TEXT,
                    DATE TEXT,
                    ROUND TEXT,
                    ECO TEXT,
                    OPENING TEXT,
                    WHITEELO INTEGER,
                    BLACKELO INTEGER,
                    PLYCOUNT INTEGER,
                    FEN TEXT,
                    _DATA_ BLOB,
                    game_id TEXT,
                    started_at TEXT,
                    opponent_engine TEXT,
                    user_time_control TEXT,
                    tutor_interrupt_mode TEXT,
                    pgn TEXT
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_games_white ON Games(WHITE);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_games_black ON Games(BLACK);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_games_eco ON Games(ECO);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_games_game_id ON Games(game_id);")
            conn.commit()
        finally:
            conn.close()
        return cls(db_path)

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            conn.create_function("LOWER", 1, lambda s: str(s).lower() if s is not None else None)
            conn.create_function("UPPER", 1, lambda s: str(s).upper() if s is not None else None)
        except Exception:
            pass
        return conn

    def _get_primary_table(self, cur) -> str:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        for cand in ["Games", "games", "variations", "flags", "kibitzer_analysis", "tutor_games"]:
            for t in tables:
                if t.lower() == cand.lower():
                    return t
        return tables[0] if tables else "Games"

    def get_game_by_rowid(self, rowid: Union[int, str]) -> Optional[Dict[str, Any]]:
        """
        Retrieves a single game by ROWID, resolving PGN moves from _DATA_, XPV, or companion tables.
        """
        conn = self._get_connection()
        row = None
        primary_table = "Games"
        try:
            cur = conn.cursor()
            primary_table = self._get_primary_table(cur)

            if primary_table == "variations":
                cur.execute("SELECT ROWID as id, * FROM variations WHERE ROWID = ?", (rowid,))
                row = cur.fetchone()
            elif primary_table == "flags":
                cur.execute("SELECT ROWID as id, * FROM flags WHERE ROWID = ?", (rowid,))
                row = cur.fetchone()
            else:
                is_int = False
                try:
                    int_val = int(rowid)
                    is_int = True
                except (ValueError, TypeError):
                    is_int = False

                if is_int:
                    cur.execute(f"SELECT ROWID, * FROM {primary_table} WHERE ROWID = ?", (int_val,))
                    row = cur.fetchone()

                if not row:
                    try:
                        cur.execute(f"SELECT ROWID, * FROM {primary_table} WHERE game_id = ?", (str(rowid),))
                        row = cur.fetchone()
                    except sqlite3.OperationalError:
                        pass

            prev_rowid: Optional[int] = None
            next_rowid: Optional[int] = None
            if row is not None:
                row_keys = row.keys() if hasattr(row, "keys") else []
                cur_rid = None
                for rk in ("ROWID", "rowid", "id"):
                    if rk in row_keys and isinstance(row[rk], int):
                        cur_rid = row[rk]
                        break
                if cur_rid is not None:
                    try:
                        pr = cur.execute(
                            f"SELECT MAX(ROWID) FROM {primary_table} WHERE ROWID < ?", (cur_rid,)
                        ).fetchone()
                        nr = cur.execute(
                            f"SELECT MIN(ROWID) FROM {primary_table} WHERE ROWID > ?", (cur_rid,)
                        ).fetchone()
                        prev_rowid = pr[0] if pr and pr[0] is not None else None
                        next_rowid = nr[0] if nr and nr[0] is not None else None
                    except Exception:
                        pass
        finally:
            conn.close()

        if not row:
            return None

        row_dict = dict(row)

        if primary_table == "variations":
            created_date = str(row_dict.get("saved_at") or "")[:10].replace("-", ".")
            engine_name = row_dict.get("engine") or "Kibitzer Engine"
            fragment = str(row_dict.get("pgn_fragment") or "").strip()
            fen_pos = row_dict.get("fen") or ""
            ply_num = row_dict.get("ply", 0)
            eval_raw = row_dict.get("eval_data") or ""
            eval_info = ""
            if eval_raw:
                try:
                    eval_data = json.loads(eval_raw) if isinstance(eval_raw, str) else eval_raw
                    score_cp = eval_data.get("score_cp")
                    win_prob = eval_data.get("win_prob")
                    tags = eval_data.get("tags", [])
                    eval_parts = []
                    if score_cp is not None:
                        eval_parts.append(f"[%eval {score_cp / 100.0:+.2f}]")
                    if win_prob is not None:
                        prob_num = win_prob * 100 if win_prob <= 1 else win_prob
                        eval_parts.append(f"[%win_prob {prob_num:.1f}%]")
                    if tags:
                        eval_parts.append(f"[tags: {', '.join(tags)}]")
                    if eval_parts:
                        eval_info = " { " + " ".join(eval_parts) + " }"
                except Exception:
                    pass

            is_black = " b " in fen_pos
            move_num = (ply_num // 2) + 1
            if fragment and not fragment[0].isdigit():
                prefix = f"{move_num}... " if is_black else f"{move_num}. "
                moves_body = f"{prefix}{fragment}{eval_info} *"
            else:
                moves_body = f"{fragment}{eval_info} *"

            pgn_text = f"""[Event "Kibitzer Alternative Analysis"]
[Site "DeepScout Companion Hub"]
[Date "{created_date}"]
[White "{engine_name}"]
[Black "Candidate Variation"]
[Result "*"]
[ECO "-"]
[Opening "Roads Not Taken (Ply {ply_num})"]
[SetUp "1"]
[FEN "{fen_pos}"]

{moves_body}"""
            return {
                "id": rowid,
                "white": engine_name,
                "black": "Candidate Variation",
                "result": "*",
                "date": created_date,
                "event": "Kibitzer Analysis",
                "eco": "",
                "opening": f"Ply {ply_num}",
                "plycount": ply_num,
                "white_elo": "2800",
                "black_elo": "",
                "initial_fen": fen_pos or "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                "pgn": pgn_text,
            }

        if primary_table == "flags":
            created_date = str(row_dict.get("logged_at") or "")[:10].replace("-", ".")
            engine_name = row_dict.get("engine") or "Stockfish 18"
            flag_type_raw = str(row_dict.get("flag_type") or "Tactical Intervention")
            flag_type = flag_type_raw.replace("_", " ").title()
            fen_pos = row_dict.get("fen") or ""
            ply_num = row_dict.get("ply", 0)
            tutor_outcome = str(row_dict.get("tutor_outcome") or "flag_triggered").replace("_", " ").title()

            # Parse centipawn data
            cp_raw = row_dict.get("centipawn_data") or ""
            eval_str = "+0.00"
            loss_cp = 0
            fen_before = ""
            played_san = ""
            if cp_raw:
                try:
                    cp_data = json.loads(cp_raw) if isinstance(cp_raw, str) else cp_raw
                    eval_str = str(cp_data.get("eval", "+0.00"))
                    loss_cp = int(cp_data.get("loss_cp", 0))
                    fen_before = str(cp_data.get("fen_before") or "")
                    played_san = str(cp_data.get("played_san") or "")
                except Exception:
                    pass

            # Newer logs keep the position the suggestion applies to in centipawn_data.fen_before;
            # `fen` is the position after the flagged move. Start the PGN from the former when available.
            if fen_before:
                fen_pos = fen_before
                try:
                    move_num = int(fen_before.split()[-1])
                except Exception:
                    move_num = (ply_num // 2) + 1
            else:
                move_num = (ply_num // 2) + 1
            played_note = f" [Played: {played_san}]" if played_san else ""

            # Parse suggested variations
            variations_raw = row_dict.get("suggested_variations") or ""
            moves_text = ""
            if variations_raw:
                try:
                    vars_parsed = json.loads(variations_raw) if isinstance(variations_raw, str) else variations_raw
                    if isinstance(vars_parsed, list) and len(vars_parsed) > 0:
                        top_var = vars_parsed[0]
                        is_black = " b " in fen_pos
                        prefix = f"{move_num}... " if is_black else f"{move_num}. "
                        if isinstance(top_var, dict):
                            san_move = top_var.get("line") or top_var.get("san") or top_var.get("pv_san") or ""
                            tags_list = top_var.get("tags") or []
                            tags_str = ", ".join(tags_list) if tags_list else "best"
                            loss_txt = f" (-{loss_cp} cp)" if loss_cp else ""
                            moves_text = f"{prefix}{san_move} {{ [%eval {eval_str}] [Tutor Suggestion: {flag_type}{loss_txt}]{played_note} [Tags: {tags_str}] }} *"
                        elif isinstance(top_var, str):
                            moves_text = f"{prefix}{top_var} {{ [%eval {eval_str}] [Tutor Suggestion: {flag_type}]{played_note} }} *"
                except Exception:
                    moves_text = f"1. ... *" if " b " in fen_pos else "1. *"

            if not moves_text:
                moves_text = "1. ... *" if " b " in fen_pos else "1. *"

            pgn_text = f"""[Event "Tutor Intervention: {flag_type}"]
[Site "DeepScout Companion Hub"]
[Date "{created_date}"]
[White "{engine_name}"]
[Black "{flag_type} (Ply {ply_num})"]
[Result "*"]
[ECO "-"]
[Opening "Tutor Feedback: {flag_type} (Outcome: {tutor_outcome})"]
[SetUp "1"]
[FEN "{fen_pos}"]

{moves_text}"""
            return {
                "id": rowid,
                "white": engine_name,
                "black": f"{flag_type} (Ply {ply_num})",
                "result": "*",
                "date": created_date,
                "event": "Tutor Intervention",
                "eco": "",
                "opening": f"Ply {ply_num} ({flag_type})",
                "plycount": ply_num,
                "white_elo": "2500",
                "black_elo": "",
                "initial_fen": fen_pos or "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                "pgn": pgn_text,
            }

        # Standard Games / games table
        data = row_dict.get("_DATA_")
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
        elif row_dict.get("pgn"):
            pgn_text = str(row_dict.get("pgn") or "")

        # Check if actual move text exists outside header tags and bracketed comments
        import re
        stripped_for_check = re.sub(r'\{[^}]*\}', '', pgn_text)
        stripped_for_check = re.sub(r'\[%[^\]]*\]', '', stripped_for_check)
        stripped_for_check = re.sub(r'\[[^\]]*\]', '', stripped_for_check).strip()
        has_actual_moves = bool(re.search(r'\b1\.\s*[a-zA-Z]', stripped_for_check) or re.search(r'\b[a-hKQRBN][a-h1-8x+#=]', stripped_for_check))

        moves_from_xpv = decode_xpv(xpv) if (xpv and not has_actual_moves) else ""

        def get_header(tag: str, fallback: str = "") -> str:
            m = re.search(rf'\[{tag}\s+"([^"]*)"\]', pgn_text)
            return m.group(1) if m else fallback

        event = row_dict.get("EVENT") or get_header("Event", "DeepScout Chess Game")
        site = row_dict.get("SITE") or get_header("Site", "Local")
        date = row_dict.get("DATE") or get_header("Date", "????.??.??")
        white = row_dict.get("WHITE") or get_header("White", "White")
        black = row_dict.get("BLACK") or get_header("Black", "Black")
        result = row_dict.get("RESULT") or get_header("Result", "*")
        eco = row_dict.get("ECO") or get_header("ECO", "")
        opening = row_dict.get("OPENING") or get_header("Opening", "")
        white_elo = row_dict.get("WHITEELO") or get_header("WhiteElo", "")
        black_elo = row_dict.get("BLACKELO") or get_header("BlackElo", "")
        termination = get_header("Termination", "")
        final_eval = get_header("FinalEval", "")
        eval_source = get_header("EvalSource", "")
        player_acpl_val = get_header("PlayerACPL", "")
        engine_acpl_val = get_header("EngineACPL", "")

        header_lines = [
            f'[Event "{event}"]',
            f'[Site "{site}"]',
            f'[Date "{date}"]',
            f'[White "{white}"]',
            f'[Black "{black}"]',
            f'[Result "{result}"]',
        ]
        if white_elo:
            header_lines.append(f'[WhiteElo "{white_elo}"]')
        if black_elo:
            header_lines.append(f'[BlackElo "{black_elo}"]')
        if eco:
            header_lines.append(f'[ECO "{eco}"]')
        if opening:
            header_lines.append(f'[Opening "{opening}"]')
        if termination:
            header_lines.append(f'[Termination "{termination}"]')
        if final_eval:
            header_lines.append(f'[FinalEval "{final_eval}"]')
        if eval_source:
            header_lines.append(f'[EvalSource "{eval_source}"]')
        if player_acpl_val:
            header_lines.append(f'[PlayerACPL "{player_acpl_val}"]')
        if engine_acpl_val:
            header_lines.append(f'[EngineACPL "{engine_acpl_val}"]')

        if moves_from_xpv:
            body_content = moves_from_xpv + f" {result}"
            if pgn_text and ("[%acpl" in pgn_text or "[%eval" in pgn_text or "[%provenance" in pgn_text):
                body_content += "\n\n" + pgn_text.strip()
            full_pgn = "\n".join(header_lines) + "\n\n" + body_content
        elif has_actual_moves:
            if not pgn_text.strip().startswith("["):
                full_pgn = "\n".join(header_lines) + "\n\n" + pgn_text.strip()
            else:
                full_pgn = pgn_text.strip()
        else:
            body_content = f"1. e4 e5 {result}"
            if pgn_text:
                body_content += "\n\n" + pgn_text.strip()
            full_pgn = "\n".join(header_lines) + "\n\n" + body_content

        # DSD-43: Extract custom starting FEN for tactical setup hydration
        extracted_fen = (
            row_dict.get("FEN")
            or row_dict.get("initial_fen")
            or row_dict.get("setup_fen")
            or ""
        )
        if not extracted_fen:
            fen_tag_match = re.search(r'\[FEN\s+"([^"]+)"\]', pgn_text)
            if fen_tag_match:
                extracted_fen = fen_tag_match.group(1)
        if not extracted_fen:
            extracted_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

        player_acpl = int(player_acpl_val) if (player_acpl_val and player_acpl_val.isdigit()) else None
        engine_acpl = int(engine_acpl_val) if (engine_acpl_val and engine_acpl_val.isdigit()) else None
        actual_id = row_dict.get("game_id") or row_dict.get("ROWID") or rowid

        return {
            "id": actual_id,
            "rowid": row_dict.get("ROWID"),
            "prev_id": prev_rowid,
            "next_id": next_rowid,
            "white": white,
            "black": black,
            "result": result,
            "date": date,
            "event": event,
            "eco": eco,
            "opening": opening,
            "plycount": row_dict.get("PLYCOUNT", 0),
            "white_elo": str(white_elo) if white_elo else "",
            "black_elo": str(black_elo) if black_elo else "",
            "initial_fen": extracted_fen,
            "pgn": full_pgn,
            "termination": termination or None,
            "final_eval": final_eval or None,
            "eval_source": eval_source or None,
            "player_acpl": player_acpl,
            "engine_acpl": engine_acpl,
        }

    get_game = get_game_by_rowid

    def list_games(
        self,
        page: int = 1,
        page_size: int = 50,
        search: Optional[str] = None,
        white: Optional[str] = None,
        black: Optional[str] = None,
        result: Optional[str] = None,
        eco: Optional[str] = None,
        sort_by: str = "ROWID",
        sort_order: str = "ASC",
    ) -> Dict[str, Any]:
        """
        Fast paginated search and filter across SQLite games, variations, or flags.
        """
        conn = self._get_connection()
        try:
            cur = conn.cursor()
            primary_table = self._get_primary_table(cur)

            if primary_table == "variations":
                cur.execute("SELECT COUNT(*) FROM variations")
                total = cur.fetchone()[0]
                offset = max(0, (page - 1) * page_size)
                cur.execute(
                    "SELECT ROWID as id, engine as WHITE, ('Variation at Ply ' || ply) as BLACK, '*' as RESULT, SUBSTR(saved_at, 1, 10) as DATE, ('Kibitzer ' || trigger_source) as EVENT, '' as ECO, pgn_fragment as OPENING, ply as PLYCOUNT, 2800 as WHITEELO, '' as BLACKELO, eval_data, engine FROM variations ORDER BY ROWID DESC LIMIT ? OFFSET ?",
                    [page_size, offset],
                )
                raw_rows = [dict(r) for r in cur.fetchall()]
                rows = []
                for r in raw_rows:
                    eval_raw = r.get("eval_data") or ""
                    score_cp, win_prob = None, None
                    if eval_raw:
                        try:
                            ed = json.loads(eval_raw) if isinstance(eval_raw, str) else eval_raw
                            score_cp = ed.get("score_cp")
                            win_prob = ed.get("win_prob")
                        except Exception:
                            pass
                    eval_str = f"{score_cp / 100.0:+.2f}" if score_cp is not None else None
                    acc_str = f"{(win_prob * 100 if win_prob <= 1 else win_prob):.1f}%" if win_prob is not None else None
                    rows.append({
                        "id": r["id"],
                        "WHITE": r["WHITE"],
                        "BLACK": r["BLACK"],
                        "RESULT": r["RESULT"],
                        "DATE": r["DATE"],
                        "EVENT": r["EVENT"],
                        "ECO": r["ECO"],
                        "OPENING": r["OPENING"],
                        "PLYCOUNT": r["PLYCOUNT"],
                        "WHITEELO": r["WHITEELO"],
                        "BLACKELO": r["BLACKELO"],
                        "tier": "Gold",
                        "acpl": eval_str,
                        "accuracy": acc_str,
                        "final_eval": eval_str,
                        "engine": r.get("engine") or "Kibitzer",
                        "depth": "18",
                        "has_gold_eval": True,
                        "has_silver_stats": True,
                    })
                return {
                    "games": rows,
                    "total": total,
                    "page": page,
                    "page_size": page_size,
                    "total_pages": max(1, (total + page_size - 1) // page_size),
                }

            if primary_table == "flags":
                cur.execute("SELECT COUNT(*) FROM flags")
                total = cur.fetchone()[0]
                offset = max(0, (page - 1) * page_size)
                cur.execute(
                    "SELECT ROWID as id, engine as WHITE, (flag_type || ' at Ply ' || ply) as BLACK, '*' as RESULT, SUBSTR(logged_at, 1, 10) as DATE, ('Tutor ' || tutor_outcome) as EVENT, '' as ECO, flag_type as OPENING, ply as PLYCOUNT, 2500 as WHITEELO, '' as BLACKELO, centipawn_data, engine FROM flags ORDER BY ROWID DESC LIMIT ? OFFSET ?",
                    [page_size, offset],
                )
                raw_rows = [dict(r) for r in cur.fetchall()]
                rows = []
                for r in raw_rows:
                    cp_raw = r.get("centipawn_data") or ""
                    eval_str, loss_cp = None, None
                    if cp_raw:
                        try:
                            cp_data = json.loads(cp_raw) if isinstance(cp_raw, str) else cp_raw
                            eval_str = str(cp_data.get("eval", "+0.00"))
                            loss_cp = cp_data.get("loss_cp")
                        except Exception:
                            pass
                    rows.append({
                        "id": r["id"],
                        "WHITE": r["WHITE"],
                        "BLACK": r["BLACK"],
                        "RESULT": r["RESULT"],
                        "DATE": r["DATE"],
                        "EVENT": r["EVENT"],
                        "ECO": r["ECO"],
                        "OPENING": r["OPENING"],
                        "PLYCOUNT": r["PLYCOUNT"],
                        "WHITEELO": r["WHITEELO"],
                        "BLACKELO": r["BLACKELO"],
                        "tier": "Gold",
                        "acpl": f"{loss_cp} cp" if loss_cp is not None else None,
                        "accuracy": None,
                        "final_eval": eval_str,
                        "engine": r.get("engine") or "Tutor",
                        "depth": "16",
                        "has_gold_eval": True,
                        "has_silver_stats": True,
                    })
                return {
                    "games": rows,
                    "total": total,
                    "page": page,
                    "page_size": page_size,
                    "total_pages": max(1, (total + page_size - 1) // page_size),
                }

            # Standard Games / games table
            where_clauses = []
            params = []

            if search:
                search_pattern = f"%{search.strip().lower()}%"
                where_clauses.append(
                    "(LOWER(WHITE) LIKE ? OR LOWER(BLACK) LIKE ? OR LOWER(EVENT) LIKE ? OR LOWER(OPENING) LIKE ?)"
                )
                params.extend([search_pattern, search_pattern, search_pattern, search_pattern])

            if white:
                where_clauses.append("LOWER(WHITE) LIKE ?")
                params.append(f"%{white.strip().lower()}%")

            if black:
                where_clauses.append("LOWER(BLACK) LIKE ?")
                params.append(f"%{black.strip().lower()}%")

            if result:
                where_clauses.append("RESULT = ?")
                params.append(result.strip())

            if eco:
                where_clauses.append("UPPER(ECO) LIKE ?")
                params.append(f"{eco.strip().upper()}%")

            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

            valid_cols = {"ROWID", "WHITE", "BLACK", "RESULT", "DATE", "ECO", "OPENING", "PLYCOUNT", "WHITEELO", "BLACKELO"}
            sort_str = str(sort_by).upper() if sort_by else "ROWID"
            order_str = str(sort_order).upper() if sort_order else "ASC"
            clean_sort = sort_str if sort_str in valid_cols else "ROWID"
            clean_order = "DESC" if order_str == "DESC" else "ASC"

            # Check if _DATA_ and/or pgn column is available for Data Fitness metrics
            cur.execute(f"PRAGMA table_info({primary_table})")
            table_cols = {col[1] for col in cur.fetchall()}
            has_data_col = "_DATA_" in table_cols
            has_pgn_col = "pgn" in table_cols
            if has_data_col and has_pgn_col:
                data_col_expr = ", COALESCE(NULLIF(_DATA_, ''), pgn) as _DATA_"
            elif has_data_col:
                data_col_expr = ", _DATA_"
            elif has_pgn_col:
                data_col_expr = ", pgn as _DATA_"
            else:
                data_col_expr = ""

            # Count total
            cur.execute(f"SELECT COUNT(*) FROM {primary_table} {where_sql}", params)
            total = cur.fetchone()[0]

            # Fetch page
            offset = max(0, (page - 1) * page_size)
            cur.execute(
                f"SELECT ROWID as id, WHITE, BLACK, RESULT, DATE, EVENT, ECO, OPENING, PLYCOUNT, WHITEELO, BLACKELO{data_col_expr} FROM {primary_table} {where_sql} ORDER BY {clean_sort} {clean_order} LIMIT ? OFFSET ?",
                params + [page_size, offset],
            )
            raw_rows = [dict(r) for r in cur.fetchall()]
            rows = []
            for r in raw_rows:
                raw_data = r.get("_DATA_")
                data_str = ""
                if raw_data:
                    if isinstance(raw_data, bytes):
                        data_str = raw_data.decode("utf-8", errors="replace")
                    else:
                        data_str = str(raw_data)

                cleaned_data = strip_fake_zero_acpl_comments(data_str)

                white = (r.get("WHITE") or "").strip()
                black = (r.get("BLACK") or "").strip()
                res_val = (r.get("RESULT") or "").strip()
                date_val = (r.get("DATE") or "").strip()
                event_val = (r.get("EVENT") or "").strip()
                eco = (r.get("ECO") or "").strip()
                opening_val = (r.get("OPENING") or "").strip()
                ply = int(r.get("PLYCOUNT") or 0)
                w_elo = str(r.get("WHITEELO") or "").strip()
                b_elo = str(r.get("BLACKELO") or "").strip()

                # Hydrate missing SQL metadata from PGN text when legacy/companion columns were NULL
                if cleaned_data and (not white or not black or ply < 2 or not date_val or not eco):
                    meta = extract_pgn_metadata(cleaned_data)
                    if not white:
                        white = meta["WHITE"]
                    if not black:
                        black = meta["BLACK"]
                    if not res_val:
                        res_val = meta["RESULT"]
                    if not date_val:
                        date_val = meta["DATE"]
                    if not event_val:
                        event_val = meta["EVENT"]
                    if not eco or eco == "-":
                        eco = meta["ECO"]
                    if not opening_val:
                        opening_val = meta["OPENING"]
                    if ply < 2:
                        ply = meta["PLYCOUNT"]
                    if not w_elo and meta["WHITEELO"] is not None:
                        w_elo = str(meta["WHITEELO"])
                    if not b_elo and meta["BLACKELO"] is not None:
                        b_elo = str(meta["BLACKELO"])

                acpl_m = re.search(r'\[%acpl\s+global="([^"]+)"', cleaned_data) or re.search(r'\[(?:Player|Engine)ACPL\s+"([^"]+)"\]', cleaned_data)
                caps_m = re.search(r'\[%caps\s+accuracy="([^"]+)"', cleaned_data) or re.search(r'\[(?:Total|White)Accuracy\s+"([^"]+)"\]', cleaned_data)
                eval_m = re.search(r'\[FinalEval\s+"([^"]+)"\]', cleaned_data) or re.search(r'\[%eval\s+([^\]]+)\]', cleaned_data)
                prov_m = re.search(r'\[%provenance\s+engine="([^"]+)"', cleaned_data) or re.search(r'\[EvalSource\s+"([^"]+)"\]', cleaned_data)
                depth_m = re.search(r'depth="([^"]+)"', cleaned_data)

                has_gold = has_genuine_gold_eval(cleaned_data, ply_count=ply)
                declared_silver = bool(re.search(r'\[DataTier\s+"Silver"\]', cleaned_data, re.IGNORECASE))
                has_valid_str = bool(
                    ply >= 2
                    and white
                    and black
                    and white != "?"
                    and black != "?"
                )

                if has_gold:
                    tier = "Gold"
                elif declared_silver and has_valid_str:
                    tier = "Silver"
                elif has_valid_str and ((eco and eco not in ("A00", "-")) or w_elo.isdigit() or b_elo.isdigit()):
                    tier = "Silver"
                elif has_valid_str:
                    tier = "Bronze"
                else:
                    tier = "Raw"

                eval_source_str = prov_m.group(1) if prov_m else None
                if eval_source_str and eval_source_str.strip().upper() in PLACEHOLDER_EVAL_SOURCES:
                    eval_source_str = None

                rows.append({
                    "id": r["id"],
                    "WHITE": white or r["WHITE"],
                    "BLACK": black or r["BLACK"],
                    "RESULT": res_val or r["RESULT"],
                    "DATE": date_val or r["DATE"],
                    "EVENT": event_val or r["EVENT"],
                    "ECO": eco or r["ECO"],
                    "OPENING": opening_val or r["OPENING"],
                    "PLYCOUNT": ply if ply else r["PLYCOUNT"],
                    "WHITEELO": w_elo or r["WHITEELO"],
                    "BLACKELO": b_elo or r["BLACKELO"],
                    "tier": tier,
                    "acpl": acpl_m.group(1) if (has_gold and acpl_m) else None,
                    "accuracy": caps_m.group(1) if (has_gold and caps_m) else None,
                    "final_eval": eval_m.group(1) if eval_m else None,
                    "engine": eval_source_str,
                    "depth": depth_m.group(1) if (has_gold and depth_m) else None,
                    "has_gold_eval": bool(has_gold),
                    "has_silver_stats": bool(tier in ("Silver", "Gold")),
                })

            total_pages = max(1, (total + page_size - 1) // page_size)

            return {
                "games": rows,
                "total": total,
                "page": page,
                "page_size": page_size,
                "total_pages": total_pages,
            }
        except Exception as e:
            return {
                "games": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "total_pages": 1,
                "error": str(e),
            }
        finally:
            conn.close()

    def list_players(self, search: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Extracts distinct players and game counts with fast union query.
        """
        conn = self._get_connection()
        try:
            cur = conn.cursor()

            sql = """
                SELECT player, COUNT(*) as games_count FROM (
                    SELECT TRIM(WHITE) as player FROM Games WHERE WHITE IS NOT NULL AND TRIM(WHITE) != ''
                    UNION ALL
                    SELECT TRIM(BLACK) as player FROM Games WHERE BLACK IS NOT NULL AND TRIM(BLACK) != ''
                )
            """
            params = []
            if search:
                sql += " WHERE LOWER(player) LIKE ?"
                params.append(f"%{search.strip().lower()}%")

            sql += " GROUP BY player ORDER BY games_count DESC, UPPER(player) ASC LIMIT ?"
            params.append(limit)

            cur.execute(sql, params)
            return [{"player": r[0], "count": r[1]} for r in cur.fetchall()]
        except Exception:
            return []
        finally:
            conn.close()

    def get_database_stats(self) -> Dict[str, Any]:
        """
        Computes summary metrics for the active database.
        """
        conn = self._get_connection()
        try:
            cur = conn.cursor()
            primary_table = self._get_primary_table(cur)

            if primary_table == "variations":
                cur.execute("SELECT COUNT(*) FROM variations")
                total = cur.fetchone()[0]
                cur.execute("SELECT engine, COUNT(*) FROM variations GROUP BY engine")
                engine_counts = {r[0]: r[1] for r in cur.fetchall()}
                return {
                    "total_games": total,
                    "results": {"*": total},
                    "top_openings": [{"eco": "VAR", "opening": k, "count": v} for k, v in list(engine_counts.items())[:5]],
                    "path": os.path.basename(self.db_path),
                }

            if primary_table == "flags":
                cur.execute("SELECT COUNT(*) FROM flags")
                total = cur.fetchone()[0]
                cur.execute("SELECT flag_type, COUNT(*) FROM flags GROUP BY flag_type")
                flag_counts = {r[0]: r[1] for r in cur.fetchall()}
                return {
                    "total_games": total,
                    "results": {"*": total},
                    "top_openings": [{"eco": "FLAG", "opening": k, "count": v} for k, v in list(flag_counts.items())[:5]],
                    "path": os.path.basename(self.db_path),
                }

            cur.execute(f"SELECT COUNT(*) FROM {primary_table}")
            total_games = cur.fetchone()[0]

            cur.execute(f"SELECT RESULT, COUNT(*) FROM {primary_table} GROUP BY RESULT")
            result_counts = {r[0] or "*": r[1] for r in cur.fetchall()}

            try:
                cur.execute(f"SELECT ECO, OPENING, COUNT(*) as cnt FROM {primary_table} WHERE ECO IS NOT NULL AND ECO != '' GROUP BY ECO, OPENING ORDER BY cnt DESC LIMIT 5")
                top_openings = [{"eco": r[0], "opening": r[1] or r[0], "count": r[2]} for r in cur.fetchall()]
            except Exception:
                top_openings = []

            return {
                "total_games": total_games,
                "results": result_counts,
                "top_openings": top_openings,
                "path": os.path.basename(self.db_path),
            }
        except Exception:
            return {
                "total_games": 0,
                "results": {},
                "top_openings": [],
                "path": os.path.basename(self.db_path),
            }
        finally:
            conn.close()

    def import_pgn(self, pgn_content: str) -> int:
        """
        Imports one or multiple games from PGN text into the SQLite database.
        Enforces honest Silver/Gold tiering, strips fake zero-ACPL stubs,
        and performs non-destructive UPSERTs on `game_id` when present.
        """
        pgn_io = io.StringIO(pgn_content)
        imported_count = 0
        conn = self._get_connection()
        try:
            cursor = conn.cursor()
            primary_table = self._get_primary_table(cursor)
            cursor.execute(f"PRAGMA table_info({primary_table})")
            existing_cols = {col[1]: col[1] for col in cursor.fetchall()}
            existing_lower = {c.lower(): c for c in existing_cols}

            while True:
                game = chess.pgn.read_game(pgn_io)
                if game is None:
                    break

                exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
                raw_full_pgn = game.accept(exporter)
                is_sparring = bool(
                    "sparring" in (game.headers.get("Event", "") or "").lower()
                    or (game.headers.get("Site", "") or "").strip() == "DeepScout Arena"
                    or os.path.basename(self.db_path).lower() == "sparring_games.sqlite"
                )

                clean_pgn = strip_fake_zero_acpl_comments(raw_full_pgn)
                meta = extract_pgn_metadata(
                    clean_pgn,
                    fallback_today_date=is_sparring,
                    is_sparring=is_sparring,
                )
                plycount = meta["PLYCOUNT"]
                white = meta["WHITE"] or "Unknown"
                black = meta["BLACK"] or "Unknown"

                # Discard 0-ply/1-ply sparring stubs and 0-ply unknown stubs cleanly
                if is_sparring and plycount < 2:
                    continue
                if plycount == 0 and white in ("?", "Unknown", "") and black in ("?", "Unknown", ""):
                    continue

                # Standardize Seven Tag Roster & honest DataTier header in PGN text
                clean_pgn = set_pgn_header(clean_pgn, "Date", meta["DATE"])
                clean_pgn = set_pgn_header(clean_pgn, "Round", meta["ROUND"])
                clean_pgn = set_pgn_header(clean_pgn, "ECO", meta["ECO"])
                if meta["OPENING"]:
                    clean_pgn = set_pgn_header(clean_pgn, "Opening", meta["OPENING"])

                tier = "Gold" if has_genuine_gold_eval(clean_pgn, ply_count=plycount) else "Silver"
                if is_sparring:
                    clean_pgn = set_pgn_header(clean_pgn, "DataTier", tier)

                col_values: Dict[str, Any] = {
                    "white": white,
                    "black": black,
                    "result": meta["RESULT"],
                    "event": meta["EVENT"],
                    "site": meta["SITE"],
                    "date": meta["DATE"],
                    "round": meta["ROUND"],
                    "eco": meta["ECO"],
                    "opening": meta["OPENING"],
                    "whiteelo": meta["WHITEELO"] if meta["WHITEELO"] is not None else "",
                    "blackelo": meta["BLACKELO"] if meta["BLACKELO"] is not None else "",
                    "plycount": plycount,
                    "fen": meta["FEN"],
                    "_data_": clean_pgn,
                    "pgn": clean_pgn,
                }
                game_id_val = meta["GAME_ID"]
                if game_id_val and game_id_val != "sparring-session":
                    col_values["game_id"] = game_id_val
                    col_values["started_at"] = datetime.now(timezone.utc).isoformat()
                    if is_sparring:
                        opp = black if "human" in white.lower() else white
                        col_values["opponent_engine"] = opp

                # Filter to columns actually present in target table (non-destructive)
                write_pairs = [
                    (existing_lower[k], v)
                    for k, v in col_values.items()
                    if k in existing_lower
                ]

                updated_existing = False
                if game_id_val and game_id_val != "sparring-session" and "game_id" in existing_lower:
                    gid_col = existing_lower["game_id"]
                    cursor.execute(f"SELECT ROWID FROM {primary_table} WHERE {gid_col} = ?", (game_id_val,))
                    found = cursor.fetchone()
                    if found:
                        set_clause = ", ".join(f"{c} = ?" for c, _ in write_pairs)
                        vals = [v for _, v in write_pairs] + [found[0]]
                        cursor.execute(f"UPDATE {primary_table} SET {set_clause} WHERE ROWID = ?", vals)
                        updated_existing = True

                if not updated_existing:
                    cols_sql = ", ".join(c for c, _ in write_pairs)
                    placeholders = ", ".join("?" for _ in write_pairs)
                    cursor.execute(
                        f"INSERT INTO {primary_table} ({cols_sql}) VALUES ({placeholders})",
                        [v for _, v in write_pairs],
                    )
                imported_count += 1

            conn.commit()
        finally:
            conn.close()
        return imported_count

    def append_variation_to_pgn(
        self,
        game_id: Union[int, str],
        ply: int,
        pv_san: str,
        eval_str: Optional[str] = None,
        engine_name: Optional[str] = None,
        depth: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Inserts a Kibitzer variation line as a standard PGN RAV variation `( ... )`
        at the specified 0-based `ply` (number of half-moves already played) and
        atomically persists the updated PGN back to BOTH `_DATA_` and `pgn` columns
        in SQLite without altering table DDL.
        """
        record = self.get_game_by_rowid(game_id)
        if not record:
            raise ValueError(f"Game '{game_id}' not found in {os.path.basename(self.db_path)}.")

        pgn_text = record.get("pgn") or ""
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            game = chess.pgn.Game()
            init_fen = record.get("initial_fen")
            if init_fen and init_fen != STANDARD_START_FEN:
                game.headers["SetUp"] = "1"
                game.headers["FEN"] = init_fen

        # Walk mainline to the parent node at `ply` (0 = start position, 1 = after 1st ply, ...)
        target_ply = max(0, int(ply))
        node: Any = game
        walked = 0
        while walked < target_ply and node.variations:
            node = node.variations[0]
            walked += 1

        # Parse SAN/UCI moves from pv_san starting at node.board()
        board = node.board()
        raw_tokens = [
            tok.strip()
            for tok in re.split(r"\s+", (pv_san or "").strip())
            if tok.strip()
            and not re.match(r"^\d+\.+$", tok.strip())
            and tok.strip() not in ("1-0", "0-1", "1/2-1/2", "*")
        ]
        parsed_moves: List[chess.Move] = []
        for tok in raw_tokens:
            clean_tok = re.sub(r"^\d+\.+", "", tok)
            if not clean_tok:
                continue
            mv = None
            try:
                mv = board.parse_san(clean_tok)
            except Exception:
                try:
                    cand = chess.Move.from_uci(clean_tok)
                    if cand in board.legal_moves:
                        mv = cand
                except Exception:
                    mv = None
            if mv is None:
                break
            parsed_moves.append(mv)
            board.push(mv)

        if not parsed_moves:
            raise ValueError("No legal moves found in variation line for this board position.")

        # Idempotent insert: reuse matching variation branch if it already exists
        first_mv = parsed_moves[0]
        existing_var = next((v for v in node.variations if v.move == first_mv), None)
        already_existed = False
        if existing_var is not None and len(parsed_moves) == 1:
            already_existed = True
            var_node = existing_var
        else:
            # Check if an identical full sequence already exists as a variation
            var_node = None
            for cand_v in node.variations:
                if cand_v.move != first_mv:
                    continue
                probe = cand_v
                matched_all = True
                for nxt_mv in parsed_moves[1:]:
                    nxt_child = next((c for c in probe.variations if c.move == nxt_mv), None)
                    if nxt_child is None:
                        matched_all = False
                        break
                    probe = nxt_child
                if matched_all:
                    var_node = cand_v
                    already_existed = True
                    break

            if var_node is None:
                cur_node = node.add_variation(first_mv)
                var_node = cur_node
                for nxt_mv in parsed_moves[1:]:
                    cur_node = cur_node.add_variation(nxt_mv)

        # Attach clean engine/eval annotation to the head of the saved variation
        note_parts = []
        if eval_str:
            note_parts.append(f"[%eval {eval_str}]")
        if engine_name:
            depth_suffix = f" d{depth}" if depth else ""
            note_parts.append(f"Kibitzer: {engine_name}{depth_suffix}")
        if note_parts and not already_existed:
            note_str = " ".join(note_parts)
            var_node.comment = (var_node.comment + " " + note_str).strip() if var_node.comment else note_str

        exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
        updated_pgn = game.accept(exporter)

        conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            cur = conn.cursor()
            gtable = self._get_primary_table(cur)
            cur.execute(f"PRAGMA table_info({gtable})")
            col_map = {r[1].lower(): r[1] for r in cur.fetchall()}

            cur.execute("BEGIN IMMEDIATE")
            try:
                target_rowid = record.get("rowid")
                if target_rowid is None:
                    try:
                        int_id = int(game_id)
                        r = cur.execute(f"SELECT ROWID FROM {gtable} WHERE ROWID = ?", (int_id,)).fetchone()
                        if r:
                            target_rowid = r[0]
                    except (ValueError, TypeError):
                        pass
                if target_rowid is None and "game_id" in col_map:
                    r = cur.execute(
                        f"SELECT ROWID FROM {gtable} WHERE {col_map['game_id']} = ?", (str(game_id),)
                    ).fetchone()
                    if r:
                        target_rowid = r[0]
                if target_rowid is None:
                    cur.execute("ROLLBACK")
                    raise ValueError(f"Could not locate SQLite row for game '{game_id}'.")

                updates: List[Tuple[str, Any]] = []
                if "_data_" in col_map:
                    updates.append((col_map["_data_"], updated_pgn))
                if "pgn" in col_map:
                    updates.append((col_map["pgn"], updated_pgn))

                if updates:
                    set_sql = ", ".join(f"{col} = ?" for col, _ in updates)
                    cur.execute(
                        f"UPDATE {gtable} SET {set_sql} WHERE ROWID = ?",
                        [val for _, val in updates] + [target_rowid],
                    )
                cur.execute("COMMIT")
            except Exception:
                try:
                    cur.execute("ROLLBACK")
                except Exception:
                    pass
                raise
        finally:
            conn.close()

        return {
            "success": True,
            "game_id": record.get("id", game_id),
            "db_name": os.path.basename(self.db_path),
            "ply": walked,
            "moves_saved": len(parsed_moves),
            "already_existed": already_existed,
            "pgn": updated_pgn,
        }
