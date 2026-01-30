import { loadChessLibraries } from './chesslib.js';

class PracticeModeApp {
    constructor() {
        this.ws = null;
        this.board = null;
        this.connected = false;
        this.practiceActive = false;
        this.targetSquare = null;
        this.timerDuration = 30; // Default 30 seconds
        this.timeRemaining = 30;
        this.timerInterval = null;
        this.score = { correct: 0, total: 0 };
        this.darkMode = false;

        this.initializeApp();
    }

    initializeApp() {
        this.loadThemePreference();
        this.applyTheme();
        this.showPracticeSetup();
        this.connectWebSocket();
    }

    loadThemePreference() {
        const saved = localStorage.getItem('blindfoldChessTheme');
        this.darkMode = saved === 'dark';
    }

    applyTheme() {
        if (this.darkMode) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }

    toggleTheme() {
        this.darkMode = !this.darkMode;
        localStorage.setItem('blindfoldChessTheme', this.darkMode ? 'dark' : 'light');
        this.applyTheme();
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

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('Connected to server');
            this.connected = true;
            const startBtn = document.getElementById('startPracticeButton');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.textContent = 'Start Practice';
            }
        };

        this.ws.onclose = () => {
            console.log('Disconnected from server');
            this.connected = false;
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleWebSocketMessage(message);
        };
    }

    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'practice_started':
                this.handlePracticeStarted(message);
                break;
            case 'square_result':
                this.handleSquareResult(message);
                break;
            case 'practice_ended':
                this.handlePracticeEnded(message);
                break;
        }
    }

    handlePracticeStarted(message) {
        this.practiceActive = true;
        this.targetSquare = message.target_square;
        this.timerDuration = message.timer_duration;
        this.timeRemaining = message.timer_duration;
        this.score = message.score;

        this.showPracticeInterface();
        this.updateTargetSquare();
        this.updateScore();
        this.startTimer();
    }

    handleSquareResult(message) {
        this.score = message.score;
        this.targetSquare = message.target_square;

        // Visual feedback for incorrect click
        if (!message.correct) {
            this.blinkSquareRed(message.clicked_square);
        }

        this.updateTargetSquare();
        this.updateScore();
    }

    handlePracticeEnded(message) {
        this.practiceActive = false;
        this.stopTimer();
        this.showCompletionScreen(message.stats);
    }

    showPracticeSetup() {
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container practice-container">
                <div class="header">
                    <button type="button" class="theme-toggle" id="themeToggle">
                        <span class="sr-only">Toggle dark mode</span>
                    </button>
                    <button type="button" class="help-toggle" id="helpToggle" aria-label="Help" title="Help">?</button>
                    <div class="logo-pair">
                        <img src="/static/icons/white_horse_right-removebg.png" class="logo-img left" alt="" aria-hidden="true">
                        <h1 class="clickable-title" id="headerTitle">Blindfold Chess Training</h1>
                        <img src="/static/icons/white_horse_left-removebg.png" class="logo-img right" alt="" aria-hidden="true">
                    </div>
                </div>
                
                <div class="practice-info">
                    <div class="setup-group" style="max-width: 400px; margin: 20px auto; background: white; padding: 20px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);">
                        <label>Timer Duration (seconds):</label>
                        <input type="range" class="timer-slider" min="15" max="120" value="30" step="15" id="timerSlider">
                        <div class="timer-display" id="timerDisplay">30 seconds</div>
                        
                        <button class="start-button" id="startPracticeButton" ${!this.connected ? 'disabled' : ''} style="margin-top: 15px;">
                            ${this.connected ? 'Start Practice' : 'Connecting...'}
                        </button>
                    </div>
                    
                    <div class="practice-stats">
                        <div class="practice-score" id="practiceScore">Score: 0/0</div>
                        <div class="practice-timer" id="practiceTimer">Time: 0:30</div>
                    </div>
                </div>
                
                <div class="practice-board-container">
                    <div id="practiceBoard"></div>
                </div>
            </div>
        `;

        // Initialize board immediately
        this.initializeBoard();
        this.setupEventListeners();
    }

    setupEventListeners() {
        const timerSlider = document.getElementById('timerSlider');
        const timerDisplay = document.getElementById('timerDisplay');

        if (timerSlider && timerDisplay) {
            timerSlider.addEventListener('input', (e) => {
                this.timerDuration = parseInt(e.target.value);
                timerDisplay.textContent = `${this.timerDuration} seconds`;
            });
        }

        const startButton = document.getElementById('startPracticeButton');
        if (startButton) {
            startButton.addEventListener('click', () => {
                if (this.connected) {
                    this.startPractice();
                }
            });
        }

        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => this.toggleTheme());
        }
        this.updateThemeToggleIcon();
        const headerTitle = document.getElementById('headerTitle');
        if (headerTitle) {
            headerTitle.addEventListener('click', () => this.navigateToPortal());
        }

        const helpToggle = document.getElementById('helpToggle');
        if (helpToggle) {
            helpToggle.addEventListener('click', () => this.showHelpModal());
        }
    }

    navigateToPortal() {
        if (this.practiceActive) {
            if (confirm('Are you sure you want to leave? Your current practice session will be lost.')) {
                window.location.href = '/';
            }
        } else {
            window.location.href = '/';
        }
    }

    showHelpModal() {
        const existingModal = document.getElementById('helpModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'helpModal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        `;

        modal.innerHTML = `
            <div style="background: white; border-radius: 15px; padding: 30px; max-width: 500px; position: relative; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
                <button id="closeHelp" style="position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
                <h2 style="margin-bottom: 20px; color: #2d3748;">Practice Mode - How It Works</h2>
                <div style="font-size: 14px; color: #4a5568; line-height: 1.6;">
                    <p style="margin-bottom: 15px;"><strong>Objective:</strong> Improve your chess square identification skills.</p>

                    <p style="margin-bottom: 10px;"><strong>Instructions:</strong></p>
                    <ul style="margin-left: 20px; margin-bottom: 15px;">
                        <li>A random square (e.g., "E4") will be displayed</li>
                        <li>Click on the correct square on the board</li>
                        <li>Race against the timer to maximize your accuracy</li>
                    </ul>

                    <p style="margin-bottom: 10px;"><strong>Settings:</strong></p>
                    <ul style="margin-left: 20px;">
                        <li>Adjust timer duration (15-120 seconds)</li>
                    </ul>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeBtn = document.getElementById('closeHelp');
        closeBtn.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    startPractice() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'start_practice',
                timer_duration: this.timerDuration
            }));
        }
    }

    showPracticeInterface() {
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container practice-container">
                <div class="header">
                    <button type="button" class="theme-toggle" id="themeToggle">
                        <span class="sr-only">Toggle dark mode</span>
                    </button>
                    <button type="button" class="help-toggle" id="helpToggle" aria-label="Help" title="Help">?</button>
                    <div class="logo-pair">
                        <img src="/static/icons/white_horse_right-removebg.png" class="logo-img left" alt="" aria-hidden="true">
                        <h1 class="clickable-title" id="headerTitle">Blindfold Chess Training</h1>
                        <img src="/static/icons/white_horse_left-removebg.png" class="logo-img right" alt="" aria-hidden="true">
                    </div>
                </div>
                
                <div class="practice-info">
                    <div class="target-square-display" id="targetSquareDisplay">
                        Click on: <span class="target-square">--</span>
                    </div>
                    <div class="practice-stats">
                        <div class="practice-score" id="practiceScore">Score: 0/0</div>
                        <div class="practice-timer" id="practiceTimer">Time: 0:30</div>
                    </div>
                </div>
                
                <div class="practice-board-container">
                    <div id="practiceBoard"></div>
                </div>
            </div>
        `;

        this.initializeBoard();
        this.attachPracticeEventListeners();
    }

    attachPracticeEventListeners() {
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => this.toggleTheme());
        }
        this.updateThemeToggleIcon();

        const helpToggle = document.getElementById('helpToggle');
        if (helpToggle) {
            helpToggle.addEventListener('click', () => this.showHelpModal());
        }

        const headerTitle = document.getElementById('headerTitle');
        if (headerTitle) {
            headerTitle.addEventListener('click', () => this.navigateToPortal());
        }
    }

    initializeBoard() {
        if (typeof Chess === 'undefined' || typeof Chessboard === 'undefined') {
            loadChessLibraries().then(() => this.createBoard());
        } else {
            this.createBoard();
        }
    }

    createBoard() {
        const config = {
            position: 'start',
            pieceTheme: '/static/img/chesspieces/wikipedia/{piece}.png',
            draggable: false,
        };

        this.board = new Chessboard('practiceBoard', config);

        // Clear all pieces to show empty board
        this.board.clear();

        // Add click handlers to all squares
        this.attachSquareClickHandlers();
    }

    attachSquareClickHandlers() {
        const boardElement = document.getElementById('practiceBoard');
        if (!boardElement) return;

        // Wait for board to be fully rendered
        setTimeout(() => {
            const squares = boardElement.querySelectorAll('.square-55d63');
            squares.forEach(square => {
                square.addEventListener('click', (e) => {
                    if (!this.practiceActive) return;

                    // Extract square name from class (e.g., 'square-e4')
                    const classList = Array.from(square.classList);
                    const squareClass = classList.find(cls => cls.startsWith('square-') && cls.length === 9);
                    if (squareClass) {
                        const squareName = squareClass.substring(7); // Remove 'square-' prefix
                        this.handleSquareClick(squareName);
                    }
                });
            });
        }, 100);
    }

    handleSquareClick(square) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'square_click',
                square: square
            }));
        }
    }

    blinkSquareRed(square) {
        const boardElement = document.getElementById('practiceBoard');
        if (!boardElement) return;

        const squareElement = boardElement.querySelector(`.square-${square}`);
        if (squareElement) {
            squareElement.classList.add('square-error');
            setTimeout(() => {
                squareElement.classList.remove('square-error');
            }, 600);
        }
    }

    updateTargetSquare() {
        const targetElement = document.querySelector('.target-square');
        if (targetElement && this.targetSquare) {
            targetElement.textContent = this.targetSquare.toUpperCase();
        }
    }

    updateScore() {
        const scoreElement = document.getElementById('practiceScore');
        if (scoreElement) {
            scoreElement.textContent = `Score: ${this.score.correct}/${this.score.total}`;
        }
    }

    startTimer() {
        this.updateTimerDisplay();
        this.timerInterval = setInterval(() => {
            this.timeRemaining--;
            this.updateTimerDisplay();

            if (this.timeRemaining <= 0) {
                this.endPractice();
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    updateTimerDisplay() {
        const timerElement = document.getElementById('practiceTimer');
        if (timerElement) {
            const minutes = Math.floor(this.timeRemaining / 60);
            const seconds = this.timeRemaining % 60;
            timerElement.textContent = `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    endPractice() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'end_practice'
            }));
        }
    }

    showCompletionScreen(stats) {
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="container">
                <div class="header">
                    <button type="button" class="theme-toggle" id="themeToggle">
                        <span class="sr-only">Toggle dark mode</span>
                    </button>
                    <button type="button" class="help-toggle" id="helpToggle" aria-label="Help" title="Help">?</button>
                    <div class="logo-pair">
                        <img src="/static/icons/white_horse_right-removebg.png" class="logo-img left" alt="" aria-hidden="true">
                        <h1 class="clickable-title" id="headerTitle">Blindfold Chess Training</h1>
                        <img src="/static/icons/white_horse_left-removebg.png" class="logo-img right" alt="" aria-hidden="true">
                    </div>
                </div>
                
                <div class="practice-complete-modal">
                    <h2>Practice Complete!</h2>
                    <div class="completion-stats">
                        <div class="stat-item">
                            <div class="stat-value">${stats.correct}/${stats.total}</div>
                            <div class="stat-label">Correct Squares</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">${stats.percentage}%</div>
                            <div class="stat-label">Accuracy</div>
                        </div>
                    </div>
                    <div class="completion-actions">
                        <button class="start-button" id="tryAgainButton">Try Again</button>
                        <button class="control-button" id="returnPortalButton">Return to Portal</button>
                    </div>
                </div>
            </div>
        `;

        const tryAgainButton = document.getElementById('tryAgainButton');
        if (tryAgainButton) {
            tryAgainButton.addEventListener('click', () => {
                this.showPracticeSetup();
            });
        }

        const returnButton = document.getElementById('returnPortalButton');
        if (returnButton) {
            returnButton.addEventListener('click', () => {
                window.location.href = '/';
            });
        }

        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => this.toggleTheme());
        }
        this.updateThemeToggleIcon();

        const helpToggle = document.getElementById('helpToggle');
        if (helpToggle) {
            helpToggle.addEventListener('click', () => this.showHelpModal());
        }

        const headerTitle = document.getElementById('headerTitle');
        if (headerTitle) {
            headerTitle.addEventListener('click', () => {
                window.location.href = '/';
            });
        }
    }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new PracticeModeApp();
});
