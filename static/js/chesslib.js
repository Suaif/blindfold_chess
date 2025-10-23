// Utility to load Chess.js, jQuery, and Chessboard.js on demand.
// Returns a Promise that resolves when libraries are available.

export function loadChessLibraries() {
  return new Promise((resolve) => {
    // If already loaded, resolve immediately
    if (typeof window.Chess !== 'undefined' && typeof window.Chessboard !== 'undefined' && window.jQuery) {
      resolve();
      return;
    }

    // Load chess.js
    const chessScript = document.createElement('script');
    chessScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
    document.head.appendChild(chessScript);

    // Load jQuery (required by chessboard.js 1.0.0)
    const jqueryScript = document.createElement('script');
    jqueryScript.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
    document.head.appendChild(jqueryScript);

    // Load chessboard.js after jQuery
    let boardScript;
    jqueryScript.onload = () => {
      boardScript = document.createElement('script');
      boardScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.js';
      boardScript.onload = checkLoaded;
      document.head.appendChild(boardScript);
      checkLoaded();
    };

    // Load chessboard.css
    const boardCSS = document.createElement('link');
    boardCSS.rel = 'stylesheet';
    boardCSS.href = 'https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.css';
    document.head.appendChild(boardCSS);

    let loaded = 0;
    const checkLoaded = () => {
      loaded++;
      if (loaded >= 3 && typeof window.Chess !== 'undefined' && typeof window.Chessboard !== 'undefined' && window.jQuery) {
        resolve();
      }
    };

    chessScript.onload = checkLoaded;
    // jqueryScript.onload handled above
    // boardScript.onload set within jqueryScript.onload
  });
}
