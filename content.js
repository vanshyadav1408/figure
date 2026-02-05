const DEFAULT_MAX_ELEMENTS = 120;
const DEFAULT_MAX_TEXT = 4000;

function normalizeLimit(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  if (style.opacity === "0") return false;
  return true;
}

function getLabel(element) {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl?.innerText) return labelEl.innerText.trim();
  }
  const placeholder = element.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();
  const alt = element.getAttribute("alt");
  if (alt) return alt.trim();
  const text = element.innerText || element.textContent || "";
  return text.trim().slice(0, 160);
}

function escapeAttr(value) {
  return value.replace(/"/g, "\\\"");
}

function getSelector(element) {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const testId =
    element.getAttribute("data-testid") ||
    element.getAttribute("data-test") ||
    element.getAttribute("data-qa");
  if (testId) {
    return `[data-testid="${escapeAttr(testId)}"]`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${escapeAttr(name)}"]`;
  }

  const aria = element.getAttribute("aria-label");
  if (aria) {
    return `${element.tagName.toLowerCase()}[aria-label="${escapeAttr(aria)}"]`;
  }

  const path = [];
  let node = element;
  while (node && node.nodeType === 1 && node !== document.body) {
    let selector = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentElement?.children || []).filter(
      (sib) => sib.tagName === node.tagName
    );
    if (siblings.length > 1) {
      const index = siblings.indexOf(node) + 1;
      selector += `:nth-of-type(${index})`;
    }
    path.unshift(selector);
    node = node.parentElement;
  }
  return path.join(" > ");
}

function collectPageState(options = {}) {
  const maxElements = normalizeLimit(options.maxElements, DEFAULT_MAX_ELEMENTS, 10, 500);
  const maxText = normalizeLimit(options.maxText, DEFAULT_MAX_TEXT, 0, 20000);
  const elements = [];
  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, [role=button], [contenteditable=true]"
    )
  );

  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    const label = getLabel(element);
    elements.push({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type"),
      label,
      selector: getSelector(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });

    if (elements.length >= maxElements) break;
  }

  elements.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

  const textSnippet =
    maxText > 0
      ? (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxText)
      : "";

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    elements,
    textSnippet,
  };
}

function resolveTarget(action) {
  if (action.selector) {
    const el = document.querySelector(action.selector);
    if (el) return el;
  }

  if (action.text) {
    const needle = action.text.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, [role=button], [contenteditable=true]"
      )
    );
    for (const element of candidates) {
      const label = getLabel(element).toLowerCase();
      if (label && label.includes(needle)) return element;
    }
  }

  return null;
}

function dispatchInputEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function scrollToElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
}

async function performAction(action) {
  const type = action?.type;
  if (!type) {
    return { ok: false, error: "Missing action type" };
  }

  if (type === "wait") {
    const ms = Number(action.ms || action.duration || 500);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, result: `waited ${ms}ms` };
  }

  if (type === "scroll") {
    const amount = Number(action.amount || Math.round(window.innerHeight * 0.7));
    const direction = action.direction === "up" ? -1 : 1;
    window.scrollBy({ top: amount * direction, behavior: "smooth" });
    return { ok: true, result: `scrolled ${direction === 1 ? "down" : "up"}` };
  }

  const element = resolveTarget(action);
  if (!element) {
    return { ok: false, error: "Target not found" };
  }

  scrollToElement(element);

  if (type === "click") {
    element.focus();
    element.click();
    return { ok: true, result: "clicked" };
  }

  if (type === "type") {
    const value = action.value ?? action.text ?? "";
    element.focus();
    if (element.isContentEditable) {
      element.innerText = value;
    } else {
      element.value = value;
    }
    dispatchInputEvents(element);
    return { ok: true, result: "typed" };
  }

  if (type === "key") {
    const key = action.key || action.value || "Enter";
    const event = new KeyboardEvent("keydown", { key, bubbles: true });
    element.dispatchEvent(event);
    return { ok: true, result: `key ${key}` };
  }

  return { ok: false, error: `Unsupported action: ${type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_STATE") {
    sendResponse(collectPageState(message.options));
    return;
  }

  if (message.type === "PERFORM_ACTION") {
    performAction(message.action).then(sendResponse);
    return true;
  }
});
