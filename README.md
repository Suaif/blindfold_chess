# Blindfold Chess Training Application

A comprehensive web application designed to help chess players train their blindfold chess skills with an AI assistant that can recap moves and test position knowledge through interactive questions.

## Features

### 🎯 Core Functionality
- **Interactive Chessboard**: Full-featured chessboard with drag-and-drop piece movement
- **AI Chess Engine**: Integrated Stockfish engine with adjustable ELO (1350-3100)
- **AI Assistant**: Powered by Ollama LLM for natural language interaction
- **Blindfold Training**: Practice without visual aids using AI assistance
- Right-click behavior: Cancel an in-progress drag and suppress the browser's context menu anywhere over the board.

### 🧠 AI Assistant Commands
- **RECAP**: Lists all moves made in the game with move numbers
- **TEST**: Asks random questions about the current position:
  - Number of checks in the position
  - Number of captures in the position
  - Location of specific pieces (queens, etc.)
  - What piece is on a specific square
- **Custom Questions to the model**: Ask about piece locations, square contents, and position details

## Installation & Setup

### Step 1: Clone the Repository

```bash
git clone <repository-url>
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

3. **Test Ollama installation:**
   ```bash
   ollama run llama3.2:3b "Hello, can you help me with chess training?"
   ```

### Step 4: Run the Application 🚀

```bash
python main.py
```
The application UI will now be available at **http://localhost:8000**

## Voice Input (Speak Your Move)

You can enter moves by voice using these backends:

1) Browser (Web Speech API)
- Works in Chrome/Edge with built-in speech recognition.
- No server setup required.

2) Local Vosk (Offline)
- Runs entirely on your CPU. Smaller model is faster; large model is more accurate.

3) Local Whisper via Faster-Whisper (GPU if available)
- High-quality transcription, uses your NVIDIA GPU if present (RTX 4060 recommended).
- Falls back to CPU with int8 compute for portability.

### Setup steps

- Install Python packages:

```bash
pip install -r requirements.txt
```

- Vosk models:
   - Large (en-us-0.22) and Small (en-us-0.15) model directories are expected under `assets/speech_to_text/`.
   - If missing, download from https://alphacephei.com/vosk/models and place the folders under:

```
assets/speech_to_text/vosk-model-en-us-0.22
assets/speech_to_text/vosk-model-small-en-us-0.15
```

- Whisper models (Faster-Whisper):
   - Small and Medium English models are referenced under:

```
assets/speech_to_text/models--guillaumekln--faster-whisper-small.en/...
assets/speech_to_text/models--guillaumekln--faster-whisper-medium.en/...
```

   - If missing, you can obtain them via Hugging Face (guillaumekln/faster-whisper-*) and place them under the paths above.

### Using in the UI

- In the voice controls next to the Record button, pick one of:
   - Vosk Large (en-us-0.22)
   - Vosk Small (small-en-us-0.15)
   - Whisper Small (CUDA if available)
   - Whisper Medium (CUDA if available)

When you click Record, the browser captures a short utterance, encodes a mono 16 kHz WAV, and sends it to the `/stt` endpoint. The server performs transcription with the selected backend and returns text. Spoken phrases like "e two e four", "castle king side", "knight f three", or "e seven e eight queen" are normalized to legal chess moves.

Troubleshooting
- If you select Whisper and see an error, ensure `faster-whisper` is installed (it is listed in `requirements.txt`).
- GPU usage: the app auto-detects CUDA via `ctranslate2`. If unavailable, it will run on CPU.

## Code Organization

- `main.py`: FastAPI app, websocket/game flow, and thin HTTP endpoints (including `/stt`).
- `stt.py`: Speech-to-Text utilities. Contains Vosk model discovery/loading and WAV transcription. Designed to support future Whisper integration without changing `main.py`.
- `chat_assistant.py`: Ollama-powered chat logic for recap and training questions.

## License

This project is open source. Feel free to modify and distribute according to your needs.

---

**Enjoy your blindfold chess training!** 🏆
