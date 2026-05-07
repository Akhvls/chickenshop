import { app, BrowserWindow, dialog, ipcMain, shell as electronShell } from "electron";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IPty } from "node-pty";
import type {
  ProjectDirectoryNode,
  ProjectFileContents,
  ProjectNode,
  TerminalDataPayload,
  TerminalExitPayload,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSize,
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
  id: string;
  process: IPty;
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

function getDefaultProjectPath(): string {
  return path.resolve(__dirname, "..");
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
  channel: "terminal:data" | "terminal:exit",
  payload: TerminalDataPayload | TerminalExitPayload
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
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

function createTerminal({ cols = 120, rows = 30 }: TerminalSize = {}): TerminalSession {
  if (!pty) {
    throw new Error(
      `Real terminal backend failed to load.${ptyLoadError ? ` ${ptyLoadError.message}` : ""}`
    );
  }

  const cwd = getDefaultProjectPath();
  const id = `terminal-${++terminalCounter}`;
  const shell = process.env.SHELL || "/bin/zsh";
  const terminalProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      TERM_PROGRAM: "chickenshop"
    }
  });

  terminalProcesses.set(id, {
    id,
    process: terminalProcess
  });

  terminalProcess.onData((data) => {
    sendTerminalPayload("terminal:data", { id, data });
  });

  terminalProcess.onExit(({ exitCode }) => {
    terminalProcesses.delete(id);
    sendTerminalPayload("terminal:exit", { id, code: exitCode });
  });

  return {
    id,
    cwd,
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
