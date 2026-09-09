import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo } from "../types";

export interface CollaborationSession { pane: SessionInfo; backendId: string; }

export interface CollaborationProfile {
  tmuxId: string;
  tmuxCreated: number;
  tmuxName: string;
  enabled: boolean;
  taskboardEnabled: boolean;
  mailEnabled: boolean;
  project: string;
  workdir: string;
  taskboardUrl: string;
  taskboardBin: string;
  tokenFile: string;
  pythonBin: string;
  mailctlPath: string;
}
export const COLLABORATION_KEY = "dssh.collaboration.v2";
const EVENT = "dssh-collaboration-changed";
export const emptyProfile = (): CollaborationProfile => ({
  tmuxId:"", tmuxCreated:0, tmuxName:"",
  enabled:false, taskboardEnabled:false, mailEnabled:false, project:"", workdir:"",
  taskboardUrl:"", taskboardBin:"taskboard", tokenFile:"", pythonBin:"python3", mailctlPath:"",
});
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function profileError(p: CollaborationProfile): string {
  if (!p.enabled) return "";
  if (!/^\$\d+$/.test(p.tmuxId) || !Number.isSafeInteger(p.tmuxCreated) || p.tmuxCreated <= 0) return "请绑定有效的 tmux 会话";
  if (!p.taskboardEnabled && !p.mailEnabled) return "请至少开启任务看板或 Agent 通信";
  if (!identifier.test(p.project)) return "请填写项目编号（字母、数字、点、下划线或连字符）";
  if (!p.workdir.startsWith("/")) return "请填写远端工作目录的绝对路径";
  if (Object.values(p).some(v => typeof v === "string" && (v.length > 4096 || /[\r\n\0]/.test(v)))) return "配置不能包含换行或超过 4096 字符";
  if (p.taskboardEnabled) {
    try {
      const url = new URL(p.taskboardUrl);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { return "请填写不含凭据或查询参数的 HTTP(S) 看板地址"; }
    if (!p.taskboardBin.trim()) return "请填写 taskboard 可执行文件";
    if (p.tokenFile && !p.tokenFile.startsWith("/")) return "令牌文件须为远端绝对路径";
  }
  if (p.mailEnabled && (!p.pythonBin.trim() || !p.mailctlPath.startsWith("/"))) return "请填写 Python 命令和 mailctl.py 的远端绝对路径";
  return "";
}
export function loadCollaboration(): Record<string, CollaborationProfile> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLABORATION_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const profiles: Record<string, CollaborationProfile> = Object.create(null);
    for (const [serverId, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const defaults = emptyProfile();
      const known = value as Record<string, unknown>;
      const profile = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof known[key] === typeof fallback ? known[key] : fallback])) as unknown as CollaborationProfile;
      if (profileError(profile)) profile.enabled = false;
      profiles[serverId] = profile;
    }
    return profiles;
  } catch { return {}; }
}
export function saveCollaboration(serverId: string, profile: CollaborationProfile): void {
  if (!serverId) throw new Error("请先选择服务器");
  const error = profileError(profile); if (error) throw new Error(error);
  if (!/^\$\d+$/.test(profile.tmuxId) || profile.tmuxCreated <= 0 || !profile.workdir.startsWith("/")) throw new Error("请先选择 tmux 会话并填写 worktree 根目录");
  localStorage.setItem(COLLABORATION_KEY, JSON.stringify({...loadCollaboration(), [collaborationKey(serverId, profile)]:profile}));
  window.dispatchEvent(new Event(EVENT));
}
export function collaborationKey(serverId: string, p: Pick<CollaborationProfile,"tmuxId"|"tmuxCreated"|"workdir">): string {
  return JSON.stringify([serverId,p.tmuxId,p.tmuxCreated,p.workdir]);
}
export function resolveWorktree(sessionId: string, tmux: NonNullable<SessionInfo["tmux"]>): Promise<string> {
  return invoke("collaboration_worktree", {sessionId, target:{id:tmux.id,created:tmux.created}});
}
export function collaborationMailHome(p: CollaborationProfile): string {
  return `${p.workdir.replace(/\/$/,"")}/.dssh/agents/tmux-${p.tmuxId.slice(1)}-${p.tmuxCreated}`;
}
export function useActiveCollaboration(profiles: Record<string, CollaborationProfile>, pane: SessionInfo | undefined, backendId: string | null | undefined, cwd: string | undefined) {
  const [resolved,setResolved] = useState<{key:string;root:string}|null>(null);
  const candidates = Object.entries(profiles).filter(([key,p])=>p.enabled && pane?.tmux && key===collaborationKey(pane.server.id,p) && p.tmuxId===pane.tmux.id && p.tmuxCreated===pane.tmux.created);
  const key=JSON.stringify([pane?.id,backendId,cwd,pane?.tmux,candidates]);
  useEffect(()=>{
    let live=true;
    if(!candidates.length || !backendId || !pane?.tmux) return;
    let pending=false;
    const refresh=()=>{
      if(pending||document.hidden)return;
      pending=true;
      resolveWorktree(backendId,pane.tmux!).then(root=>{if(live)setResolved({key,root});}).catch(()=>{if(live)setResolved(null);}).finally(()=>{pending=false;});
    };
    refresh();
    const timer=window.setInterval(refresh,5000);
    window.addEventListener("focus",refresh);
    return ()=>{live=false;window.clearInterval(timer);window.removeEventListener("focus",refresh);};
  },[key]);
  return resolved?.key===key ? candidates.find(([,p])=>p.workdir===resolved.root)?.[1] : undefined;
}
export function useCollaboration() {
  const [profiles, setProfiles] = useState(loadCollaboration);
  useEffect(() => {
    const update = () => setProfiles(loadCollaboration());
    window.addEventListener(EVENT, update); window.addEventListener("storage", update);
    return () => { window.removeEventListener(EVENT, update); window.removeEventListener("storage", update); };
  }, []);
  return profiles;
}
export type CollaborationOperation = "context" | "inbox" | "read" | "send" | "reply";
export interface CollaborationRequest {
  operation: CollaborationOperation;
  task?: string; uid?: string; to?: string; kind?: string; body?: string; preview?: boolean;
}
export async function collaborationRequest(sessionId:string, profile:CollaborationProfile, request:CollaborationRequest):Promise<string> {
  if (!profile.enabled) throw new Error("Agent 协作未开启");
  const error = profileError(profile); if(error) throw new Error(error);
  if (!sessionId) throw new Error("请先连接此服务器");
  if (request.operation === "context" ? !profile.taskboardEnabled : !profile.mailEnabled) throw new Error("该服务未开启");
  return invoke("collaboration_request", {sessionId, profile, request});
}
