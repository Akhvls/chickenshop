const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("newideWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  getState: () => ipcRenderer.invoke("window:get-state"),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  onToggleSidebar: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("sidebar:toggle", listener);
    return () => ipcRenderer.removeListener("sidebar:toggle", listener);
  }
});

contextBridge.exposeInMainWorld("newideProject", {
  getDefault: () => ipcRenderer.invoke("project:get-default"),
  openFolder: () => ipcRenderer.invoke("project:open-folder"),
  readFile: (filePath) => ipcRenderer.invoke("project:read-file", filePath)
});

contextBridge.exposeInMainWorld("newideTerminal", {
  create: (size) => ipcRenderer.invoke("terminal:create", size),
  write: (id, data) => ipcRenderer.invoke("terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
  dispose: (id) => ipcRenderer.invoke("terminal:dispose", id),
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  }
});
