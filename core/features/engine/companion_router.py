"""
Companion Engine Subsystem - FastAPI Router
Endpoints for Kibitzer, Tutor, and Sparring data synchronization and classification.
"""

import os
import re
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import chess

from core.features.engine.companion_types import (
    CreateSparringGameRequest,
    LogKibitzerVariationRequest,
    LogTutorFlagRequest,
    TutorOutcome,
)
from core.persistence.companion_repositories import CompanionDataManager
from core.persistence.database import (
    strip_fake_zero_acpl_comments,
    count_pgn_plies,
    set_pgn_header,
    has_genuine_gold_eval,
)
from core.features.engine.tag_classifier import (
    classify_multipv,
    classify_variation_tags,
    cp_to_win_probability,
)
from core.features.engine.engine_service import sanitize_uci_options, get_engine_service

router = APIRouter(prefix="/api/v1/companion", tags=["Companion Subsystem (Kibitzer / Tutor / Sparring)"])

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
companion_mgr = CompanionDataManager(ROOT_DIR)
companion_engine_service = get_engine_service(ROOT_DIR)

# -----------------------------------------------------------------------------
# Sparring Game Endpoints
# -----------------------------------------------------------------------------

@router.post("/sparring/create")
def create_sparring_game(req: CreateSparringGameRequest) -> Dict[str, Any]:
    """Mints a game_id lazily without writing an empty 0-ply row to SQLite."""
    try:
        game = companion_mgr.sparring_repo.create_game(
            game_id=req.game_id,
            opponent_engine=req.opponent_engine,
            user_time_control=req.user_time_control,
            tutor_interrupt_mode=req.tutor_interrupt_mode,
        )
        return {"success": True, "game": game}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sparring/update-pgn")
def update_sparring_pgn(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Updates live PGN and optional game result (>= 2 plies only)."""
    game_id = payload.get("game_id")
    pgn = payload.get("pgn", "")
    result = payload.get("result")
    if not game_id:
        raise HTTPException(status_code=400, detail="game_id is required.")
    try:
        success = companion_mgr.sparring_repo.update_game_pgn(game_id, pgn, result)
        return {"success": success}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/sparring/list")
def list_sparring_games(limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    """Lists past sparring games."""
    return companion_mgr.sparring_repo.list_games(limit=limit, offset=offset)

# -----------------------------------------------------------------------------
# Kibitzer Variation Endpoints
# -----------------------------------------------------------------------------

@router.post("/kibitzer/variation")
def log_kibitzer_variation(req: LogKibitzerVariationRequest) -> Dict[str, Any]:
    """Logs a Kibitzer alternative variation line."""
    try:
        var_id = companion_mgr.kibitzer_repo.log_variation(
            game_id=req.game_id,
            ply=req.ply,
            fen=req.fen,
            engine=req.engine,
            pgn_fragment=req.pgn_fragment,
            eval_data=req.eval_data,
            trigger_source=req.trigger_source,
            logged_by=req.logged_by,
            was_played=req.was_played,
        )
        return {"success": True, "variation_id": var_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/kibitzer/game/{game_id}")
def get_kibitzer_variations(game_id: str) -> List[Dict[str, Any]]:
    """Retrieves all Kibitzer variations logged during a specific game."""
    return companion_mgr.kibitzer_repo.get_variations_for_game(game_id)

# -----------------------------------------------------------------------------
# Tutor Flag Endpoints
# -----------------------------------------------------------------------------

@router.post("/tutor/flag")
def log_tutor_flag(req: LogTutorFlagRequest) -> Dict[str, Any]:
    """Logs a Tutor reinforcement flag event."""
    try:
        flag_id = companion_mgr.tutor_repo.log_flag(
            game_id=req.game_id,
            ply=req.ply,
            fen=req.fen,
            flag_type=req.flag_type,
            engine=req.engine,
            centipawn_data=req.centipawn_data,
            suggested_variations=req.suggested_variations,
            tutor_outcome=req.tutor_outcome,
            trigger_source=req.trigger_source,
        )
        return {"success": True, "flag_id": flag_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/tutor/flag/{flag_id}/outcome")
def update_tutor_outcome(flag_id: int, outcome: TutorOutcome) -> Dict[str, Any]:
    """Updates user action/outcome on a flagged position."""
    try:
        updated = companion_mgr.tutor_repo.update_tutor_outcome(flag_id, outcome)
        return {"success": updated}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# -----------------------------------------------------------------------------
# Cross-DB Game Dossier & Classifier Endpoints
# -----------------------------------------------------------------------------

@router.get("/game/{game_id}/dossier")
def get_game_dossier(game_id: str) -> Dict[str, Any]:
    """Correlates sparring game, tutor flags, and kibitzer variations by ply."""
    return companion_mgr.get_full_game_dossier(game_id)

@router.post("/classify")
def classify_position_lines(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Classifies MultiPV lines using the Section 6 Tag Classifier."""
    fen = payload.get("fen")
    lines = payload.get("lines", [])
    if not fen:
        raise HTTPException(status_code=400, detail="fen is required.")
    try:
        board = chess.Board(fen)
        classified = classify_multipv(board, lines)
        return {"success": True, "lines": classified}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# -----------------------------------------------------------------------------
# DSD-51: Telemetry Flush & Deterministic Adjudication Engine
# -----------------------------------------------------------------------------

class CompanionVariationRecord(BaseModel):
    ply: int
    fen: str
    engine: str
    pgn_fragment: str
    eval_data: Optional[str] = None
    trigger_source: str = "continuous"
    logged_by: str = "auto_verbose"
    was_played: Optional[int] = None

class CompanionFlagRecord(BaseModel):
    ply: int
    fen: str
    flag_type: str
    engine: str
    centipawn_data: Optional[str] = None
    suggested_variations: Optional[str] = None
    tutor_outcome: Optional[str] = None
    trigger_source: str = "continuous"

TRUE_TERMINATIONS = {
    "CHECKMATE",
    "STALEMATE",
    "DRAW_INSUFFICIENT",
    "DRAW_REPETITION",
    "DRAW_FIFTY",
    "DRAW",
    "TIME_FORFEIT",
}


class TelemetryFlushRequest(BaseModel):
    game_id: str
    pgn: str
    player_color: str  # "white" | "black"
    # "EVAL_ADJUDICATED" | "MANUAL_RESIGN" | "TIME_FORFEIT" | "CHECKMATE" | "STALEMATE" | "DRAW_*"
    termination_type: str
    game_result: Optional[str] = None  # real board result ("1-0" | "0-1" | "1/2-1/2") for true terminations / time forfeit
    engine_id: Optional[str] = None    # active sparring/analyzer engine ID for fast terminal-FEN fallback eval
    tutor_eval_cp: Optional[int] = None
    kibitzer_eval_cp: Optional[int] = None
    engine_eval_cp: Optional[int] = None
    final_eval_override: Optional[str] = None
    player_acpl: Optional[int] = None
    engine_acpl: Optional[int] = None
    kibitzer_lines: Optional[List[CompanionVariationRecord]] = None
    tutor_events: Optional[List[CompanionFlagRecord]] = None


def _extract_terminal_board_from_pgn(pgn_text: str) -> Optional[chess.Board]:
    """Replays mainline moves from PGN text and returns the final board position."""
    import io as _io
    import chess.pgn as _pgn

    try:
        g = _pgn.read_game(_io.StringIO(pgn_text or ""))
        if g is None:
            return None
        b = g.board()
        for mv in g.mainline_moves():
            if mv in b.legal_moves:
                b.push(mv)
            else:
                break
        return b
    except Exception:
        return None


def _format_final_eval_str(eval_cp: int, mate_str: Optional[str] = None) -> str:
    """Formats White-POV final eval cleanly (e.g. `+3.50`, `-2.10`, `#M4`, `-#M3`)."""
    if mate_str:
        s = mate_str.strip()
        if s.startswith("#M") or s.startswith("-#M"):
            return s
        if s.startswith("#"):
            rest = s[1:]
            try:
                m = int(rest)
                if m > 0:
                    return f"#M{m}"
                if m < 0:
                    return f"-#M{abs(m)}"
                return "#M0"
            except ValueError:
                return s
    return f"{eval_cp / 100.0:+.2f}"


@router.post("/sparring/telemetry-flush")
def telemetry_flush(payload: TelemetryFlushRequest) -> Dict[str, Any]:
    """
    DSD-51 + Pass 2:
    - Enforces >= 2 ply lazy UPSERT (discarding 0/1-ply sessions without DB writes).
    - Separates `[Result]` (awarding 1-0/0-1 on Manual Resignation or Time Forfeit)
      from `[FinalEval]` (preserving the true terminal board evaluation so strategically
      won games lost on time remain filterable for Opening Book building).
    - If no live eval arrived (`eval_source == "NONE"`), runs a fast 1-position fallback
      evaluation on the terminal FEN so `[FinalEval]` and `[EvalSource]` are never `NONE`.
    """
    # Strip synthetic zero-ACPL sparring comments before counting plies & checking tier
    cleaned_pgn = strip_fake_zero_acpl_comments(payload.pgn or "")
    ply_count = count_pgn_plies(cleaned_pgn)

    # Discard 0-ply and 1-ply sessions cleanly without writing to SQLite
    if ply_count < 2:
        companion_mgr.sparring_repo.delete_stub_if_exists(payload.game_id)
        return {
            "success": True,
            "discarded": True,
            "reason": "insufficient_plies",
            "ply_count": ply_count,
            "game_id": payload.game_id,
            "result": "*",
            "user_eval": 0,
            "final_eval": None,
            "eval_source": "NONE",
            "data_tier": None,
        }

    # ── Adjudication & FinalEval Cascade (White-POV cp) ──────────────────────
    eval_mate_str: Optional[str] = None
    if payload.tutor_eval_cp is not None:
        eval_cp = payload.tutor_eval_cp
        eval_source = "TUTOR"
    elif payload.kibitzer_eval_cp is not None:
        eval_cp = payload.kibitzer_eval_cp
        eval_source = "KIBITZER"
    elif payload.engine_eval_cp is not None:
        eval_cp = payload.engine_eval_cp
        eval_source = "SPARRING"
    else:
        eval_cp = 0
        eval_source = "NONE"

    # Terminal-FEN fallback fast 1-position evaluation whenever live eval is missing
    if eval_source == "NONE" or (payload.final_eval_override is None and eval_cp == 0 and eval_source == "NONE"):
        terminal_board = _extract_terminal_board_from_pgn(cleaned_pgn)
        if terminal_board is not None:
            if terminal_board.is_checkmate():
                if terminal_board.turn == chess.WHITE:
                    eval_cp = -10000
                    eval_mate_str = "-#M0"
                else:
                    eval_cp = 10000
                    eval_mate_str = "#M0"
                eval_source = "Board (Checkmate)"
            elif terminal_board.is_stalemate() or terminal_board.is_insufficient_material():
                eval_cp = 0
                eval_source = "Board (Draw)"
            else:
                # Choose requested active engine, else configured Analyzer engine, else stockfish
                fallback_engine_id = payload.engine_id
                if not fallback_engine_id:
                    try:
                        roles = companion_engine_service.get_engine_roles()
                        fallback_engine_id = roles["roles"]["analyzer"].get("engine_id") or "stockfish"
                    except Exception:
                        fallback_engine_id = "stockfish"
                try:
                    ev_res = companion_engine_service.evaluate_position(
                        fen=terminal_board.fen(),
                        depth=12,
                        time_limit_sec=0.35,
                        engine_id=fallback_engine_id,
                        subsystem="sparring",
                    )
                    if ev_res.get("success"):
                        eval_cp = int(ev_res.get("eval_cp") or 0)
                        raw_ev_str = str(ev_res.get("eval_score") or "")
                        if raw_ev_str.startswith("#") or raw_ev_str.startswith("-#"):
                            eval_mate_str = raw_ev_str
                        # Resolve friendly engine display name
                        avail = companion_engine_service.get_available_engines()
                        eng_info = next((e for e in avail if e.get("id", "").lower() == fallback_engine_id.lower()), None)
                        eval_source = (eng_info or {}).get("name") or fallback_engine_id
                except Exception:
                    pass

    # Normalize to user's perspective for adjudication (positive = user is winning)
    color = payload.player_color.lower()
    user_eval = eval_cp if color == "white" else -eval_cp
    term_upper = (payload.termination_type or "EVAL_ADJUDICATED").upper()

    # ── Outcome Resolution (Result separated from FinalEval!) ─────────────────
    result_from_board = payload.game_result if payload.game_result in ("1-0", "0-1", "1/2-1/2") else None
    if term_upper == "MANUAL_RESIGN":
        # Manual resignation awards the match result to the opponent, while [FinalEval]
        # preserves the true board evaluation at the final position.
        result = result_from_board or ("0-1" if color == "white" else "1-0")
    elif term_upper == "TIME_FORFEIT":
        # Time forfeit honors the flagged clock result (1-0 / 0-1) while [FinalEval]
        # preserves the true board evaluation (e.g. +5.00 before flagging on move 50).
        result = result_from_board or ("0-1" if color == "white" else "1-0")
    elif result_from_board and term_upper in TRUE_TERMINATIONS:
        result = result_from_board
    else:
        if user_eval >= 100:
            result = "1-0" if color == "white" else "0-1"
        elif user_eval <= -100:
            result = "0-1" if color == "white" else "1-0"
        else:
            result = "1/2-1/2"

    # ── PGN Header Enrichment (Non-Destructive & Idempotent) ──────────────────
    enriched_pgn = cleaned_pgn
    enriched_pgn = set_pgn_header(enriched_pgn, "Result", result)
    enriched_pgn = set_pgn_header(enriched_pgn, "Termination", term_upper)
    final_eval_str = (
        payload.final_eval_override.strip()
        if payload.final_eval_override and payload.final_eval_override.strip()
        else _format_final_eval_str(eval_cp, mate_str=eval_mate_str)
    )
    enriched_pgn = set_pgn_header(enriched_pgn, "FinalEval", final_eval_str)
    enriched_pgn = set_pgn_header(enriched_pgn, "EvalSource", eval_source)
    if payload.player_acpl is not None:
        enriched_pgn = set_pgn_header(enriched_pgn, "PlayerACPL", str(payload.player_acpl))
    if payload.engine_acpl is not None:
        enriched_pgn = set_pgn_header(enriched_pgn, "EngineACPL", str(payload.engine_acpl))

    # Update trailing result token in movetext if it ended with '*'
    enriched_pgn = re.sub(r'(\s)\*\s*$', rf'\g<1>{result}', enriched_pgn)

    # Honest Silver vs Gold classification
    data_tier = "Gold" if has_genuine_gold_eval(enriched_pgn, ply_count=ply_count) else "Silver"
    enriched_pgn = set_pgn_header(enriched_pgn, "DataTier", data_tier)

    # ── Persistence (Atomic Unified UPSERT) ───────────────────────────────────
    try:
        companion_mgr.sparring_repo.upsert_game(
            game_id=payload.game_id,
            pgn=enriched_pgn,
            result=result,
            player_color=color,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to persist game: {e}")

    # Bulk-ingest Kibitzer lines if provided
    if payload.kibitzer_lines:
        for line in payload.kibitzer_lines:
            try:
                companion_mgr.kibitzer_repo.log_variation(
                    game_id=payload.game_id,
                    ply=line.ply,
                    fen=line.fen,
                    engine=line.engine,
                    pgn_fragment=line.pgn_fragment,
                    eval_data=line.eval_data,
                    trigger_source=line.trigger_source,
                    logged_by=line.logged_by,
                    was_played=line.was_played,
                )
            except Exception:
                pass  # Non-fatal — partial ingestion acceptable

    # Bulk-ingest Tutor events if provided
    if payload.tutor_events:
        for event in payload.tutor_events:
            try:
                companion_mgr.tutor_repo.log_flag(
                    game_id=payload.game_id,
                    ply=event.ply,
                    fen=event.fen,
                    flag_type=event.flag_type,
                    engine=event.engine,
                    centipawn_data=event.centipawn_data,
                    suggested_variations=event.suggested_variations,
                    tutor_outcome=event.tutor_outcome,
                    trigger_source=event.trigger_source,
                )
            except Exception:
                pass  # Non-fatal — partial ingestion acceptable

    return {
        "success": True,
        "discarded": False,
        "ply_count": ply_count,
        "game_id": payload.game_id,
        "result": result,
        "user_eval": user_eval,
        "final_eval": final_eval_str,
        "eval_source": eval_source,
        "data_tier": data_tier,
    }


# -----------------------------------------------------------------------------
# DSD-53: 3-Stream Engine Logs & Lifecycle Handshake Endpoints
# -----------------------------------------------------------------------------

class EngineHandshakeRequest(BaseModel):
    engine_id: str = "stockfish"
    subsystem: str = "sparring"
    elo: Optional[int] = None
    threads: Optional[int] = None
    hash_mb: Optional[int] = None
    book_name: Optional[str] = None
    use_book: bool = True
    custom_options: Optional[Dict[str, Any]] = None


@router.get("/engine-logs")
def get_engine_logs(subsystem: Optional[str] = Query(None, description="sparring, kibitzer, or tutor")) -> Dict[str, Any]:
    """Retrieves ring-buffer logs across the 3 streams without double-nesting."""
    logs = companion_engine_service.get_uci_logs(subsystem)
    if subsystem:
        entries = logs.get(subsystem, []) if isinstance(logs, dict) else list(logs or [])
        return {"subsystem": subsystem, "logs": entries}
    return logs


@router.post("/engine-handshake")
def engine_handshake(req: EngineHandshakeRequest) -> Dict[str, Any]:
    """Performs engine lifecycle handshake and populates ring buffer for target subsystem."""
    lines = companion_engine_service.log_engine_handshake(
        subsystem=req.subsystem,
        engine_id=req.engine_id,
        elo=req.elo,
        threads=req.threads,
        hash_mb=req.hash_mb,
        book_name=req.book_name,
        use_book=req.use_book,
        custom_options=req.custom_options,
    )
    has_err = any(l.startswith("[ERROR]") for l in lines)
    return {
        "success": not has_err,
        "uci_log": lines,
        "error": lines[0] if has_err else None,
    }

