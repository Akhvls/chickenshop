import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  NewideTerminalApi,
  NewideUpdateApi,
  NewideWindowApi,
  TerminalDataPayload,
  TerminalExitPayload,
  TerminalStatePayload,
  WindowState
} from "./shared";

const windowApi: NewideWindowApi = {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  getState: () => ipcRenderer.invoke("window:get-state"),
  onStateChange: (callback) => {
    const listener = (_event: IpcRendererEvent, state: WindowState) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  onToggleSidebar: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("sidebar:toggle", listener);
    return () => ipcRenderer.removeListener("sidebar:toggle", listener);
  }
};

const terminalApi: NewideTerminalApi = {
  create: (size) => ipcRenderer.invoke("terminal:create", size),
  write: (id, data) => ipcRenderer.invoke("terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
  dispose: (id) => ipcRenderer.invoke("terminal:dispose", id),
  onData: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalDataPayload) =>
      callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onExit: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalExitPayload) =>
      callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalStatePayload) =>
      callback(payload);
    ipcRenderer.on("terminal:state", listener);
    return () => ipcRenderer.removeListener("terminal:state", listener);
  }
};

const updateApi: NewideUpdateApi = {
  check: () => ipcRenderer.invoke("update:check"),
  openDownload: (url) => ipcRenderer.invoke("update:open-download", url)
};

contextBridge.exposeInMainWorld("newideWindow", windowApi);
contextBridge.exposeInMainWorld("newideTerminal", terminalApi);
contextBridge.exposeInMainWorld("newideUpdate", updateApi);
