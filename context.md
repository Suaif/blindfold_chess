# Repository Context

This document is a quick-start map of the codebase so future conversations have the right context at a glance.

## Main objective and operating principles

- Goal: Blindfold chess training app you can run entirely on your local machine. It provides an interactive board, a chess engine opponent, and an AI assistant that quizzes and recaps positions. Voice input is supported via local STT.
- Runtime: Everything is local. Backend runs with FastAPI; the chess engine is Stockfish; LLM chat runs via Ollama; STT uses Vosk offline models today and is designed to be extended to Whisper.
- Hardware: Prefer using the NVIDIA RTX 4060 GPU for heavy models (e.g., Whisper large/faster-whisper later). Keep latency low while maintaining accuracy. For STT, you can choose a smaller model for speed or a larger model for accuracy. For LLM, the configured model is a small 3B variant to keep latency manageable.
- UX intent: Minimal page reloads, responsive to moves and chat; low friction to start a game and speak a move.

## How it works (high level)

1) Client opens the app and connects to the backend WebSocket at `/ws`.
2) Start a new game with chosen side and ELO; backend spins up Stockfish configured with `UCI_LimitStrength` and `UCI_Elo`.
3) User plays by dragging pieces, typing a move, or speaking a move. Server validates and responds with position updates. If it’s the engine’s turn, Stockfish generates a reply move.
4) The chat assistant handles commands like RECAP/TEST and small Q&A about the current board using a local Ollama model.
5) Optional voice input: client records short audio, encodes mono 16 kHz WAV, posts to `/stt`; server transcribes using local Vosk.

## Characteristics and trade-offs

- Local-first: No external services required (beyond optional CDN assets for front-end libraries).
- Latency vs. quality: Vosk small vs. large models; potential Whisper integration on GPU (RTX 4060) for higher-quality STT. LLM model (llama3.2:3b) chosen for responsiveness.
- Robustness: Server validates moves with python-chess; engine runs off-thread to avoid blocking the event loop.

## Technologies and libraries

- Backend
  - FastAPI + WebSockets for real-time updates.
  - python-chess for board rules and SAN/UCI handling.
  - Stockfish engine via python-chess UCI integration.
  - Ollama client (`ollama==0.1.7`) to chat with a local LLM (e.g., `llama3.2:3b`).
  - Vosk (`vosk==0.3.45`) for offline speech-to-text.
  - uvicorn to run the app.

- Frontend
  - Chess.js (rules/validation on client) and Chessboard.js (board rendering) via CDNs.
  - Vanilla JS with ES modules; custom modules manage audio capture and lib loading.
  - CSS in `static/css/style.css`; images under `static/img/`.

## Key endpoints and protocols

- WebSocket `/ws`
  - Client → Server messages:
    - `{"type":"new_game","color":"white|black","elo": number}`
    - `{"type":"move","move":"e2e4|san-or-uci-like"}` (server expects UCI string in practice)
    - `{"type":"chat","message":"..."}`
  - Server → Client messages (selected):
    - `connected`, `game_started`, `position_update`, `invalid_move`, `game_over`, `chat_response`, `error`

- HTTP POST `/stt`
  - Form fields: `audio` (WAV file), `backend` (currently `vosk`), `model` (`auto|small|large`).
  - Returns `{ "text": "..." }`.
  - Expects mono 16 kHz 16-bit PCM WAV for best results (other WAVs tolerated but suboptimal).

## File and code structure

Top-level highlights:

- `main.py` — FastAPI app entry. Serves the app shell, handles the WebSocket game loop and `/stt` route. Initializes/configures Stockfish asynchronously; validates and applies moves.
- `chat_assistant.py` — Chat logic powered by Ollama. Implements RECAP and TEST flows and simple Q&A about the board.
- `stt.py` — Speech-to-Text utilities. Vosk model discovery/loading and a generic `transcribe_wav_bytes(...)` API designed to support additional backends (e.g., Whisper) with minimal changes to `main.py`.
- `index.html` — Marketing/setup page (standalone); the main app HTML is served from `main.py` directly with a `<script type="module" src="/static/js/main.js">` entry.
- `static/`
  - `css/style.css` — Styling for the app (layout, panels, chessboard area, chat, toasts, responsive rules).
  - `js/main.js` — App entry (ES module). Wires UI, WebSocket events, chessboard, chat, and STT.
  - `js/chesslib.js` — Promise-based loader for Chess.js, jQuery, and Chessboard.js.
  - `js/audio.js` — `LocalRecorder` (mic capture + WAV encoding) and `normalizeSpeechToCandidates(...)` helper.
  - `img/chesspieces/...` — Piece image sets; default path used is `wikipedia/{piece}.png`.
  - `icons/` — Favicons.
- `assets/`
  - `speech_to_text/vosk-model-.../` — Local Vosk model directories.
  - `stockfish/` — Stockfish source and project files; a Windows binary is referenced by `STOCKFISH_PATH` in `main.py` (ensure this path matches your local executable).
- `requirements.txt` — Python dependencies (FastAPI, Uvicorn, python-chess, Ollama client, Vosk, etc.).
- `test.ipynb` — Notebook with chess analysis examples and a faster-whisper (CUDA) snippet for local experimentation.

## Portal and user interaction (what the user sees)

The app UI rendered by `main.py` (not `index.html`) contains:

- Setup screen
  - Select color (White/Black).
  - Set opponent ELO via slider.
  - Start Game button (enabled on WebSocket connect).

- Main interface
  - Game controls: shows selected color and ELO; buttons to Reset or start a New Game.
  - Chessboard panel: board with drag-and-drop, piece visibility toggles (top/right), manual move input, and voice controls.
    - Piece visibility: “Show pieces” checkbox toggles a CSS class that hides images.
    - Manual move: text box accepts SAN or UCI-like inputs (e.g., `e2e4`, `Nf3`, `O-O`, `e8=Q`).
    - Voice controls: model selector (Vosk Large/Small), Record/Stop button, and a read-only text box showing transcription. Client records audio, generates a 16kHz WAV, and posts to `/stt`.
  - Move list panel: scrollable list of SAN moves with move numbers.
  - Chat panel: message list plus input; supports `RECAP`, `TEST`, and simple board Q&A commands.
  - Toast notifications: lightweight status messages in the lower-right, not affecting layout.

## Notes and future directions

- Whisper integration: `stt.py` is structured so adding a Whisper branch (OpenAI, faster-whisper, or whisper.cpp) is straightforward. With RTX 4060, consider GPU-accelerated inference for better accuracy with acceptable latency.
- Stockfish path: update `STOCKFISH_PATH` in `main.py` to the correct Windows executable location.
- CDN vs. local: Currently Chess.js and Chessboard.js are loaded via CDN for convenience. Can be vendored into `static/` for fully offline usage if needed.
