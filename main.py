from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
import chess
import chess.engine
import asyncio
from typing import Dict, List, Optional, Set
from datetime import datetime
import re
from pathlib import Path
import os
from chat_assistant import ChatAssistant
from chess_normalizer import normalize_transcription
from stt import create_transcriber, STTError, AudioTranscriber
from tts import synthesize_to_base64

FILE_NAMES = {
    "a": "A",
    "b": "B",
    "c": "C",
    "d": "D",
    "e": "E",
    "f": "F",
    "g": "G",
    "h": "H",
}

RANK_NAMES = {
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
}

PROMOTION_NAMES = {
    "q": "queen",
    "r": "rook",
    "b": "bishop",
    "n": "knight",
}

STOCKFISH_PATH = r"C:\Users\ismas\projects\blindfold_chess\assets\stockfish\stockfish-windows-x86-64-avx2.exe"

app = FastAPI(title="Blindfold Chess Training", version="1.0.0")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get('/favicon.ico', include_in_schema=False)
async def favicon():
    return FileResponse('static/icons/icon.ico')

class GameState:
    def __init__(self):
        self.board = chess.Board()
        self.move_history = []
        self.engine = None
        self.player_color = chess.WHITE
        self.engine_elo = 1350
        self.game_active = False
        self.test_score = 0
        self.test_questions = 0
        
    async def initialize_engine(self, stockfish_path=STOCKFISH_PATH):
        """Initialize Stockfish in a background thread so the async loop is not blocked."""
        try:
            loop = asyncio.get_running_loop()
            self.engine = await loop.run_in_executor(
                None,
                lambda: chess.engine.SimpleEngine.popen_uci(stockfish_path)
            )
            # Configure engine strength via UCI_Elo
            await loop.run_in_executor(
                None,
                lambda: self.engine.configure({
                    "UCI_LimitStrength": True,
                    "UCI_Elo": self.engine_elo
                })
            )
            return True
        except Exception as e:
            print(f"Failed to initialize Stockfish: {e}")
            return False
    
    def close_engine(self):
        if self.engine:
            self.engine.close()

    def make_move(self, move_uci):
        try:
            move = chess.Move.from_uci(move_uci)
            if move not in self.board.legal_moves:
                return False, "Illegal move"
                       
            san_move = self.board.san(move)
            self.board.push(move)
            
            self.move_history.append(san_move)
            return True, san_move
        except Exception as e:
            return False, str(e)
    
    async def get_engine_move(self):
        if not self.engine:
            return None
        
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: self.engine.play(
                    self.board,
                    chess.engine.Limit(time=0.1)
                )
            )
            
            if result.move:
                return self.make_move(result.move.uci())
            return False, "No move returned"
        except Exception as e:
            return False, str(e)

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.game_states: Dict[WebSocket, GameState] = {}
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        self.game_states[websocket] = GameState()
    
    def disconnect(self, websocket: WebSocket):
        if websocket in self.game_states:
            self.game_states[websocket].close_engine()
            del self.game_states[websocket]
        self.active_connections.discard(websocket)
    
    async def broadcast_to_client(self, websocket: WebSocket, message: dict):
        try:
            await websocket.send_json(message)
        except:
            self.disconnect(websocket)

manager = ConnectionManager()

chat_assistant = ChatAssistant()

# Cache transcriber instances for reuse across requests
transcriber_cache: Dict[str, AudioTranscriber] = {}


def get_transcriber(backend: str = "vosk", model: str = "auto") -> AudioTranscriber:
    """Get or create a cached transcriber instance.
    
    Args:
        backend: Backend to use ("vosk" or "whisper").
        model: Model hint for the backend.
        
    Returns:
        Cached or newly created AudioTranscriber instance.
    """
    cache_key = f"{backend}:{model}"
    if cache_key not in transcriber_cache:
        transcriber_cache[cache_key] = create_transcriber(backend=backend, model=model)
    return transcriber_cache[cache_key]


def uci_to_spoken_text(uci: str) -> str:
    if not uci or len(uci) < 4:
        return uci
    from_file, from_rank, to_file, to_rank = uci[0], uci[1], uci[2], uci[3]
    parts = [
        FILE_NAMES.get(from_file, from_file.upper()),
        RANK_NAMES.get(from_rank, from_rank),
        "to",
        FILE_NAMES.get(to_file, to_file.upper()),
        RANK_NAMES.get(to_rank, to_rank),
    ]
    if len(uci) > 4:
        promo_piece = PROMOTION_NAMES.get(uci[4].lower(), uci[4])
        parts.extend(["promote to", promo_piece])
    return " ".join(parts)


async def create_tts_payload(text: Optional[str], voice: Optional[str] = None) -> Optional[Dict[str, str]]:
    if not text or not text.strip():
        return None
    loop = asyncio.get_running_loop()
    audio_b64 = await loop.run_in_executor(None, synthesize_to_base64, text, voice)
    payload: Dict[str, str] = {"text": text}
    if audio_b64:
        payload["audio"] = audio_b64
    return payload



PIECE_WORDS_SPOKEN = {
    'K': 'king',
    'Q': 'queen',
    'R': 'rook',
    'B': 'bishop',
    'N': 'knight',
}


def san_to_spoken_text(san: str) -> str:
    """Convert SAN (e.g., 'Qe7', 'e4', 'O-O') into spoken form.

    - Pieces: 'Qe7' -> 'queen e7'
    - Pawns: 'e4' -> 'e4'
    - Captures: 'Qxe7' -> 'queen takes e7'
    - Castling: 'O-O' -> 'castle king side', 'O-O-O' -> 'castle queen side'
    - Promotions: 'e8=Q' -> 'e8 promotes to queen'
    - Trailing annotations (+, #, !, ?) are ignored.
    """
    if not san:
        return ""
    s = san.strip()
    # Strip trailing annotations (check, mate, !, ?)
    s = re.sub(r"[+#?!]+$", "", s)
    # Castling
    if s.upper().startswith("O-O-O"):
        return "castle queen side"
    if s.upper().startswith("O-O"):
        return "castle king side"
    # Destination square: last [a-h][1-8]
    m = list(re.finditer(r"[a-h][1-8]", s, flags=re.IGNORECASE))
    dest = m[-1].group(0).lower() if m else s
    # Promotion
    pm = re.search(r"=([QRBN])", s, flags=re.IGNORECASE)
    if pm:
        piece = PIECE_WORDS_SPOKEN.get(pm.group(1).upper(), "").lower()
        if piece:
            return f"{dest} promotes to {piece}"

    is_capture = "x" in s
    first = s[0].upper()
    if first in PIECE_WORDS_SPOKEN:
        name = PIECE_WORDS_SPOKEN[first]
        return f"{name} takes {dest}" if is_capture else f"{name} {dest}"

    # Pawn moves
    if is_capture:
        return f"pawn takes {dest}"
    return dest


SAN_PATTERN = re.compile(r"^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?$", re.IGNORECASE)
UCI_PATTERN = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$", re.IGNORECASE)


def candidate_to_spoken_text(candidate: str) -> str:
    if not candidate:
        return ""
    c = candidate.strip()
    if not c:
        return ""

    if c.upper().startswith("O-O"):
        return san_to_spoken_text(c)

    if SAN_PATTERN.match(c):
        return san_to_spoken_text(c)

    if UCI_PATTERN.match(c):
        dest = c[2:4].lower()
        if len(c) == 5:
            promo_piece = PIECE_WORDS_SPOKEN.get(c[4].upper(), c[4].lower())
            return f"{dest} promotes to {promo_piece}"
        return dest

    return c


async def send_tts_message(websocket: WebSocket, text: Optional[str], voice: Optional[str] = None):
    payload = await create_tts_payload(text, voice=voice)
    if payload:
        message = {"type": "tts", **payload}
        await manager.broadcast_to_client(websocket, message)


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None


@app.get("/", response_class=HTMLResponse)
async def get_index():
    return """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Blindfold Chess Training</title>
        <link rel="stylesheet" href="/static/css/style.css">
    </head>
    <body>
        <div id="app">
            <h1>Loading Blindfold Chess Training...</h1>
            <p>Please wait while the application loads.</p>
        </div>
        <script type="module" src="/static/js/main.js"></script>
    </body>
    </html>
    """

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    game_state = manager.game_states[websocket]
    
    try:
        # Initialize engine
        engine_initialized = await game_state.initialize_engine()
        if not engine_initialized:
            await manager.broadcast_to_client(websocket, {
                "type": "error",
                "message": "Failed to initialize Stockfish engine. Please ensure Stockfish is installed."
            })
            return
        
        await manager.broadcast_to_client(websocket, {
            "type": "connected",
            "message": "Connected to chess server"
        })
        
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "new_game":
                game_state.__init__()  # Reset game state
                game_state.player_color = chess.WHITE if data.get("color") == "white" else chess.BLACK
                game_state.engine_elo = data.get("elo", 1350)
                await game_state.initialize_engine()
                game_state.game_active = True
                
                await manager.broadcast_to_client(websocket, {
                    "type": "game_started",
                    "fen": game_state.board.fen(),
                    "player_color": "white" if game_state.player_color else "black",
                    "engine_elo": game_state.engine_elo
                })

                # If player is Black, engine (White) should make the first move
                if game_state.player_color == chess.BLACK:
                    engine_success, engine_result = await game_state.get_engine_move()
                    if engine_success:
                        spoken_move = san_to_spoken_text(engine_result)
                        await send_tts_message(websocket, f"Engine plays {spoken_move}.")
                        print(f"TTS - Engine: Engine plays {spoken_move}")
                        await manager.broadcast_to_client(websocket, {
                            "type": "position_update",
                            "fen": game_state.board.fen(),
                            "last_move": engine_result,
                            "move_history": game_state.move_history,
                        })
                    else:
                        await manager.broadcast_to_client(websocket, {
                            "type": "error",
                            "message": f"Engine failed to make opening move: {engine_result}"
                        })
            
            elif message_type == "move":
                if not game_state.game_active:
                    continue

                move_uci = data.get("move")
                source = data.get("source", "manual")  # Track if move is from voice or manual input
                success, result = game_state.make_move(move_uci)

                if not success:
                    print(f"✗ - Invalid move: {move_uci} → {result}")
                    await manager.broadcast_to_client(websocket, {
                        "type": "invalid_move",
                        "message": result
                    })
                    continue

                print(f"✅ -  Move played: {move_uci} → {result}")

                # Player's move caused an immediate game over
                if game_state.board.is_game_over():
                    await manager.broadcast_to_client(websocket, {
                        "type": "position_update",
                        "fen": game_state.board.fen(),
                        "last_move": result,
                        "move_history": game_state.move_history,
                    })
                    result_type = "checkmate" if game_state.board.is_checkmate() else "draw"
                    await manager.broadcast_to_client(websocket, {
                        "type": "game_over",
                        "result": result_type,
                        "winner": "white" if game_state.board.turn == chess.BLACK else "black"
                    })
                    game_state.game_active = False
                    continue

                engine_result = None
                if game_state.board.turn != game_state.player_color:
                    engine_success, engine_result = await game_state.get_engine_move()
                    if engine_success:
                        spoken_move = san_to_spoken_text(engine_result)
                        await send_tts_message(websocket, f"Engine plays {spoken_move}.")
                        print(f"TTS - Engine: Engine plays {spoken_move}")

                        if game_state.board.is_game_over():
                            await manager.broadcast_to_client(websocket, {
                                "type": "position_update",
                                "fen": game_state.board.fen(),
                                "last_move": engine_result,
                                "move_history": game_state.move_history,
                            })
                            result_type = "checkmate" if game_state.board.is_checkmate() else "draw"
                            await manager.broadcast_to_client(websocket, {
                                "type": "game_over",
                                "result": result_type,
                                "winner": "white" if game_state.board.turn == chess.BLACK else "black"
                            })
                            game_state.game_active = False
                            continue
                    else:
                        await manager.broadcast_to_client(websocket, {
                            "type": "error",
                            "message": f"Engine failed to make a move: {engine_result}"
                        })
                        continue

                await manager.broadcast_to_client(websocket, {
                    "type": "position_update",
                    "fen": game_state.board.fen(),
                    "last_move": engine_result or result,
                    "move_history": game_state.move_history,
                })
            
            elif message_type == "chat":
                user_message = data.get("message", "")
                try:
                    response = await chat_assistant.process_message(user_message, game_state)
                except Exception as e:
                    # Prevent the server from crashing; log and send fallback message.
                    print(f"Chat assistant error: {e}")
                    response = "Sorry, I couldn't process that request right now. Please try again."

                await manager.broadcast_to_client(websocket, {
                    "type": "chat_response",
                    "user_message": user_message,
                    "ai_response": response
                })
    
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)

@app.post("/stt")
async def stt_endpoint(audio: UploadFile = File(...), backend: str = Form("vosk"), model: str = Form("auto")):
    """Transcribe a short utterance.

    - Backends: "vosk" (offline), "whisper" (faster-whisper; CUDA if available)
    - Model hints:
        - Vosk: "auto" | "small" | "large"
        - Whisper: "small" | "medium"

    Client should send a mono 16kHz 16-bit PCM WAV for best results.
    Returns: {"text": "..."}
    """
    data = await audio.read()
    if not data:
        empty_payload = await create_tts_payload("I did not catch any audio.")
        response: Dict[str, object] = {"text": ""}
        if empty_payload:
            response["tts"] = empty_payload
        return response

    try:
        # Get cached transcriber instance for better performance
        transcriber = get_transcriber(backend=backend, model=model)
        text = transcriber.transcribe(data)
        normalization = normalize_transcription(text)
        print(f"STT Transcription [{backend}.{model}]: \"{text}\"")
        if normalization.candidates:
            print(f"    candidates: {normalization.candidates}")
        if normalization.applied_rules:
            print(f"    normalization rules: {normalization.applied_rules}")

        spoken_candidate = ""
        if normalization.candidates:
            spoken_candidate = candidate_to_spoken_text(normalization.candidates[0])
        fallback_text = text.strip()
        feedback_phrase = spoken_candidate or fallback_text
        feedback_text = (
            f"Heard {feedback_phrase}."
            if feedback_phrase
            else "Sorry, I could not understand that move."
        )
        tts_payload = await create_tts_payload(feedback_text)
        response: Dict[str, object] = {
            "text": text,
            "normalized": normalization.to_dict(),
            "candidates": normalization.candidates,
        }
        if tts_payload:
            response["tts"] = tts_payload
        return response
    except STTError as e:
        # Unsupported backend or unavailable model; treat as client or service error respectively.
        msg = str(e)
        print(f"STTError in /stt endpoint: {msg}")  # Log the actual error
        if msg.lower().startswith("unsupported stt backend"):
            raise HTTPException(status_code=400, detail=msg)
        raise HTTPException(status_code=503, detail=msg)
    except Exception as e:
        print(f"Unexpected error in /stt endpoint: {e}")  # Log unexpected errors
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"STT processing error: {e}")


@app.post("/tts/speak")
async def tts_speak(payload: TTSRequest):
    tts_payload = await create_tts_payload(payload.text, voice=payload.voice)
    if not tts_payload:
        raise HTTPException(status_code=400, detail="No text provided for TTS.")
    return {"tts": tts_payload}


@app.post("/log_voice")
async def log_voice(request: Request):
    """Log voice input parsing results from the client."""
    body = await request.json()
    
    transcription = body.get('transcription', '')
    success = body.get('success', False)
    
    if success:
        matched = body.get('matched_candidate', '')
        uci = body.get('uci', '')
        # print(f"   ✅ Parsed as: \"{matched}\" → {uci}")
    else:
        candidates = body.get('candidates', [])
        cand_str = ', '.join(candidates) if candidates else 'none'
        print(f"   ❌ No valid move found (tried: {cand_str})")
    
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)







