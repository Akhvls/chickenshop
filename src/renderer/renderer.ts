type NewideTerminalApi = import("../shared").NewideTerminalApi;
type NewideUpdateApi = import("../shared").NewideUpdateApi;
type NewideWindowApi = import("../shared").NewideWindowApi;
type TerminalKind = import("../shared").TerminalKind;
type TerminalSession = import("../shared").TerminalSession;
type UpdateCheckResult = import("../shared").UpdateCheckResult;
type WindowState = import("../shared").WindowState;
type XtermConstructor = typeof import("@xterm/xterm").Terminal;
type XtermTerminal = import("@xterm/xterm").Terminal;
type XtermDisposable = import("@xterm/xterm").IDisposable;
type FitAddonConstructor = typeof import("@xterm/addon-fit").FitAddon;
type FitAddon = import("@xterm/addon-fit").FitAddon;

interface Window {
  FitAddon?: {
    FitAddon: FitAddonConstructor;
  };
  Terminal?: XtermConstructor;
  newideTerminal?: NewideTerminalApi;
  newideUpdate?: NewideUpdateApi;
  newideWindow?: NewideWindowApi;
}

type SessionType = "chat" | "terminal";
type TerminalRenameTarget = "sidebar" | "tab";
type WindowAction = "minimize" | "maximize" | "close";

interface TerminalFrontend {
  xterm: XtermTerminal;
  fitAddon: FitAddon;
  host: HTMLDivElement;
  disposables: XtermDisposable[];
  opened: boolean;
  lastCols: number;
  lastRows: number;
}

interface RendererTerminal extends TerminalSession, TerminalFrontend {
  baseName: string;
  exited: boolean;
}

interface ChatSession {
  id: string;
  model: string;
  name: string;
  prompt: string;
}

interface OpenTab {
  type: SessionType;
  id: string;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required DOM element was not found: ${selector}`);
  }
  return element;
}

function closestElement<T extends Element>(
  target: EventTarget | null,
  selector: string
): T | null {
  return target instanceof Element ? target.closest<T>(selector) : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const iconBase = "./assets/icons";

function icon(name: string, className = "ui-icon"): HTMLImageElement {
  const image = document.createElement("img");
  const sourceName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.png`;
  image.className = className;
  image.src = `${iconBase}/${sourceName}`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function terminalKindIcon(
  kind: TerminalKind | undefined,
  className = "terminal-icon"
): HTMLImageElement {
  return icon(kind === "codex" ? "openai-logo.svg" : "terminal-icon", `ui-icon ${className}`);
}

function chatIcon(className = "chat-icon"): HTMLImageElement {
  return icon("chat-icon", `ui-icon ${className}`);
}

let chats: Record<string, ChatSession> = {};
let terminals: Record<string, RendererTerminal> = {};
let activeChatId: string | undefined;
let activeTerminalId: string | undefined;
let openTabs: OpenTab[] = [];
let editingTerminalId: string | undefined;
let editingTerminalRenameTarget: TerminalRenameTarget | undefined;
let lastTerminalRowClickId: string | undefined;
let lastTerminalRowClickAt = 0;
let chatCounter = 0;

const tabsRoot = requireElement<HTMLDivElement>("[data-open-tabs]");
const homePane = requireElement<HTMLElement>("[data-home-pane]");
const chatListRoot = requireElement<HTMLElement>("[data-chat-list]");
const chatInput = requireElement<HTMLTextAreaElement>("[data-chat-input]");
const chatModelSelect = requireElement<HTMLSelectElement>("[data-chat-model]");
const chatModelLabel = requireElement<HTMLElement>("[data-chat-model-label]");
const chatComposer = requireElement<HTMLFormElement>("[data-chat-composer]");
const terminalListRoot = requireElement<HTMLElement>("[data-terminal-list]");
const terminalScreen = requireElement<HTMLElement>("[data-terminal-screen]");
const updateBanner = requireElement<HTMLElement>("[data-update-banner]");
const updateTitle = requireElement<HTMLElement>("[data-update-title]");
const updateNotes = requireElement<HTMLElement>("[data-update-notes]");
const updateDismissButton = requireElement<HTMLButtonElement>("[data-update-dismiss]");
const updateDownloadButton = requireElement<HTMLButtonElement>("[data-update-download]");
const newChatButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-new-chat]")
];
const newTerminalButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-new-terminal]")
];
const viewerPanels = document.querySelectorAll<HTMLElement>("[data-viewer-panel]");
const XtermTerminal = window.Terminal;
const XtermFitAddon = window.FitAddon?.FitAddon;

let terminalCreationReady = false;
let availableUpdateVersion: string | undefined;
let updateDownloadUrl: string | undefined;
const pendingTerminalData: Record<string, string> = {};
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;
const dismissedUpdateStorageKey = "chickenshop:dismissed-update-version";
const chatInputMinHeight = 24;
const chatInputMultilineMinHeight = chatInputMinHeight * 2;
const chatInputMaxHeight = 168;
const chatCompactButtonColumnWidth = 32;
const chatCompactColumnGap = 4;
let chatInputMeasure: HTMLTextAreaElement | undefined;

setTimeout(() => {
  terminalCreationReady = true;
}, 600);

const windowControls: Record<WindowAction, () => void> = {
  minimize: () => {
    void window.newideWindow?.minimize();
  },
  maximize: () => {
    void window.newideWindow?.toggleMaximize();
  },
  close: () => {
    void window.newideWindow?.close();
  }
};

function isWindowAction(action: string | null): action is WindowAction {
  return action === "minimize" || action === "maximize" || action === "close";
}

function showViewer(viewerType: "chat" | "terminal"): void {
  homePane.classList.remove("active");
  viewerPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewerPanel === viewerType);
  });
}

function showHome(): void {
  viewerPanels.forEach((panel) => {
    panel.classList.remove("active");
  });
  homePane.classList.add("active");
}

function getTabKey(type: SessionType, id: string): string {
  return `${type}:${id}`;
}

function getActiveTabKey(): string | undefined {
  if (activeChatId) return getTabKey("chat", activeChatId);
  if (activeTerminalId) return getTabKey("terminal", activeTerminalId);
  return undefined;
}

function ensureOpenTab(type: SessionType, id: string): void {
  const key = getTabKey(type, id);
  if (openTabs.some((tab) => getTabKey(tab.type, tab.id) === key)) return;
  openTabs.push({ type, id });
}

function renderTerminalRenameInput(
  terminal: RendererTerminal,
  target: TerminalRenameTarget,
  className: string
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = className;
  input.value = terminal.name;
  input.dataset.terminalRename = `${target}:${terminal.id}`;
  input.setAttribute("aria-label", "terminal name");
  input.spellcheck = false;

  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  input.addEventListener("dblclick", (event) => {
    event.stopPropagation();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTerminalRename(terminal.id, input.value);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelTerminalRename();
    }
  });

  input.addEventListener("blur", () => {
    if (editingTerminalId !== terminal.id) return;
    commitTerminalRename(terminal.id, input.value);
  });

  return input;
}

function focusTerminalRenameInput(
  terminalId: string,
  target: TerminalRenameTarget
): void {
  const renameKey = `${target}:${terminalId}`;
  const input = [...document.querySelectorAll<HTMLInputElement>("[data-terminal-rename]")].find(
    (candidate) => candidate.dataset.terminalRename === renameKey
  );

  if (!input) return;
  input.focus();
  input.select();
}

function beginTerminalRename(terminalId: string, target: TerminalRenameTarget): void {
  if (!terminals[terminalId]) return;

  lastTerminalRowClickId = undefined;
  lastTerminalRowClickAt = 0;
  editingTerminalId = terminalId;
  editingTerminalRenameTarget = target;
  renderOpenTabs();
  renderTerminals();

  requestAnimationFrame(() => {
    focusTerminalRenameInput(terminalId, target);
  });
}

function commitTerminalRename(terminalId: string, name: string): void {
  const terminal = terminals[terminalId];
  const nextName = name.trim();

  editingTerminalId = undefined;
  editingTerminalRenameTarget = undefined;

  if (terminal && nextName) {
    terminal.name = nextName;
  }

  renderOpenTabs();
  renderTerminals();
}

function cancelTerminalRename(): void {
  editingTerminalId = undefined;
  editingTerminalRenameTarget = undefined;
  renderOpenTabs();
  renderTerminals();
}

function activateOpenTab(tab?: OpenTab): void {
  if (!tab) {
    activeChatId = undefined;
    activeTerminalId = undefined;
    renderTerminalView();
    showHome();
    renderOpenTabs();
    renderChats();
    renderTerminals();
    return;
  }

  if (tab.type === "chat") {
    setActiveChat(tab.id);
    return;
  }

  setActiveTerminal(tab.id);
}

function renderOpenTabs(): void {
  const activeKey = getActiveTabKey();

  tabsRoot.replaceChildren(
    ...openTabs.flatMap((openTab): HTMLDivElement[] => {
      const isChat = openTab.type === "chat";
      const chat = isChat ? chats[openTab.id] : undefined;
      const terminal = !isChat ? terminals[openTab.id] : undefined;
      const session = chat ?? terminal;
      if (!session) return [];

      const tab = document.createElement("div");
      const tabKey = getTabKey(openTab.type, openTab.id);
      const isActive = tabKey === activeKey;
      tab.className = "workspace-tab";
      tab.classList.toggle("chat-tab", isChat);
      tab.classList.toggle("terminal-tab", !isChat);
      tab.classList.toggle("active", isActive);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(isActive));

      const select = document.createElement("div");
      select.className = "tab-select";
      select.setAttribute("role", "button");
      select.tabIndex = 0;
      select.title = isChat ? chat?.name ?? "" : terminal?.cwd ?? "";
      select.append(isChat
        ? chatIcon("tab-chat-icon")
        : terminalKindIcon(terminal?.kind, "tab-terminal-icon"));

      const isRenaming =
        terminal &&
        editingTerminalId === terminal.id &&
        editingTerminalRenameTarget === "tab";

      if (isRenaming) {
        select.append(
          renderTerminalRenameInput(
            terminal,
            "tab",
            "terminal-row-rename"
          )
        );
      } else {
        const label = document.createElement("span");
        label.className = "tab-label";
        label.textContent = session.name;
        select.append(label);
      }

      select.addEventListener("click", () => activateOpenTab(openTab));
      select.addEventListener("dblclick", (event) => {
        if (isChat) return;
        event.preventDefault();
        beginTerminalRename(openTab.id, "tab");
      });
      select.addEventListener("keydown", (event) => {
        const isActivationKey = event.key === "Enter" || event.key === " ";
        if (!isActivationKey) return;
        event.preventDefault();
        activateOpenTab(openTab);
      });

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.setAttribute("aria-label", `close ${session.name}`);
      close.append(icon("close", "ui-icon tab-close-icon"));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        if (isChat) {
          closeChatTab(openTab.id);
          return;
        }
        closeTerminalTab(openTab.id);
      });

      tab.append(select, close);
      return [tab];
    })
  );
}

function getDismissedUpdateVersion(): string | undefined {
  try {
    return window.localStorage.getItem(dismissedUpdateStorageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function setDismissedUpdateVersion(version: string): void {
  try {
    window.localStorage.setItem(dismissedUpdateStorageKey, version);
  } catch {
    // Ignore storage failures; the banner can still be dismissed for this session.
  }
}

function hideUpdateBanner(): void {
  availableUpdateVersion = undefined;
  updateDownloadUrl = undefined;
  updateBanner.hidden = true;
}

function showUpdateBanner(result: UpdateCheckResult): void {
  const latest = result.latest;
  if (!latest || result.status !== "available") {
    hideUpdateBanner();
    return;
  }

  if (getDismissedUpdateVersion() === latest.version) return;

  availableUpdateVersion = latest.version;
  updateDownloadUrl = latest.downloadUrl;
  updateTitle.textContent = `chickenshop ${latest.version} is ready`;
  updateNotes.textContent = latest.notes ?? "";
  updateNotes.hidden = !latest.notes;
  updateBanner.hidden = false;
}

async function checkForUpdates(): Promise<void> {
  if (!window.newideUpdate?.check) return;

  try {
    const result = await window.newideUpdate.check();
    showUpdateBanner(result);
  } catch {
    hideUpdateBanner();
  }
}

function scheduleUpdateChecks(): void {
  window.setTimeout(() => {
    void checkForUpdates();
  }, 1500);

  window.setInterval(() => {
    void checkForUpdates();
  }, updateCheckIntervalMs);
}

function renderChats(): void {
  chatListRoot.replaceChildren(
    ...Object.values(chats).map((chat) => {
      const row = document.createElement("div");
      row.className = "chat-row";
      row.classList.toggle("selected", chat.id === activeChatId);
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.chatId = chat.id;
      row.append(chatIcon());

      const title = document.createElement("span");
      title.className = "chat-row-title";
      title.textContent = chat.name;
      row.append(title);

      const close = document.createElement("button");
      close.className = "session-row-close";
      close.type = "button";
      close.dataset.chatClose = chat.id;
      close.setAttribute("aria-label", `close ${chat.name}`);
      close.append(icon("close", "ui-icon session-row-close-icon"));
      row.append(close);

      return row;
    })
  );
}

function renderTerminals(): void {
  terminalListRoot.replaceChildren(
    ...Object.values(terminals).map((terminal) => {
      const row = document.createElement("div");
      row.className = "terminal-row";
      row.classList.toggle("selected", terminal.id === activeTerminalId);
      row.classList.toggle("codex-terminal-row", terminal.kind === "codex");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.terminalId = terminal.id;
      row.append(terminalKindIcon(terminal.kind));

      const isRenaming =
        editingTerminalId === terminal.id && editingTerminalRenameTarget === "sidebar";

      if (isRenaming) {
        row.append(
          renderTerminalRenameInput(
            terminal,
            "sidebar",
            "terminal-row-rename"
          )
        );
      } else {
        const title = document.createElement("span");
        title.className = "terminal-row-title";
        title.textContent = terminal.name;
        row.append(title);
      }

      const close = document.createElement("button");
      close.className = "session-row-close terminal-row-close";
      close.type = "button";
      close.dataset.terminalClose = terminal.id;
      close.setAttribute("aria-label", `close ${terminal.name}`);
      close.append(icon("close", "ui-icon session-row-close-icon terminal-row-close-icon"));
      row.append(close);

      return row;
    })
  );
}

function setSidebarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]").forEach((button) => {
    button.setAttribute("aria-expanded", String(!collapsed));
  });
}

function toggleSidebar(): void {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  resizeChatInput();
  window.setTimeout(resizeChatInput, 220);
}

function appendTerminalOutput(terminalId: string, text: string): void {
  const terminal = terminals[terminalId];
  if (!terminal) {
    pendingTerminalData[terminalId] = `${pendingTerminalData[terminalId] ?? ""}${text}`;
    return;
  }

  terminal.xterm.write(text);
}

function disposeTerminalFrontend(terminal?: RendererTerminal): void {
  terminal?.disposables?.forEach((disposable) => disposable.dispose());
  terminal?.xterm?.dispose();
}

function createTerminalFrontend(terminalId: string): TerminalFrontend {
  if (!XtermTerminal || !XtermFitAddon) {
    throw new Error("xterm failed to load.");
  }

  const xterm = new XtermTerminal({
    allowTransparency: true,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 1,
    fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.45,
    macOptionIsMeta: true,
    scrollback: 10000,
    theme: {
      background: "#fbf1e8",
      foreground: "#263c55",
      cursor: "#213650",
      selectionBackground: "#cbd8e5",
      black: "#263c55",
      blue: "#3a6ea5",
      brightBlack: "#8793a1",
      brightBlue: "#4b86c5",
      brightCyan: "#4596a8",
      brightGreen: "#5a8d57",
      brightMagenta: "#8a6ca8",
      brightRed: "#b15c58",
      brightWhite: "#213650",
      brightYellow: "#a58239",
      cyan: "#3f8796",
      green: "#4f7f4c",
      magenta: "#7c5e96",
      red: "#9c514d",
      white: "#263c55",
      yellow: "#8c7132"
    }
  });
  const fitAddon = new XtermFitAddon();
  const host = document.createElement("div");
  host.className = "terminal-instance";
  xterm.loadAddon(fitAddon);

  const disposables = [
    xterm.onData((data) => {
      if (!window.newideTerminal?.write) return;
      window.newideTerminal.write(terminalId, data).catch((error) => {
        xterm.write(`\r\nCould not write to terminal: ${getErrorMessage(error)}\r\n`);
      });
    }),
    xterm.onResize(({ cols, rows }) => {
      void window.newideTerminal?.resize(terminalId, cols, rows);
    })
  ];

  return {
    xterm,
    fitAddon,
    host,
    disposables,
    opened: false,
    lastCols: xterm.cols,
    lastRows: xterm.rows
  };
}

function fitTerminal(terminal?: RendererTerminal): void {
  if (!terminal?.opened) return;

  terminal.fitAddon.fit();

  if (terminal.xterm.cols !== terminal.lastCols || terminal.xterm.rows !== terminal.lastRows) {
    terminal.lastCols = terminal.xterm.cols;
    terminal.lastRows = terminal.xterm.rows;
    void window.newideTerminal?.resize(terminal.id, terminal.xterm.cols, terminal.xterm.rows);
  }
}

function renderTerminalView(): void {
  const terminal = activeTerminalId ? terminals[activeTerminalId] : undefined;
  if (!terminal) {
    terminalScreen.replaceChildren();
    return;
  }

  terminalScreen.replaceChildren(terminal.host);

  if (!terminal.opened) {
    terminal.xterm.open(terminal.host);
    terminal.opened = true;
  }

  fitTerminal(terminal);

  requestAnimationFrame(() => {
    fitTerminal(terminal);
    terminal.xterm.focus();
  });
}

function renderChatView(): void {
  const chat = activeChatId ? chats[activeChatId] : undefined;
  if (!chat) {
    chatInput.value = "";
    chatModelSelect.value = chatModelSelect.options[0]?.value ?? "";
    chatModelLabel.textContent = chatModelSelect.value;
    resizeChatInput();
    return;
  }

  chat.prompt = normalizeChatPrompt(chat.prompt);
  chatInput.value = chat.prompt;
  chatModelSelect.value = chat.model;
  chatModelLabel.textContent = chat.model;
  resizeChatInput();
}

function normalizeChatPrompt(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\s*\n+\s*/g, " ");
  return normalized.trim().length === 0 ? "" : normalized;
}

function getChatInputMeasure(): HTMLTextAreaElement {
  if (chatInputMeasure) return chatInputMeasure;

  chatInputMeasure = document.createElement("textarea");
  chatInputMeasure.rows = 1;
  chatInputMeasure.tabIndex = -1;
  chatInputMeasure.setAttribute("aria-hidden", "true");
  chatInputMeasure.style.position = "fixed";
  chatInputMeasure.style.left = "-10000px";
  chatInputMeasure.style.top = "0";
  chatInputMeasure.style.height = "0";
  chatInputMeasure.style.minHeight = "0";
  chatInputMeasure.style.maxHeight = "none";
  chatInputMeasure.style.overflow = "hidden";
  chatInputMeasure.style.padding = "0";
  chatInputMeasure.style.border = "0";
  chatInputMeasure.style.visibility = "hidden";
  chatInputMeasure.style.pointerEvents = "none";
  chatInputMeasure.style.resize = "none";
  chatInputMeasure.style.whiteSpace = "pre-wrap";
  chatInputMeasure.style.wordBreak = "normal";
  chatInputMeasure.style.overflowWrap = "break-word";
  document.body.append(chatInputMeasure);

  return chatInputMeasure;
}

function getCompactChatInputWidth(): number {
  const composerStyle = getComputedStyle(chatComposer);
  const paddingX =
    (parseFloat(composerStyle.paddingLeft) || 0) +
    (parseFloat(composerStyle.paddingRight) || 0);
  const contentWidth = chatComposer.clientWidth - paddingX;
  const reservedControlWidth =
    chatCompactButtonColumnWidth * 2 + chatCompactColumnGap * 2;
  const compactWidth = contentWidth - reservedControlWidth;
  const fallbackWidth = chatInput.getBoundingClientRect().width;

  return Math.max(0, Math.round(compactWidth || fallbackWidth));
}

function measureChatInputHeightForCompactRow(): number {
  const measureInput = getChatInputMeasure();
  const inputStyle = getComputedStyle(chatInput);
  const compactWidth = getCompactChatInputWidth();

  measureInput.style.boxSizing = inputStyle.boxSizing;
  measureInput.style.font = inputStyle.font;
  measureInput.style.letterSpacing = inputStyle.letterSpacing;
  measureInput.style.lineHeight = inputStyle.lineHeight;
  measureInput.style.width = `${compactWidth}px`;
  measureInput.value = chatInput.value || " ";
  measureInput.style.height = "0";

  return measureInput.scrollHeight;
}

function shouldUseMultilineChatInput(): boolean {
  if (!chatInput.value) return false;

  return measureChatInputHeightForCompactRow() > chatInputMinHeight + 1;
}

function resizeChatInput(): void {
  const shouldUseMultiline = shouldUseMultilineChatInput();
  chatInput.wrap = "soft";
  chatInput.style.minHeight = "0";
  chatInput.style.height = "0";
  chatComposer.classList.toggle("is-multiline", shouldUseMultiline);

  chatInput.style.height = "0";
  const contentHeight = chatInput.scrollHeight;
  const nextHeight = shouldUseMultiline
    ? Math.min(
        Math.max(contentHeight, chatInputMultilineMinHeight),
        chatInputMaxHeight
      )
    : chatInputMinHeight;
  chatInput.style.overflowY =
    shouldUseMultiline && contentHeight > chatInputMaxHeight ? "auto" : "hidden";
  chatInput.style.minHeight = "";
  chatInput.style.height = `${nextHeight}px`;
}

function setActiveChat(chatId: string | undefined): void {
  if (!chatId) return;
  const chat = chats[chatId];
  if (!chat) return;

  ensureOpenTab("chat", chatId);
  activeChatId = chatId;
  activeTerminalId = undefined;

  showViewer("chat");
  renderChatView();
  renderOpenTabs();
  renderChats();
  renderTerminals();

  requestAnimationFrame(() => {
    chatInput.focus();
  });
}

function setActiveTerminal(terminalId: string | undefined): void {
  if (!terminalId) return;
  const terminal = terminals[terminalId];
  if (!terminal) return;

  ensureOpenTab("terminal", terminalId);
  activeChatId = undefined;
  activeTerminalId = terminalId;

  showViewer("terminal");
  renderTerminalView();
  renderOpenTabs();
  renderChats();
  renderTerminals();

  requestAnimationFrame(() => {
    terminalScreen.focus();
  });
}

function createChatSession(): void {
  const id = `chat-${++chatCounter}`;
  const matchingChatCount = Object.keys(chats).length;
  const name = matchingChatCount > 0 ? `chat ${matchingChatCount + 1}` : "chat";

  chats[id] = {
    id,
    model: chatModelSelect.value || "5.5 Extra High",
    name,
    prompt: ""
  };

  setActiveChat(id);
}

async function createTerminalSession(): Promise<void> {
  let terminal: TerminalSession;
  let startupOutput = "";
  let terminalExited = false;

  if (window.newideTerminal?.create) {
    try {
      terminal = await window.newideTerminal.create();
    } catch (error: unknown) {
      const id = `terminal-${Date.now()}`;
      terminal = {
        id,
        name: "terminal",
        cwd: "unavailable",
        kind: "shell"
      };
      startupOutput = `terminal failed to start: ${getErrorMessage(error)}\r\n`;
      terminalExited = true;
    }
  } else {
    const id = `terminal-${Date.now()}`;
    terminal = {
      id,
      name: "terminal",
      cwd: "preview",
      kind: "shell"
    };
    startupOutput = "terminal execution is only available in the Electron desktop app.\r\n";
    terminalExited = true;
  }

  const baseName = terminal.name;
  const matchingNameCount = Object.values(terminals).filter(
    (existingTerminal) => existingTerminal.baseName === baseName
  ).length;
  const frontend = createTerminalFrontend(terminal.id);

  terminals[terminal.id] = {
    ...terminal,
    ...frontend,
    baseName,
    name: matchingNameCount > 0 ? `${baseName} ${matchingNameCount + 1}` : baseName,
    exited: terminalExited
  };

  setActiveTerminal(terminal.id);

  if (pendingTerminalData[terminal.id]) {
    appendTerminalOutput(terminal.id, pendingTerminalData[terminal.id]);
    delete pendingTerminalData[terminal.id];
  }

  if (startupOutput) {
    appendTerminalOutput(terminal.id, startupOutput);
  }
}

function closeTerminalTab(terminalId: string | undefined): void {
  if (!terminalId) return;
  const wasActive = terminalId === activeTerminalId;
  const tabIndex = openTabs.findIndex(
    (tab) => tab.type === "terminal" && tab.id === terminalId
  );

  openTabs = openTabs.filter((tab) => !(tab.type === "terminal" && tab.id === terminalId));

  if (editingTerminalId === terminalId) {
    editingTerminalId = undefined;
    editingTerminalRenameTarget = undefined;
  }

  void window.newideTerminal?.dispose(terminalId);
  disposeTerminalFrontend(terminals[terminalId]);
  delete terminals[terminalId];

  if (wasActive) {
    activeTerminalId = undefined;
    activateOpenTab(openTabs[Math.min(tabIndex, openTabs.length - 1)]);
    return;
  }

  renderOpenTabs();
  renderTerminals();
}

function closeChatTab(chatId: string | undefined): void {
  if (!chatId) return;
  const wasActive = chatId === activeChatId;
  const tabIndex = openTabs.findIndex((tab) => tab.type === "chat" && tab.id === chatId);

  openTabs = openTabs.filter((tab) => !(tab.type === "chat" && tab.id === chatId));
  delete chats[chatId];

  if (wasActive) {
    activeChatId = undefined;
    activateOpenTab(openTabs[Math.min(tabIndex, openTabs.length - 1)]);
    return;
  }

  renderOpenTabs();
  renderChats();
}

function requestTerminalCreation(): void {
  if (!terminalCreationReady) return;
  void createTerminalSession();
}

document.querySelectorAll<HTMLElement>("[data-window-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.getAttribute("data-window-action");
    if (isWindowAction(action)) windowControls[action]();
  });
});

document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]").forEach((button) => {
  button.addEventListener("click", toggleSidebar);
});

newChatButtons.forEach((button) => {
  button.addEventListener("click", createChatSession);
});

newTerminalButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    requestTerminalCreation();
  });
});

updateDismissButton.addEventListener("click", () => {
  if (availableUpdateVersion) setDismissedUpdateVersion(availableUpdateVersion);
  hideUpdateBanner();
});

updateDownloadButton.addEventListener("click", () => {
  if (!updateDownloadUrl) return;
  void window.newideUpdate?.openDownload(updateDownloadUrl);
});

chatComposer.addEventListener("submit", (event) => {
  event.preventDefault();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "NumpadEnter") return;
  event.preventDefault();
});

chatInput.addEventListener("input", () => {
  const chat = activeChatId ? chats[activeChatId] : undefined;
  const prompt = normalizeChatPrompt(chatInput.value);
  if (prompt !== chatInput.value) {
    const selectionStart = chatInput.selectionStart ?? chatInput.value.length;
    const normalizedSelectionStart = normalizeChatPrompt(
      chatInput.value.slice(0, selectionStart)
    ).length;
    chatInput.value = prompt;
    chatInput.setSelectionRange(normalizedSelectionStart, normalizedSelectionStart);
  }

  resizeChatInput();
  if (!chat) return;
  chat.prompt = prompt;
});

chatModelSelect.addEventListener("change", () => {
  const chat = activeChatId ? chats[activeChatId] : undefined;
  chatModelLabel.textContent = chatModelSelect.value;
  if (!chat) return;
  chat.model = chatModelSelect.value;
});

chatListRoot.addEventListener("click", (event) => {
  const closeButton = closestElement<HTMLElement>(event.target, "[data-chat-close]");
  if (closeButton) {
    event.preventDefault();
    closeChatTab(closeButton.dataset.chatClose);
    return;
  }

  const chatButton = closestElement<HTMLElement>(event.target, "[data-chat-id]");
  if (!chatButton?.dataset.chatId) return;

  setActiveChat(chatButton.dataset.chatId);
});

chatListRoot.addEventListener("keydown", (event) => {
  if (closestElement<HTMLElement>(event.target, "[data-chat-close]")) return;

  const chatButton = closestElement<HTMLElement>(event.target, "[data-chat-id]");
  if (!chatButton?.dataset.chatId) return;

  const isActivationKey = event.key === "Enter" || event.key === " ";
  if (!isActivationKey) return;

  event.preventDefault();
  setActiveChat(chatButton.dataset.chatId);
});

terminalListRoot.addEventListener("click", (event) => {
  const closeButton = closestElement<HTMLElement>(event.target, "[data-terminal-close]");
  if (closeButton) {
    event.preventDefault();
    lastTerminalRowClickId = undefined;
    lastTerminalRowClickAt = 0;
    closeTerminalTab(closeButton.dataset.terminalClose);
    return;
  }

  if (closestElement<HTMLElement>(event.target, "[data-terminal-rename]")) return;

  const terminalButton = closestElement<HTMLElement>(event.target, "[data-terminal-id]");
  if (!terminalButton) return;

  const terminalId = terminalButton.dataset.terminalId;
  if (!terminalId) return;
  const now = Date.now();
  const isRenameClick =
    lastTerminalRowClickId === terminalId && now - lastTerminalRowClickAt < 450;

  lastTerminalRowClickId = terminalId;
  lastTerminalRowClickAt = now;

  if (isRenameClick) {
    event.preventDefault();
    beginTerminalRename(terminalId, "sidebar");
    return;
  }

  setActiveTerminal(terminalId);
});

terminalListRoot.addEventListener("keydown", (event) => {
  if (
    closestElement<HTMLElement>(event.target, "[data-terminal-close]") ||
    closestElement<HTMLElement>(event.target, "[data-terminal-rename]")
  ) {
    return;
  }

  const terminalButton = closestElement<HTMLElement>(event.target, "[data-terminal-id]");
  if (!terminalButton) return;

  const isActivationKey = event.key === "Enter" || event.key === " ";
  if (!isActivationKey) return;

  event.preventDefault();
  setActiveTerminal(terminalButton.dataset.terminalId);
});

terminalScreen.addEventListener("click", () => {
  if (activeTerminalId) terminals[activeTerminalId]?.xterm.focus();
});

window.addEventListener("resize", () => {
  fitTerminal(activeTerminalId ? terminals[activeTerminalId] : undefined);
});

if ("ResizeObserver" in window) {
  const layoutResizeObserver = new ResizeObserver(() => {
    fitTerminal(activeTerminalId ? terminals[activeTerminalId] : undefined);
    resizeChatInput();
  });

  layoutResizeObserver.observe(terminalScreen);
}

document.addEventListener("keydown", (event) => {
  const isSidebarShortcut =
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "b";

  if (!isSidebarShortcut) return;
  event.preventDefault();
  toggleSidebar();
});

window.addEventListener("resize", resizeChatInput);

function applyWindowState({ expanded }: WindowState): void {
  document.body.classList.toggle("window-expanded", expanded);
}

void window.newideWindow?.getState().then(applyWindowState);
window.newideWindow?.onStateChange(applyWindowState);
window.newideWindow?.onToggleSidebar(toggleSidebar);

window.newideTerminal?.onData(({ id, data }) => {
  appendTerminalOutput(id, data);
});

window.newideTerminal?.onExit(({ id, code }) => {
  const terminal = terminals[id];
  if (!terminal) return;

  terminal.exited = true;
  appendTerminalOutput(id, `\r\n[terminal exited${typeof code === "number" ? ` with code ${code}` : ""}]\r\n`);
  renderTerminals();
});

window.newideTerminal?.onState(({ id, cwd, kind }) => {
  const terminal = terminals[id];
  if (!terminal) return;

  terminal.cwd = cwd;
  terminal.kind = kind;

  renderOpenTabs();
  renderTerminals();
});

function initializeApp(): void {
  showHome();
  renderChats();
  renderTerminals();
  scheduleUpdateChecks();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp, { once: true });
} else {
  initializeApp();
}
