document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle-engine');
  const status = document.getElementById('status');
  const body = document.body;
  const bestMovesContainer = document.getElementById('best-moves-container');
  const bestMovesList = document.getElementById('best-moves');
  const bestMovesMessage = document.getElementById('best-moves-message');
  
  const depthSlider = document.getElementById('depth-slider');
  const depthValue = document.getElementById('depth-value');
  const timeSlider = document.getElementById('time-slider');
  const timeValue = document.getElementById('time-value');
  const toggleSide = document.getElementById('toggle-side');
  const sideLabel = document.getElementById('analysis-side-label');

  let currentTurn = null;

  chrome.storage.local.get(['engineEnabled', 'engineDepth', 'engineTime', 'analysisTurn', 'bestLines', 'analysisState'], (result) => {
    const isEnabled = result.engineEnabled !== false;
    toggle.checked = isEnabled;
    updateStatus(isEnabled);
    
    const depth = result.engineDepth || 15;
    const time = result.engineTime || 3000;
    
    depthSlider.value = depth;
    depthValue.textContent = depth;
    
    timeSlider.value = time;
    timeValue.textContent = time;

    if (result.analysisTurn === 'w' || result.analysisTurn === 'b') {
      updateSideUI(result.analysisTurn);
    }
    if (Array.isArray(result.bestLines) && result.bestLines.length > 0) {
      const st = result.analysisState || 'ready';
      renderBestMoves(result.bestLines, st, null);
    }
  });

  toggle.addEventListener('change', (e) => {
    const isEnabled = e.target.checked;
    
    chrome.storage.local.set({ engineEnabled: isEnabled });
    
    updateStatus(isEnabled);

    sendMessageToContent({
      type: 'TOGGLE_ENGINE',
      enabled: isEnabled
    });
  });

  depthSlider.addEventListener('input', (e) => {
    depthValue.textContent = e.target.value;
  });

  depthSlider.addEventListener('change', (e) => {
    const depth = parseInt(e.target.value, 10);
    chrome.storage.local.set({ engineDepth: depth });
    sendMessageToContent({
      type: 'UPDATE_SETTINGS',
      depth: depth,
      time: parseInt(timeSlider.value, 10)
    });
  });

  timeSlider.addEventListener('input', (e) => {
    timeValue.textContent = e.target.value;
  });

  timeSlider.addEventListener('change', (e) => {
    const time = parseInt(e.target.value, 10);
    chrome.storage.local.set({ engineTime: time });
    sendMessageToContent({
      type: 'UPDATE_SETTINGS',
      depth: parseInt(depthSlider.value, 10),
      time: time
    });
  });

  if (toggleSide) {
    toggleSide.addEventListener('change', (e) => {
      const newTurn = e.target.checked ? 'b' : 'w';
      if (currentTurn !== newTurn) {
        sendMessageToContent({ type: 'SET_ANALYSIS_SIDE', turn: newTurn });
        updateSideUI(newTurn);
        chrome.storage.local.set({ analysisTurn: newTurn });
      }
    });
  }

  function updateSideUI(turn) {
    currentTurn = turn;
    if (sideLabel) {
      if (turn === 'w') {
        sideLabel.textContent = 'Side: White';
        if (toggleSide) toggleSide.checked = false;
      } else if (turn === 'b') {
        sideLabel.textContent = 'Side: Black';
        if (toggleSide) toggleSide.checked = true;
      } else {
        sideLabel.textContent = 'Analysis Side';
      }
    }
  }

  function isChessTab(tab) {
    return !!(tab && tab.url && tab.url.indexOf('chess.com') !== -1);
  }

  function showNoReceiverMessage() {
    if (bestMovesMessage) {
      if (bestMovesList && bestMovesList.childElementCount > 0) {
        bestMovesMessage.style.display = 'none';
        return;
      }
      bestMovesMessage.textContent = 'Open a Chess.com game tab';
      bestMovesMessage.className = 'best-moves-message';
      bestMovesMessage.style.display = 'block';
    }
  }

  function sendMessageToContent(message) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const tab = tabs && tabs[0];
      if (!isChessTab(tab)) {
        if (message && (message.type === 'UPDATE_SETTINGS' || message.type === 'TOGGLE_ENGINE' || message.type === 'SET_ANALYSIS_SIDE')) {
          return;
        }
        showNoReceiverMessage();
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, () => {
        if (chrome.runtime.lastError) {
          if (message && (message.type === 'UPDATE_SETTINGS' || message.type === 'TOGGLE_ENGINE' || message.type === 'SET_ANALYSIS_SIDE')) {
            return;
          }
          showNoReceiverMessage();
        }
      });
    });
  }

  function updateStatus(enabled) {
    if (enabled) {
      status.textContent = 'Active';
      body.classList.remove('engine-off');
    } else {
      status.textContent = 'Disabled';
      body.classList.add('engine-off');
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ENGINE_BEST_LINES') {
      renderBestMoves(msg.lines || [], msg.state, msg.error);
      if (msg.turn) {
        updateSideUI(msg.turn);
      }
      chrome.storage.local.set({
        bestLines: msg.lines || [],
        analysisState: msg.state,
        analysisTurn: msg.turn || currentTurn
      });
    }
  });

  function requestCurrentBestLines() {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const tab = tabs && tabs[0];
      if (!isChessTab(tab)) {
        showNoReceiverMessage();
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_ENGINE_BEST_LINES' }, (response) => {
        if (chrome.runtime.lastError) {
          showNoReceiverMessage();
          return;
        }
        if (response && typeof response === 'object') {
          renderBestMoves(response.lines || [], response.state, response.error);
          if (response.turn) {
            updateSideUI(response.turn);
          }
          chrome.storage.local.set({
            bestLines: response.lines || [],
            analysisState: response.state,
            analysisTurn: response.turn || currentTurn
          });
        }
      });
    });
  }

  function renderBestMoves(lines, state, errorText) {
    const hasExisting = bestMovesList && bestMovesList.childElementCount > 0;
    const shouldShow = state === 'processing' || state === 'ready' || state === 'empty' || hasExisting;
    if (bestMovesContainer) bestMovesContainer.style.display = shouldShow ? 'block' : 'none';
    if (!lines || lines.length === 0) {
      let text = '';
      let isError = false;
      if (state === 'processing') text = 'Analyzing…';
      else if (state === 'empty') text = 'No moves found';
      else if (state === 'disabled') text = 'Engine disabled';
      else if (state === 'error') {
        text = errorText || 'Engine error';
        isError = true;
      } else text = 'Waiting for analysis…';
      bestMovesMessage.textContent = text;
      bestMovesMessage.className = isError ? 'best-moves-message error' : 'best-moves-message';
      bestMovesMessage.style.display = 'block';
      if (state === 'processing') {
        while (bestMovesList.firstChild) bestMovesList.removeChild(bestMovesList.firstChild);
      }
      return;
    }
    bestMovesMessage.style.display = 'none';
    while (bestMovesList.firstChild) bestMovesList.removeChild(bestMovesList.firstChild);
    lines.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'best-move-item';
      const left = document.createElement('span');
      left.textContent = `${idx + 1}. ${item.move}`;
      const right = document.createElement('span');
      right.className = 'best-move-score';
      right.textContent = item.score || '';
      li.appendChild(left);
      li.appendChild(right);
      bestMovesList.appendChild(li);
    });
  }
  
  requestCurrentBestLines();
});
