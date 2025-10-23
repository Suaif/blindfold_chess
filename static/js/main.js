import { loadChessLibraries } from './chesslib.js';
import { LocalRecorder, normalizeSpeechToCandidates } from './audio.js';

class BlindfoldChessApp {
    constructor() {
        this.ws = null;
        this.board = null;
        this.game = null;
        this.connected = false;
        this.gameActive = false;
        this.playerColor = 'white';
        this.engineElo = 1350;
        this.testAnswer = null;
        this.piecesVisible = true; // track piece visibility
        this.recognition = null;   // SpeechRecognition instance
        this.isListening = false;
        
        this.initializeApp();
    }
    
    initializeApp() {
        // Ensure global toast container exists before rendering any UI
        this.ensureToastContainer();
        this.showSetupScreen();
        this.connectWebSocket();
    }
    
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('Connected to chess server');
            this.connected = true;
            // Enable the start button if we are still on the setup screen
            const startBtn = document.getElementById('startButton');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.removeAttribute('disabled');
                startBtn.textContent = 'Start Game';
            }
        };
        
        this.ws.onclose = () => {
            console.log('Disconnected from chess server');
            this.connected = false;
            // Attempt to reconnect after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showStatusMessage('Connection error. Please refresh the page.', 'error');
        };
        
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleWebSocketMessage(message);
        };
    }
    
    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'connected':
                this.showStatusMessage('Connected to server', 'success');
                break;
                
            case 'game_started':
                this.playerColor = message.player_color;
                this.engineElo = message.engine_elo;
                this.gameActive = true;
                // Render interface first so #chessboard element exists
                this.showMainInterface();
                this.initializeBoard(message.fen);
                this.updateGameControls();
                break;
                
            case 'position_update':
                this.updateBoard(message.fen);
                this.updateMoveList(message.move_history);
                this.updatePositionStats(message);
                this.updateGameControls();
                break;
                
            case 'invalid_move':
                this.showStatusMessage(`Invalid move: ${message.message}`, 'error');
                break;
                
            case 'game_over':
                this.handleGameOver(message);
                break;
                
            case 'chat_response':
                this.addChatMessage(message.user_message, 'user');
                this.addChatMessage(message.ai_response, 'assistant');
                break;
                
            case 'error':
                this.showStatusMessage(message.message, 'error');
                break;
        }
    }
    
    showSetupScreen() {
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container">
                <div class="header">
                    <h1>♔ Blindfold Chess Training ♚</h1>
                    <p>Train your blindfold chess skills with AI assistance</p>
                </div>
                <div class="setup-screen">
                    <h2>Game Setup</h2>
                    
                    <div class="setup-group">
                        <label>Select Your Color:</label>
                        <div class="color-selector">
                            <div class="color-option selected" data-color="white">
                                ♔ White
                            </div>
                            <div class="color-option" data-color="black">
                                ♚ Black
                            </div>
                        </div>
                    </div>
                    
                    <div class="setup-group">
                        <label>Opponent Strength (ELO):</label>
                        <input type="range" class="elo-slider" min="800" max="2800" value="1350" id="eloSlider">
                        <div class="elo-display" id="eloDisplay">1350 ELO</div>
                    </div>
                    
                    <button class="start-button" id="startButton" ${!this.connected ? 'disabled' : ''}>
                        ${this.connected ? 'Start Game' : 'Connecting...'}
                    </button>
                    
                    <div id="setupStatus"></div>
                </div>
            </div>
        `;
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Color selection
        document.querySelectorAll('.color-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
                e.target.classList.add('selected');
                this.playerColor = e.target.dataset.color;
            });
        });
        
        // ELO slider
        const eloSlider = document.getElementById('eloSlider');
        const eloDisplay = document.getElementById('eloDisplay');
        eloSlider.addEventListener('input', (e) => {
            this.engineElo = parseInt(e.target.value);
            eloDisplay.textContent = `${this.engineElo} ELO`;
        });
        
        // Start button
        const startButton = document.getElementById('startButton');
        startButton.addEventListener('click', () => {
            if (this.connected) {
                this.startNewGame();
            }
        });
    }
    
    startNewGame() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'new_game',
                color: this.playerColor,
                elo: this.engineElo
            }));
        }
    }
    
    showMainInterface() {
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container">
                <div class="header">
                    <h1>♔ Blindfold Chess Training ♚</h1>
                </div>
                
                <div class="game-controls">
                    <p>Playing as ${this.playerColor} vs ${this.engineElo} ELO opponent</p>
                    <button class="control-button reset-button" id="resetButton">Reset Game</button>
                    <button class="control-button new-game-button" id="newGameButton">New Game</button>
                </div>
                
                <div class="main-content">
                    <div class="panel chessboard-panel">
                        <div class="board-controls-top">
                            <label class="piece-toggle">
                                <input type="checkbox" id="piecesToggleTop" ${this.piecesVisible ? 'checked' : ''}>
                                <span>Show pieces</span>
                            </label>
                        </div>
                        <h3>Chessboard</h3>
                        <div id="chessboard"></div>
                        <div class="manual-move-input">
                            <input type="text" id="manualMoveInput" class="manual-move-text" placeholder="Type your move (e.g., e2e4, Nf3, O-O, e8=Q)">
                            <button id="manualMoveButton" class="manual-move-button">Play</button>
                        </div>
                        <div class="voice-controls-row">
                            <select id="voiceModelSelect" class="voice-model-select" title="Choose Vosk model">
                                <option value="large">Vosk Large (en-us-0.22)</option>
                                <option value="small">Vosk Small (small-en-us-0.15)</option>
                            </select>
                            <button id="voiceMoveButton" class="voice-move-button" title="Record / Stop">🎤 Record</button>
                            <input type="text" id="voiceText" class="voice-text" placeholder="Recognition output..." readonly>
                        </div>
                    </div>
                    
                    <div class="panel move-list-panel">
                        <div class="board-controls-right">
                            <label class="piece-toggle">
                                <input type="checkbox" id="piecesToggleRight" ${this.piecesVisible ? 'checked' : ''}>
                                <span>Show pieces</span>
                            </label>
                        </div>
                        <h3>Move History</h3>
                        <div class="move-list" id="moveList"></div>
                    </div>
                    
                    <div class="panel chat-panel">
                        <h3>AI Assistant</h3>
                        <div class="chat-messages" id="chatMessages"></div>
                        <div class="chat-input-container">
                            <input type="text" class="chat-input" id="chatInput" placeholder="Type RECAP, TEST, or ask about the position...">
                            <button class="send-button" id="sendButton">Send</button>
                        </div>
                    </div>
                </div>
                
                <div id="statusMessages"></div>
            </div>
        `;
        
        this.setupMainInterfaceEventListeners();
    }
    
    setupMainInterfaceEventListeners() {
        // Reset button
        document.getElementById('resetButton').addEventListener('click', () => {
            this.resetGame();
        });
        
        // New game button
        document.getElementById('newGameButton').addEventListener('click', () => {
            this.showSetupScreen();
        });
        
        // Chat input
        const chatInput = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendButton');
        
        const sendMessage = () => {
            const message = chatInput.value.trim();
            if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'chat',
                    message: message
                }));
                chatInput.value = '';
            }
        };
        
        sendButton.addEventListener('click', sendMessage);
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });

        // Piece visibility toggles (top and right) - keep them synchronized
        const topToggle = document.getElementById('piecesToggleTop');
        const rightToggle = document.getElementById('piecesToggleRight');

        const toggleHandler = (e) => {
            const visible = !!e.target.checked;
            this.togglePieces(visible);
        };

        if (topToggle) topToggle.addEventListener('change', toggleHandler);
        if (rightToggle) rightToggle.addEventListener('change', toggleHandler);

        // Ensure both toggles reflect the current state
        if (topToggle) topToggle.checked = this.piecesVisible;
        if (rightToggle) rightToggle.checked = this.piecesVisible;

        // Manual move input
        const manualInput = document.getElementById('manualMoveInput');
        const manualButton = document.getElementById('manualMoveButton');
        const submitManual = () => {
            const mv = manualInput.value.trim();
            if (!mv) return;
            this.submitManualMove(mv);
        };
        if (manualButton) manualButton.addEventListener('click', submitManual);
        if (manualInput) manualInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                submitManual();
            }
        });

        // Voice input button
        const voiceBtn = document.getElementById('voiceMoveButton');
        const voiceModelSelect = document.getElementById('voiceModelSelect');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                if (this.isListening) {
                    this.stopLocalRecording();
                } else {
                    this.startLocalRecording();
                }
            });
        }
    }
    
    initializeBoard(fen) {
        // Load chess.js and chessboard.js libraries
        if (typeof Chess === 'undefined' || typeof Chessboard === 'undefined') {
            loadChessLibraries().then(() => this.createBoard(fen));
        } else {
            this.createBoard(fen);
        }
    }
    
    
    
    createBoard(fen) {
        this.game = new Chess(fen);
        
        const config = {
            position: fen,
            pieceTheme: '/static/img/chesspieces/wikipedia/{piece}.png',
            orientation: this.playerColor,
            draggable: true,
            onDragStart: (source, piece) => {
                // Only allow dragging pieces of the player's color
                if (this.game.game_over()) return false;
                if (this.game.turn() !== (this.playerColor === 'white' ? 'w' : 'b')) return false;
                if ((this.playerColor === 'white' && piece.search(/^w/) === -1) ||
                    (this.playerColor === 'black' && piece.search(/^b/) === -1)) {
                    return false;
                }
                return true;
            },
            onDrop: (source, target) => {
                const move = this.game.move({
                    from: source,
                    to: target,
                    promotion: 'q' // Auto-promote to queen
                });
                
                if (move === null) {
                    return 'snapback';
                }
                
                // Send move to server
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'move',
                        move: move.from + move.to + (move.promotion || '')
                    }));
                }
            },
            onSnapEnd: () => {
                this.board.position(this.game.fen());
            }
        };
        
        this.board = new Chessboard('chessboard', config);

        // Apply visibility immediately after the board is created
        this.applyPieceVisibility();
    }

    // Toggle piece visibility and sync checkboxes
    togglePieces(visible) {
        this.piecesVisible = visible;
        this.applyPieceVisibility();

        const topToggle = document.getElementById('piecesToggleTop');
        const rightToggle = document.getElementById('piecesToggleRight');
        if (topToggle) topToggle.checked = visible;
        if (rightToggle) rightToggle.checked = visible;
    }

    // Apply CSS class to hide/show piece images
    applyPieceVisibility() {
        const boardEl = document.getElementById('chessboard');
        if (!boardEl) return;
        if (this.piecesVisible) {
            boardEl.classList.remove('pieces-hidden');
        } else {
            boardEl.classList.add('pieces-hidden');
        }
    }
    
    updateBoard(fen) {
        if (this.board) {
            this.board.position(fen);
        }
        if (this.game) {
            this.game.load(fen);
        }
        // Re-apply visibility in case the board library re-renders pieces
        this.applyPieceVisibility();
        // Update UI controls like manual input availability
        this.updateGameControls();
    }

    // Submit a move typed by the user (SAN or coordinate). Validates and sends to server.
    submitManualMove(moveText) {
        if (!this.gameActive) {
            return this.showStatusMessage('No active game. Start a new game first.', 'error');
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return this.showStatusMessage('Not connected. Please wait for connection.', 'error');
        }

        // Ensure it's player's turn
        const turn = this.game ? this.game.turn() : null;
        const playerTurn = (this.playerColor === 'white' ? 'w' : 'b');
        if (turn !== playerTurn) {
            return this.showStatusMessage("It's not your turn yet.", 'info');
        }

        // Try parse to UCI using chess.js (SAN) or regex (coordinate)
        const uci = this.parseMoveToUCI(moveText);
        if (!uci) {
            return this.showStatusMessage('Invalid move format. Try e2e4, Nf3, O-O, or e8=Q.', 'error');
        }

        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promo = uci.length > 4 ? uci.slice(4) : undefined;

        // Validate on local game
        const moveObj = { from, to };
        if (promo) moveObj.promotion = promo;
        const applied = this.game.move(moveObj);
        if (!applied) {
            return this.showStatusMessage('Illegal move in current position.', 'error');
        }

        // Reflect on board immediately
        if (this.board) {
            this.board.position(this.game.fen());
            this.applyPieceVisibility();
        }

        // Send to server
        this.ws.send(JSON.stringify({
            type: 'move',
            move: from + to + (promo || '')
        }));

        // Clear input
        const manualInput = document.getElementById('manualMoveInput');
        if (manualInput) manualInput.value = '';
    }

    // Convert a typed move to UCI (e2e4, or from SAN like Nf3 / O-O / e8=Q)
    parseMoveToUCI(moveText) {
        const text = moveText.trim();
        if (!text) return null;

        // Coordinate format like e2e4 or e7e8q
        const coord = text.toLowerCase().replace(/\s+/g, '');
        const m = coord.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
        if (m) {
            const from = m[1];
            const to = m[2];
            const promo = m[3] || '';
            // Optionally, validate with a temp game
            const tmp = new Chess(this.game.fen());
            const ok = tmp.move({ from, to, promotion: promo || undefined });
            if (!ok) return null;
            return from + to + promo;
        }

        // Else try SAN via chess.js with sloppy parsing
        try {
            const tmp = new Chess(this.game.fen());
            const mv = tmp.move(text, { sloppy: true });
            if (!mv) return null;
            const promo = mv.promotion ? mv.promotion : '';
            return mv.from + mv.to + promo;
        } catch (e) {
            return null;
        }
    }
    
    updateMoveList(moveHistory) {
        const moveList = document.getElementById('moveList');
        if (!moveList) return;
        
        let html = '';
        for (let i = 0; i < moveHistory.length; i += 2) {
            const moveNumber = Math.floor(i / 2) + 1;
            html += `<div class="move-item">`;
            html += `<span class="move-number">${moveNumber}.</span>`;
            html += moveHistory[i];
            if (i + 1 < moveHistory.length) {
                html += ` ${moveHistory[i + 1]}`;
            }
            html += `</div>`;
        }
        
        moveList.innerHTML = html;
        moveList.scrollTop = moveList.scrollHeight;
    }
    
    updatePositionStats(data) {
        // This could be used to show additional position information
        // For now, we'll just log it for debugging
        console.log('Position stats updated:', data);
    }
    
    addChatMessage(message, sender) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${sender}`;
        messageDiv.textContent = message;
        
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    handleGameOver(message) {
        this.gameActive = false;
        let resultMessage = '';
        
        if (message.result === 'checkmate') {
            const winner = message.winner;
            const playerWon = (winner === this.playerColor);
            resultMessage = `Checkmate! ${playerWon ? 'You' : 'Engine'} won!`;
        } else {
            resultMessage = 'Game ended in a draw!';
        }
        
        this.showStatusMessage(resultMessage, 'info');
        this.addChatMessage(`Game Over: ${resultMessage}`, 'assistant');
    }
    
    resetGame() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'new_game',
                color: this.playerColor,
                elo: this.engineElo
            }));
        }
        this.clearChatMessages();
    }
    
    clearChatMessages() {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
    }

    // Create or retrieve the fixed toast container
    ensureToastContainer() {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        return container;
    }

    // Show a transient status message as a bottom-right toast
    showStatusMessage(message, type) {
        const container = this.ensureToastContainer();

        const messageDiv = document.createElement('div');
        messageDiv.className = `status-message status-${type} toast`;
        messageDiv.textContent = message;

        container.appendChild(messageDiv);

        // Auto-hide with animation after 5 seconds
        const hideDelay = 5000;
        const animMs = 180;
        setTimeout(() => {
            messageDiv.classList.add('toast-hide');
            setTimeout(() => {
                if (messageDiv.parentNode) messageDiv.parentNode.removeChild(messageDiv);
            }, animMs);
        }, hideDelay);
    }
    
    updateGameControls() {
        // Enable/disable the manual move input depending on state
        const manualInput = document.getElementById('manualMoveInput');
        const manualButton = document.getElementById('manualMoveButton');
    const voiceBtn = document.getElementById('voiceMoveButton');
    const voiceModelSelect = document.getElementById('voiceModelSelect');
    if (!manualInput || !manualButton) return;

        const connected = !!(this.ws && this.ws.readyState === WebSocket.OPEN);
        const isActive = !!this.gameActive;
        const playerTurn = this.game ? (this.game.turn() === (this.playerColor === 'white' ? 'w' : 'b')) : false;
        const enabled = connected && isActive && playerTurn;

        manualInput.disabled = !enabled;
        manualButton.disabled = !enabled;
    if (voiceBtn) voiceBtn.disabled = !enabled;
    // Keep the model selector enabled so users can pick model even when not their turn

        if (!isActive) {
            manualInput.placeholder = 'Start a game to enter moves';
        } else if (!connected) {
            manualInput.placeholder = 'Connecting...';
        } else if (!playerTurn) {
            manualInput.placeholder = "Waiting for opponent's move";
        } else {
            manualInput.placeholder = 'Type your move (e.g., e2e4, Nf3, O-O)';
        }
    }

    // ---- Speech recognition (Web Speech API) ----
    getSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        return SpeechRecognition ? new SpeechRecognition() : null;
    }

    startVoiceRecognition() {
        if (!this.gameActive) {
            return this.showStatusMessage('Start a game to speak moves.', 'info');
        }
        // only allow on player's turn
        const playerTurn = this.game ? (this.game.turn() === (this.playerColor === 'white' ? 'w' : 'b')) : false;
        if (!playerTurn) {
            return this.showStatusMessage("It's not your turn yet.", 'info');
        }

        const rec = this.getSpeechRecognition();
        const statusEl = document.getElementById('voiceStatus');
        if (!rec) {
            if (statusEl) statusEl.textContent = 'Speech not supported in this browser';
            return;
        }

        // configure
        rec.lang = 'en-US';
        rec.continuous = false;
        rec.interimResults = false;

        rec.onstart = () => {
            this.isListening = true;
            const btn = document.getElementById('voiceMoveButton');
            if (btn) btn.textContent = '■ Stop';
            if (statusEl) statusEl.textContent = 'Listening...';
        };
        rec.onend = () => {
            this.isListening = false;
            const btn = document.getElementById('voiceMoveButton');
            if (btn) btn.textContent = '🎤 Speak';
            if (statusEl) statusEl.textContent = '';
        };
        rec.onerror = (e) => {
            if (statusEl) statusEl.textContent = 'Error: ' + (e.error || 'unknown');
        };
        rec.onresult = (e) => {
            const transcript = Array.from(e.results)
                .map(r => r[0].transcript)
                .join(' ');
            this.handleSpokenMove(transcript);
        };

        this.recognition = rec;
        try { rec.start(); } catch (e) { /* ignore double-start */ }
    }

    stopVoiceRecognition() {
        if (this.recognition) {
            try { this.recognition.stop(); } catch (e) {}
        }
    }

    // ---- Local recording for server-side STT (e.g., Vosk/Whisper) ----
    async startLocalRecording() {
        if (!this.gameActive) {
            return this.showStatusMessage('Start a game to speak moves.', 'info');
        }
        const playerTurn = this.game ? (this.game.turn() === (this.playerColor === 'white' ? 'w' : 'b')) : false;
        if (!playerTurn) {
            return this.showStatusMessage("It's not your turn yet.", 'info');
        }
        
        this.isListening = true;
    const voiceText = document.getElementById('voiceText');
    const btn = document.getElementById('voiceMoveButton');
    if (btn) btn.textContent = '■ Stop';
    if (voiceText) voiceText.value = 'Recording...';
        try {
            this.recorder = new LocalRecorder();
            await this.recorder.start();
        } catch (e) {
            this.isListening = false;
            if (btn) btn.textContent = '🎤 Record';
            if (voiceText) voiceText.value = 'Mic error';
            return this.showStatusMessage('Failed to start recording: ' + e, 'error');
        }
    }

    async stopLocalRecording() {
        if (!this.isListening) return;
        this.isListening = false;
        const voiceText = document.getElementById('voiceText');
        const btn = document.getElementById('voiceMoveButton');
        if (btn) btn.textContent = '🎤 Record';
        if (voiceText) voiceText.value = 'Processing...';

        try {
            const wavBlob = await (this.recorder ? this.recorder.stopAndGetWavBlob(16000) : Promise.reject('No recorder'));

            const form = new FormData();
            form.append('audio', wavBlob, 'speech.wav');
            form.append('backend', 'vosk');
            // include selected model hint for server (auto/large/small)
            const voiceModelSelect = document.getElementById('voiceModelSelect');
            // Map selection to small/large
            const modelChoice = voiceModelSelect ? voiceModelSelect.value : 'large';
            form.append('model', modelChoice);
            const res = await fetch('/stt', { method: 'POST', body: form });
            if (!res.ok) throw new Error('STT request failed');
            const data = await res.json();
            if (voiceText) voiceText.value = data.text || '';
            if (data.text) this.handleSpokenMove(data.text);
        } catch (e) {
            if (voiceText) voiceText.value = 'STT error';
            this.showStatusMessage('Speech recognition failed: ' + e, 'error');
        } finally {
            this.recorder = null;
        }
    }

    

    handleSpokenMove(text) {
        const voiceText = document.getElementById('voiceText');
        if (voiceText) voiceText.value = text;

        const candidates = normalizeSpeechToCandidates(text);
        for (const cand of candidates) {
            const ok = this.parseMoveToUCI(cand);
            if (ok) {
                // submit through existing path
                this.submitManualMove(cand);
                return;
            }
        }
        this.showStatusMessage('Could not parse spoken move. Try again or type it.', 'error');
    }

    
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessApp = new BlindfoldChessApp();
});