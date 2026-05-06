// In-page overlay UI for macro recording: status bar + navigation prompt.
// Visual style mirrors content.js (yellow/orange neo-brutalist palette).

const STYLE_ID = "__tab_manager_macro_style__";
const BAR_ID = "__tab_manager_macro_bar__";
const PROMPT_ID = "__tab_manager_macro_prompt__";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BAR_ID}, #${PROMPT_ID} {
      position: fixed;
      z-index: 2147483647;
      font-family: ui-sans-serif, system-ui, sans-serif;
      color: #111827;
      box-sizing: border-box;
    }
    #${BAR_ID} {
      top: 16px;
      right: 16px;
      min-width: 240px;
      background: #fffdf5;
      border: 2px solid #111827;
      border-radius: 12px;
      box-shadow: 6px 6px 0 rgba(17, 24, 39, 0.16);
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    #${BAR_ID} .tm-macro-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.18);
      animation: tm-macro-pulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes tm-macro-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.7); opacity: 0.5; }
    }
    #${BAR_ID} .tm-macro-name {
      font-weight: 700;
      max-width: 160px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${BAR_ID} .tm-macro-count {
      color: #6b7280;
      font-size: 12px;
      flex-shrink: 0;
    }
    #${BAR_ID} button {
      appearance: none;
      cursor: pointer;
      border: 1px solid #111827;
      border-radius: 8px;
      padding: 4px 10px;
      min-height: 28px;
      font-size: 12px;
      font-weight: 700;
      background: #ffffff;
      color: #111827;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    #${BAR_ID} button:hover {
      transform: translateY(-1px);
      box-shadow: 0 3px 0 rgba(17, 24, 39, 0.12);
    }
    #${BAR_ID} button.tm-macro-stop {
      background: #f59e0b;
    }
    #${PROMPT_ID} {
      top: 64px;
      right: 16px;
      width: min(360px, calc(100vw - 24px));
      background: #fffdf5;
      border: 2px solid #111827;
      border-radius: 14px;
      box-shadow: 8px 8px 0 rgba(17, 24, 39, 0.16);
      overflow: hidden;
    }
    #${PROMPT_ID} .tm-macro-prompt-header {
      padding: 12px 14px 10px;
      background: linear-gradient(135deg, #fde68a 0%, #fef3c7 100%);
      border-bottom: 1px solid #f59e0b;
      font-weight: 700;
      font-size: 14px;
    }
    #${PROMPT_ID} .tm-macro-prompt-body {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 13px;
      line-height: 1.5;
    }
    #${PROMPT_ID} .tm-macro-prompt-url {
      padding: 8px 10px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      font-size: 12px;
      color: #374151;
      word-break: break-all;
      max-height: 80px;
      overflow-y: auto;
    }
    #${PROMPT_ID} .tm-macro-prompt-actions {
      display: flex;
      gap: 8px;
    }
    #${PROMPT_ID} button {
      flex: 1;
      appearance: none;
      cursor: pointer;
      border: 1px solid #111827;
      border-radius: 10px;
      padding: 8px 10px;
      min-height: 36px;
      font-size: 13px;
      font-weight: 700;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    #${PROMPT_ID} button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 0 rgba(17, 24, 39, 0.12);
    }
    #${PROMPT_ID} .tm-macro-prompt-primary {
      background: #f59e0b;
      color: #111827;
    }
    #${PROMPT_ID} .tm-macro-prompt-secondary {
      background: #ffffff;
      color: #111827;
    }
  `;
  document.documentElement.appendChild(style);
}

export function showRecordingBar({ name, stepCount, onStop, onDiscard }) {
  ensureStyles();
  hideRecordingBar();

  const bar = document.createElement("div");
  bar.id = BAR_ID;

  const dot = document.createElement("div");
  dot.className = "tm-macro-dot";

  const nameEl = document.createElement("div");
  nameEl.className = "tm-macro-name";
  nameEl.textContent = name || "录制中";
  nameEl.title = name || "录制中";

  const countEl = document.createElement("div");
  countEl.className = "tm-macro-count";
  countEl.textContent = `${stepCount || 0} 步`;

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "tm-macro-stop";
  stopBtn.textContent = "停止并保存";
  stopBtn.addEventListener("click", () => onStop && onStop());

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.textContent = "放弃";
  discardBtn.addEventListener("click", () => onDiscard && onDiscard());

  bar.append(dot, nameEl, countEl, stopBtn, discardBtn);
  document.documentElement.appendChild(bar);
}

export function updateRecordingBar({ name, stepCount }) {
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;
  if (name != null) {
    const nameEl = bar.querySelector(".tm-macro-name");
    if (nameEl) {
      nameEl.textContent = name;
      nameEl.title = name;
    }
  }
  if (stepCount != null) {
    const countEl = bar.querySelector(".tm-macro-count");
    if (countEl) countEl.textContent = `${stepCount} 步`;
  }
}

export function hideRecordingBar() {
  document.getElementById(BAR_ID)?.remove();
}

export function showNavigationPrompt({ url, onConfirmStop, onCancel }) {
  ensureStyles();
  hideNavigationPrompt();

  const wrap = document.createElement("div");
  wrap.id = PROMPT_ID;

  const header = document.createElement("div");
  header.className = "tm-macro-prompt-header";
  header.textContent = "页面试图跳转";

  const body = document.createElement("div");
  body.className = "tm-macro-prompt-body";

  const desc = document.createElement("div");
  desc.textContent = "即将离开当前页面。可以记录一次 URL 等待并在新页面继续录制，也可以取消留在当前页。";

  const urlEl = document.createElement("div");
  urlEl.className = "tm-macro-prompt-url";
  urlEl.textContent = url || "(未知 URL)";

  const actions = document.createElement("div");
  actions.className = "tm-macro-prompt-actions";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "tm-macro-prompt-primary";
  confirmBtn.textContent = "记录并跳转";
  confirmBtn.addEventListener("click", () => onConfirmStop && onConfirmStop());

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "tm-macro-prompt-secondary";
  cancelBtn.textContent = "继续录制";
  cancelBtn.addEventListener("click", () => onCancel && onCancel());

  actions.append(confirmBtn, cancelBtn);
  body.append(desc, urlEl, actions);
  wrap.append(header, body);
  document.documentElement.appendChild(wrap);
}

export function hideNavigationPrompt() {
  document.getElementById(PROMPT_ID)?.remove();
}

export function isPromptVisible() {
  return !!document.getElementById(PROMPT_ID);
}
