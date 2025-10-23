# Repository Context

This document is a quick-start map of the codebase so future conversations have the right context at a glance.

## Main objective and operating principles

- Goal: Blindfold chess training app you can run entirely on your local machine. It provides an interactive board, a chess engine opponent, and an AI assistant that quizzes and recaps positions. Voice input is supported via local STT.
- Runtime: Everything is local. Backend runs with FastAPI; the chess engine is Stockfish; LLM chat runs via Ollama; STT uses Whisper (default) or Vosk offline models for voice input.
- Hardware: Prefer using the NVIDIA RTX 4060 GPU for heavy models (e.g., Whisper with CUDA acceleration). Keep latency low while maintaining accuracy. For STT, Whisper Small is the default for good speed/accuracy balance; you can choose other models (Vosk Large/Small, Whisper Medium) as needed. For LLM, the configured model is a small 3B variant to keep latency manageable.
- Development Environment: Uses conda environment named `chess` for Python dependencies and package management.
- UX intent: Minimal page reloads, responsive to moves and chat; low friction to start a game and speak a move.

## How it works (high level)

1) Client opens the app and connects to the backend WebSocket at `/ws`.
2) Start a new game with chosen side and ELO; backend spins up Stockfish configured with `UCI_LimitStrength` and `UCI_Elo`.
3) User plays by dragging pieces, typing a move, or speaking a move. Server validates and responds with position updates. If it's the engine's turn, Stockfish generates a reply move.
4) The chat assistant handles commands like RECAP/TEST and small Q&A about the current board using a local Ollama model.
5) Optional voice input: client records short audio, encodes mono 16 kHz WAV, posts to `/stt`; server transcribes using Whisper (default, GPU-accelerated) or Vosk (offline CPU models).

## Characteristics and trade-offs

- Local-first: No external services required (beyond optional CDN assets for front-end libraries).
- Latency vs. quality: Whisper Small (default, GPU-accelerated) offers excellent accuracy with low latency. Alternative models available: Vosk small/large (CPU-only, offline), Whisper Medium (higher accuracy, slightly slower). LLM model (llama3.2:3b) chosen for responsiveness.
- Robustness: Server validates moves with python-chess; engine runs off-thread to avoid blocking the event loop.
- Windows compatibility: Temporary file handling optimized for Windows permission model in Whisper transcription.

## Technologies and libraries

- Backend
  - FastAPI + WebSockets for real-time updates.
  - python-chess for board rules and SAN/UCI handling.
  - Stockfish engine via python-chess UCI integration.
  - Ollama client (`ollama==0.1.7`) to chat with a local LLM (e.g., `llama3.2:3b`).
  - Vosk (`vosk==0.3.45`) for offline CPU-based speech-to-text.
  - faster-whisper for GPU-accelerated speech-to-text (default, CUDA support via RTX 4060).
  - uvicorn to run the app.
  - Conda environment `chess` for Python package management.

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
  - Form fields: `audio` (WAV file), `backend` (`vosk` or `whisper`, default: `whisper`), `model` (`auto|small|medium|large`).
  - Returns `{ "text": "..." }`.
  - Expects mono 16 kHz 16-bit PCM WAV for best results (other WAVs tolerated but suboptimal).
  - Default: Whisper Small with CUDA acceleration for optimal speed/accuracy balance.

## File and code structure

Top-level highlights:

- `main.py` — FastAPI app entry. Serves the app shell, handles the WebSocket game loop and `/stt` route. Initializes/configures Stockfish asynchronously; validates and applies moves. Uses cached transcriber instances for efficient STT processing.
- `chat_assistant.py` — Chat logic powered by Ollama. Implements RECAP and TEST flows and simple Q&A about the board.
- `stt.py` — Speech-to-Text utilities with a class-based architecture. Implements `AudioTranscriber` abstract base class with concrete backends: `VoskTranscriber` (offline Vosk models) and `WhisperTranscriber` (faster-whisper with CUDA support). Includes factory function `create_transcriber()` with instance caching and backward-compatible `transcribe_wav_bytes()` convenience wrapper.
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
- `test_stt_refactor.py` — Test suite for the refactored STT module, verifying factory function, caching, interface compliance, and error handling.
- `test_whisper.py` — Comprehensive test script demonstrating WhisperTranscriber usage, performance comparisons, and backend benchmarking.

## Portal and user interaction (what the user sees)

The app UI rendered by `main.py` (not `index.html`) contains:

- Setup screen
  - Select color (White/Black).
  - Set opponent ELO via slider.
  - Start Game button (enabled on WebSocket connect).

- Main interface
  - Game controls: shows selected color and ELO; buttons to Reset or start a New Game.
  - Chessboard panel: board with drag-and-drop, piece visibility toggles (top/right), manual move input, and voice controls.
    - Piece visibility: "Show pieces" checkbox toggles a CSS class that hides images.
    - Manual move: text box accepts SAN or UCI-like inputs (e.g., `e2e4`, `Nf3`, `O-O`, `e8=Q`).
    - Voice controls: model selector (default: Whisper Small; alternatives: Vosk Large/Small, Whisper Medium), Record/Stop button, and a read-only text box showing transcription. Client records audio, generates a 16kHz WAV, and posts to `/stt`.
  - Move list panel: scrollable list of SAN moves with move numbers.
  - Chat panel: message list plus input; supports `RECAP`, `TEST`, and simple board Q&A commands.
  - Toast notifications: lightweight status messages in the lower-right, not affecting layout.

## STT Architecture (class-based design)

The speech-to-text module uses an object-oriented architecture for extensibility and maintainability:

- **Abstract interface**: `AudioTranscriber` defines the contract (`transcribe()`, `get_backend_name()`)
- **Concrete implementations**:
  - `VoskTranscriber`: Offline Vosk models with automatic model discovery (CPU-only)
  - `WhisperTranscriber`: faster-whisper with CUDA acceleration (RTX 4060) - **default backend**
- **Factory pattern**: `create_transcriber(backend, model)` creates and caches instances
- **Instance caching**: Models are loaded once and reused across requests for better performance
- **Backward compatibility**: `transcribe_wav_bytes()` function wraps the class API for existing code
- **Windows compatibility**: Temporary file handling uses `delete=False` pattern to avoid Windows file locking issues

Benefits:
- Easy to add new backends (e.g., whisper.cpp, cloud APIs) without touching existing code
- Better resource management through caching (important for GPU memory on RTX 4060)
- Clean separation of concerns (model loading, configuration, transcription)
- Testable design with mockable interfaces
- Production-ready error handling and logging

Default configuration:
- Frontend: Whisper Small selected in dropdown
- Backend: CUDA-accelerated when available, falls back to CPU
- Compute type: float16 on CUDA, int8 on CPU

## Notes and future directions

- Adding new STT backends: Simply create a new class inheriting from `AudioTranscriber`, implement `transcribe()` and `get_backend_name()`, then add it to the factory function.
- Stockfish path: update `STOCKFISH_PATH` in `main.py` to the correct Windows executable location.
- CDN vs. local: Currently Chess.js and Chessboard.js are loaded via CDN for convenience. Can be vendored into `static/` for fully offline usage if needed.
- Async STT: Consider adding async transcription support for non-blocking operation in high-traffic scenarios.

## Setup and Running

1. **Environment**: Activate the conda environment:
   ```bash
   conda activate chess
   ```

2. **Dependencies**: Install Python packages (if not already installed):
   ```bash
   pip install -r requirements.txt
   ```

3. **Stockfish**: Ensure the Stockfish executable path in `main.py` is correct for your system.

4. **Ollama**: Ensure Ollama is running with the `llama3.2:3b` model available.

5. **Run the server**:
   ```bash
   python main.py
   ```
   
6. **Access the app**: Open `http://localhost:8000` in your browser.

The app will use Whisper Small by default for voice input (GPU-accelerated on RTX 4060), with Vosk and Whisper Medium available as alternatives in the dropdown.
