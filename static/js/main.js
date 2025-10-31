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
        this.isListening = false;
        this.ttsAudio = null;
        this.ttsQueue = [];
        this.recorder = null;
        this.latestMoveHistory = [];
        this.resetTimelineState();
        this.boundKeyHandler = null;
        this.darkMode = false;
        this.ttsEnabled = true;
        this.awaitingTestAnswer = false; // awaiting spoken answer to TEST
        
        this.initializeApp();
    }
    
    initializeApp() {
        // Ensure global toast container exists before rendering any UI
        this.ensureToastContainer();
        this.loadThemePreference();
        this.applyTheme();
        this.loadTtsPreference();
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
        if (!moveText) return '';

        const normalizeSan = (san) => {
            if (!san) return '';
            let s = san.trim();
            s = s.replace(/[+#?!]+$/g, '');

            if (/^O-O-O/i.test(s)) return 'castle queen side';
            if (/^O-O/i.test(s)) return 'castle king side';

            const matchSquares = Array.from(s.matchAll(/([a-h][1-8])/gi));
            const dest = matchSquares.length ? matchSquares[matchSquares.length - 1][1].toLowerCase() : s.toLowerCase();

            const promoMatch = s.match(/=([QRBN])/i);
            if (promoMatch) {
                const promoNames = { Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
                const piece = promoNames[promoMatch[1].toUpperCase()] || promoMatch[1].toLowerCase();
                return `${dest} promotes to ${piece}`;
            }

            const isCapture = s.includes('x');
            const pieceNames = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
            const prefix = s[0] ? s[0].toUpperCase() : '';

            if (pieceNames[prefix]) {
                const name = pieceNames[prefix];
                return isCapture ? `${name} takes ${dest}` : `${name} ${dest}`;
            }

            // Pawn moves: on capture use file letter (e.g., 'exd5' -> 'e takes d5')
            if (isCapture) {
                const m = s.match(/^([a-h])x/i);
                if (m) {
                    return `${m[1].toLowerCase()} takes ${dest}`;
                }
                return `pawn takes ${dest}`;
            }
            return dest;
        };

        const currentFen = this.game ? this.game.fen() : undefined;
        if (!currentFen) return normalizeSan(moveText);

        const temp = new Chess(currentFen);

        // Try UCI first
        const uciMatch = moveText.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
        if (uciMatch) {
            const [, from, to, promo] = uciMatch;
            const mv = temp.move({ from: from.toLowerCase(), to: to.toLowerCase(), promotion: promo ? promo.toLowerCase() : undefined });
            if (mv && mv.san) return normalizeSan(mv.san);
        }

        // Try SAN/lan via sloppy parsing
        try {
            const clone = new Chess(currentFen);
            const mv = clone.move(moveText, { sloppy: true });
            if (mv && mv.san) return normalizeSan(mv.san);
        } catch (_) {
            // fall back to raw normalization
        }

        return normalizeSan(moveText);
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
                        <div class="manual-move-input">
                            <input type="text" id="manualMoveInput" class="manual-move-text" placeholder="Type your move (e.g., e2e4, Nf3, O-O, e8=Q)">
                            <button id="manualMoveButton" class="manual-move-button">Play</button>
                            <button class="control-button undo-button" id="undoButton" title="Undo your last move">Undo</button>
                        </div>
                        <div class="voice-controls-row">
                            <select id="voiceModelSelect" class="voice-model-select" title="Choose STT backend and model">
                                <option value="vosk.large">Vosk Large</option>
                                <option value="vosk.small">Vosk Small</option>
                                <option value="whisper.small" selected>Whisper Small</option>
                                <option value="whisper.medium">Whisper Medium</option>
                            </select>
                            <button id="voiceMoveButton" class="voice-move-button" title="Record or stop">Record</button>
                            <input type="text" id="voiceText" class="voice-text" placeholder="Recognition output..." readonly>
                        </div>
                    </div>
                    
                    <div class="panel move-list-panel">
                        <div class="panel-header">
                            <h3>Move History</h3>
                        </div>
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
        const undoButton = document.getElementById('undoButton');
        if (undoButton) {
            undoButton.addEventListener('click', () => {
                this.requestUndo();
            });
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
        this.syncPieceToggleButtons();
        this.syncVoiceToggleButton();
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
        const manualInput = document.getElementById('manualMoveInput');
        const manualButton = document.getElementById('manualMoveButton');
        const voiceBtn = document.getElementById('voiceMoveButton');
        const voiceModelSelect = document.getElementById('voiceModelSelect');
        const undoButton = document.getElementById('undoButton');

        const connected = !!(this.ws && this.ws.readyState === WebSocket.OPEN);
        const isActive = !!this.gameActive;
        const playerTurn = this.game ? (this.game.turn() === (this.playerColor === 'white' ? 'w' : 'b')) : false;
        const viewingLive = this.isViewingLive();
        const canMove = connected && isActive && playerTurn && viewingLive;
        const historyLength = Array.isArray(this.latestMoveHistory) ? this.latestMoveHistory.length : 0;
        const minHistory = this.playerColor === 'white' ? 1 : 2;
        const hasUndo = historyLength >= minHistory;

        if (manualInput) manualInput.disabled = !canMove;
        if (manualButton) manualButton.disabled = !canMove;
        if (voiceBtn) voiceBtn.disabled = !canMove;
        if (undoButton) undoButton.disabled = !(connected && isActive && hasUndo);
        if (voiceModelSelect) voiceModelSelect.disabled = false;

        if (manualInput) {
            if (!isActive) {
                manualInput.placeholder = 'Start a game to enter moves';
            } else if (!connected) {
                manualInput.placeholder = 'Connecting...';
            } else if (!viewingLive) {
                manualInput.placeholder = 'Viewing history (press Right Arrow to resume live board)';
            } else if (!playerTurn) {
                manualInput.placeholder = "Waiting for opponent's move";
            } else {
                manualInput.placeholder = 'Type your move (e.g., e2e4, Nf3, O-O, e8=Q)';
            }
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
        if (btn) {
            btn.textContent = 'Stop';
            btn.classList.add('is-recording');
        }
        if (voiceText) voiceText.value = 'Recording...';
        try {
            this.recorder = new LocalRecorder();
            await this.recorder.start();
        } catch (e) {
            this.isListening = false;
            if (btn) {
                btn.textContent = 'Record';
                btn.classList.remove('is-recording');
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
            btn.textContent = 'Record';
            btn.classList.remove('is-recording');
        }
        if (voiceText) voiceText.value = 'Processing...';

        try {
            const wavBlob = await (this.recorder ? this.recorder.stopAndGetWavBlob(16000) : Promise.reject('No recorder'));

            const form = new FormData();
            form.append('audio', wavBlob, 'speech.wav');
            // Parse backend+model from selector value (e.g., 'vosk.large' or 'whisper.small')
            const voiceModelSelect = document.getElementById('voiceModelSelect');
            const sel = voiceModelSelect ? (voiceModelSelect.value || 'whisper.small') : 'whisper.small';
            const [backend, model] = sel.includes('.') ? sel.split('.') : ['whisper', 'small'];
            form.append('backend', backend);
            form.append('model', model);
            const res = await fetch('/stt', { method: 'POST', body: form });
            if (!res.ok) throw new Error('STT request failed');
            const data = await res.json();
            const sttText = (data && typeof data.text === 'string') ? data.text : '';
            if (voiceText) voiceText.value = sttText;

            // Route "recap"/"test" or pending test answers to chat assistant
            const chatMessage = this.parseChatVoiceCommand(sttText);
            if (this.awaitingTestAnswer || chatMessage) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const msg = this.awaitingTestAnswer ? sttText : chatMessage;
                    this.ws.send(JSON.stringify({ type: 'chat', message: msg }));
                }
                // Skip generic STT feedback for commands/answers to avoid overlap
                return;
            }

            if (data.tts) this.playTts(data.tts);
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
                // this.requestTts(`Move recognized: ${spoken}.`);
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
        // this.requestTts('Sorry, that move was not recognized.');

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
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessApp = new BlindfoldChessApp();
});


