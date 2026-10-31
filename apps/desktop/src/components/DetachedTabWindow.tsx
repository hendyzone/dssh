import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import TerminalView from "./TerminalView";
import WebPageView from "./WebPageView";
import type { DetachedEntry, DetachedPage } from "../lib/detachedTabs";
import { finishTabDrag } from "../lib/tabDetachDrag";
import { applyTheme, getTheme } from "../themes";

export function ReopenedPreview({id,page,onStatus,active=true,restricted=false}:{id:string;page:DetachedPage;onStatus:(status:string)=>void;active?:boolean;restricted?:boolean}) {
  const [sessionId,setSessionId]=useState<string | null>(page.target.kind==="url"?"":null);
  const [error,setError]=useState<string>();
  const callback=useRef(onStatus);callback.current=onStatus;
  useEffect(()=>{
    if(page.target.kind==="url")return;
    let disposed=false;let connected:string|undefined;
    void invoke<string>("tab_connect",{id,cols:80,rows:24}).then(sid=>{
      connected=sid;
      if(disposed)void invoke("ssh_disconnect",{sessionId:sid}).catch(()=>{});
      else setSessionId(sid);
    }).catch(e=>{if(!disposed){setError(String(e));callback.current("disconnected");}});
    return()=>{disposed=true;if(connected)void invoke("ssh_disconnect",{sessionId:connected}).catch(()=>{});};
  },[id]);
  const readyPage=useRef<{id:string;sessionId:string;title:string;target:DetachedPage["target"]}>();
  if(sessionId!==null && readyPage.current?.sessionId!==sessionId)readyPage.current={...page,sessionId};
  return error?<p role="alert">预览连接失败：{error}</p>:readyPage.current?<WebPageView page={readyPage.current} active={active} restricted={restricted} onStatus={onStatus}/>:<p role="status">正在重新打开预览…</p>;
}
export default function DetachedTabWindow({id}:{id:string}) {
  const [entry,setEntry]=useState<DetachedEntry>();
  const [error,setError]=useState<string>();
  const cancel=useRef(false);
  const settled=useRef(false);
  useEffect(()=>{
    let disposed=false;let off:(()=>void)|undefined;
    const update=(list:DetachedEntry[])=>{const e=list.find(e=>e.id===id);if(!disposed && e){setEntry(e);applyTheme(getTheme(e.descriptor.settings.themeId));}};
    void (async()=>{off=await listen<DetachedEntry[]>("tabs:changed",e=>update(e.payload));if(disposed){off();return;} update(await invoke<DetachedEntry[]>("tab_snapshot"));})().catch(e=>setError(String(e)));
    return()=>{disposed=true;off?.();};
  },[id]);
  const status=(value:string)=>{
    if(settled.current || value==="connecting")return;
    settled.current=true;
    void invoke(value==="connected"?"tab_ready":"tab_failed",{id,error:"独立窗口连接失败，原标签已保留"}).catch(e=>setError(String(e)));
  };
  const returning=()=>void invoke("tab_return",{id}).catch(e=>setError(String(e)));
  const descriptor=entry?.descriptor;
  const title=descriptor?.kind==="terminal"?(descriptor.tab.customTitle??descriptor.tab.panes[0].tmux?.name):descriptor?.page.title;
  return <main className="detached-window" onKeyDown={e=>{if(e.key==="Escape")cancel.current=true;}}>
    <header className="detached-header">
      <div role="tab" draggable onDragStart={e=>{cancel.current=false;e.dataTransfer.setData("application/x-dssh-detached",id);e.dataTransfer.effectAllowed="move";}}
        onDragEnd={()=>void finishTabDrag(cancel.current,()=>{},id).catch(e=>setError(String(e)))}>{title??"正在打开…"}</div>
      <span className="detached-move" onMouseDown={e=>{if(e.button===0)void getCurrentWindow().startDragging();}}>拖动窗口</span>
      <button onClick={returning} disabled={entry?.phase==="returning"}>{entry?.phase==="returning"?"正在归还…":"返回主窗口"}</button>
      <button aria-label="关闭独立窗口并归还标签" onClick={returning}>×</button>
    </header>
    {(error||entry?.error)&&<p role="alert">{error||entry?.error}</p>}
    {descriptor?.kind==="terminal" && <div className="panes"><TerminalView session={descriptor.tab.panes[0]} active settings={descriptor.settings} detachedId={id} onBackendReady={()=>{}} onStateChange={(_,s)=>status(s)}/></div>}
    {descriptor?.kind==="preview" && <ReopenedPreview id={id} page={descriptor.page} onStatus={status} restricted/>}
  </main>;
}
