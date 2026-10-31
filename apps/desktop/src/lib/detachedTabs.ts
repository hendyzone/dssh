import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, TabInfo, ServerEntry } from "../types";
import type { WebPage } from "./webPages";

export type DetachedPage = Omit<WebPage, "sessionId"> & {server?: ServerEntry};
export type TabDescriptor = {sourceId: string; settings: AppSettings} & (
  {kind: "terminal"; tab: TabInfo} | {kind: "preview"; page: DetachedPage});
export interface DetachedEntry {id: string; descriptor: TabDescriptor; phase: "opening" | "detached" | "returning"; error: string | null}
export const canDetach = (tab?: TabInfo): boolean => !!tab && tab.panes.length === 1 && !!tab.panes[0].tmux;
export const hiddenTab = (entries: DetachedEntry[], id: string) => entries.some(e => e.descriptor.sourceId === id && e.phase === "detached");

export function useDetachedTabs() {
  const [entries, setEntries] = useState<DetachedEntry[]>([]);
  const [returnedPreviews, setReturnedPreviews] = useState<Record<string,string>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    let disposed=false;
    const offs: (()=>void)[]=[];
    let events=0;
    const update=(list: DetachedEntry[])=>{
      if(disposed || !Array.isArray(list)) return;
      setEntries(list);
      setReturnedPreviews(previous=>{
        const next={...previous};
        for(const e of list) if(e.phase==="returning" && e.descriptor.kind==="preview") next[e.descriptor.sourceId]=e.id;
        return next;
      });
    };
    void (async()=>{
      const off=await listen<DetachedEntry[]>("tabs:changed",e=>{events++;update(e.payload);});
      if(disposed){off();return;} offs.push(off);
      const version=events;
      const initial=await invoke<DetachedEntry[]>("tab_snapshot");
      if(version===events)update(initial);
      const errors=await listen<string>("tabs:error",e=>{if(!disposed)setError(e.payload);});
      if(disposed)errors();else offs.push(errors);
    })().catch(e=>{if(!disposed)setError(String(e));});
    return()=>{disposed=true;offs.forEach(off=>off());};
  },[]);
  const open=useCallback(async(descriptor:TabDescriptor, position?:{x:number;y:number})=>{
    if(pending.current.has(descriptor.sourceId))return;
    pending.current.add(descriptor.sourceId);setError(null);
    try {await invoke("tab_open",{descriptor,position:position??null});}
    catch(e){setError(String(e));}
    finally{pending.current.delete(descriptor.sourceId);}
  },[]);
  const state=useCallback((sourceId:string,status:string)=>{
    const e=entries.find(e=>e.descriptor.sourceId===sourceId && e.phase==="returning");
    if(!e || status==="connecting")return;
    void invoke(status==="connected"?"tab_ready":"tab_failed",{id:e.id,error:"主窗口重新连接失败，独立窗口已保留"}).catch(e=>setError(String(e)));
  },[entries]);
  return {entries,returnedPreviews,error,open,state};
}

const PREVIEWS_KEY="dssh.detached-previews.v1";
/** Store only reconnect references, never SSH handles, contents or key paths. */
export function saveDetachedPreviews(entries:DetachedEntry[]) {
  localStorage.setItem(PREVIEWS_KEY,JSON.stringify(entries.filter(e=>e.descriptor.kind==="preview").map(e=>{
    const d=e.descriptor as TabDescriptor & {kind:"preview"};const server=d.page.server;
    return {sourceId:d.sourceId,kind:"preview",settings:d.settings,page:{id:d.page.id,title:d.page.title,target:d.page.target,
      server:server?{id:server.id,host:server.host,port:server.port,username:server.username}:undefined}};
  })));
}
export function loadDetachedPreviews(servers:ServerEntry[]):TabDescriptor[] {
  const raw=JSON.parse(localStorage.getItem(PREVIEWS_KEY)??"[]");
  if(!Array.isArray(raw))throw new Error("独立预览恢复数据无效");
  return raw.flatMap(d=>{
    if(d?.kind!=="preview" || typeof d.sourceId!=="string" || d.page?.id!==d.sourceId || !d.settings)return [];
    if(d.page.target?.kind==="url")return [d];
    const reference=d.page.server;
    const server=servers.find(s=>s.id===reference?.id && s.host===reference.host && s.port===reference.port && s.username===reference.username);
    return server?[{...d,page:{...d.page,server}}]:[];
  });
}
