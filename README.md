# Blindfold Chess Training Application

A web application designed to help chess players train their blindfold chess skills by playing by dictating the moves, and with a chat assistant that can ask you questions about the positions.

![Screenshot of the portal](/static/screenshot.png)

## Features

### 🎯 Core Functionality
- **AI Chess Engine**: Integrated Stockfish engine with adjustable ELO (1320-3100)
- **Chat Assistant**: Powered by Ollama LLM for natural language interaction
- **Blindfold Training**: Practice without visual aids using AI assistance
- **Local integration**: It is designed to run completely locally.

### 🧠 Chat Assistant Commands
- **RECAP**: Lists all moves made in the game with move numbers
- **TEST**: Asks random questions about the current position:
  - Number of checks in the position
  - Number of captures in the position
  - Location of specific pieces (queens, etc.)
  - What piece is on a specific square
  **REPEAT**: Repeat the last voice output
  **UNDO**: Undo the last made move
- **Custom Questions to the model**: Ask about piece locations and square contents
## Installation & Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/Suaif/blindfold_chess/
cd blindfold-chess-training
```

```bash
pip install -r requirements.txt
```

### Step 2: Set up Stockfish

1. Download Stockfish from the official website [here](https://stockfishchess.org/download/)
2. Change the STOCKFISH_PATH variable in the main.py file to the path of the Stockfish executable

### Step 3: Install and Configure Ollama

1. **Install Ollama:**
   
   Download and install Olamma from here: https://ollama.com/download

2. **Pull a compatible model:**
   ```bash
   ollama pull llama3.2:3b
   ```

3. **Run Ollama:** Ollama will need to be run on a terminal during the execution.
   ```bash
   ollama serve
   ```

### Step 4: Set up STT

Using faster-whisper for faster inference.
The models can be obtained from Hugging Face (guillaumekln/faster-whisper-*) and placed in the paths below.

```
assets/speech_to_text/models--guillaumekln--faster-whisper-small.en/...
assets/speech_to_text/models--guillaumekln--faster-whisper-medium.en/...
```

### Step 5: Run the Application 

```bash
python main.py
```
The application UI will now be available at **http://localhost:8000**


## Using in the UI

Press the record button, dictate the move or command, then press the record button again.
When asking for a test question, you can add `captures`/`check`/`what`/`where` and `black`/`white` to specify the kind of question you want.

## Code Organization

- `main.py` — FastAPI server, WebSocket game loop, Stockfish control. HTTP endpoints: `/stt`, `/tts/speak`, `/log_voice`. Includes utilities to convert SAN to spoken text and to build TTS payloads.
- `chess_normalizer.py` — Deterministic speech normalization that turns noisy transcripts into SAN/UCI candidates with rule trace.
- `stt.py` — Speech-to-Text backends (Whisper via faster-whisper, Vosk) and a factory that caches transcribers.
- `tts.py` — Local Piper TTS wrapper used to synthesize audio for spoken feedback.
- `static/js/main.js` — Frontend controller: UI rendering, WebSocket client, board state, voice UX orchestration (recording, candidate handling, suggestion prompts, TTS queue), and the Repeat command.
- `static/js/voice_moves.js` — Pure helpers for voice→move: parsing to UCI, humanizing moves, best-match suggestion, and yes/no decision logic.
- `static/js/audio.js` — Microphone capture (WAV encoder) and a lightweight JS fallback normalizer for speech candidates.
- `static/css/style.css` — App styling, including the two-row layout under the board (buttons + recognition input, then timeline navigation + undo).
- `index.html` — App shell that loads the frontend bundle.

## License

This project is open source. Feel free to modify and distribute according to your needs.

---

**Enjoy your blindfold chess training!**
