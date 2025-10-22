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
        
        this.initializeApp();
    }
    
    initializeApp() {
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
                        <h3>Chessboard</h3>
                        <div id="chessboard"></div>
                    </div>
                    
                    <div class="panel move-list-panel">
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
    }
    
    updateBoard(fen) {
        if (this.board) {
            this.board.position(fen);
        }
        if (this.game) {
            this.game.load(fen);
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
    
    showStatusMessage(message, type) {
        const statusDiv = document.getElementById('statusMessages') || document.getElementById('setupStatus');
        if (!statusDiv) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `status-message status-${type}`;
        messageDiv.textContent = message;
        
        statusDiv.innerHTML = '';
        statusDiv.appendChild(messageDiv);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (messageDiv.parentNode) {
                messageDiv.parentNode.removeChild(messageDiv);
            }
        }, 5000);
    }
    
    updateGameControls() {
        // Update any game control elements if needed
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessApp = new BlindfoldChessApp();
});