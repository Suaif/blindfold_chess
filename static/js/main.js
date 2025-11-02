import { loadChessLibraries } from './chesslib.js';
import { LocalRecorder, normalizeSpeechToCandidates } from './audio.js';
import { humanizeMoveFromFen, parseMoveToUCI as parseMoveToUCIFen, findBestMatchingMoveSuggestion as suggestMoveFromFen, resolveImplicitDestination as resolveImplicitFromFen, decideYesNo } from './voice_moves.js';

class BlindfoldChessApp {
    constructor() {
        this.ws = null;
        this.board = null;
        this.game = null;
        this.connected = false;
        this.gameActive = false;
        this.playerColor = 'white';
        this.engineElo = 1320;
        this.testAnswer = null;
        this.piecesVisible = true; // track piece visibility
        this.isListening = false;
        this.ttsAudio = null;
        this.ttsQueue = [];
        this.lastTtsPayload = null; // remember last spoken TTS payload for Repeat
        this.recorder = null;
        this.latestMoveHistory = [];
        this.resetTimelineState();
        this.boundKeyHandler = null;
        this.darkMode = false;
        this.ttsEnabled = true;
        this.awaitingTestAnswer = false; // awaiting spoken answer to TEST
        // Pending yes/no confirmation for suggested voice move
        this.pendingMoveConfirm = null; // { uci, san, spoken, score }
        // Drag and highlight state
        this.isDragging = false;
        this.dragSourceSquare = null;
        this.dragCancelled = false;
        this.highlightedSquares = new Set();
        // Simple move sound
        this._audioCtx = null;
        this.playedLocalMoveSound = false;
        this._boardDomHandlersAttached = false;
        this._globalContextMenuAttached = false;
        this._boardObserver = null;
        // STT configuration (model selection moved from UI to code)
        this.sttBackend = 'whisper'; // 'whisper' or 'vosk'
        this.sttModel = 'medium';     // e.g., 'small', 'medium', 'large' or 'auto'
        
        this.initializeApp();
    }

    // ---- Move sound (Web Audio click) ----
    ensureAudioContext() {
        if (!this._audioCtx) {
            try {
                this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch {}
        }
        return this._audioCtx;
    }

    playMoveSound() {
        const ctx = this.ensureAudioContext();
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 660; // pleasant mid tone
        const now = ctx.currentTime;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.10);
        o.connect(g).connect(ctx.destination);
        o.start(now);
        o.stop(now + 0.12);
    }

    initializeApp() {
        // Ensure global toast container exists before rendering any UI
        this.ensureToastContainer();
        this.loadThemePreference();
        this.applyTheme();
        this.loadTtsPreference();
        // Install global suppressor early so it applies before board exists
        this.attachGlobalContextMenuSuppressor();
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
                
            case 'game_started': {
                this.playerColor = message.player_color;
                this.engineElo = message.engine_elo;
                this.gameActive = true;
                this.resetTimelineState();
                this.initialFen = message.fen;
                this.currentFen = message.fen;
                this.latestMoveHistory = Array.isArray(message.move_history) ? message.move_history.slice() : [];
                // Render interface first so #chessboard element exists
                this.showMainInterface();
                this.rebuildTimeline(this.latestMoveHistory, message.fen);
                this.initializeBoard(message.fen);
                this.updateMoveList(this.latestMoveHistory);
                this.updatePositionStats(message);
                this.updateGameControls();
                break;
            }
                
            case 'position_update': {
                const prevLen = Array.isArray(this.latestMoveHistory) ? this.latestMoveHistory.length : 0;
                this.currentFen = message.fen;
                this.latestMoveHistory = Array.isArray(message.move_history) ? message.move_history.slice() : [];
                this.rebuildTimeline(this.latestMoveHistory, message.fen);
                this.updateBoard(message.fen);
                this.updateMoveList(this.latestMoveHistory);
                this.updatePositionStats(message);
                if (typeof message.undo_count === 'number') {
                    const plies = message.undo_count;
                    const phrase = plies > 1 ? 'your last move' : 'the last move';
                    this.showStatusMessage(`Undid ${phrase}.`, 'info');
                } else {
                    const newLen = Array.isArray(message.move_history) ? message.move_history.length : 0;
                    const delta = Math.max(0, newLen - prevLen);
                    if (this.playedLocalMoveSound) {
                        // We already sounded for the player's move; if engine replied in same update, play once
                        if (delta >= 2) {
                            this.playMoveSound();
                        }
                        this.playedLocalMoveSound = false;
                    } else if (delta > 0) {
                        // Opponent or external move
                        this.playMoveSound();
                    }
                }
                this.updateGameControls();
                break;
            }
                
            case 'invalid_move':
                this.showStatusMessage(`Invalid move: ${message.message}`, 'error');
                break;
                
            case 'game_over':
                this.handleGameOver(message);
                break;
                
            case 'chat_response':
                this.addChatMessage(message.user_message, 'user');
                this.addChatMessage(message.ai_response, 'assistant');
                // Update state for spoken Q/A flow
                try {
                    const resp = (message.ai_response || '').toString();
                    if (resp.toUpperCase().startsWith('TEST QUESTION:')) {
                        this.awaitingTestAnswer = true;
                    } else if (/\bCorrect answer:\b/i.test(resp) || /\bCorrect\b|\bIncorrect\b/.test(resp)) {
                        this.awaitingTestAnswer = false;
                    }
                } catch {}
                break;
                
            case 'error':
                this.showStatusMessage(message.message, 'error');
                break;

            case 'tts':
                this.playTts(message);
                break;
        }
    }

    playTts(ttsPayload) {
        if (!ttsPayload || !this.ttsEnabled) return;

        const enqueue = (payload) => {
            this.ttsQueue.push(payload);
            this.processTtsQueue();
        };

        enqueue(ttsPayload);
    }

    processTtsQueue() {
        if (!this.ttsEnabled) {
            this.ttsQueue = [];
            if (this.ttsAudio) {
                try {
                    this.ttsAudio.pause();
                } catch {}
                this.ttsAudio = null;
            }
            return;
        }

        if (this.ttsAudio) return; // already playing
        if (!this.ttsQueue.length) return;

        const payload = this.ttsQueue.shift();
        if (!payload) return;

        if (payload.audio) {
            // store last payload with audio for repeat functionality
            this.lastTtsPayload = payload;
            const audio = new Audio(`data:audio/wav;base64,${payload.audio}`);
            audio.addEventListener('ended', () => {
                if (this.ttsAudio === audio) {
                    this.ttsAudio = null;
                    this.processTtsQueue();
                }
            });
            audio.addEventListener('error', (err) => {
                console.warn('TTS playback error:', err);
                if (this.ttsAudio === audio) {
                    this.ttsAudio = null;
                    this.processTtsQueue();
                }
            });
            this.ttsAudio = audio;
            audio.play().catch(err => {
                console.warn('TTS playback failed:', err);
                if (this.ttsAudio === audio) {
                    this.ttsAudio = null;
                    this.processTtsQueue();
                }
            });
        } else {
            if (payload.text) {
                this.showStatusMessage(payload.text, 'info');
            }
            // Move to next in queue
            this.processTtsQueue();
        }
    }

    repeatLastTts() {
        if (!this.ttsEnabled) {
            this.showStatusMessage('Voice feedback is disabled.', 'info');
            return;
        }
        const payload = this.lastTtsPayload;
        if (!payload) {
            this.showStatusMessage('Nothing to repeat yet.', 'info');
            return;
        }
        if (payload.audio) {
            // Re-enqueue the last audio payload
            this.playTts(payload);
        } else if (payload.text) {
            // Generate audio again for text-only payload
            this.requestTts(payload.text);
        } else {
            this.showStatusMessage('Nothing to repeat yet.', 'info');
        }
    }

    async requestTts(text) {
        if (!text || !this.ttsEnabled) return;
        try {
            const res = await fetch('/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (!res.ok) {
                console.warn('TTS request failed with status', res.status);
                return;
            }
            const payload = await res.json();
            if (payload && payload.tts) {
                this.playTts(payload.tts);
            }
        } catch (error) {
            console.warn('TTS request error:', error);
        }
    }

    humanizeMove(moveText) {
        const fen = this.game ? this.game.fen() : null;
        try { return humanizeMoveFromFen(fen, moveText, Chess); } catch { return String(moveText || ''); }
    }
    
    showSetupScreen() {
        if (this.boundKeyHandler) {
            window.removeEventListener('keydown', this.boundKeyHandler);
            this.boundKeyHandler = null;
        }
        this.resetTimelineState();
        this.latestMoveHistory = [];

        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container">
                <div class="header">
                    <button type="button" class="theme-toggle" id="themeToggle">
                        <span class="sr-only">Toggle dark mode</span>
                    </button>
                    <div class="logo-pair">
                        <img src="/static/icons/white_horse_right-removebg.png" class="logo-img left" alt="" aria-hidden="true">
                        <h1>Blindfold Chess Training</h1>
                        <img src="/static/icons/white_horse_left-removebg.png" class="logo-img right" alt="" aria-hidden="true">
                    </div>
                </div>
                <div class="setup-screen">
                    <h2>Game Setup</h2>
                    
                    <div class="setup-group">
                        <label>Select Your Color:</label>
                        <div class="color-selector">
                            <div class="color-option selected" data-color="white">
                                White
                            </div>
                            <div class="color-option" data-color="black">
                                Black
                            </div>
                        </div>
                    </div>
                    
                    <div class="setup-group">
                        <label>Opponent Strength (ELO):</label>
                        <input type="range" class="elo-slider" min="1320" max="2800" value="1350" id="eloSlider">
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

        this.attachThemeToggle();
        this.syncPieceToggleButtons();
        this.syncVoiceToggleButton();
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
                    <button type="button" class="theme-toggle" id="themeToggle">
                        <span class="sr-only">Toggle dark mode</span>
                    </button>
                    <div class="logo-pair">
                        <img src="/static/icons/white_horse_right-removebg.png" class="logo-img left" alt="" aria-hidden="true">
                        <h1>Blindfold Chess Training</h1>
                        <img src="/static/icons/white_horse_left-removebg.png" class="logo-img right" alt="" aria-hidden="true">
                    </div>
                </div>
                
                <div class="game-controls">
                    <p>Playing as ${this.playerColor} vs ${this.engineElo} ELO opponent</p>
                    <button class="control-button reset-button" id="resetButton">Reset Game</button>
                    <button class="control-button new-game-button" id="newGameButton">New Game</button>
                </div>
                
                <div class="main-content">
                    <div class="panel chessboard-panel">
                        <div class="panel-header board-header">
                            <h3>Chessboard</h3>
                            <div class="panel-actions">
                                <button type="button" class="icon-toggle eye-toggle" id="piecesToggleTop" aria-pressed="${this.piecesVisible ? 'true' : 'false'}">
                                    <span class="icon-glyph" aria-hidden="true"></span>
                                    <span class="sr-only">Toggle pieces</span>
                                </button>
                                <button type="button" class="icon-toggle audio-toggle" id="voiceToggle" aria-pressed="${this.ttsEnabled ? 'true' : 'false'}">
                                    <span class="icon-glyph" aria-hidden="true"></span>
                                    <span class="sr-only">Toggle voice feedback</span>
                                </button>
                            </div>
                        </div>
                        <div id="chessboard"></div>
                        <!-- Row 1: conversation + record + recognition output -->
                        <div class="board-row row-voice">
                            <div class="voice-buttons">
                                <button id="convoModeButton" class="circle-btn convo-btn" title="Conversational mode (coming soon)" aria-label="Conversational mode (coming soon)">
                                    <span class="btn-icon" aria-hidden="true">
                                        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">
                                            <path d="M20 2H4a2 2 0 0 0-2 2v14l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
                                        </svg>
                                    </span>
                                    <span class="sr-only">Conversational mode (coming soon)</span>
                                </button>
                                <button id="voiceMoveButton" class="circle-btn voice-move-button record-btn" title="Record" aria-label="Record" aria-pressed="false">
                                    <span class="btn-icon" aria-hidden="true">🎙️</span>
                                    <span class="sr-only">Record</span>
                                </button>
                            </div>
                            <div class="voice-text-row">
                                <input type="text" id="voiceText" class="voice-text" placeholder="Recognition output..." readonly>
                            </div>
                        </div>
                        <!-- Row 2: nav prev/next + undo -->
                        <div class="board-row row-controls">
                            <div class="timeline-nav">
                                <button id="navPrev" class="keycap-btn" title="Previous position" aria-label="Previous position">
                                    <span class="keycap-arrow" aria-hidden="true">←</span>
                                </button>
                                <button id="navNext" class="keycap-btn" title="Next position" aria-label="Next position">
                                    <span class="keycap-arrow" aria-hidden="true">→</span>
                                </button>
                            </div>
                            <button id="undoButton" class="circle-btn undo-btn" title="Undo your last move" aria-label="Undo last move">
                                <span class="btn-icon" aria-hidden="true">↶</span>
                                <span class="sr-only">Undo move</span>
                            </button>
                        </div>
                    </div>
                    
                    <div class="panel move-list-panel">
                        <div class="panel-header">
                            <h3>Move History</h3>
                        </div>
                        <div class="move-list" id="moveList"></div>
                    </div>
                    
                    <div class="panel chat-panel">
                        <h3>Chat Assistant</h3>
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
        const undoButton = document.getElementById('undoButton');
        if (undoButton) {
            undoButton.addEventListener('click', () => {
                this.requestUndo();
            });
        }

        const prevBtn = document.getElementById('navPrev');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.stepTimeline(-1));
        }
        const nextBtn = document.getElementById('navNext');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.stepTimeline(1));
        }

        const resetButton = document.getElementById('resetButton');
        if (resetButton) {
            resetButton.addEventListener('click', () => {
                this.resetGame();
            });
        }
        
        const newGameButton = document.getElementById('newGameButton');
        if (newGameButton) {
            newGameButton.addEventListener('click', () => {
                this.showSetupScreen();
            });
        }
        // Chat input
        const chatInput = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendButton');
        
        const sendMessage = () => {
            if (!chatInput) return;
            const message = chatInput.value.trim();
            if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'chat',
                    message: message
                }));
                chatInput.value = '';
            }
        };
        
        if (sendButton) sendButton.addEventListener('click', sendMessage);
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendMessage();
                }
            });
        }

        if (this.boundKeyHandler) {
            window.removeEventListener('keydown', this.boundKeyHandler);
        }
        this.boundKeyHandler = this.handleKeyDown.bind(this);
        window.addEventListener('keydown', this.boundKeyHandler);

        // Piece visibility toggles (top and right) - keep them synchronized
        const topToggle = document.getElementById('piecesToggleTop');
        const handleEyeToggle = (event) => {
            event.preventDefault();
            this.togglePieces(!this.piecesVisible);
        };

        if (topToggle) topToggle.addEventListener('click', handleEyeToggle);
        const voiceToggleButton = document.getElementById('voiceToggle');
        if (voiceToggleButton) {
            voiceToggleButton.addEventListener('click', (event) => {
                event.preventDefault();
                this.toggleTts();
            });
        }

        // Voice input button
        const voiceBtn = document.getElementById('voiceMoveButton');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                if (this.isListening) {
                    this.stopLocalRecording();
                } else {
                    this.startLocalRecording();
                }
            });
        }
        const convoBtn = document.getElementById('convoModeButton');
        if (convoBtn) {
            convoBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showStatusMessage('Conversational mode is coming soon.', 'info');
            });
        }

        this.attachThemeToggle();
        this.syncPieceToggleButtons();
        this.syncVoiceToggleButton();
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
                if (!this.isViewingLive()) {
                    this.jumpToLatestPosition(true);
                }
                // Only allow dragging pieces of the player's color
                if (this.game.game_over()) return false;
                if (this.game.turn() !== (this.playerColor === 'white' ? 'w' : 'b')) return false;
                if ((this.playerColor === 'white' && piece.search(/^w/) === -1) ||
                    (this.playerColor === 'black' && piece.search(/^b/) === -1)) {
                    return false;
                }
                // Start drag state and show legal moves immediately (on press)
                this.isDragging = true;
                this.dragSourceSquare = source;
                this.dragCancelled = false;
                this.showPossibleMovesForSquare(source);
                return true;
            },
            onDrop: (source, target) => {
                // Clear highlights when dropping
                this.clearMoveHighlights();
                // If user cancelled via right-click, snap back
                if (this.dragCancelled) {
                    this.dragCancelled = false;
                    this.isDragging = false;
                    this.dragSourceSquare = null;
                    return 'snapback';
                }
                const move = this.game.move({
                    from: source,
                    to: target,
                    promotion: 'q' // Auto-promote to queen
                });
                
                if (move === null) {
                    this.isDragging = false;
                    this.dragSourceSquare = null;
                    return 'snapback';
                }
                
                // Local move succeeded: play immediate sound
                this.playMoveSound();
                this.playedLocalMoveSound = true;

                // Send move to server
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'move',
                        move: move.from + move.to + (move.promotion || '')
                    }));
                }
                this.isDragging = false;
                this.dragSourceSquare = null;
            },
            onSnapEnd: () => {
                this.board.position(this.game.fen());
                // Ensure drag state resets in any case
                this.isDragging = false;
                this.dragSourceSquare = null;
                this.dragCancelled = false;
            }
        };
        
        this.board = new Chessboard('chessboard', config);

        // Apply visibility immediately after the board is created
        this.applyPieceVisibility();
        this.syncPieceToggleButtons();
        this.syncVoiceToggleButton();

        // Attach board DOM listeners for right-click cancel + press highlights
        this.attachBoardDomHandlers();
        // Harden piece elements against native image menus/drag and observe future changes
        this.hardenBoardPiecesAgainstContextMenu();
        this.observeBoardForPieceElements();
    }

    // ---- Move highlighting helpers ----
    getBoardElement() {
        return document.getElementById('chessboard');
    }

    clearMoveHighlights() {
        const el = this.getBoardElement();
        if (!el) return;
        if (this.highlightedSquares) {
            for (const sq of this.highlightedSquares) {
                const nodes = el.querySelectorAll(`.square-${sq}`);
                nodes.forEach(n => {
                    n.classList.remove('move-source');
                    n.classList.remove('move-dest');
                    n.classList.remove('move-capture');
                });
            }
        }
        this.highlightedSquares = new Set();
    }

    showPossibleMovesForSquare(square) {
        try {
            this.clearMoveHighlights();
            if (!this.game) return;
            const turn = this.game.turn();
            const piece = this.game.get(square);
            if (!piece) return;
            const isOwn = (this.playerColor === 'white' ? 'w' : 'b') === piece.color;
            if (!isOwn) return;
            const moves = this.game.moves({ square, verbose: true }) || [];
            if (!moves.length) return;
            const el = this.getBoardElement();
            if (!el) return;
            // Highlight source
            const srcNodes = el.querySelectorAll(`.square-${square}`);
            srcNodes.forEach(n => n.classList.add('move-source'));
            this.highlightedSquares.add(square);
            // Highlight destinations
            for (const mv of moves) {
                const dest = mv.to;
                const nodes = el.querySelectorAll(`.square-${dest}`);
                const isCapture = (mv.flags || '').includes('c');
                nodes.forEach(n => n.classList.add(isCapture ? 'move-capture' : 'move-dest'));
                this.highlightedSquares.add(dest);
            }
        } catch (e) {
            // ignore
        }
    }

    attachBoardDomHandlers() {
        if (this._boardDomHandlersAttached) return;
        const el = this.getBoardElement();
        if (!el) return;

        // On touch devices, prevent the page from scrolling when interacting with the board
        try {
            el.style.touchAction = 'none';
            const preventTouchScroll = (ev) => {
                if (ev && ev.cancelable) ev.preventDefault();
            };
            el.addEventListener('touchstart', preventTouchScroll, { passive: false, capture: true });
            el.addEventListener('touchmove', preventTouchScroll, { passive: false, capture: true });
        } catch (_) {}

        const isInsideBoard = (target) => {
            if (!target) return false;
            const root = this.getBoardElement();
            let node = target;
            while (node) {
                if (node === root) return true;
                if (node.classList) {
                    if (node.classList.contains('chessboard-63f37')) return true;
                    // piece elements (e.g., chessboard.js often uses `piece-417db`)
                    for (const cls of Array.from(node.classList)) {
                        if (cls === 'piece' || cls.startsWith('piece-')) return true;
                    }
                    // any square
                    for (const cls of Array.from(node.classList)) {
                        if (/^square-[a-h][1-8]$/.test(cls)) return true;
                    }
                }
                node = node.parentElement;
            }
            return false;
        };
        // Suppress context menu anywhere over the board (including pieces), capture phase
        const ctxHandler = (ev) => {
            // Suppress context menu while dragging anywhere; otherwise only if over board
            if (!this.isDragging && !isInsideBoard(ev.target)) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
            if (this.isDragging) {
                this.dragCancelled = true;
                this.clearMoveHighlights();
                if (this.board && this.game) {
                    this.board.position(this.game.fen());
                }
            }
        };
        document.addEventListener('contextmenu', ctxHandler, true);
        document.addEventListener('contextmenu', ctxHandler, false);
        // Some browsers use auxclick for non-primary buttons
        const auxHandler = (ev) => {
            if (!this.isDragging && !isInsideBoard(ev.target)) return;
            if (ev.button !== 2) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        };
        document.addEventListener('auxclick', auxHandler, true);
        document.addEventListener('auxclick', auxHandler, false);

        // Right button down/up/move during drag -> cancel immediately (capture)
        const cancelDrag = (ev) => {
            if (!this.isDragging) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
            this.dragCancelled = true;
            this.clearMoveHighlights();
            if (this.board && this.game) {
                this.board.position(this.game.fen());
            }
        };

        const ptrDownHandler = (ev) => { if (ev.button === 2) cancelDrag(ev); };
        const mouseDownHandler = (ev) => { if (ev.button === 2) cancelDrag(ev); };
        const ptrUpHandler = (ev) => { if (ev.button === 2) cancelDrag(ev); };
        const ptrMoveHandler = (ev) => { if ((ev.buttons & 2) === 2) cancelDrag(ev); };

        document.addEventListener('pointerdown', ptrDownHandler, true);
        document.addEventListener('mousedown', mouseDownHandler, true);
        document.addEventListener('pointerup', ptrUpHandler, true);
        document.addEventListener('pointermove', ptrMoveHandler, true);
        // Show possible moves on initial press (mousedown) without waiting for release
        el.addEventListener('mousedown', (ev) => {
            if (ev.button !== 0) return; // only left button
            // find square class up the tree
            const target = ev.target;
            const sq = this.extractSquareFromElement(target);
            if (!sq) return;
            // Only show if it's your turn and piece is yours
            try {
                if (!this.game) return;
                if (this.game.turn() !== (this.playerColor === 'white' ? 'w' : 'b')) return;
                const piece = this.game.get(sq);
                if (!piece) return;
                const isOwn = (this.playerColor === 'white' ? 'w' : 'b') === piece.color;
                if (!isOwn) return;
                this.showPossibleMovesForSquare(sq);
            } catch {}
        });
        // Clear highlights when mouse is released and no drag occurred
        window.addEventListener('mouseup', () => {
            if (!this.isDragging) {
                this.clearMoveHighlights();
            }
        });

        this._boardDomHandlersAttached = true;
    }

    // Global geometry-based suppression to catch any contextmenu over the board
    attachGlobalContextMenuSuppressor() {
        if (this._globalContextMenuAttached) return;
        const suppressIfOverBoard = (ev) => {
            try {
                const boardEl = document.getElementById('chessboard');
                if (!boardEl) return;
                const rect = boardEl.getBoundingClientRect();
                const x = ev.clientX, y = ev.clientY;
                const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                if (!inside) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
                if (this.isDragging) {
                    this.dragCancelled = true;
                    this.clearMoveHighlights();
                    if (this.board && this.game) {
                        this.board.position(this.game.fen());
                    }
                }
            } catch (_) {}
        };
        const auxIfOverBoard = (ev) => {
            if (ev && ev.button !== 2) return;
            suppressIfOverBoard(ev);
        };
        window.addEventListener('contextmenu', suppressIfOverBoard, true);
        window.addEventListener('auxclick', auxIfOverBoard, true);
        this._globalContextMenuAttached = true;
    }

    // Ensure piece images/divs do not trigger native image menus or drags
    hardenBoardPiecesAgainstContextMenu() {
        const root = this.getBoardElement();
        if (!root) return;
        const protectEl = (el) => {
            try {
                if (!el) return;
                if (el.dataset && el.dataset.hardenedContext === '1') return;
                // Disable native context menu directly on the element
                el.oncontextmenu = () => false;
                // Prevent native image drag behavior
                el.setAttribute('draggable', 'false');
                el.addEventListener('dragstart', (e) => { e.preventDefault(); }, { capture: true });
                // Extra safety: capture right-clicks on the element
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                }, { capture: true });
                if (el.dataset) el.dataset.hardenedContext = '1';
            } catch (_) {}
        };
        // Images and divs that represent pieces (background-image)
        const imgs = root.querySelectorAll('img, .piece, [class*="piece-"]');
        imgs.forEach(protectEl);
        // Also catch any node with inline background-image style
        const withBg = root.querySelectorAll('[style*="background-image"]');
        withBg.forEach(protectEl);
    }

    // Observe dynamic DOM changes to re-apply hardening as pieces render/animate
    observeBoardForPieceElements() {
        if (this._boardObserver) {
            try { this._boardObserver.disconnect(); } catch {}
            this._boardObserver = null;
        }
        const root = this.getBoardElement();
        if (!root) return;
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (!m.addedNodes || !m.addedNodes.length) continue;
                m.addedNodes.forEach((n) => {
                    if (!(n instanceof HTMLElement)) return;
                    // Direct node
                    this.hardenBoardPiecesAgainstContextMenu();
                });
            }
        });
        observer.observe(root, { childList: true, subtree: true });
        this._boardObserver = observer;
    }

    extractSquareFromElement(el) {
        let node = el;
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
            if (!node.classList) continue;
            for (const cls of Array.from(node.classList)) {
                if (/^square-[a-h][1-8]$/.test(cls)) {
                    return cls.slice('square-'.length);
                }
            }
        }
        return null;
    }


    // Toggle piece visibility and sync controls
    togglePieces(visible) {
        this.piecesVisible = visible;
        this.applyPieceVisibility();
        this.syncPieceToggleButtons();
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

    syncPieceToggleButtons() {
        const icon = this.piecesVisible ? "\u{1F441}\u{FE0F}" : "\u{1F648}";
        const label = this.piecesVisible ? 'Hide pieces' : 'Show pieces';
        const toggles = [
            document.getElementById('piecesToggleTop'),
        ];

        toggles.forEach((btn) => {
            if (!btn) return;
            btn.setAttribute('aria-pressed', this.piecesVisible ? 'true' : 'false');
            btn.setAttribute('title', label);
            btn.setAttribute('aria-label', label);
            const content = `
                <span class="icon-glyph" aria-hidden="true">${icon}</span>
                <span class="sr-only">${label}</span>
            `.trim();
            btn.innerHTML = content;
        });
    }
    
    syncVoiceToggleButton() {
        const btn = document.getElementById('voiceToggle');
        if (!btn) return;
        const icon = this.ttsEnabled ? "\u{1F50A}" : "\u{1F507}";
        const label = this.ttsEnabled ? 'Mute voice feedback' : 'Enable voice feedback';
        btn.setAttribute('aria-pressed', this.ttsEnabled ? 'true' : 'false');
        btn.setAttribute('title', label);
        btn.setAttribute('aria-label', label);
        const content = `
            <span class="icon-glyph" aria-hidden="true">${icon}</span>
            <span class="sr-only">${label}</span>
        `.trim();
        btn.innerHTML = content;
    }
    
    resetTimelineState() {
        this.positionTimeline = [];
        this.timelineIndex = 0;
        this.initialFen = null;
        this.currentFen = null;
        this.reviewing = false;
    }

    rebuildTimeline(moveHistory = [], currentFen = null) {
        const ChessCtor = typeof Chess === 'function' ? Chess : null;
        const timeline = [];

        if (ChessCtor) {
            try {
                const baseFen = this.initialFen || undefined;
                const analyser = baseFen ? new ChessCtor(baseFen) : new ChessCtor();
                timeline.push(analyser.fen());
                if (Array.isArray(moveHistory)) {
                    for (const san of moveHistory) {
                        if (!san) continue;
                        const mv = analyser.move(san, { sloppy: true });
                        if (!mv) break;
                        timeline.push(analyser.fen());
                    }
                }
            } catch (err) {
                console.warn('Timeline rebuild failed:', err);
            }
        }

        if (!timeline.length) {
            if (currentFen) {
                timeline.push(currentFen);
            } else if (ChessCtor) {
                const fallback = new ChessCtor();
                timeline.push(fallback.fen());
            } else {
                timeline.push('');
            }
        }

        if (currentFen && timeline[timeline.length - 1] !== currentFen) {
            timeline.push(currentFen);
        }

        this.positionTimeline = timeline;
        this.timelineIndex = timeline.length - 1;
        this.currentFen = currentFen || (timeline.length ? timeline[timeline.length - 1] : null);
        this.reviewing = false;
    }

    isViewingLive() {
        if (!this.positionTimeline || !this.positionTimeline.length) {
            return true;
        }
        return this.timelineIndex >= this.positionTimeline.length - 1;
    }

    showTimelinePosition(index) {
        if (!this.positionTimeline || !this.positionTimeline.length) {
            return;
        }
        const clamped = Math.max(0, Math.min(index, this.positionTimeline.length - 1));
        this.timelineIndex = clamped;
        const targetFen = this.positionTimeline[clamped];
        if (this.board && targetFen) {
            this.board.position(targetFen);
            this.applyPieceVisibility();
        }
        this.reviewing = !this.isViewingLive();
        if (Array.isArray(this.latestMoveHistory)) {
            this.updateMoveList(this.latestMoveHistory);
        }
        this.updateGameControls();
    }

    jumpToLatestPosition(silent = false) {
        if (!this.positionTimeline || !this.positionTimeline.length) {
            return;
        }
        const wasReviewing = !this.isViewingLive();
        this.showTimelinePosition(this.positionTimeline.length - 1);
        if (!silent && wasReviewing) {
            this.showStatusMessage('Back to live position.', 'info');
        }
    }

    stepTimeline(delta) {
        if (!this.positionTimeline || !this.positionTimeline.length) {
            return;
        }
        const wasReviewing = !this.isViewingLive();
        const nextIndex = Math.min(
            Math.max(this.timelineIndex + delta, 0),
            this.positionTimeline.length - 1
        );
        if (nextIndex === this.timelineIndex && delta !== 0) {
            return;
        }
        this.showTimelinePosition(nextIndex);
        if (!this.isViewingLive()) {
            const plyIndex = Math.max(0, this.timelineIndex - 1);
            const moveNumber = Math.floor(plyIndex / 2) + 1;
            const side = plyIndex % 2 === 0 ? 'White' : 'Black';
            // this.showStatusMessage(`Reviewing move ${moveNumber} (${side}). Press Right Arrow to return to live position.`, 'info');
        // } else if (wasReviewing) {
        //     this.showStatusMessage('Back to live position.', 'info');
        }
    }

    handleKeyDown(event) {
        if (!this.gameActive) return;
        const key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;

        const target = event.target;
        if (target) {
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
                return;
            }
        }

        event.preventDefault();
        if (key === 'ArrowLeft') {
            this.stepTimeline(-1);
        } else {
            this.stepTimeline(1);
        }
    }
    
    updateBoard(fen) {
        this.currentFen = fen;
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

    requestUndo(source = 'ui') {
        if (!this.gameActive) {
            return this.showStatusMessage('No active game to undo.', 'info');
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return this.showStatusMessage('Not connected. Cannot undo move.', 'error');
        }
        const historyLength = Array.isArray(this.latestMoveHistory) ? this.latestMoveHistory.length : 0;
        const minHistory = this.playerColor === 'white' ? 1 : 2;
        if (historyLength < minHistory) {
            return this.showStatusMessage('No moves to undo.', 'info');
        }
        this.jumpToLatestPosition(true);
        this.ws.send(JSON.stringify({
            type: 'undo',
            source: source
        }));
    }

    // Submit a move typed by the user (SAN or coordinate). Validates and sends to server.
    submitManualMove(moveText, source = 'manual') {
        if (!this.gameActive) {
            return this.showStatusMessage('No active game. Start a new game first.', 'error');
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return this.showStatusMessage('Not connected. Please wait for connection.', 'error');
        }

        if (!this.isViewingLive()) {
            this.jumpToLatestPosition(true);
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
            console.warn(`Move not applied locally: "${moveText}" (${uci}).`);
            return this.showStatusMessage('Illegal move or not recognized.', 'error');
        }

        // Reflect on board immediately
        if (this.board) {
            this.board.position(this.game.fen());
            this.applyPieceVisibility();
        }

        // Send to server with source information
        this.ws.send(JSON.stringify({
            type: 'move',
            move: from + to + (promo || ''),
            source: source
        }));

        // Local move succeeded: play immediate sound and mark to suppress duplicate
        this.playMoveSound();
        this.playedLocalMoveSound = true;
    }

    // Convert a typed move to UCI (e2e4, or from SAN like Nf3 / O-O / e8=Q)
    parseMoveToUCI(moveText) {
        try { return parseMoveToUCIFen(this.game ? this.game.fen() : null, moveText, Chess); } catch { return null; }
    }
    
    updateMoveList(moveHistory) {
        const moveList = document.getElementById('moveList');
        if (!moveList) return;

        this.latestMoveHistory = Array.isArray(moveHistory) ? moveHistory.slice() : [];
        const history = this.latestMoveHistory;
        const viewingLive = this.isViewingLive();
        const viewedPly = viewingLive
            ? (history.length ? history.length - 1 : -1)
            : Math.max(0, this.timelineIndex - 1);
        const viewedPairIndex = viewedPly >= 0 ? Math.floor(viewedPly / 2) : -1;

        let html = '';
        if (history.length === 0) {
            html = '<div class="move-item empty">No moves yet.</div>';
        } else {
            for (let i = 0; i < history.length; i += 2) {
                const moveNumber = Math.floor(i / 2) + 1;
                const whiteMove = history[i] || '';
                const blackMove = history[i + 1] || '';
                const isWhiteCurrent = viewedPly === i;
                const isBlackCurrent = viewedPly === i + 1;
                const classes = ['move-item'];
                if (isWhiteCurrent || isBlackCurrent) classes.push('current');
                html += `<div class="${classes.join(' ')}">`;
                html += `<span class="move-number">${moveNumber}.</span>`;
                html += `<span class="move white${isWhiteCurrent ? ' active' : ''}">${whiteMove || '&nbsp;'}</span>`;
                html += `<span class="move black${isBlackCurrent ? ' active' : ''}">${blackMove || '&nbsp;'}</span>`;
                html += `</div>`;
            }
        }

        moveList.innerHTML = html;

        if (viewingLive || viewedPairIndex < 0) {
            moveList.scrollTop = moveList.scrollHeight;
        } else {
            const items = moveList.querySelectorAll('.move-item');
            if (items[viewedPairIndex]) {
                const item = items[viewedPairIndex];
                moveList.scrollTop = Math.max(0, item.offsetTop - item.offsetHeight);
            }
        }
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

    loadTtsPreference() {
        try {
            const stored = localStorage.getItem('blindfoldTts');
            if (stored === 'muted') {
                this.ttsEnabled = false;
            } else if (stored === 'unmuted') {
                this.ttsEnabled = true;
            }
        } catch {
            this.ttsEnabled = true;
        }
    }

    loadThemePreference() {
        try {
            const stored = localStorage.getItem('blindfoldTheme');
            if (stored === 'dark') {
                this.darkMode = true;
            } else if (stored === 'light') {
                this.darkMode = false;
            } else {
                const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                this.darkMode = !!prefersDark;
            }
        } catch {
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            this.darkMode = !!prefersDark;
        }
    }

    applyTheme() {
        const body = document.body;
        if (!body) return;
        if (this.darkMode) {
            body.classList.add('dark-mode');
        } else {
            body.classList.remove('dark-mode');
        }
        this.updateThemeToggleIcon();
    }

    updateThemeToggleIcon() {
        const toggle = document.getElementById('themeToggle');
        if (!toggle) return;
        const isDark = !!this.darkMode;
        const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        const icon = isDark ? '&#9728;' : '&#9790;';
        toggle.innerHTML = `
            <span aria-hidden="true">${icon}</span>
            <span class="sr-only">${label}</span>
        `.trim();
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('title', label);
    }

    attachThemeToggle() {
        const toggle = document.getElementById('themeToggle');
        if (!toggle) return;
        toggle.onclick = () => {
            this.darkMode = !this.darkMode;
            this.applyTheme();
            try {
                localStorage.setItem('blindfoldTheme', this.darkMode ? 'dark' : 'light');
            } catch {
                // Ignore storage errors (e.g., privacy mode)
            }
        };
        this.updateThemeToggleIcon();
    }

    toggleTts() {
        this.ttsEnabled = !this.ttsEnabled;
        if (!this.ttsEnabled) {
            if (this.ttsAudio) {
                try {
                    this.ttsAudio.pause();
                } catch (err) {
                    console.warn('Failed to stop TTS audio:', err);
                }
                this.ttsAudio = null;
            }
            this.ttsQueue = [];
        }

        this.syncVoiceToggleButton();

        try {
            localStorage.setItem('blindfoldTts', this.ttsEnabled ? 'unmuted' : 'muted');
        } catch {
            // ignore storage errors
        }

        const message = this.ttsEnabled ? 'Voice feedback enabled' : 'Voice feedback muted';
        this.showStatusMessage(message, 'info');
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
        const voiceBtn = document.getElementById('voiceMoveButton');
        const undoButton = document.getElementById('undoButton');
        const prevBtn = document.getElementById('navPrev');
        const nextBtn = document.getElementById('navNext');

        const connected = !!(this.ws && this.ws.readyState === WebSocket.OPEN);
        const isActive = !!this.gameActive;
        const playerTurn = this.game ? (this.game.turn() === (this.playerColor === 'white' ? 'w' : 'b')) : false;
        const viewingLive = this.isViewingLive();
        const canMove = connected && isActive && playerTurn && viewingLive;
        const historyLength = Array.isArray(this.latestMoveHistory) ? this.latestMoveHistory.length : 0;
        const minHistory = this.playerColor === 'white' ? 1 : 2;
        const hasUndo = historyLength >= minHistory;

        if (voiceBtn) voiceBtn.disabled = !canMove;
        if (undoButton) undoButton.disabled = !(connected && isActive && hasUndo);

        const hasTimeline = Array.isArray(this.positionTimeline) && this.positionTimeline.length > 0;
        const hasPrev = hasTimeline && this.timelineIndex > 0;
        const hasNext = hasTimeline && this.timelineIndex < this.positionTimeline.length - 1;
        if (prevBtn) prevBtn.disabled = !hasPrev;
        if (nextBtn) nextBtn.disabled = !hasNext;
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
        if (btn) {
            btn.classList.add('is-recording');
            btn.setAttribute('aria-pressed', 'true');
            btn.setAttribute('title', 'Stop');
        }
        if (voiceText) voiceText.value = 'Recording...';
        try {
            this.recorder = new LocalRecorder();
            await this.recorder.start();
        } catch (e) {
            this.isListening = false;
            if (btn) {
                btn.classList.remove('is-recording');
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('title', 'Record');
            }
            if (voiceText) voiceText.value = 'Mic error';
            return this.showStatusMessage('Failed to start recording: ' + e, 'error');
        }
    }

    async stopLocalRecording() {
        if (!this.isListening) return;
        this.isListening = false;
        const voiceText = document.getElementById('voiceText');
        const btn = document.getElementById('voiceMoveButton');
        if (btn) {
            btn.classList.remove('is-recording');
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('title', 'Record');
        }
        if (voiceText) voiceText.value = 'Processing...';

        try {
            const wavBlob = await (this.recorder ? this.recorder.stopAndGetWavBlob(16000) : Promise.reject('No recorder'));

            const form = new FormData();
            form.append('audio', wavBlob, 'speech.wav');
            // Use backend+model configured in code
            form.append('backend', this.sttBackend);
            form.append('model', this.sttModel);
            const res = await fetch('/stt', { method: 'POST', body: form });
            if (!res.ok) throw new Error('STT request failed');
            const data = await res.json();
            const sttText = (data && typeof data.text === 'string') ? data.text : '';
            if (voiceText) voiceText.value = sttText;

            // If we are awaiting a yes/no for a suggested move, handle that first
            if (this.pendingMoveConfirm) {
                const handled = this.handlePendingMoveConfirmation(sttText);
                // Skip further processing (no chat/move parsing while confirming)
                return;
            }

            // Route "recap"/"test" or pending test answers to chat assistant
            const chatMessage = this.parseChatVoiceCommand(sttText);
            // Local client command: Repeat last TTS
            if (chatMessage === 'repeat') {
                this.repeatLastTts();
                return;
            }
            if (this.awaitingTestAnswer || chatMessage) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const msg = this.awaitingTestAnswer ? sttText : chatMessage;
                    this.ws.send(JSON.stringify({ type: 'chat', message: msg }));
                }
                // Skip generic STT feedback for commands/answers to avoid overlap
                return;
            }

            // Do not play server-provided TTS here; client will handle voice UX
            this.handleSpokenMove(data);
        } catch (e) {
            if (voiceText) voiceText.value = 'STT error';
            this.showStatusMessage('Speech recognition failed: ' + e, 'error');
        } finally {
            this.recorder = null;
        }
    }

    // Detect voice-driven chat commands from STT text
    parseChatVoiceCommand(text) {
        if (!text) return null;
        const s = String(text).trim().toLowerCase();
        if (!s) return null;

        // Direct recap
        if (s === 'recap' || s.includes('recap')) return 'recap';

        // Repeat last spoken TTS
        if (s === 'repeat' || s.includes('repeat')) return 'repeat';

        // Test variants
        if (s === 'test' || s.startsWith('test ')) {
            if (/(check|checks)/.test(s)) return 'test checks';
            if (/(capture|captures)/.test(s)) return 'test captures';
            if (/\bwhere\b/.test(s)) return 'test where';
            if (/\bwhat\b/.test(s)) return 'test what';
            return 'test';
        }

        // Natural questions to assistant
        if (s.startsWith('where ') || s.startsWith('what ')) return text.trim();

        return null;
    }

    

    handleSpokenMove(result) {
        const payload = typeof result === "string" ? { text: result } : (result || {});
        const rawText = typeof payload.text === 'string' ? payload.text : '';
        const text = rawText.trim();

        const voiceText = document.getElementById('voiceText');
        if (voiceText) voiceText.value = rawText;

        const backendCandidates = Array.isArray(payload.candidates)
            ? payload.candidates
            : (payload.normalized && Array.isArray(payload.normalized.candidates)
                ? payload.normalized.candidates
                : []);
        const fallbackCandidates = text ? normalizeSpeechToCandidates(text) : [];

        const orderedCandidates = [];
        const seen = new Set();
        for (const cand of backendCandidates) {
            const cleaned = (cand || '').trim();
            if (!cleaned || seen.has(cleaned)) continue;
            orderedCandidates.push(cleaned);
            seen.add(cleaned);
        }
        for (const cand of fallbackCandidates) {
            const cleaned = (cand || '').trim();
            if (!cleaned || seen.has(cleaned)) continue;
            orderedCandidates.push(cleaned);
            seen.add(cleaned);
        }

        const lowerText = text.toLowerCase();
        const undoRequested =
            (!!lowerText && (
                lowerText === 'undo' ||
                lowerText.startsWith('undo ') ||
                lowerText.endsWith(' undo') ||
                lowerText.includes(' undo ') ||
                lowerText.includes('undo move') ||
                lowerText.includes('take back')
            )) ||
            orderedCandidates.some(c => {
                const lc = (c || '').toLowerCase();
                return lc === 'undo' || lc.startsWith('undo');
            });
        if (undoRequested) {
            this.requestUndo('voice');
            return;
        }

        console.log(`[STT] Transcript: "${text}"`);
        if (backendCandidates.length) {
            console.log(`[STT] Backend candidates: [${backendCandidates.join(', ')}]`);
        }
        if (payload.normalized) {
            console.log('[STT] Normalizer details:', payload.normalized);
        }
        console.log(`[STT] Candidate queue: [${orderedCandidates.join(', ')}]`);

        for (const cand of orderedCandidates) {
            const ok = this.parseMoveToUCI(cand);
            if (ok) {
                console.log(`[STT] Matched candidate "${cand}" -> UCI ${ok}`);
                const spoken = this.humanizeMove(ok);
                // For directly recognized move, announce Playing [move]
                if (spoken) this.requestTts(`Playing ${spoken}.`);
                fetch('/log_voice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transcription: text,
                        matched_candidate: cand,
                        uci: ok,
                        candidates: orderedCandidates,
                        normalized: payload.normalized || null,
                        success: true,
                    }),
                }).catch(() => {});

                this.submitManualMove(cand, 'voice');
                return;
            }
        }

        console.log('[STT] No valid candidate matched board state');

        // Fallback: suggest the closest legal move by similarity to transcript
        const suggestion = (function(fen, t){ try { return suggestMoveFromFen(fen, t, Chess); } catch { return null; } })(this.game ? this.game.fen() : null, text);
        if (suggestion && suggestion.score >= 0.45) {
            this.pendingMoveConfirm = suggestion; // {uci, san, spoken, score}
            const spoken = suggestion.spoken || this.humanizeMove(suggestion.san) || this.humanizeMove(suggestion.uci);
            const prompt = `Did you mean ${spoken}? Please say yes or no.`;
            this.requestTts(prompt);
            this.showStatusMessage(`Suggestion: ${spoken}. Say yes or no.`, 'info');
            return;
        }

        // No suggestion available: apologize and echo what was understood
        if (text) this.requestTts(`Sorry, I understood ${text}.`);

        fetch('/log_voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcription: text,
                candidates: orderedCandidates,
                normalized: payload.normalized || null,
                success: false,
            }),
        }).catch(() => {});

        this.showStatusMessage('Could not parse spoken move. Try again or type it.', 'error');
    }

    // Try to resolve implicit pawn capture like 'xe5' to a unique legal move (delegated)
    resolveImplicitDestination(moveText) {
        try { return resolveImplicitFromFen(this.game ? this.game.fen() : null, moveText, Chess); } catch { return null; }
    }

    // Similarity helpers moved to voice_moves.js

    // Find best matching legal move given a transcript (delegated)
    findBestMatchingMoveSuggestion(transcript) {
        try { return suggestMoveFromFen(this.game ? this.game.fen() : null, transcript, Chess); } catch { return null; }
    }

    // Handle yes/no response for a pending move suggestion
    handlePendingMoveConfirmation(sttText) {
        if (!this.pendingMoveConfirm) return false;
        const decision = decideYesNo(sttText); // 'yes' | 'no' | null
        const suggestion = this.pendingMoveConfirm;
        // Clear suggestion now regardless
        this.pendingMoveConfirm = null;
        if (decision === 'yes') {
            const spoken = suggestion.spoken || this.humanizeMove(suggestion.san) || this.humanizeMove(suggestion.uci);
            this.requestTts(`Playing ${spoken}.`);
            this.submitManualMove(suggestion.uci, 'voice');
            return true;
        }
        if (decision === 'no') {
            this.requestTts('Okay. Please say the move again.');
            return true;
        }
        // ask again
        const spoken = suggestion.spoken || this.humanizeMove(suggestion.san) || this.humanizeMove(suggestion.uci);
        this.pendingMoveConfirm = suggestion;
        this.requestTts(`Please answer yes or no. Did you mean ${spoken}?`);
        return true;
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessApp = new BlindfoldChessApp();
});


