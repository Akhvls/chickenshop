const iconBase = "./assets/icons";
const fileTypeIconBase = "./assets/file-types";

const fileTypeIcons = {
  md: "md",
  markdown: "md",
  txt: "txt",
  text: "txt"
};

const fallbackProject = {
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
src/renderer/index.html

This surface should behave like a quiet text editor: open a file, read it, edit it, and keep the surrounding chrome out of the way.`
    },
    {
      type: "file",
      name: "scratch.txt",
      path: "demo:/newide/scratch.txt",
      status: "Now",
      content: `Scratch

- Keep the app text-first.
- Sidebar: New file, Search, Projects.
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
4. Search across notes
5. Optional agent actions once the editor foundation feels right`
    }
  ]
};

let activeProject;
let files = {};
let terminals = {};
let activeFileId;
let activeTerminalId;
let openTabs = [];
let expandedFolders = new Set();
let isLoadingFile = false;
let editingTerminalId;
let editingTerminalRenameTarget;
let lastTerminalRowClickId;
let lastTerminalRowClickAt = 0;

const tabsRoot = document.querySelector("[data-open-tabs]");
const homePane = document.querySelector("[data-home-pane]");
const textEditor = document.querySelector("[data-text-editor]");
const editor = document.querySelector("[data-editor]");
const terminalListRoot = document.querySelector("[data-terminal-list]");
const terminalScreen = document.querySelector("[data-terminal-screen]");
const projectTreeRoot = document.querySelector("[data-project-tree]");
const viewerPanels = document.querySelectorAll("[data-viewer-panel]");
const XtermTerminal = window.Terminal;
const XtermFitAddon = window.FitAddon?.FitAddon;

let terminalCreationReady = false;
const pendingTerminalData = {};

setTimeout(() => {
  terminalCreationReady = true;
}, 600);

const windowControls = {
  minimize: () => window.newideWindow?.minimize(),
  maximize: () => window.newideWindow?.toggleMaximize(),
  close: () => window.newideWindow?.close()
};

const viewers = {
  text: {
    read(file) {
      if (!file || file.readonly) return;
      file.content = editor.textContent;
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

function getViewer(file) {
  return viewers[file?.viewer] ?? viewers.text;
}

function icon(name, className = "ui-icon") {
  const image = document.createElement("img");
  image.className = className;
  image.src = `${iconBase}/${name}.png`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function getFileExtension(fileName = "") {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension === fileName ? "" : extension;
}

function getFileTypeIconName(fileName) {
  return fileTypeIcons[getFileExtension(fileName)];
}

function fileTypeIcon(fileName, className = "tab-file-icon") {
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

function svgIcon(className, paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("ui-icon", className);
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");

  paths.forEach((pathData) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  });

  return svg;
}

function terminalIcon(className = "terminal-icon") {
  return svgIcon(className, [
    "M3.25 4.25h11.5a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H3.25a2 2 0 0 1-2-2v-5.5a2 2 0 0 1 2-2Z",
    "m4.75 7.15 1.85 1.6-1.85 1.6",
    "M8 10.45h3.25"
  ]);
}

function showViewer(viewerType) {
  homePane?.classList.remove("active");
  viewerPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewerPanel === viewerType);
  });
}

function showHome() {
  viewerPanels.forEach((panel) => {
    panel.classList.remove("active");
  });
  homePane?.classList.add("active");
}

function saveActiveFile() {
  if (!activeFileId) return;
  const file = files[activeFileId];
  getViewer(file).read(file);
}

function updateLineNumbers() {
  const lineCount = Math.max(editor.textContent.split("\n").length, 1);
  textEditor
    .querySelectorAll("[data-line-number]")
    .forEach((lineNumber) => lineNumber.remove());

  const lineFragment = document.createDocumentFragment();
  Array.from({ length: lineCount }, (_item, index) => {
    const lineNumber = document.createElement("span");
    lineNumber.className = "editor-line-number";
    lineNumber.dataset.lineNumber = "";
    lineNumber.setAttribute("aria-hidden", "true");
    lineNumber.style.setProperty("--line-index", index);
    lineNumber.textContent = String(index + 1);
    lineFragment.append(lineNumber);
  });

  textEditor.insertBefore(lineFragment, editor);
}

function getTabKey(type, id) {
  return `${type}:${id}`;
}

function getActiveTabKey() {
  if (activeTerminalId) return getTabKey("terminal", activeTerminalId);
  if (activeFileId) return getTabKey("file", activeFileId);
  return undefined;
}

function ensureOpenTab(type, id) {
  const key = getTabKey(type, id);
  if (openTabs.some((tab) => getTabKey(tab.type, tab.id) === key)) return;
  openTabs.push({ type, id });
}

function getTabDetails(tab) {
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
    closeLabel: `Close ${terminal.name}`
  };
}

function renderTerminalRenameInput(terminal, target, className) {
  const input = document.createElement("input");
  input.className = className;
  input.value = terminal.name;
  input.dataset.terminalRename = `${target}:${terminal.id}`;
  input.setAttribute("aria-label", "Terminal name");
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

function focusTerminalRenameInput(terminalId, target) {
  const renameKey = `${target}:${terminalId}`;
  const input = [...document.querySelectorAll("[data-terminal-rename]")].find(
    (candidate) => candidate.dataset.terminalRename === renameKey
  );

  if (!input) return;
  input.focus();
  input.select();
}

function beginTerminalRename(terminalId, target) {
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

function commitTerminalRename(terminalId, name) {
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

function cancelTerminalRename() {
  editingTerminalId = undefined;
  editingTerminalRenameTarget = undefined;
  renderOpenTabs();
  renderTerminals();
}

function activateOpenTab(tab) {
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

function renderOpenTabs() {
  const activeKey = getActiveTabKey();

  tabsRoot.replaceChildren(
    ...openTabs.flatMap((openTab) => {
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

function renderSidebarStates() {
  document.querySelectorAll("[data-file-path]").forEach((button) => {
    const isActive = button.dataset.filePath === activeFileId;
    button.classList.toggle("selected", isActive);
    button.classList.toggle("is-active", isActive);
  });
}

function renderTerminals() {
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
      close.setAttribute("aria-label", `Close ${terminal.name}`);
      close.append(icon("close", "ui-icon terminal-row-close-icon"));
      row.append(close);

      return row;
    })
  );
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    button.setAttribute("aria-expanded", String(!collapsed));
  });
}

function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
}

function toggleFolder(folderPath) {
  if (expandedFolders.has(folderPath)) {
    expandedFolders.delete(folderPath);
  } else {
    expandedFolders.add(folderPath);
  }
  renderProjectTree();
}

function isTextCandidate(fileName) {
  return /\.(css|html|js|json|md|mjs|cjs|txt|ts|tsx|jsx|yml|yaml)$/i.test(fileName);
}

function findNode(node, predicate) {
  if (!node) return undefined;
  if (predicate(node)) return node;

  for (const child of node.children ?? []) {
    const match = findNode(child, predicate);
    if (match) return match;
  }

  return undefined;
}

function findPreferredFile(project) {
  return (
    findNode(
      project,
      (node) => node.type === "file" && node.path.endsWith("src/renderer/index.html")
    ) ??
    findNode(project, (node) => node.type === "file" && isTextCandidate(node.name))
  );
}

function expandParentsForPath(targetPath, node = activeProject, parents = []) {
  if (!node) return false;
  if (node.path === targetPath) {
    parents.forEach((folderPath) => expandedFolders.add(folderPath));
    return true;
  }

  for (const child of node.children ?? []) {
    if (expandParentsForPath(targetPath, child, [...parents, node.path])) {
      return true;
    }
  }

  return false;
}

function registerFallbackFiles(node) {
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

  node.children?.forEach(registerFallbackFiles);
}

function renderProjectTree() {
  projectTreeRoot.replaceChildren();

  if (!activeProject) return;

  const rootRow = document.createElement("div");
  rootRow.className = "project-row";

  const rootButton = document.createElement("button");
  const isRootExpanded = expandedFolders.has(activeProject.path);
  rootButton.className = "tree-item folder-row project-main";
  rootButton.type = "button";
  rootButton.dataset.folderPath = activeProject.path;
  rootButton.style.setProperty("--tree-depth", 0);
  rootButton.setAttribute("aria-expanded", String(isRootExpanded));
  rootButton.append(icon(isRootExpanded ? "chevron-down" : "chevron-right", "ui-icon tree-chevron"));
  rootButton.append(icon("folder", "ui-icon tree-icon"));

  const rootLabel = document.createElement("span");
  rootLabel.textContent = activeProject.name;
  rootButton.append(rootLabel);
  rootRow.append(rootButton);
  projectTreeRoot.append(rootRow);

  const children = renderTreeChildren(activeProject.children ?? [], 1);
  children.hidden = !expandedFolders.has(activeProject.path);
  projectTreeRoot.append(children);
}

function renderTreeChildren(nodes, depth) {
  const list = document.createElement("div");
  list.className = "file-list tree-children";

  nodes.forEach((node) => {
    if (node.type === "directory") {
      const isExpanded = expandedFolders.has(node.path);
      const row = document.createElement("button");
      row.className = "tree-item folder-row";
      row.type = "button";
      row.dataset.folderPath = node.path;
      row.style.setProperty("--tree-depth", depth);
      row.setAttribute("aria-expanded", String(isExpanded));
      row.append(icon(isExpanded ? "chevron-down" : "chevron-right", "ui-icon tree-chevron"));
      row.append(icon("folder", "ui-icon tree-icon"));

      const label = document.createElement("span");
      label.textContent = node.name;
      row.append(label);
      list.append(row);

      const childList = renderTreeChildren(node.children ?? [], depth + 1);
      childList.hidden = !isExpanded;
      list.append(childList);
      return;
    }

    const row = document.createElement("button");
    row.className = "tree-item file-row";
    row.type = "button";
    row.dataset.filePath = node.path;
    row.style.setProperty("--tree-depth", depth);

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

function appendTerminalOutput(terminalId, text) {
  const terminal = terminals[terminalId];
  if (!terminal) {
    pendingTerminalData[terminalId] = `${pendingTerminalData[terminalId] ?? ""}${text}`;
    return;
  }

  terminal.xterm.write(text);
}

function disposeTerminalFrontend(terminal) {
  terminal?.disposables?.forEach((disposable) => disposable.dispose());
  terminal?.xterm?.dispose();
}

function createTerminalFrontend(terminalId) {
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
        xterm.write(`\r\nCould not write to terminal: ${error.message}\r\n`);
      });
    }),
    xterm.onResize(({ cols, rows }) => {
      window.newideTerminal?.resize?.(terminalId, cols, rows);
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

function fitTerminal(terminal) {
  if (!terminal?.opened) return;

  terminal.fitAddon.fit();

  if (terminal.xterm.cols !== terminal.lastCols || terminal.xterm.rows !== terminal.lastRows) {
    terminal.lastCols = terminal.xterm.cols;
    terminal.lastRows = terminal.xterm.rows;
    window.newideTerminal?.resize?.(terminal.id, terminal.xterm.cols, terminal.xterm.rows);
  }
}

function renderTerminalView() {
  const terminal = terminals[activeTerminalId];
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

function setActiveTerminal(terminalId) {
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

async function createTerminalSession() {
  let terminal;
  let startupOutput = "";
  let terminalExited = false;

  if (window.newideTerminal?.create) {
    try {
      terminal = await window.newideTerminal.create();
    } catch (error) {
      const id = `terminal-${Date.now()}`;
      terminal = {
        id,
        name: "terminal",
        cwd: "Unavailable",
      };
      startupOutput = `Terminal failed to start: ${error.message}\r\n`;
      terminalExited = true;
    }
  } else {
    const id = `terminal-${Date.now()}`;
    terminal = {
      id,
      name: "terminal",
      cwd: "Preview",
    };
    startupOutput = "Terminal execution is only available in the Electron desktop app.\r\n";
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

function setActiveFile(fileId, { force = false } = {}) {
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

async function openProjectFile(filePath) {
  if (!filePath) return;

  if (!files[filePath]) {
    if (!window.newideProject?.readFile) return;

    try {
      const projectFile = await window.newideProject.readFile(filePath);
      files[filePath] = {
        name: projectFile.name,
        path: projectFile.path,
        viewer: "text",
        status: projectFile.readonly ? "Preview" : "",
        content: projectFile.content,
        readonly: projectFile.readonly
      };
    } catch (error) {
      files[filePath] = {
        name: filePath.split(/[\\/]/).at(-1) || "File",
        path: filePath,
        viewer: "text",
        status: "Error",
        content: `Could not open this file.\n\n${error.message}`,
        readonly: true
      };
    }
  }

  expandParentsForPath(filePath);
  renderProjectTree();
  setActiveFile(filePath);
}

function closeFileTab(fileId) {
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

function closeTerminalTab(terminalId) {
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

  window.newideTerminal?.dispose?.(terminalId);
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

async function loadProject(project, { openPreferred = false } = {}) {
  if (!project) return;

  saveActiveFile();
  activeProject = project;
  files = {};
  Object.keys(terminals).forEach((terminalId) => {
    window.newideTerminal?.dispose?.(terminalId);
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

async function openProjectPicker() {
  if (!window.newideProject?.openFolder) return;
  const project = await window.newideProject.openFolder();
  if (project) await loadProject(project);
}

document.querySelectorAll("[data-window-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.getAttribute("data-window-action");
    windowControls[action]?.();
  });
});

document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
  button.addEventListener("click", toggleSidebar);
});

document.querySelector("[data-open-project]")?.addEventListener("click", openProjectPicker);

const terminalAddButton = document.querySelector(".terminal-add");

function requestTerminalCreation() {
  if (!terminalCreationReady) return;
  createTerminalSession();
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
  const closeButton = event.target.closest("[data-terminal-close]");
  if (closeButton) {
    event.preventDefault();
    lastTerminalRowClickId = undefined;
    lastTerminalRowClickAt = 0;
    closeTerminalTab(closeButton.dataset.terminalClose);
    return;
  }

  if (event.target.closest("[data-terminal-rename]")) return;

  const terminalButton = event.target.closest("[data-terminal-id]");
  if (!terminalButton) return;

  const terminalId = terminalButton.dataset.terminalId;
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
    event.target.closest("[data-terminal-close]") ||
    event.target.closest("[data-terminal-rename]")
  ) {
    return;
  }

  const terminalButton = event.target.closest("[data-terminal-id]");
  if (!terminalButton) return;

  const isActivationKey = event.key === "Enter" || event.key === " ";
  if (!isActivationKey) return;

  event.preventDefault();
  setActiveTerminal(terminalButton.dataset.terminalId);
});

projectTreeRoot.addEventListener("click", (event) => {
  const fileButton = event.target.closest("[data-file-path]");
  if (fileButton) {
    openProjectFile(fileButton.dataset.filePath);
    return;
  }

  const folderButton = event.target.closest("[data-folder-path]");
  if (folderButton) {
    toggleFolder(folderButton.dataset.folderPath);
  }
});

terminalScreen.addEventListener("click", () => {
  terminals[activeTerminalId]?.xterm.focus();
});

window.addEventListener("resize", () => {
  fitTerminal(terminals[activeTerminalId]);
});

if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    fitTerminal(terminals[activeTerminalId]);
  }).observe(terminalScreen);
}

document.querySelectorAll(".primary-nav .nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".primary-nav .nav-item")
      .forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

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

function applyWindowState({ expanded }) {
  document.body.classList.toggle("window-expanded", expanded);
}

window.newideWindow?.getState?.().then(applyWindowState);
window.newideWindow?.onStateChange(applyWindowState);
window.newideWindow?.onToggleSidebar?.(toggleSidebar);

window.newideTerminal?.onData?.(({ id, data }) => {
  appendTerminalOutput(id, data);
});

window.newideTerminal?.onExit?.(({ id, code }) => {
  const terminal = terminals[id];
  if (!terminal) return;

  terminal.exited = true;
  appendTerminalOutput(id, `\r\n[terminal exited${typeof code === "number" ? ` with code ${code}` : ""}]\r\n`);
  renderTerminals();
});

async function initializeEditor() {
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeEditor, { once: true });
} else {
  initializeEditor();
}
