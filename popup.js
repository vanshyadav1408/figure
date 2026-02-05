const defaults = {
  model: "gemini-3-flash-preview",
  maxSteps: 8,
  stepDelayMs: 0,
  fastMode: true,
};

const elements = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  maxSteps: document.getElementById("maxSteps"),
  stepDelayMs: document.getElementById("stepDelayMs"),
  fastMode: document.getElementById("fastMode"),
  instruction: document.getElementById("instruction"),
  runBtn: document.getElementById("runBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  log: document.getElementById("log"),
  elapsed: document.getElementById("elapsed"),
};

const state = {
  running: false,
  log: [],
  startedAt: null,
  stoppedAt: null,
  timerId: null,
};

function appendLog(entry) {
  state.log.push(entry);
  elements.log.textContent = state.log.join("\n");
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setRunning(isRunning) {
  state.running = isRunning;
  elements.runBtn.disabled = isRunning;
  elements.stopBtn.disabled = !isRunning;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateElapsed() {
  if (!state.startedAt) {
    elements.elapsed.textContent = "00:00";
    return;
  }
  const end = state.running ? Date.now() : (state.stoppedAt || Date.now());
  elements.elapsed.textContent = formatElapsed(end - state.startedAt);
}

function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(updateElapsed, 250);
}

function stopTimer() {
  if (!state.timerId) return;
  clearInterval(state.timerId);
  state.timerId = null;
}

function loadSettings() {
  chrome.storage.local.get(
    ["apiKey", "model", "maxSteps", "stepDelayMs", "fastMode"],
    (data) => {
      elements.apiKey.value = data.apiKey || "";
      elements.model.value = data.model || defaults.model;
      elements.maxSteps.value = data.maxSteps ?? defaults.maxSteps;
      elements.stepDelayMs.value = data.stepDelayMs ?? defaults.stepDelayMs;
      elements.fastMode.checked = data.fastMode ?? defaults.fastMode;
    }
  );
}

function saveSettings() {
  const maxStepsValue = Number(elements.maxSteps.value);
  const delayValue = Number(elements.stepDelayMs.value);
  chrome.storage.local.set({
    apiKey: elements.apiKey.value.trim(),
    model: elements.model.value.trim(),
    maxSteps:
      Number.isFinite(maxStepsValue) && maxStepsValue > 0
        ? maxStepsValue
        : defaults.maxSteps,
    stepDelayMs: Number.isFinite(delayValue) ? delayValue : defaults.stepDelayMs,
    fastMode: elements.fastMode.checked,
  });
}

function bindInputs() {
  [
    elements.apiKey,
    elements.model,
    elements.maxSteps,
    elements.stepDelayMs,
    elements.fastMode,
  ].forEach((input) => {
    input.addEventListener("change", saveSettings);
    input.addEventListener("blur", saveSettings);
  });
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}

async function startRun() {
  const instruction = elements.instruction.value.trim();
  if (!instruction) {
    appendLog("Add a task before running.");
    return;
  }

  saveSettings();
  const tab = await getActiveTab();
  if (!tab?.id) {
    appendLog("No active tab found.");
    return;
  }

  appendLog("Starting agent...");
  setRunning(true);
  state.startedAt = Date.now();
  state.stoppedAt = null;
  updateElapsed();
  startTimer();
  chrome.runtime.sendMessage({
    type: "POPUP_START",
    tabId: tab.id,
    instruction,
  });
}

function stopRun() {
  chrome.runtime.sendMessage({ type: "POPUP_STOP" });
  appendLog("Stop requested.");
}

function clearLog() {
  state.log = [];
  elements.log.textContent = "";
  chrome.runtime.sendMessage({ type: "POPUP_CLEAR_LOG" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "AGENT_LOG") {
    appendLog(message.entry);
  }
  if (message.type === "AGENT_STATUS") {
    setRunning(message.running);
    state.startedAt = message.startedAt ?? state.startedAt;
    state.stoppedAt = message.stoppedAt ?? state.stoppedAt;
    updateElapsed();
    if (message.running) {
      startTimer();
    } else {
      stopTimer();
    }
    if (message.logs && message.logs.length) {
      state.log = message.logs.slice();
      elements.log.textContent = state.log.join("\n");
    }
  }
});

function init() {
  loadSettings();
  bindInputs();

  elements.runBtn.addEventListener("click", startRun);
  elements.stopBtn.addEventListener("click", stopRun);
  elements.clearBtn.addEventListener("click", clearLog);

  chrome.runtime.sendMessage({ type: "POPUP_GET_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }
    if (response) {
      setRunning(response.running);
      state.startedAt = response.startedAt ?? null;
      state.stoppedAt = response.stoppedAt ?? null;
      updateElapsed();
      if (response.running) {
        startTimer();
      }
      if (response.logs) {
        state.log = response.logs.slice();
        elements.log.textContent = state.log.join("\n");
      }
    }
  });
}

init();
