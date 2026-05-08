import { app, BrowserWindow, dialog, ipcMain, shell as electronShell } from "electron";
import { mkdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IPty } from "node-pty";
import type {
  ProjectDirectoryNode,
  ProjectFileContents,
  ProjectNode,
  TerminalDataPayload,
  TerminalExitPayload,
  TerminalKind,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSize,
  TerminalStatePayload,
  TerminalWriteRequest,
  UpdateCheckResult,
  UpdateFeedInfo
} from "./shared";

interface ScanCounter {
  count: number;
}

interface ScanOptions {
  depth?: number;
  counter: ScanCounter;
}

interface BackendTerminal {
  cwd: string;
  id: string;
  inputBuffer: string;
  kind: TerminalKind;
  outputBuffer: string;
  process: IPty;
  rootCwd: string;
}

interface ShellLaunchConfig {
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface PackageUpdateConfig {
  chickenshop?: {
    updateFeedUrl?: string;
  };
}

let mainWindow: BrowserWindow | undefined;
let terminalCounter = 0;
let pty: typeof import("node-pty") | undefined;
let ptyLoadError: Error | undefined;
let cachedUpdateFeedUrl: string | undefined;

try {
  pty = require("node-pty") as typeof import("node-pty");
} catch (error: unknown) {
  ptyLoadError = error instanceof Error ? error : new Error(String(error));
}

const terminalProcesses = new Map<string, BackendTerminal>();

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

const ignoredFiles = new Set([".DS_Store"]);

function shouldIgnoreEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return ignoredDirectories.has(name);
  return ignoredFiles.has(name);
}

async function scanDirectory(
  directoryPath: string,
  { depth = 0, counter }: ScanOptions
): Promise<ProjectNode[]> {
  if (depth > 10 || counter.count > 1200) return [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  entries = entries
    .filter((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

  const children: ProjectNode[] = [];

  for (const entry of entries) {
    if (counter.count > 1200) break;
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      counter.count += 1;
      children.push({
        type: "directory",
        name: entry.name,
        path: entryPath,
        children: await scanDirectory(entryPath, {
          depth: depth + 1,
          counter
        })
      });
      continue;
    }

    if (entry.isFile()) {
      counter.count += 1;
      children.push({
        type: "file",
        name: entry.name,
        path: entryPath
      });
    }
  }

  return children;
}

async function buildProject(directoryPath: string): Promise<ProjectDirectoryNode> {
  const rootPath = path.resolve(directoryPath);
  return {
    type: "directory",
    name: path.basename(rootPath) || rootPath,
    path: rootPath,
    children: await scanDirectory(rootPath, {
      counter: { count: 0 }
    })
  };
}

async function readProjectFile(filePath: string): Promise<ProjectFileContents> {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);

  if (!stat.isFile()) {
    throw new Error("Selected path is not a file.");
  }

  if (stat.size > 2 * 1024 * 1024) {
    return {
      name: path.basename(resolvedPath),
      path: resolvedPath,
      content: "This file is larger than 2 MB, so it was not loaded into the preview editor.",
      readonly: true
    };
  }

  const buffer = await fs.readFile(resolvedPath);
  const hasBinaryByte = buffer.subarray(0, 4096).includes(0);

  return {
    name: path.basename(resolvedPath),
    path: resolvedPath,
    content: hasBinaryByte
      ? "Binary file preview is not supported yet."
      : buffer.toString("utf8"),
    readonly: hasBinaryByte
  };
}

function hasAsarPathSegment(filePath: string): boolean {
  return path
    .normalize(filePath)
    .split(path.sep)
    .some((segment) => segment.endsWith(".asar"));
}

function isTerminalSafeDirectory(directoryPath: string): boolean {
  if (hasAsarPathSegment(directoryPath)) return false;

  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function getPackagedProjectPath(): string {
  for (const candidate of [app.getPath("desktop"), app.getPath("documents"), app.getPath("home")]) {
    if (isTerminalSafeDirectory(candidate)) return candidate;
  }

  return app.getPath("home");
}

function getDefaultProjectPath(): string {
  if (app.isPackaged) return getPackagedProjectPath();

  const developmentProjectPath = path.resolve(__dirname, "..");
  return isTerminalSafeDirectory(developmentProjectPath)
    ? developmentProjectPath
    : getPackagedProjectPath();
}

function getTerminalWorkingDirectory(candidatePath?: string): string {
  const fallbackPaths = [candidatePath, getDefaultProjectPath(), getPackagedProjectPath()];

  for (const candidate of fallbackPaths) {
    if (!candidate) continue;

    const resolvedPath = path.resolve(candidate);
    if (isTerminalSafeDirectory(resolvedPath)) {
      return resolvedPath;
    }
  }

  return path.parse(app.getPath("home")).root;
}

function getIsoTimestamp(): string {
  return new Date().toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < maxLength; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

function normalizeUpdateFeed(value: unknown): UpdateFeedInfo | undefined {
  if (!value || typeof value !== "object") return undefined;

  const feed = value as Record<string, unknown>;
  const version = typeof feed.version === "string" ? feed.version.trim() : "";
  const downloadUrl =
    typeof feed.downloadUrl === "string" ? feed.downloadUrl.trim() : "";

  if (!version || !isHttpUrl(downloadUrl)) return undefined;

  return {
    version,
    downloadUrl,
    notes: typeof feed.notes === "string" ? feed.notes.trim() : undefined,
    releasedAt:
      typeof feed.releasedAt === "string" ? feed.releasedAt.trim() : undefined
  };
}

async function getUpdateFeedUrl(): Promise<string> {
  const envUrl = process.env.CHICKENSHOP_UPDATE_FEED_URL?.trim();
  if (envUrl) return envUrl;

  if (cachedUpdateFeedUrl !== undefined) return cachedUpdateFeedUrl;

  try {
    const packageJsonPath = path.join(app.getAppPath(), "package.json");
    const packageConfig = JSON.parse(
      await fs.readFile(packageJsonPath, "utf8")
    ) as PackageUpdateConfig;
    cachedUpdateFeedUrl = packageConfig.chickenshop?.updateFeedUrl?.trim() ?? "";
  } catch {
    cachedUpdateFeedUrl = "";
  }

  return cachedUpdateFeedUrl;
}

async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const checkedAt = getIsoTimestamp();
  const feedUrl = await getUpdateFeedUrl();

  if (!feedUrl) {
    return {
      status: "disabled",
      currentVersion,
      checkedAt,
      message: "No update feed URL is configured."
    };
  }

  if (!isHttpUrl(feedUrl)) {
    return {
      status: "error",
      currentVersion,
      checkedAt,
      feedUrl,
      message: "The configured update feed URL must start with http:// or https://."
    };
  }

  try {
    const response = await fetch(feedUrl, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache"
      }
    });

    if (!response.ok) {
      throw new Error(`Update feed returned HTTP ${response.status}.`);
    }

    const latest = normalizeUpdateFeed(await response.json());
    if (!latest) {
      throw new Error("Update feed JSON is missing a valid version or downloadUrl.");
    }

    return {
      status: compareVersions(latest.version, currentVersion) > 0
        ? "available"
        : "current",
      currentVersion,
      checkedAt,
      feedUrl,
      latest
    };
  } catch (error: unknown) {
    return {
      status: "error",
      currentVersion,
      checkedAt,
      feedUrl,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function sendTerminalPayload(
  channel: "terminal:data" | "terminal:exit" | "terminal:state",
  payload: TerminalDataPayload | TerminalExitPayload | TerminalStatePayload
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function emitTerminalState(terminal: BackendTerminal): void {
  sendTerminalPayload("terminal:state", {
    id: terminal.id,
    cwd: terminal.cwd,
    kind: terminal.kind
  });
}

function updateTerminalState(
  terminal: BackendTerminal,
  nextState: Partial<Pick<BackendTerminal, "cwd" | "kind">>
): void {
  const nextCwd = nextState.cwd ?? terminal.cwd;
  const nextKind = nextState.kind ?? terminal.kind;

  if (nextCwd === terminal.cwd && nextKind === terminal.kind) return;

  terminal.cwd = nextCwd;
  terminal.kind = nextKind;
  emitTerminalState(terminal);
}

function getShellIntegrationRoot(): string {
  const root = path.join(app.getPath("userData"), "shell-integration");
  mkdirSync(root, { recursive: true });
  return root;
}

function ensureZshIntegrationDirectory(): string {
  const directory = path.join(getShellIntegrationRoot(), "zsh");
  mkdirSync(directory, { recursive: true });

  writeFileSync(
    path.join(directory, ".zshrc"),
    String.raw`if [[ -z "$CHICKENSHOP_SHELL_INTEGRATION_SOURCED" ]]; then
  export CHICKENSHOP_SHELL_INTEGRATION_SOURCED=1
  if [[ -n "$CHICKENSHOP_ORIGINAL_ZDOTDIR" && -r "$CHICKENSHOP_ORIGINAL_ZDOTDIR/.zshrc" ]]; then
    source "$CHICKENSHOP_ORIGINAL_ZDOTDIR/.zshrc"
  elif [[ -r "$HOME/.zshrc" ]]; then
    source "$HOME/.zshrc"
  fi
fi

_chickenshop_report_cwd() {
  printf '\033]633;P;Cwd=%s\a' "$PWD"
}

_chickenshop_report_command() {
  printf '\033]633;E;Command=%s\a' "$1"
}

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook chpwd _chickenshop_report_cwd
  add-zsh-hook precmd _chickenshop_report_cwd
  add-zsh-hook preexec _chickenshop_report_command
else
  chpwd_functions+=(_chickenshop_report_cwd)
  precmd_functions+=(_chickenshop_report_cwd)
  preexec_functions+=(_chickenshop_report_command)
fi

_chickenshop_report_cwd
`,
    "utf8"
  );

  return directory;
}

function ensureBashIntegrationFile(): string {
  const directory = path.join(getShellIntegrationRoot(), "bash");
  mkdirSync(directory, { recursive: true });
  const rcfile = path.join(directory, "bashrc");

  writeFileSync(
    rcfile,
    String.raw`if [[ -z "$CHICKENSHOP_SHELL_INTEGRATION_SOURCED" ]]; then
  export CHICKENSHOP_SHELL_INTEGRATION_SOURCED=1
  if [[ -r "$HOME/.bashrc" ]]; then
    source "$HOME/.bashrc"
  fi
fi

_chickenshop_report_cwd() {
  printf '\033]633;P;Cwd=%s\a' "$PWD"
}

case ";$PROMPT_COMMAND;" in
  *";_chickenshop_report_cwd;"*) ;;
  *) PROMPT_COMMAND="_chickenshop_report_cwd${"$"}{PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac

_chickenshop_report_cwd
`,
    "utf8"
  );

  return rcfile;
}

function getShellLaunchConfig(shellPath: string): ShellLaunchConfig {
  const shellName = path.basename(shellPath);

  if (shellName === "zsh") {
    return {
      args: [],
      env: {
        ...process.env,
        CHICKENSHOP_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR || app.getPath("home"),
        ZDOTDIR: ensureZshIntegrationDirectory()
      }
    };
  }

  if (shellName === "bash") {
    return {
      args: ["--rcfile", ensureBashIntegrationFile()],
      env: { ...process.env }
    };
  }

  return {
    args: [],
    env: { ...process.env }
  };
}

function isCodexCommand(command: string): boolean {
  const normalizedCommand = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, "")
    .replace(/^(?:command|exec|env|sudo)\s+/, "");

  return /^(?:npx\s+)?(?:[^\s/]+\/)*codex(?:\s|$)/.test(normalizedCommand);
}

function observeTerminalCommand(terminal: BackendTerminal, command: string): void {
  if (isCodexCommand(command)) {
    updateTerminalState(terminal, { kind: "codex" });
  }

  const cwd = resolveCdCommand(terminal.cwd, command);
  if (cwd) updateTerminalState(terminal, { cwd });
}

function observeTerminalInput(terminal: BackendTerminal, data: string): void {
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      observeTerminalCommand(terminal, terminal.inputBuffer);
      terminal.inputBuffer = "";
      continue;
    }

    if (character === "\u0003") {
      terminal.inputBuffer = "";
      continue;
    }

    if (character === "\u007f") {
      terminal.inputBuffer = terminal.inputBuffer.slice(0, -1);
      continue;
    }

    if (character >= " " && character !== "\u007f") {
      terminal.inputBuffer += character;
    }
  }
}

function expandHomePath(candidatePath: string): string {
  if (candidatePath === "~") return app.getPath("home");
  if (candidatePath.startsWith("~/")) return path.join(app.getPath("home"), candidatePath.slice(2));
  return candidatePath;
}

function normalizeReportedCwd(cwd: string): string | undefined {
  try {
    const decodedCwd = decodeURIComponent(expandHomePath(cwd.trim()));
    const resolvedCwd = path.resolve(decodedCwd);
    return isTerminalSafeDirectory(resolvedCwd) ? resolvedCwd : undefined;
  } catch {
    return undefined;
  }
}

function stripAnsiCodes(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[\(\)][A-Za-z0-9]/g, "")
    .replace(/\u001b[=>]/g, "");
}

function parseShellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (const character of command.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping || quote) return undefined;
  if (current) words.push(current);
  return words;
}

function resolveCdCommand(currentCwd: string, command: string): string | undefined {
  const trimmedCommand = command.trim();
  if (!trimmedCommand || /[;&|<>()`$]/.test(trimmedCommand)) return undefined;

  const words = parseShellWords(trimmedCommand);
  if (!words || words.length > 2 || words[0] !== "cd") return undefined;

  const targetPath = expandHomePath(words[1] ?? "~");
  if (targetPath === "-") return undefined;

  return normalizeReportedCwd(path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(currentCwd, targetPath));
}

function resolvePromptCwd(terminal: BackendTerminal, promptCwd: string): string | undefined {
  const fragment = promptCwd.trim();
  if (!fragment) return undefined;

  if (fragment.startsWith("/") || fragment === "~" || fragment.startsWith("~/")) {
    return normalizeReportedCwd(fragment);
  }

  if (fragment.includes("/")) {
    return normalizeReportedCwd(path.resolve(terminal.cwd, expandHomePath(fragment)))
      ?? normalizeReportedCwd(path.resolve(terminal.rootCwd, expandHomePath(fragment)));
  }

  const parentCwd = path.dirname(terminal.cwd);
  const candidates = [
    path.basename(terminal.cwd) === fragment ? terminal.cwd : undefined,
    path.basename(parentCwd) === fragment ? parentCwd : undefined,
    path.basename(terminal.rootCwd) === fragment ? terminal.rootCwd : undefined,
    path.join(terminal.cwd, fragment),
    path.join(parentCwd, fragment),
    path.join(terminal.rootCwd, fragment)
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const cwd = normalizeReportedCwd(candidate);
    if (cwd) return cwd;
  }

  return undefined;
}

function parseVisiblePromptCwd(terminal: BackendTerminal, line: string): string | undefined {
  const promptMatch = line.match(/^(?:\S+@\S+\s+)?(.+?)\s+[%$#]\s*$/);
  if (!promptMatch) return undefined;
  return resolvePromptCwd(terminal, promptMatch[1]);
}

function observeCodexWorkingDirectoryLine(terminal: BackendTerminal, rawLine: string): void {
  if (terminal.kind !== "codex") return;

  const normalizedLine = stripAnsiCodes(rawLine)
    .replace(/[│└╰├─•]/g, " ")
    .trim();

  const pathMatch = normalizedLine.match(/^((?:~(?:\/|$)|\/)[^<>:"|?*\r\n]*)$/);
  if (pathMatch) {
    const cwd = normalizeReportedCwd(pathMatch[1]);
    if (cwd) updateTerminalState(terminal, { cwd });
    return;
  }

  const directoryLabelMatch = normalizedLine.match(/\bdirectory:\s+((?:~(?:\/|$)|\/)[^│\r\n]+)$/);
  if (directoryLabelMatch) {
    const cwd = normalizeReportedCwd(directoryLabelMatch[1]);
    if (cwd) updateTerminalState(terminal, { cwd });
    return;
  }

  const promptCwd = parseVisiblePromptCwd(terminal, normalizedLine);
  if (promptCwd) updateTerminalState(terminal, { cwd: promptCwd });
}

function observeCodexWorkingDirectoryOutput(terminal: BackendTerminal, data: string): void {
  if (terminal.kind !== "codex") return;

  terminal.outputBuffer = `${terminal.outputBuffer}${data}`.slice(-4096);
  const lines = terminal.outputBuffer.split(/\r\n|\r|\n/);
  terminal.outputBuffer = lines.pop() ?? "";

  for (const line of lines) {
    observeCodexWorkingDirectoryLine(terminal, line);
  }

  observeCodexWorkingDirectoryLine(terminal, terminal.outputBuffer);
}

function processTerminalData(terminal: BackendTerminal, data: string): string {
  let cleanedData = data.replace(
    /\u001b\]633;([PE]);(?:Cwd|Command)=([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g,
    (_match, marker: string, value: string) => {
      if (marker === "P") {
        const cwd = normalizeReportedCwd(value);
        if (cwd) updateTerminalState(terminal, { cwd });
      } else {
        observeTerminalCommand(terminal, value);
      }

      return "";
    }
  );

  cleanedData = cleanedData.replace(
    /\u001b\]7;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g,
    (_match, value: string) => {
      try {
        const url = new URL(value);
        if (url.protocol === "file:") {
          const cwd = normalizeReportedCwd(url.pathname);
          if (cwd) updateTerminalState(terminal, { cwd });
        }
      } catch {
        // Ignore malformed shell integration output from user shells.
      }

      return "";
    }
  );

  observeCodexWorkingDirectoryOutput(terminal, cleanedData);

  return cleanedData;
}

function disposeTerminal(id: string): void {
  const terminal = terminalProcesses.get(id);
  if (!terminal) return;

  terminalProcesses.delete(id);

  try {
    terminal.process.kill();
  } catch {
    // The process may already be gone by the time the app is closing.
  }
}

function disposeAllTerminals(): void {
  for (const id of terminalProcesses.keys()) {
    disposeTerminal(id);
  }
}

function createTerminal({ cols = 120, rows = 30, cwd: requestedCwd }: TerminalSize = {}): TerminalSession {
  if (!pty) {
    throw new Error(
      `Real terminal backend failed to load.${ptyLoadError ? ` ${ptyLoadError.message}` : ""}`
    );
  }

  const cwd = getTerminalWorkingDirectory(requestedCwd);
  const id = `terminal-${++terminalCounter}`;
  const shell = process.env.SHELL || "/bin/zsh";
  const launchConfig = getShellLaunchConfig(shell);
  const terminalProcess = pty.spawn(shell, launchConfig.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...launchConfig.env,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "chickenshop"
    }
  });

  terminalProcesses.set(id, {
    cwd,
    id,
    inputBuffer: "",
    kind: "shell",
    outputBuffer: "",
    process: terminalProcess,
    rootCwd: cwd
  });

  const terminal = terminalProcesses.get(id);

  terminalProcess.onData((data) => {
    if (!terminal) return;
    const cleanedData = processTerminalData(terminal, data);
    if (cleanedData) sendTerminalPayload("terminal:data", { id, data: cleanedData });
  });

  terminalProcess.onExit(({ exitCode }) => {
    terminalProcesses.delete(id);
    sendTerminalPayload("terminal:exit", { id, code: exitCode });
  });

  return {
    id,
    cwd,
    kind: "shell",
    name: path.basename(cwd) || "terminal"
  };
}

function publishWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.send("window:state", {
    expanded: mainWindow.isFullScreen()
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#f6eadf",
    frame: false,
    resizable: true,
    show: false,
    title: "chickenshop",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = window;

  window.loadFile(path.join(__dirname, "renderer", "index.html"));

  window.webContents.on("before-input-event", (event, input) => {
    const isSidebarShortcut =
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.key.toLowerCase() === "b";

    if (!isSidebarShortcut) return;
    event.preventDefault();
    window.webContents.send("sidebar:toggle");
  });

  window.once("ready-to-show", () => {
    window.show();
    publishWindowState();
  });

  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);
  window.on("enter-full-screen", publishWindowState);
  window.on("leave-full-screen", publishWindowState);
  window.on("restore", publishWindowState);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  disposeAllTerminals();

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", disposeAllTerminals);

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return;
  }
  mainWindow.maximize();
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:get-state", () => ({
  expanded: mainWindow?.isFullScreen() ?? false
}));

ipcMain.handle("project:get-default", () => buildProject(getDefaultProjectPath()));

ipcMain.handle("project:open-folder", async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    buttonLabel: "Open Project",
    message: "Choose a project folder",
    properties: ["openDirectory"]
  });
  mainWindow.webContents.send("project:folder-picker-closed");

  if (result.canceled || !result.filePaths[0]) return null;
  return buildProject(result.filePaths[0]);
});

ipcMain.handle("project:read-file", (_event, filePath: string) => readProjectFile(filePath));

ipcMain.handle("terminal:create", (_event, size?: TerminalSize) => createTerminal(size));

ipcMain.handle("terminal:write", (_event, { id, data }: TerminalWriteRequest) => {
  const terminal = terminalProcesses.get(id);
  if (!terminal) return false;
  observeTerminalInput(terminal, data);
  terminal.process.write(data);
  return true;
});

ipcMain.handle("terminal:resize", (_event, { id, cols, rows }: TerminalResizeRequest) => {
  const terminal = terminalProcesses.get(id);
  if (!terminal) return false;
  terminal.process.resize(cols, rows);
  return true;
});

ipcMain.handle("terminal:dispose", (_event, id: string) => {
  disposeTerminal(id);
  return true;
});

ipcMain.handle("update:check", () => checkForUpdate());

ipcMain.handle("update:open-download", (_event, url: string) => {
  if (!isHttpUrl(url)) return false;
  void electronShell.openExternal(url);
  return true;
});
