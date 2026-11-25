const Helpers = (function () {
  const pieceMap = {
    wp: 'P',
    wn: 'N',
    wb: 'B',
    wr: 'R',
    wq: 'Q',
    wk: 'K',
    bp: 'p',
    bn: 'n',
    bb: 'b',
    br: 'r',
    bq: 'q',
    bk: 'k'
  };
  function mapPieceToChar(classes, dataPiece) {
    if (typeof classes === 'string' && classes) {
      if (classes.includes('wp')) return 'P';
      if (classes.includes('wn')) return 'N';
      if (classes.includes('wb')) return 'B';
      if (classes.includes('wr')) return 'R';
      if (classes.includes('wq')) return 'Q';
      if (classes.includes('wk')) return 'K';
      if (classes.includes('bp')) return 'p';
      if (classes.includes('bn')) return 'n';
      if (classes.includes('bb')) return 'b';
      if (classes.includes('br')) return 'r';
      if (classes.includes('bq')) return 'q';
      if (classes.includes('bk')) return 'k';
    }
    if (dataPiece && pieceMap[dataPiece]) {
      return pieceMap[dataPiece];
    }
    return '';
  }
  function isBoardFlipped(boardNode) {
    if (!boardNode) return false;
    const attrFlip = boardNode.getAttribute && boardNode.getAttribute('flipped') !== null;
    const closestFlip = boardNode.closest('.flipped, .board-flipped');
    const globalFlip = document.querySelector('.flipped, .board-flipped');
    return !!(attrFlip || closestFlip || globalFlip);
  }
  function determineActiveColor(context, boardNode, board) {
    let activeColor = 'w';
    const flipped = isBoardFlipped(boardNode);
    const whiteActive = document.querySelector('.clock-white.clock-player-turn, .clock-component.white.clock-player-turn');
    const blackActive = document.querySelector('.clock-black.clock-player-turn, .clock-component.black.clock-player-turn');
    if (whiteActive) return 'w';
    if (blackActive) return 'b';
    const bottomActive = document.querySelector('.clock-bottom.clock-player-turn');
    const topActive = document.querySelector('.clock-top.clock-player-turn');
    if (bottomActive) activeColor = flipped ? 'b' : 'w';
    else if (topActive) activeColor = flipped ? 'w' : 'b';
    else {
      let highlights = context.querySelectorAll('.highlight, .highlight-last, div[class*="highlight"]');
      if (highlights.length === 0) {
        highlights = document.querySelectorAll('.highlight, .highlight-last, div[class*="highlight"]');
      }
      
      // Look for a dragging piece first, as that overrides highlights
      const draggingEl = document.querySelector('.dragging, .is-dragging, .piece.dragging, [data-dragging="true"]');
      if (draggingEl) {
        // If a piece is being dragged, the turn hasn't actually changed yet.
        // We'll rely on the board state being identical to prevent a FEN change,
        // but let's try to infer color from the dragged piece just in case.
        const className = (draggingEl.className && typeof draggingEl.className === 'string') ? draggingEl.className : '';
        const dataPiece = draggingEl.getAttribute('data-piece');
        const char = mapPieceToChar(className, dataPiece);
        if (char) {
          const isWhitePiece = (char === char.toUpperCase());
          return isWhitePiece ? 'w' : 'b'; // It is still the turn of the person dragging
        }
      }

      for (const hl of highlights) {
        const className = (hl.className && typeof hl.className === 'string') ? hl.className : '';
        const sqMatch = className.match(/square-(\d)(\d)/);
        if (sqMatch) {
          const file = parseInt(sqMatch[1]) - 1;
          const rank = parseInt(sqMatch[2]) - 1;
          const idx = rank * 8 + file;
          const pieceChar = board[idx];
          if (pieceChar) {
            const isWhitePiece = (pieceChar === pieceChar.toUpperCase());
            activeColor = isWhitePiece ? 'b' : 'w';
            break;
          }
        }
      }
    }
    return activeColor;
  }
  function getSquareCoords(square, isWhite) {
    const file = square.charCodeAt(0) - 97;
    const rank = parseInt(square[1]) - 1;
    let x, y;
    if (isWhite) {
      x = (file + 0.5) * 12.5;
      y = (7 - rank + 0.5) * 12.5;
    } else {
      x = (7 - file + 0.5) * 12.5;
      y = (rank + 0.5) * 12.5;
    }
    return { x, y };
  }
  return { mapPieceToChar, determineActiveColor, getSquareCoords, isBoardFlipped };
})();
window.Helpers = Helpers;
