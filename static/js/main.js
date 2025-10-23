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
            this.loadChessLibraries(() => {
                this.createBoard(fen);
            });
        } else {
            this.createBoard(fen);
        }
    }
    
    loadChessLibraries(callback) {
        // Load chess.js
        const chessScript = document.createElement('script');
        chessScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
        document.head.appendChild(chessScript);
        
        // Load jQuery (required by chessboard.js 1.0.0)
        const jqueryScript = document.createElement('script');
        jqueryScript.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        document.head.appendChild(jqueryScript);

        // Load chessboard.js **after** jQuery finishes loading
        let boardScript;
        jqueryScript.onload = () => {
            boardScript = document.createElement('script');
            boardScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.js';
            boardScript.onload = checkLoaded;
            document.head.appendChild(boardScript);
            checkLoaded(); // in case jQuery load counts towards script tally
        };
        
        // Load chessboard.js CSS
        const boardCSS = document.createElement('link');
        boardCSS.rel = 'stylesheet';
        boardCSS.href = 'https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.css';
        document.head.appendChild(boardCSS);
        
        // Wait for libraries to load
        let loaded = 0;
        const checkLoaded = () => {
            loaded++;
            if (loaded >= 3 && typeof Chess !== 'undefined' && typeof Chessboard !== 'undefined' && window.jQuery) {
                callback();
            }
        };
        
        chessScript.onload = checkLoaded;
        // jqueryScript.onload handled above to chain boardScript
        // boardScript.onload set within jqueryScript.onload
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

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return this.showStatusMessage('Microphone not available in this browser.', 'error');
        }

        // Prepare audio context and ScriptProcessor to capture raw PCM
        this.isListening = true;
    const voiceText = document.getElementById('voiceText');
    const btn = document.getElementById('voiceMoveButton');
    if (btn) btn.textContent = '■ Stop';
    if (voiceText) voiceText.value = 'Recording...';

        try {
            this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.inputSampleRate = this.audioContext.sampleRate;
            this.audioSource = this.audioContext.createMediaStreamSource(this.audioStream);
            this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
            this.audioData = [];

            this.processor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                // copy buffer to detach from underlying memory
                this.audioData.push(new Float32Array(input));
            };
            this.audioSource.connect(this.processor);
            this.processor.connect(this.audioContext.destination);
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
            // stop audio graph
            if (this.processor) this.processor.disconnect();
            if (this.audioSource) this.audioSource.disconnect();
            if (this.audioStream) this.audioStream.getTracks().forEach(t => t.stop());
            if (this.audioContext) await this.audioContext.close();
        } catch {}

        try {
            const merged = this.mergeFloat32(this.audioData);
            const wavBlob = this.encodeWAV(this.downsampleBuffer(merged, this.inputSampleRate, 16000), 16000);

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
            // cleanup refs
            this.audioContext = null;
            this.audioSource = null;
            this.processor = null;
            this.audioStream = null;
            this.audioData = [];
        }
    }

    mergeFloat32(chunks) {
        let length = 0;
        for (const c of chunks) length += c.length;
        const result = new Float32Array(length);
        let offset = 0;
        for (const c of chunks) { result.set(c, offset); offset += c.length; }
        return result;
    }

    downsampleBuffer(buffer, inRate, outRate) {
        if (outRate === inRate) return buffer;
        const ratio = inRate / outRate;
        const newLen = Math.round(buffer.length / ratio);
        const result = new Float32Array(newLen);
        let pos = 0;
        for (let i = 0; i < newLen; i++) {
            const idx = i * ratio;
            const idx0 = Math.floor(idx);
            const idx1 = Math.min(idx0 + 1, buffer.length - 1);
            const frac = idx - idx0;
            result[i] = buffer[idx0] * (1 - frac) + buffer[idx1] * frac;
        }
        return result;
    }

    encodeWAV(samples, sampleRate) {
        // 16-bit PCM WAV
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);

        const writeString = (v, o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        const floatTo16 = (out, offset, input) => {
            for (let i = 0; i < input.length; i++, offset += 2) {
                let s = Math.max(-1, Math.min(1, input[i]));
                view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            }
        };

        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // byte rate
        view.setUint16(32, 2, true); // block align
        view.setUint16(34, 16, true); // bits per sample
        writeString(view, 36, 'data');
        view.setUint32(40, samples.length * 2, true);
        floatTo16(view, 44, samples);

        return new Blob([view], { type: 'audio/wav' });
    }

    handleSpokenMove(text) {
        const voiceText = document.getElementById('voiceText');
        if (voiceText) voiceText.value = text;

        const candidates = this.normalizeSpeechToCandidates(text);
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

    // Convert spoken text into likely move strings to try (coordinates or SAN)
    normalizeSpeechToCandidates(text) {
        if (!text) return [];
        let s = text.toLowerCase().trim();
        // strip punctuation
        s = s.replace(/[^a-z0-9\s-]/g, ' ');
        s = s.replace(/\s+/g, ' ');

        // number words to digits
        const numMap = {
            'one': '1', 'won': '1',
            'two': '2', 'to': '2', 'too': '2',
            'three': '3',
            'four': '4', 'for': '4',
            'five': '5',
            'six': '6',
            'seven': '7',
            'eight': '8', 'ate': '8'
        };
        s = s.split(' ').map(w => numMap[w] || w).join(' ');

        // castles
        s = s.replace(/castle\s+king\s*side|king\s*side\s*castle|short\s*castle|o\s*-\s*o/g, 'O-O');
        s = s.replace(/castle\s+queen\s*side|queen\s*side\s*castle|long\s*castle|o\s*-\s*o\s*-\s*o/g, 'O-O-O');

        // piece names -> SAN letters
        s = s.replace(/knight/g, 'N')
             .replace(/bishop/g, 'B')
             .replace(/rook/g, 'R')
             .replace(/queen/g, 'Q')
             .replace(/king/g, 'K');

        // captures
        s = s.replace(/takes|x|by/g, 'x');
        // promotion words
        s = s.replace(/equals\s*queen|promote\s*to\s*queen|=\s*q/g, '=Q');
        s = s.replace(/equals\s*rook|promote\s*to\s*rook|=\s*r/g, '=R');
        s = s.replace(/equals\s*bishop|promote\s*to\s*bishop|=\s*b/g, '=B');
        s = s.replace(/equals\s*knight|promote\s*to\s*knight|=\s*n/g, '=N');

        const candidates = new Set();

        // Direct SAN candidate
        candidates.add(s.replace(/\s+/g, ''));

        // Common SAN spacing (e.g., N f 3 -> Nf3)
        candidates.add(s.replace(/\b([nbrqk])\s*([a-h])\s*([1-8])\b/gi, '$1$2$3').replace(/\s+/g, ''));

        // Coordinate candidate: detect patterns like e 2 e 4 -> e2e4
        const letters = s.match(/[a-h]/g) || [];
        const digits = s.match(/[1-8]/g) || [];
        // build naive coordinate by removing spaces
        candidates.add(s.replace(/\s+/g, ''));

        // Try extracting two squares in order
        const sq = Array.from(s.matchAll(/([a-h])\s*([1-8])/g)).map(m => m[1] + m[2]);
        if (sq.length >= 2) {
            candidates.add((sq[0] + sq[1]).toLowerCase());
        }

        // Promotion coordinate like e7 e8 queen -> e7e8q
        const promoMap = { 'queen': 'q', 'rook': 'r', 'bishop': 'b', 'knight': 'n', 'q': 'q', 'r': 'r', 'b': 'b', 'n': 'n' };
        const promoMatch = s.match(/([a-h])\s*7\b.*?([a-h])\s*8\b.*?(queen|rook|bishop|knight|q|r|b|n)/);
        if (promoMatch) {
            const from = promoMatch[1] + '7';
            const to = promoMatch[2] + '8';
            const pr = promoMap[promoMatch[3]] || '';
            candidates.add((from + to + pr).toLowerCase());
        }

        // Include castles explicitly
        if (s.includes('O-O-O')) candidates.add('O-O-O');
        if (s.includes('O-O')) candidates.add('O-O');

        // Remove empties
        return Array.from(candidates).filter(Boolean);
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessApp = new BlindfoldChessApp();
});