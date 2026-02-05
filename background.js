const DEFAULTS = {
  model: "gemini-3-flash-preview",
  maxSteps: 8,
  stepDelayMs: 0,
  fastMode: true,
};

let cachedEnvKey = null;

async function loadEnvApiKey() {
  if (cachedEnvKey !== null) {
    return cachedEnvKey;
  }

  try {
    const url = chrome.runtime.getURL("config.js");
    const mod = await import(url);
    const key = typeof mod.GEMINI_API_KEY === "string" ? mod.GEMINI_API_KEY.trim() : "";
    cachedEnvKey = key;
    return key;
  } catch (error) {
    cachedEnvKey = "";
    return "";
  }
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["click", "type", "scroll", "wait", "key", "finish"],
          },
          selector: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          value: { type: ["string", "null"] },
          key: { type: ["string", "null"] },
          direction: { type: ["string", "null"] },
          amount: { type: ["number", "null"] },
          ms: { type: ["number", "null"] },
          reason: { type: ["string", "null"] },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
    done: { type: "boolean" },
    final: { type: ["string", "null"] },
  },
  required: ["actions", "done"],
  additionalProperties: false,
};

let runState = {
  running: false,
  stopRequested: false,
  tabId: null,
  logs: [],
  startedAt: null,
  stoppedAt: null,
};

function log(entry) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${entry}`;
  runState.logs.push(line);
  chrome.runtime.sendMessage({ type: "AGENT_LOG", entry: line });
}

function sendStatus() {
  chrome.runtime.sendMessage({
    type: "AGENT_STATUS",
    running: runState.running,
    startedAt: runState.startedAt,
    stoppedAt: runState.stoppedAt,
    logs: runState.logs,
  });
}

function chromeCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

async function getSettings() {
  const envApiKey = await loadEnvApiKey();
  const data = await chromeCall(chrome.storage.local.get.bind(chrome.storage.local), [
    "apiKey",
    "model",
    "maxSteps",
    "stepDelayMs",
    "fastMode",
  ]);

  return {
    apiKey: envApiKey || data.apiKey || "",
    model: data.model || DEFAULTS.model,
    maxSteps: data.maxSteps ?? DEFAULTS.maxSteps,
    stepDelayMs: data.stepDelayMs ?? DEFAULTS.stepDelayMs,
    fastMode: data.fastMode ?? DEFAULTS.fastMode,
  };
}

async function ensureContentScript(tabId) {
  try {
    await chromeCall(chrome.scripting.executeScript.bind(chrome.scripting), {
      target: { tabId },
      files: ["content.js"],
    });
    return true;
  } catch (error) {
    log(`Failed to inject content script: ${error.message}`);
    return false;
  }
}

async function sendToTab(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Timed out waiting for content script"));
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function captureScreenshot(tabId) {
  const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId);
  const dataUrl = await chromeCall(
    chrome.tabs.captureVisibleTab.bind(chrome.tabs),
    tab.windowId,
    {
      format: "png",
    }
  );

  if (!dataUrl) return null;
  const [, base64] = dataUrl.split(",");
  return base64 || null;
}

function buildPrompt(instruction, state, step, maxSteps, hasScreenshot) {
  const safeElements = Array.isArray(state.elements) ? state.elements : [];
  const header = `Task: ${instruction}\nStep: ${step}/${maxSteps}\nURL: ${state.url}\nTitle: ${state.title}\nViewport: ${state.viewport.width}x${state.viewport.height} (scroll ${state.viewport.scrollX},${state.viewport.scrollY})`;

  const screenshotNote = hasScreenshot
    ? "A screenshot of the current viewport is provided."
    : "No screenshot is available; rely on the element list and text.";

  const elementLines = safeElements
    .slice(0, 80)
    .map((el, index) => {
      const label = el.label ? ` label="${el.label.replace(/\s+/g, " ")}"` : "";
      return `[${index + 1}] <${el.tag}>${label} selector="${el.selector}" rect=${el.rect.x},${el.rect.y},${el.rect.width}x${el.rect.height}`;
    })
    .join("\n");

  const rules = [
    "You are a browser automation agent.",
    "Use the elements list (selectors + labels) to decide the next actions.",
    screenshotNote,
    "Return only JSON that matches the schema. No extra commentary.",
    "Allowed action types: click, type, scroll, wait, key, finish.",
    "For click/type, prefer selector. Use text only when selector is unavailable.",
    "If the task is complete, set done=true and provide final summary in 'final'.",
    "Avoid destructive actions (delete, submit payment) unless the task explicitly asks.",
    "If you get a multiple choice step, click 5-6 correct button simultaneously and then submit.",
  ].join(" ");

  const textSnippet = state.textSnippet
    ? `Page text snippet:\n${state.textSnippet}`
    : "";

  return `${header}\n\n${rules}\n\nInteractive elements:\n${elementLines}\n\n${textSnippet}`;
}

async function callGemini({ apiKey, model, promptText, screenshotBase64 }) {
  const parts = [{ text: promptText }];
  if (screenshotBase64) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: screenshotBase64,
      },
    });
  }

  const body = {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

function extractResponseText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("");
}

function parseAgentResponse(response) {
  const raw = extractResponseText(response);
  if (!raw) {
    throw new Error("Empty response from model");
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAgent(tabId, instruction) {
  if (runState.running) {
    log("Agent already running.");
    return;
  }

  const settings = await getSettings();
  if (!settings.apiKey) {
    log("Missing API key. Add it in the popup or generate config.js.");
    return;
  }

  runState = {
    running: true,
    stopRequested: false,
    tabId,
    logs: runState.logs,
    startedAt: Date.now(),
    stoppedAt: null,
  };
  sendStatus();

  const collectOptions = settings.fastMode
    ? { maxElements: 60, maxText: 0 }
    : { maxElements: 120, maxText: 4000 };

  log("Injecting content script...");
  const injected = await ensureContentScript(tabId);
  if (!injected) {
    runState.running = false;
    return;
  }

  for (let step = 1; step <= settings.maxSteps; step += 1) {
    if (runState.stopRequested) break;

    log(`Collecting state (step ${step}/${settings.maxSteps})...`);
    let state;
    let screenshot = null;
    try {
      const statePromise = sendToTab(tabId, {
        type: "COLLECT_STATE",
        options: collectOptions,
      });
      const screenshotPromise = settings.fastMode
        ? Promise.resolve(null)
        : captureScreenshot(tabId);
      const [stateResult, screenshotResult] = await Promise.all([
        statePromise,
        screenshotPromise.catch((error) => {
          log(`Screenshot failed: ${error.message}`);
          return null;
        }),
      ]);
      state = stateResult;
      screenshot = screenshotResult;
    } catch (error) {
      log(`State collection failed: ${error.message}`);
      break;
    }

    const promptText = buildPrompt(
      instruction,
      state,
      step,
      settings.maxSteps,
      Boolean(screenshot)
    );

    let modelResponse;
    try {
      modelResponse = await callGemini({
        apiKey: settings.apiKey,
        model: settings.model,
        promptText,
        screenshotBase64: screenshot,
      });
    } catch (error) {
      log(error.message);
      break;
    }

    let agentResponse;
    try {
      agentResponse = parseAgentResponse(modelResponse);
    } catch (error) {
      log(`Failed to parse model JSON: ${error.message}`);
      break;
    }

    if (agentResponse.plan) {
      log(`Plan: ${agentResponse.plan}`);
    }

    if (agentResponse.done) {
      log(`Done: ${agentResponse.final || "Task completed."}`);
      break;
    }

    const actions = Array.isArray(agentResponse.actions)
      ? agentResponse.actions
      : [];

    if (!actions.length) {
      log("No actions returned. Stopping.");
      break;
    }

    for (const action of actions) {
      if (runState.stopRequested) break;
      log(`Action: ${action.type}`);
      try {
        const result = await sendToTab(tabId, {
          type: "PERFORM_ACTION",
          action,
        });
        if (result?.ok) {
          log(`Result: ${result.result}`);
        } else {
          log(`Action failed: ${result?.error || "unknown error"}`);
        }
      } catch (error) {
        log(`Action error: ${error.message}`);
      }

      await sleep(settings.stepDelayMs);
    }
  }

  runState.running = false;
  runState.stopRequested = false;
  runState.stoppedAt = Date.now();
  sendStatus();
  log("Agent stopped.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "POPUP_START") {
    runAgent(message.tabId, message.instruction);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "POPUP_STOP") {
    runState.stopRequested = true;
    sendStatus();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "POPUP_GET_STATUS") {
    sendResponse({
      running: runState.running,
      logs: runState.logs,
      startedAt: runState.startedAt,
      stoppedAt: runState.stoppedAt,
    });
    return true;
  }

  if (message.type === "POPUP_CLEAR_LOG") {
    runState.logs = [];
    sendStatus();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});







