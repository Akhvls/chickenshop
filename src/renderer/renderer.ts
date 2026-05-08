type ProjectDirectoryNode = import("../shared").ProjectDirectoryNode;
type ProjectFileNode = import("../shared").ProjectFileNode;
type ProjectNode = import("../shared").ProjectNode;
type NewideProjectApi = import("../shared").NewideProjectApi;
type NewideTerminalApi = import("../shared").NewideTerminalApi;
type NewideUpdateApi = import("../shared").NewideUpdateApi;
type NewideWindowApi = import("../shared").NewideWindowApi;
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
  newideProject?: NewideProjectApi;
  newideTerminal?: NewideTerminalApi;
  newideUpdate?: NewideUpdateApi;
  newideWindow?: NewideWindowApi;
}

type ViewerType = "text";
type TabType = "file" | "terminal";
type TerminalRenameTarget = "sidebar" | "tab";
type WindowAction = "minimize" | "maximize" | "close";

interface EditableFile {
  name: string;
  path: string;
  viewer: ViewerType;
  status: string;
  content: string;
  readonly?: boolean;
}

interface OpenTab {
  type: TabType;
  id: string;
}

interface TabDetails {
  name: string;
  title: string;
  closeLabel: string;
}

interface Viewer {
  read(file?: EditableFile): void;
  render(file: EditableFile): void;
  clear(): void;
}

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
const fileTypeIconBase = "./assets/file-types";

const fileTypeIcons: Record<string, string> = {
  md: "md",
  markdown: "md",
  txt: "txt",
  text: "txt"
};

const fallbackProject: ProjectDirectoryNode = {
  type: "directory",
  name: "newide",
  path: "demo:/newide",
  children: [
    {
      type: "file",
      name: "dev-notes.md",
      path: "demo:/newide/dev-notes.md",
      status: "6m",
      content: `# Dev startup notes

Electron is installed locally and the dev command runs the desktop app directly.

npm run dev

The renderer is loaded from:
dist/renderer/index.html

This surface should behave like a quiet text editor: open a file, read it, edit it, and keep the surrounding chrome out of the way.`
    },
    {
      type: "file",
      name: "scratch.txt",
      path: "demo:/newide/scratch.txt",
      status: "Now",
      content: `Scratch

- Keep the app text-first.
- Sidebar: new project, search, explorer.
- Main pane: editable file content, not a chat transcript.
- Later: wire this to real file open/save actions.`
    },
    {
      type: "file",
      name: "roadmap.md",
      path: "demo:/newide/roadmap.md",
      status: "4d",
      content: `# Roadmap

1. Text editor shell
2. Project file tree
3. Real open/save support
4. search across notes
5. Optional agent actions once the editor foundation feels right`
    }
  ]
};

let activeProject: ProjectDirectoryNode | undefined;
let files: Record<string, EditableFile> = {};
let terminals: Record<string, RendererTerminal> = {};
let activeFileId: string | undefined;
let activeTerminalId: string | undefined;
let openTabs: OpenTab[] = [];
let expandedFolders = new Set<string>();
let isLoadingFile = false;
let editingTerminalId: string | undefined;
let editingTerminalRenameTarget: TerminalRenameTarget | undefined;
let lastTerminalRowClickId: string | undefined;
let lastTerminalRowClickAt = 0;
let isProjectPickerOpen = false;

const tabsRoot = requireElement<HTMLDivElement>("[data-open-tabs]");
const homePane = requireElement<HTMLElement>("[data-home-pane]");
const textEditor = requireElement<HTMLElement>("[data-text-editor]");
const editor = requireElement<HTMLElement>("[data-editor]");
const terminalListRoot = requireElement<HTMLElement>("[data-terminal-list]");
const terminalScreen = requireElement<HTMLElement>("[data-terminal-screen]");
const projectTreeRoot = requireElement<HTMLElement>("[data-project-tree]");
const updateBanner = requireElement<HTMLElement>("[data-update-banner]");
const updateTitle = requireElement<HTMLElement>("[data-update-title]");
const updateNotes = requireElement<HTMLElement>("[data-update-notes]");
const updateDismissButton = requireElement<HTMLButtonElement>("[data-update-dismiss]");
const updateDownloadButton = requireElement<HTMLButtonElement>("[data-update-download]");
const openProjectButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-open-project]")
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

const viewers: Record<ViewerType, Viewer> = {
  text: {
    read(file) {
      if (!file || file.readonly) return;
      file.content = editor.textContent ?? "";
    },
    render(file) {
      editor.textContent = file.content ?? "";
      editor.contentEditable = file.readonly ? "false" : "plaintext-only";
      updateLineNumbers();
    },
    clear() {
      editor.textContent = "";
      editor.contentEditable = "plaintext-only";
      updateLineNumbers();
    }
  }
};

function getViewer(file?: EditableFile): Viewer {
  return file ? viewers[file.viewer] : viewers.text;
}

function icon(name: string, className = "ui-icon"): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.src = `${iconBase}/${name}.png`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function getFileExtension(fileName = ""): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return !extension || extension === fileName ? "" : extension;
}

function getFileTypeIconName(fileName: string): string | undefined {
  return fileTypeIcons[getFileExtension(fileName)];
}

function fileTypeIcon(fileName: string, className = "tab-file-icon"): HTMLImageElement {
  const image = document.createElement("img");
  const iconName = getFileTypeIconName(fileName);
  image.className = className;
  image.src = iconName
    ? `${fileTypeIconBase}/${iconName}.png`
    : `${iconBase}/file.png`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function terminalIcon(className = "terminal-icon"): HTMLImageElement {
  return icon("terminal-icon", `ui-icon ${className}`);
}

function showViewer(viewerType: ViewerType | "terminal"): void {
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

function saveActiveFile(): void {
  if (!activeFileId) return;
  const file = files[activeFileId];
  getViewer(file).read(file);
}

function updateLineNumbers(): void {
  const lineCount = Math.max((editor.textContent ?? "").split("\n").length, 1);
  textEditor
    .querySelectorAll("[data-line-number]")
    .forEach((lineNumber) => lineNumber.remove());

  const lineFragment = document.createDocumentFragment();
  Array.from({ length: lineCount }, (_item, index) => {
    const lineNumber = document.createElement("span");
    lineNumber.className = "editor-line-number";
    lineNumber.dataset.lineNumber = "";
    lineNumber.setAttribute("aria-hidden", "true");
    lineNumber.style.setProperty("--line-index", String(index));
    lineNumber.textContent = String(index + 1);
    lineFragment.append(lineNumber);
  });

  textEditor.insertBefore(lineFragment, editor);
}

function getTabKey(type: TabType, id: string): string {
  return `${type}:${id}`;
}

function getActiveTabKey(): string | undefined {
  if (activeTerminalId) return getTabKey("terminal", activeTerminalId);
  if (activeFileId) return getTabKey("file", activeFileId);
  return undefined;
}

function ensureOpenTab(type: TabType, id: string): void {
  const key = getTabKey(type, id);
  if (openTabs.some((tab) => getTabKey(tab.type, tab.id) === key)) return;
  openTabs.push({ type, id });
}

function getTabDetails(tab: OpenTab): TabDetails | undefined {
  if (tab.type === "file") {
    const file = files[tab.id];
    if (!file) return undefined;
    return {
      name: file.name,
      title: file.path,
      closeLabel: `Close ${file.name}`
    };
  }

  const terminal = terminals[tab.id];
  if (!terminal) return undefined;
  return {
    name: terminal.name,
    title: terminal.cwd,
    closeLabel: `close ${terminal.name}`
  };
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
    activeFileId = undefined;
    activeTerminalId = undefined;
    viewers.text.clear();
    showHome();
    renderOpenTabs();
    renderSidebarStates();
    renderTerminals();
    return;
  }

  if (tab.type === "terminal") {
    setActiveTerminal(tab.id);
    return;
  }

  setActiveFile(tab.id, { force: true });
}

function renderOpenTabs(): void {
  const activeKey = getActiveTabKey();

  tabsRoot.replaceChildren(
    ...openTabs.flatMap((openTab): HTMLDivElement[] => {
      const details = getTabDetails(openTab);
      if (!details) return [];

      const tab = document.createElement("div");
      const tabKey = getTabKey(openTab.type, openTab.id);
      tab.className = "workspace-tab";
      tab.classList.toggle("active", tabKey === activeKey);
      tab.classList.toggle("terminal-tab", openTab.type === "terminal");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(tabKey === activeKey));

      const select = document.createElement("div");
      select.className = "tab-select";
      select.setAttribute("role", "button");
      select.tabIndex = 0;
      select.title = details.title;

      if (openTab.type === "terminal") {
        select.append(terminalIcon("tab-terminal-icon"));
      } else {
        select.append(fileTypeIcon(details.name));
      }

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = details.name;
      select.append(label);

      select.addEventListener("click", () => activateOpenTab(openTab));
      select.addEventListener("keydown", (event) => {
        const isActivationKey = event.key === "Enter" || event.key === " ";
        if (!isActivationKey) return;
        event.preventDefault();
        activateOpenTab(openTab);
      });

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.setAttribute("aria-label", details.closeLabel);
      close.append(icon("close", "ui-icon tab-close-icon"));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        if (openTab.type === "terminal") {
          closeTerminalTab(openTab.id);
          return;
        }
        closeFileTab(openTab.id);
      });

      tab.append(select, close);
      return [tab];
    })
  );
}

function renderSidebarStates(): void {
  document.querySelectorAll<HTMLElement>("[data-file-path]").forEach((button) => {
    const isActive = button.dataset.filePath === activeFileId;
    button.classList.toggle("selected", isActive);
    button.classList.toggle("is-active", isActive);
  });
}

function setOpenProjectSelected(selected: boolean): void {
  openProjectButtons.forEach((button) => {
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
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

function renderTerminals(): void {
  terminalListRoot.replaceChildren(
    ...Object.values(terminals).map((terminal) => {
      const row = document.createElement("div");
      row.className = "terminal-row";
      row.classList.toggle("selected", terminal.id === activeTerminalId);
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.terminalId = terminal.id;
      row.append(terminalIcon());

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
      close.className = "terminal-row-close";
      close.type = "button";
      close.dataset.terminalClose = terminal.id;
      close.setAttribute("aria-label", `close ${terminal.name}`);
      close.append(icon("close", "ui-icon terminal-row-close-icon"));
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
}

function toggleFolder(folderPath: string): void {
  if (expandedFolders.has(folderPath)) {
    expandedFolders.delete(folderPath);
  } else {
    expandedFolders.add(folderPath);
  }
  renderProjectTree();
}

function isTextCandidate(fileName: string): boolean {
  return /\.(css|html|js|json|md|mjs|cjs|txt|ts|tsx|jsx|yml|yaml)$/i.test(fileName);
}

function findFileNode(
  node: ProjectNode | undefined,
  predicate: (node: ProjectFileNode) => boolean
): ProjectFileNode | undefined {
  if (!node) return undefined;
  if (node.type === "file") return predicate(node) ? node : undefined;

  for (const child of node.children) {
    const match = findFileNode(child, predicate);
    if (match) return match;
  }

  return undefined;
}

function findPreferredFile(project: ProjectDirectoryNode): ProjectFileNode | undefined {
  return (
    findFileNode(
      project,
      (node) => node.path.endsWith("src/renderer/index.html")
    ) ??
    findFileNode(project, (node) => isTextCandidate(node.name))
  );
}

function expandParentsForPath(
  targetPath: string,
  node: ProjectNode | undefined = activeProject,
  parents: string[] = []
): boolean {
  if (!node) return false;
  if (node.path === targetPath) {
    parents.forEach((folderPath) => expandedFolders.add(folderPath));
    return true;
  }

  if (node.type !== "directory") return false;

  for (const child of node.children) {
    if (expandParentsForPath(targetPath, child, [...parents, node.path])) {
      return true;
    }
  }

  return false;
}

function registerFallbackFiles(node: ProjectNode | undefined): void {
  if (!node) return;
  if (node.type === "file") {
    files[node.path] = {
      name: node.name,
      path: node.path,
      viewer: "text",
      status: node.status ?? "",
      content: node.content ?? ""
    };
    return;
  }

  node.children.forEach(registerFallbackFiles);
}

function renderProjectTree(): void {
  projectTreeRoot.replaceChildren();

  if (!activeProject) return;

  const rootRow = document.createElement("div");
  rootRow.className = "project-row";

  const rootButton = document.createElement("button");
  const isRootExpanded = expandedFolders.has(activeProject.path);
  rootButton.className = "tree-item folder-row project-main";
  rootButton.type = "button";
  rootButton.dataset.folderPath = activeProject.path;
  rootButton.style.setProperty("--tree-depth", "0");
  rootButton.setAttribute("aria-expanded", String(isRootExpanded));
  rootButton.append(icon(isRootExpanded ? "chevron-down" : "chevron-right", "ui-icon tree-chevron"));
  rootButton.append(icon("folder", "ui-icon tree-icon"));

  const rootLabel = document.createElement("span");
  rootLabel.textContent = activeProject.name;
  rootButton.append(rootLabel);
  rootRow.append(rootButton);
  projectTreeRoot.append(rootRow);

  const children = renderTreeChildren(activeProject.children, 1);
  children.hidden = !expandedFolders.has(activeProject.path);
  projectTreeRoot.append(children);
}

function renderTreeChildren(nodes: ProjectNode[], depth: number): HTMLDivElement {
  const list = document.createElement("div");
  list.className = "file-list tree-children";

  nodes.forEach((node) => {
    if (node.type === "directory") {
      const isExpanded = expandedFolders.has(node.path);
      const row = document.createElement("button");
      row.className = "tree-item folder-row";
      row.type = "button";
      row.dataset.folderPath = node.path;
      row.style.setProperty("--tree-depth", String(depth));
      row.setAttribute("aria-expanded", String(isExpanded));
      row.append(icon(isExpanded ? "chevron-down" : "chevron-right", "ui-icon tree-chevron"));
      row.append(icon("folder", "ui-icon tree-icon"));

      const label = document.createElement("span");
      label.textContent = node.name;
      row.append(label);
      list.append(row);

      const childList = renderTreeChildren(node.children, depth + 1);
      childList.hidden = !isExpanded;
      list.append(childList);
      return;
    }

    const row = document.createElement("button");
    row.className = "tree-item file-row";
    row.type = "button";
    row.dataset.filePath = node.path;
    row.style.setProperty("--tree-depth", String(depth));

    const spacer = document.createElement("span");
    spacer.className = "tree-chevron tree-chevron-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.append(spacer);
    row.append(icon("file", "ui-icon tree-icon"));

    const title = document.createElement("span");
    title.className = "file-title";
    title.textContent = node.name;
    row.append(title);

    if (node.status) {
      const meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent = node.status;
      row.append(meta);
    }

    list.append(row);
  });

  return list;
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
      background: "#fff7f0",
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

function setActiveTerminal(terminalId: string | undefined): void {
  if (!terminalId) return;
  const terminal = terminals[terminalId];
  if (!terminal) return;

  saveActiveFile();
  ensureOpenTab("terminal", terminalId);
  activeFileId = undefined;
  activeTerminalId = terminalId;

  showViewer("terminal");
  renderTerminalView();
  renderOpenTabs();
  renderSidebarStates();
  renderTerminals();

  requestAnimationFrame(() => {
    terminalScreen.focus();
  });
}

async function createTerminalSession(): Promise<void> {
  let terminal: TerminalSession;
  let startupOutput = "";
  let terminalExited = false;

  if (window.newideTerminal?.create) {
    try {
      terminal = await window.newideTerminal.create({ cwd: activeProject?.path });
    } catch (error: unknown) {
      const id = `terminal-${Date.now()}`;
      terminal = {
        id,
        name: "terminal",
        cwd: "unavailable"
      };
      startupOutput = `terminal failed to start: ${getErrorMessage(error)}\r\n`;
      terminalExited = true;
    }
  } else {
    const id = `terminal-${Date.now()}`;
    terminal = {
      id,
      name: "terminal",
      cwd: "preview"
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

function setActiveFile(fileId: string, { force = false }: { force?: boolean } = {}): void {
  const file = files[fileId];
  if (!file) return;
  ensureOpenTab("file", fileId);

  if (fileId === activeFileId && !force) {
    renderOpenTabs();
    renderSidebarStates();
    return;
  }

  saveActiveFile();
  activeFileId = fileId;
  activeTerminalId = undefined;

  isLoadingFile = true;
  showViewer("text");
  getViewer(file).render(file);
  renderOpenTabs();
  renderSidebarStates();
  renderTerminals();
  requestAnimationFrame(() => {
    isLoadingFile = false;
  });
}

async function openProjectFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;

  if (!files[filePath]) {
    if (!window.newideProject?.readFile) return;

    try {
      const projectFile = await window.newideProject.readFile(filePath);
      files[filePath] = {
        name: projectFile.name,
        path: projectFile.path,
        viewer: "text",
        status: projectFile.readonly ? "preview" : "",
        content: projectFile.content,
        readonly: projectFile.readonly
      };
    } catch (error: unknown) {
      files[filePath] = {
        name: filePath.split(/[\\/]/).at(-1) || "File",
        path: filePath,
        viewer: "text",
        status: "Error",
        content: `Could not open this file.\n\n${getErrorMessage(error)}`,
        readonly: true
      };
    }
  }

  expandParentsForPath(filePath);
  renderProjectTree();
  setActiveFile(filePath);
}

function closeFileTab(fileId: string): void {
  const wasActive = fileId === activeFileId;
  const tabIndex = openTabs.findIndex(
    (tab) => tab.type === "file" && tab.id === fileId
  );

  if (wasActive) {
    saveActiveFile();
  }

  openTabs = openTabs.filter((tab) => !(tab.type === "file" && tab.id === fileId));

  if (wasActive) {
    activeFileId = undefined;
    activateOpenTab(openTabs[Math.min(tabIndex, openTabs.length - 1)]);
    return;
  }

  renderOpenTabs();
  renderSidebarStates();
}

function closeTerminalTab(terminalId: string | undefined): void {
  if (!terminalId) return;
  const wasActive = terminalId === activeTerminalId;
  const tabIndex = openTabs.findIndex(
    (tab) => tab.type === "terminal" && tab.id === terminalId
  );

  openTabs = openTabs.filter(
    (tab) => !(tab.type === "terminal" && tab.id === terminalId)
  );

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

async function loadProject(
  project: ProjectDirectoryNode | null | undefined,
  { openPreferred = false }: { openPreferred?: boolean } = {}
): Promise<void> {
  if (!project) return;

  saveActiveFile();
  activeProject = project;
  files = {};
  Object.keys(terminals).forEach((terminalId) => {
    void window.newideTerminal?.dispose(terminalId);
    disposeTerminalFrontend(terminals[terminalId]);
  });
  terminals = {};
  openTabs = [];
  activeFileId = undefined;
  activeTerminalId = undefined;
  editingTerminalId = undefined;
  editingTerminalRenameTarget = undefined;
  expandedFolders = new Set([project.path]);

  if (project.path.startsWith("demo:")) {
    registerFallbackFiles(project);
  }

  renderProjectTree();
  renderOpenTabs();
  renderTerminals();
  viewers.text.clear();
  showHome();

  if (openPreferred) {
    const preferred = findPreferredFile(project);
    if (preferred) await openProjectFile(preferred.path);
  }
}

async function openProjectPicker(): Promise<void> {
  if (!window.newideProject?.openFolder || isProjectPickerOpen) return;

  isProjectPickerOpen = true;
  setOpenProjectSelected(true);

  try {
    const project = await window.newideProject.openFolder();
    if (project) await loadProject(project);
  } finally {
    isProjectPickerOpen = false;
    setOpenProjectSelected(false);
  }
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

openProjectButtons.forEach((button) => {
  button.addEventListener("click", () => {
    void openProjectPicker();
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

const terminalAddButton = document.querySelector<HTMLElement>(".terminal-add");

function requestTerminalCreation(): void {
  if (!terminalCreationReady) return;
  void createTerminalSession();
}

terminalAddButton?.addEventListener("click", (event) => {
  event.preventDefault();
  requestTerminalCreation();
});

terminalAddButton?.addEventListener("keydown", (event) => {
  const isActivationKey = event.key === "Enter" || event.key === " ";
  if (!isActivationKey) return;
  event.preventDefault();
  requestTerminalCreation();
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

projectTreeRoot.addEventListener("click", (event) => {
  const fileButton = closestElement<HTMLElement>(event.target, "[data-file-path]");
  if (fileButton) {
    void openProjectFile(fileButton.dataset.filePath);
    return;
  }

  const folderButton = closestElement<HTMLElement>(event.target, "[data-folder-path]");
  if (folderButton?.dataset.folderPath) {
    toggleFolder(folderButton.dataset.folderPath);
  }
});

terminalScreen.addEventListener("click", () => {
  if (activeTerminalId) terminals[activeTerminalId]?.xterm.focus();
});

window.addEventListener("resize", () => {
  fitTerminal(activeTerminalId ? terminals[activeTerminalId] : undefined);
});

if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    fitTerminal(activeTerminalId ? terminals[activeTerminalId] : undefined);
  }).observe(terminalScreen);
}

editor.addEventListener("input", () => {
  if (isLoadingFile || !activeFileId) return;
  saveActiveFile();
  files[activeFileId].status = "Unsaved changes";
  updateLineNumbers();
});

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

function applyWindowState({ expanded }: WindowState): void {
  document.body.classList.toggle("window-expanded", expanded);
}

void window.newideWindow?.getState().then(applyWindowState);
window.newideWindow?.onStateChange(applyWindowState);
window.newideWindow?.onToggleSidebar(toggleSidebar);
window.newideProject?.onFolderPickerClosed(() => {
  setOpenProjectSelected(false);
});

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

async function initializeEditor(): Promise<void> {
  if (window.newideProject?.getDefault) {
    try {
      await loadProject(await window.newideProject.getDefault());
      return;
    } catch {
      await loadProject(fallbackProject);
      return;
    }
  }

  await loadProject(fallbackProject);
}

async function initializeApp(): Promise<void> {
  await initializeEditor();
  scheduleUpdateChecks();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeApp();
  }, { once: true });
} else {
  void initializeApp();
}
