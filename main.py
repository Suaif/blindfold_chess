from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
import chess
import chess.engine
import json
import asyncio
from typing import Dict, List, Optional, Set
from datetime import datetime
from pathlib import Path
from chat_assistant import ChatAssistant

STOCKFISH_PATH = r"C:\Users\ismas\projects\chess_blindfold\assets\stockfish\stockfish-windows-x86-64-avx2.exe"

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
        <script src="/static/js/main.js"></script>
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
                success, result = game_state.make_move(move_uci)
                
                if success:
                    # Check if game is over
                    if game_state.board.is_game_over():
                        # First send final position so client sees the mating move
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
                    
                    # Engine's turn
                    if game_state.board.turn != game_state.player_color:
                        engine_success, engine_result = await game_state.get_engine_move()
                        if engine_success:
                            if game_state.board.is_game_over():
                                # Send final position before announcing game over
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
                    
                    await manager.broadcast_to_client(websocket, {
                        "type": "position_update",
                        "fen": game_state.board.fen(),
                        "last_move": result,
                        "move_history": game_state.move_history,
                    })
                else:
                    await manager.broadcast_to_client(websocket, {
                        "type": "invalid_move",
                        "message": result
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)