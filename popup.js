const defaults = {
  model: "gemini-3-flash-preview",
  maxSteps: 8,
  stepDelayMs: 700,
};

const elements = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  maxSteps: document.getElementById("maxSteps"),
  stepDelayMs: document.getElementById("stepDelayMs"),
  instruction: document.getElementById("instruction"),
  runBtn: document.getElementById("runBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  log: document.getElementById("log"),
};

const state = {
  running: false,
  log: [],
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

function loadSettings() {
  chrome.storage.local.get(["apiKey", "model", "maxSteps", "stepDelayMs"], (data) => {
    elements.apiKey.value = data.apiKey || "";
    elements.model.value = data.model || defaults.model;
    elements.maxSteps.value = data.maxSteps ?? defaults.maxSteps;
    elements.stepDelayMs.value = data.stepDelayMs ?? defaults.stepDelayMs;
  });
}

function saveSettings() {
  chrome.storage.local.set({
    apiKey: elements.apiKey.value.trim(),
    model: elements.model.value.trim(),
    maxSteps: Number(elements.maxSteps.value) || defaults.maxSteps,
    stepDelayMs: Number(elements.stepDelayMs.value) || defaults.stepDelayMs,
  });
}

function bindInputs() {
  [
    elements.apiKey,
    elements.model,
    elements.maxSteps,
    elements.stepDelayMs,
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
      if (response.logs) {
        state.log = response.logs.slice();
        elements.log.textContent = state.log.join("\n");
      }
    }
  });
}

init();
