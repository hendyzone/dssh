export interface TmuxSession {
  id: string;
  name: string;
  windows: number;
  attached: number;
  created: number;
}
export interface TmuxPane {
  sessionId: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
  id: string;
  index: number;
  active: boolean;
  command: string;
  path: string;
  zoomed: boolean;
}
export interface TmuxSnapshot {
  installed: boolean;
  version: string;
  sessions: TmuxSession[];
  panes: TmuxPane[];
}
