# Blindfold Chess Training Application

A comprehensive web application designed to help chess players train their blindfold chess skills with an AI assistant that can recap moves and test position knowledge through interactive questions.

## Features

### 🎯 Core Functionality
- **Interactive Chessboard**: Full-featured chessboard with drag-and-drop piece movement
- **AI Chess Engine**: Integrated Stockfish engine with adjustable ELO (1350-3100)
- **AI Assistant**: Powered by Ollama LLM for natural language interaction
- **Blindfold Training**: Practice without visual aids using AI assistance

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

## License

This project is open source. Feel free to modify and distribute according to your needs.

---

**Enjoy your blindfold chess training!** 🏆