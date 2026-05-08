export type ProjectNodeType = "directory" | "file";

export interface ProjectFileNode {
  type: "file";
  name: string;
  path: string;
  status?: string;
  content?: string;
}

export interface ProjectDirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: ProjectNode[];
}

export type ProjectNode = ProjectDirectoryNode | ProjectFileNode;

export interface ProjectFileContents {
  name: string;
  path: string;
  content: string;
  readonly: boolean;
}

export interface WindowState {
  expanded: boolean;
}

export interface TerminalSize {
  cols?: number;
  rows?: number;
  cwd?: string;
}

export interface TerminalSession {
  id: string;
  cwd: string;
  name: string;
}

export interface TerminalDataPayload {
  id: string;
  data: string;
}

export interface TerminalExitPayload {
  id: string;
  code?: number;
}

export interface TerminalWriteRequest {
  id: string;
  data: string;
}

export interface TerminalResizeRequest {
  id: string;
  cols: number;
  rows: number;
}

export interface UpdateFeedInfo {
  version: string;
  downloadUrl: string;
  notes?: string;
  releasedAt?: string;
}

export type UpdateCheckStatus = "disabled" | "current" | "available" | "error";

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersion: string;
  checkedAt: string;
  feedUrl?: string;
  latest?: UpdateFeedInfo;
  message?: string;
}

export type Unsubscribe = () => void;

export interface NewideWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  getState(): Promise<WindowState>;
  onStateChange(callback: (state: WindowState) => void): Unsubscribe;
  onToggleSidebar(callback: () => void): Unsubscribe;
}

export interface NewideProjectApi {
  getDefault(): Promise<ProjectDirectoryNode>;
  openFolder(): Promise<ProjectDirectoryNode | null>;
  readFile(filePath: string): Promise<ProjectFileContents>;
  onFolderPickerClosed(callback: () => void): Unsubscribe;
}

export interface NewideTerminalApi {
  create(size?: TerminalSize): Promise<TerminalSession>;
  write(id: string, data: string): Promise<boolean>;
  resize(id: string, cols: number, rows: number): Promise<boolean>;
  dispose(id: string): Promise<boolean>;
  onData(callback: (payload: TerminalDataPayload) => void): Unsubscribe;
  onExit(callback: (payload: TerminalExitPayload) => void): Unsubscribe;
}

export interface NewideUpdateApi {
  check(): Promise<UpdateCheckResult>;
  openDownload(url: string): Promise<boolean>;
}
