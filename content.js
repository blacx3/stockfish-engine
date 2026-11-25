// ── session tokens — all random per page load ──────────────────
const _O  = '_' + Math.random().toString(36).slice(2,10); // overlay class
const _A  = '_' + Math.random().toString(36).slice(2,10); // arrow id
const _M  = '_' + Math.random().toString(36).slice(2,10); // marker id
const _SK = Math.random().toString(36).slice(2,16);        // postMessage session key
// message property names derived from session key — not static strings
// chess.com can monitor window.postMessage — these make it unscannable
const _IN  = _SK + 'i'; // content→iframe
const _OUT = _SK + 'o'; // iframe→content
const _ERR = _SK + 'e';
const _RDY = _SK + 'r';

// per-session arrow style — not identical every install
const _OPACITY     = (0.82 + Math.random() * 0.14).toFixed(2);
const _STROKE_W    = (2.2  + Math.random() * 0.6).toFixed(1);
const _ARROW_COLOR = `rgba(255,170,0,${_OPACITY})`;

// ── state ──────────────────────────────────────────────────────
let isEngineEnabled   = true;
let engineDepth       = 15;
let engineTime        = 3000;
let currentSearchId   = 0;
let pendingFen        = null;
let isWaitingForReady = false;
let bestLines         = [];
let analysisState     = 'idle';
let infoUpdateScheduled  = false;
let mutationDebounceTimer = null;
let moveRequestTime   = 0;
let pendingArrowTimer = null;
let currentFen        = '';
let boardObserver     = null;
let overlayElement    = null;
let iframeEl          = null;
// opening suppression — skip analysis for first N position changes
// engines analyzing 1.e4 is a statistical tell
const OPENING_SKIP = 5;

chrome.storage.local.get(['engineEnabled', 'engineDepth', 'engineTime'], (r) => {
  if (r.engineEnabled !== undefined) isEngineEnabled = r.engineEnabled;
  if (r.engineDepth) engineDepth = r.engineDepth;
  if (r.engineTime)  engineTime  = r.engineTime;
});

// ── clock reading ──────────────────────────────────────────────
// read user's remaining time from DOM — scale think time accordingly
// humans rush when low on time; we model that
function readRemainingSeconds() {
  const selectors = [
    '.clock-bottom .clock-time-monospace',
    '.clock-bottom [class*="time"]',
    '[class*="clock-bottom"] [class*="time"]',
    '.board-layout-clock-bottom [class*="time"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const t = el.textContent.trim().replace(/[^\d:.]/g, '');
    const mmss = t.match(/^(\d+):(\d{2})/);
    if (mmss) return parseInt(mmss[1]) * 60 + parseInt(mmss[2]);
    const ssd  = t.match(/^(\d+)\.(\d)/);
    if (ssd)  return parseFloat(ssd[1] + '.' + ssd[2]);
    const ss   = t.match(/^(\d+)$/);
    if (ss)   return parseInt(ss[1]);
  }
  return null;
}

function clockScaledTime(base) {
  const rem = readRemainingSeconds();
  if (rem === null) return base;
  if (rem < 8)   return Math.floor(base * 0.15); // panic — move fast
  if (rem < 20)  return Math.floor(base * 0.35); // urgent
  if (rem < 45)  return Math.floor(base * 0.60); // hurrying
  if (rem < 90)  return Math.floor(base * 0.82); // time-aware
  return base;                                     // comfortable
}

// ── adaptive timing ────────────────────────────────────────────
function getThinkTime(fen) {
  const n = (fen.split(' ')[0].match(/[a-zA-Z]/g) || []).length;
  const complexity = n <= 8 ? 1.35 : n <= 14 ? 1.15 : n <= 22 ? 1.0 : 0.85;
  const jitter     = 1 + (Math.random() * 0.5 - 0.25); // ±25%
  return clockScaledTime(Math.floor(engineTime * complexity * jitter));
}

// ── eval-gated move selection ──────────────────────────────────
// replaces pure weighted random — uses actual engine score to decide
// how "correct" to play. equal positions get more variance;
// decisive positions show better moves (user is in trouble)
function evalGatedPick(lines) {
  if (!lines || lines.length === 0) return null;

  const scoreStr = (lines[0] && lines[0].score) || '';
  let evalMag = 999;
  if (scoreStr.startsWith('M') || scoreStr.startsWith('-M')) {
    evalMag = 999; // mate = decisive
  } else {
    const v = parseFloat(scoreStr);
    if (!isNaN(v)) evalMag = Math.abs(v);
  }

  const r = Math.random();

  if (evalMag < 0.35) {
    // dead equal — heavy variance, occasional suppression
    // in equal positions humans "miss" or play sub-optimally constantly
    if (r < 0.10) return 'suppress';
    if (r < 0.42) return lines[1] ? lines[1].move : lines[0].move;
    if (r < 0.58 && lines[2]) return lines[2].move;
    return lines[0].move;
  }
  if (evalMag < 1.2) {
    // slight edge — standard mix
    if (r < 0.68) return lines[0].move;
    if (r < 0.90) return lines[1] ? lines[1].move : lines[0].move;
    return lines[2] ? lines[2].move : lines[0].move;
  }
  // clearly winning/losing — show best move
  // user needs correct play; occasional top-2 keeps variance
  if (r < 0.88) return lines[0].move;
  return lines[1] ? lines[1].move : lines[0].move;
}

// ── postMessage (session-keyed) ────────────────────────────────
function engineSend(cmd) {
  if (iframeEl && iframeEl.contentWindow) {
    const msg = {};
    msg[_IN] = cmd;
    iframeEl.contentWindow.postMessage(msg, '*');
  }
}

function sendStateUpdate(lines, state, error) {
  try {
    const turn = currentFen ? currentFen.split(' ')[1] : null;
    chrome.runtime.sendMessage({ type: 'ENGINE_BEST_LINES', lines, state, error: error || null, turn });
  } catch(e) {}
}

// ── init ───────────────────────────────────────────────────────
function init() {
  iframeEl = document.createElement('iframe');
  // session key passed via hash — worker-init.js reads it to derive its message keys
  iframeEl.src = chrome.runtime.getURL('worker.html') + '#' + _SK;
  iframeEl.style.display  = 'none';
  iframeEl.style.position = 'absolute';
  iframeEl.style.top      = '-9999px';
  // append to <html> not <body> — avoids body-level DOM monitors
  document.documentElement.appendChild(iframeEl);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    // session-keyed reads — static strings never appear
    if (msg[_RDY]) {
      engineSend('uci');
      engineSend('setoption name MultiPV value 3');
      if (!boardObserver) setupBoardObserver();
      return;
    }

    if (msg[_ERR]) {
      analysisState = 'error';
      sendStateUpdate([], analysisState, msg[_ERR]);
      return;
    }

    const line = msg[_OUT];
    if (!line) return;
    if (!isEngineEnabled) return;

    if (line === 'readyok') {
      if (isWaitingForReady) {
        isWaitingForReady = false;
        if (pendingFen) {
          const fen = pendingFen;
          pendingFen = null;
          const t = getThinkTime(fen);
          engineSend('position fen ' + fen);
          engineSend('go depth ' + engineDepth + ' movetime ' + t);
        }
      }

    } else if (line.startsWith('bestmove')) {
      if (isWaitingForReady) return;
      const move = line.split(' ')[1];
      if (move && move !== '(none)') {
        const picked = evalGatedPick(bestLines) || move;
        if (picked !== 'suppress') {
          // delay arrow display until 62–90% of movetime has elapsed
          // fast SF results don't instantly show — models human "thinking"
          const elapsed   = Date.now() - moveRequestTime;
          const minWait   = Math.floor(engineTime * (0.62 + Math.random() * 0.28));
          const remaining = Math.max(0, minWait - elapsed);
          if (pendingArrowTimer) clearTimeout(pendingArrowTimer);
          pendingArrowTimer = setTimeout(() => {
            pendingArrowTimer = null;
            drawBestMove(picked);
          }, remaining);
        }
        analysisState = 'ready';
        if (bestLines.length === 0) bestLines = [{ move, score: '', multipv: 1, pv: move }];
        sendStateUpdate(bestLines.slice(0, 5), analysisState);
      } else {
        analysisState = 'empty';
        clearArrow();
        sendStateUpdate([], analysisState);
      }

    } else if (line.startsWith('info')) {
      const multipvMatch   = line.match(/\bmultipv\s+(\d+)/);
      const scoreMateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
      const scoreCpMatch   = line.match(/\bscore\s+cp\s+(-?\d+)/);
      const pvMatch        = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][a-z]?(?:\s+[a-h][1-8][a-h][1-8][a-z]?)*)/);
      if (pvMatch) {
        const pv        = pvMatch[1];
        const firstMove = pv.split(/\s+/)[0];
        let scoreText   = '';
        if (scoreMateMatch) {
          scoreText = 'M' + parseInt(scoreMateMatch[1], 10);
        } else if (scoreCpMatch) {
          const cp = parseInt(scoreCpMatch[1], 10);
          scoreText = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
        }
        const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
        const existing = bestLines.findIndex(b => b.multipv === multipv);
        const entry    = { move: firstMove, score: scoreText, multipv, pv };
        if (existing >= 0) bestLines[existing] = entry;
        else bestLines.push(entry);
        bestLines.sort((a, b) => a.multipv - b.multipv);
        analysisState = 'ready';
        if (!infoUpdateScheduled) {
          infoUpdateScheduled = true;
          setTimeout(() => { infoUpdateScheduled = false; sendStateUpdate(bestLines.slice(0, 5), analysisState); }, 200);
        }
      }
    }
  });

  window.postToEngine = engineSend;
}

const engineInterface = { postMessage: engineSend };

// ── board observer (original logic, jitter added to debounce) ──

function setupBoardObserver() {
  const chessComBoard = findChessComBoardElement();
  if (chessComBoard) {
    if (boardObserver && overlayElement && overlayElement.parentElement === chessComBoard) return;
    const success = observeChessCom(chessComBoard);
    if (!success) setTimeout(setupBoardObserver, 2000);
    return;
  }
  setTimeout(setupBoardObserver, 2000);
}

function findChessComBoardElement() {
  const pieces = document.querySelectorAll('.piece');
  if (pieces.length > 0) {
    const parent = pieces[0].parentElement;
    if (parent) return parent;
  }
  const boards = document.querySelectorAll('chess-board, wc-chess-board');
  if (boards.length > 0) for (const b of boards) return b;
  const candidates = [
    document.querySelector('#board-vs-computer'),
    document.querySelector('#board-single'),
    document.querySelector('#board-layout-chessboard'),
    document.querySelector('.board')
  ];
  for (const board of candidates) {
    if (board && (board.children.length > 0 || board.shadowRoot)) return board;
  }
  return document.querySelector('.board');
}

function observeChessCom(boardNode) {
  const { context, pieces } = findPiecesAndContext(boardNode);
  if (!context || pieces.length === 0) return false;

  const overlayHost = context instanceof ShadowRoot ? context.host : context;
  createOverlay(overlayHost);

  const fen = getChessComFen(context, pieces);
  if (fen) updateAnalysis(fen);

  if (boardObserver) boardObserver.disconnect();
  if (window.boardPollTimer) clearInterval(window.boardPollTimer);

  window.boardPollTimer = setInterval(() => {
    const cp = getPiecesFromContext(context);
    if (!cp || cp.length < 2) return;
    const nf = getChessComFen(context, cp);
    if (nf && nf !== currentFen && (currentFen.split(' ')[0] || '') !== nf.split(' ')[0]) {
      updateAnalysis(nf);
    }
  }, 500);

  boardObserver = new MutationObserver(() => {
    if (mutationDebounceTimer) return;
    // jittered debounce — 80–150ms random, not mechanical 100ms
    const jitter = 80 + Math.floor(Math.random() * 70);
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      const cp = getPiecesFromContext(context);
      if (cp.length === 0) {
        const fc = getPiecesFromContext(context);
        if (fc.length > 0) return;
        boardObserver.disconnect();
        boardObserver = null;
        setTimeout(setupBoardObserver, 500);
        return;
      }
      if (cp.length < 2) return;
      const nf = getChessComFen(context, cp);
      if (nf && nf !== currentFen && (currentFen.split(' ')[0] || '') !== nf.split(' ')[0]) {
        updateAnalysis(nf);
      }
    }, jitter);
  });

  boardObserver.observe(context, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'data-piece', 'data-square']
  });
  return true;
}

function findPiecesAndContext(root) {
  let pieces = getPiecesFromContext(root);
  if (pieces.length > 0) return { context: root, pieces };
  if (root.shadowRoot) {
    pieces = getPiecesFromContext(root.shadowRoot);
    if (pieces.length > 0) return { context: root.shadowRoot, pieces };
  }
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      pieces = getPiecesFromContext(el.shadowRoot);
      if (pieces.length > 0) return { context: el.shadowRoot, pieces };
    }
  }
  return { context: null, pieces: [] };
}

function getPiecesFromContext(context) {
  if (!context) return [];
  let list = context.querySelectorAll('.piece, div[class*="piece"], img[class*="piece"]');
  if (list.length > 0) return Array.from(list);
  list = context.querySelectorAll('[class*="square-"]');
  const valid = Array.from(list).filter(p => p.className && typeof p.className === 'string' && p.className.match(/square-\d+/));
  if (valid.length > 0) return valid;
  list = context.querySelectorAll('[data-square][data-piece]');
  if (list.length > 0) return Array.from(list);
  return [];
}

function getChessComFen(context, pieces) {
  if (!pieces || pieces.length === 0) return null;
  const board = new Array(64).fill(null);
  pieces.forEach(piece => {
    const classes = (piece.className && typeof piece.className === 'string') ? piece.className : '';
    let file, rank;
    const sqMatch = classes.match(/square-(\d)(\d)/);
    if (sqMatch) { file = parseInt(sqMatch[1]) - 1; rank = parseInt(sqMatch[2]) - 1; }
    else {
      const ds = piece.getAttribute('data-square');
      if (ds && ds.length === 2) { file = ds.charCodeAt(0) - 97; rank = parseInt(ds[1]) - 1; }
      else return;
    }
    const char = Helpers.mapPieceToChar(classes, piece.getAttribute('data-piece'));
    if (char) board[rank * 8 + file] = char;
  });
  let fen = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const ch = board[r * 8 + f];
      if (ch) { if (empty > 0) { fen += empty; empty = 0; } fen += ch; }
      else empty++;
    }
    if (empty > 0) fen += empty;
    if (r > 0) fen += '/';
  }
  const boardNode = context instanceof ShadowRoot ? context.host : context;
  fen += ' ' + Helpers.determineActiveColor(context, boardNode, board) + ' KQkq - 0 1';
  return fen;
}

// ── overlay ────────────────────────────────────────────────────

function createOverlay(container) {
  if (overlayElement) overlayElement.remove();
  overlayElement = document.createElement('div');
  overlayElement.className = _O; // random class name
  overlayElement.style.cssText = 'z-index:2147483647;pointer-events:none;position:absolute;top:0;left:0;width:100%;height:100%';
  // random IDs + per-session arrow style
  overlayElement.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <marker id="${_M}" markerWidth="6" markerHeight="6" refX="3" refY="3"
                orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L6,3 L0,6 Z" fill="${_ARROW_COLOR}"/>
        </marker>
      </defs>
      <line id="${_A}" x1="0" y1="0" x2="0" y2="0"
            style="stroke:${_ARROW_COLOR};stroke-width:${_STROKE_W};stroke-linecap:round;marker-end:url(#${_M})"
            display="none"/>
    </svg>`;
  if (window.getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(overlayElement);
}

function clearArrow() {
  if (!overlayElement) return;
  const a = overlayElement.querySelector('#' + _A);
  if (a) a.setAttribute('display', 'none');
}

// ── analysis ───────────────────────────────────────────────────

function updateAnalysis(fen) {
  if (!isEngineEnabled || !fen) return;

  currentFen = fen;
  currentSearchId++;
  bestLines  = [];
  analysisState = 'processing';
  moveRequestTime = Date.now();
  if (pendingArrowTimer) { clearTimeout(pendingArrowTimer); pendingArrowTimer = null; }
  sendStateUpdate([], analysisState);
  clearArrow();

  // opening suppression — skip first N positions
  // engines analyzing opening moves is a statistical signature
  if (currentSearchId <= OPENING_SKIP) {
    analysisState = 'idle';
    sendStateUpdate([], analysisState);
    return;
  }

  pendingFen = fen;
  if (isWaitingForReady) return;
  engineSend('stop');
  engineSend('isready');
  isWaitingForReady = true;
}

function drawBestMove(move) {
  if (!isEngineEnabled || !overlayElement) return;
  const from = move.substring(0, 2);
  const to   = move.substring(2, 4);
  const boardNode = overlayElement.parentElement;
  const isWhiteView = !((boardNode && (
    boardNode.closest('.flipped, .board-flipped') ||
    (boardNode.getAttribute && boardNode.getAttribute('flipped') !== null)
  )) || document.querySelector('.flipped, .board-flipped'));
  const freshFen = getChessComFen(boardNode, getPiecesFromContext(boardNode));
  if (freshFen && freshFen.split(' ')[0] !== currentFen.split(' ')[0]) return;
  const fc    = Helpers.getSquareCoords(from, isWhiteView);
  const tc    = Helpers.getSquareCoords(to,   isWhiteView);
  const arrow = overlayElement.querySelector('#' + _A);
  if (!arrow) return;
  const dx = tc.x - fc.x, dy = tc.y - fc.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  let x2 = tc.x, y2 = tc.y;
  if (len > 3) { const t = (len - 3.5) / len; x2 = fc.x + dx * t; y2 = fc.y + dy * t; }
  arrow.setAttribute('x1', fc.x);
  arrow.setAttribute('y1', fc.y);
  arrow.setAttribute('x2', x2);
  arrow.setAttribute('y2', y2);
  arrow.setAttribute('display', 'block');
}

// ── message listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE_ENGINE') {
    isEngineEnabled = msg.enabled;
    if (!isEngineEnabled) {
      clearArrow();
      if (pendingArrowTimer) { clearTimeout(pendingArrowTimer); pendingArrowTimer = null; }
      engineSend('stop');
      analysisState = 'disabled';
      sendStateUpdate([], analysisState);
    } else {
      const board = findChessComBoardElement();
      if (board) {
        const { context, pieces } = findPiecesAndContext(board);
        if (context && pieces.length > 0) updateAnalysis(getChessComFen(context, pieces));
      }
    }
  } else if (msg.type === 'UPDATE_SETTINGS') {
    engineDepth = msg.depth;
    engineTime  = msg.time;
    if (isEngineEnabled) {
      const board = findChessComBoardElement();
      if (board) {
        const { context, pieces } = findPiecesAndContext(board);
        if (context && pieces.length > 0) updateAnalysis(getChessComFen(context, pieces));
      }
    }
  } else if (msg.type === 'GET_ENGINE_BEST_LINES') {
    const turn = currentFen ? currentFen.split(' ')[1] : null;
    sendResponse({ lines: bestLines.slice(0, 5), state: analysisState, turn });
  } else if (msg.type === 'FLIP_ANALYSIS') {
    if (currentFen) {
      const p = currentFen.split(' ');
      if (p.length >= 2) { p[1] = p[1] === 'w' ? 'b' : 'w'; updateAnalysis(p.join(' ')); }
    }
  } else if (msg.type === 'SET_ANALYSIS_SIDE') {
    if (currentFen) {
      const p = currentFen.split(' ');
      if (p.length >= 2 && msg.turn && (msg.turn === 'w' || msg.turn === 'b')) {
        p[1] = msg.turn;
        updateAnalysis(p.join(' '));
      }
    }
  }
});

// delayed init — 1.5–4s random startup, breaks instant-injection pattern
setTimeout(init, 1500 + Math.random() * 2500);
