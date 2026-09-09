import { useEffect, useRef, useState } from "react";
import { collaborationRequest, type CollaborationProfile, type CollaborationRequest } from "../lib/collaboration";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { IconClose } from "./Icons";
import "./Collaboration.css";
import AgentGuide from "./AgentGuide";

type Row = Record<string, unknown>;
const rows = (value:unknown):Row[] => Array.isArray(value) ? value.filter((v):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v)) : [];
const text = (value:unknown) => value == null ? "" : String(value);
const kinds:Record<string,string>={request:"请求协助",ack:"已收到",progress:"进度",blocked:"阻塞",handoff:"交接",result:"结果",question:"提问",answer:"回答"};

export default function CollaborationPanel({sessionId,profile,onClose}:{sessionId:string;profile:CollaborationProfile;onClose:()=>void}){
  const [context,setContext]=useState<Row|null>(null);
  const [task,setTask]=useState("");
  const [mailOutput,setMailOutput]=useState("");
  const [uid,setUid]=useState("");
  const [to,setTo]=useState("");
  const [kind,setKind]=useState("request");
  const [body,setBody]=useState("");
  const [mode,setMode]=useState<"send"|"reply">("send");
  const [preview,setPreview]=useState<{request:CollaborationRequest;message:Row}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [status,setStatus]=useState("");
  const generation=useRef(0);
  const pending=useRef(false);
  const execute=async(request:CollaborationRequest,apply:(value:string)=>void)=>{
    if(pending.current||!profile.enabled||!sessionId)return;
    const id=generation.current;
    pending.current=true;setBusy(true);setError("");setStatus("");
    try{const value=await collaborationRequest(sessionId,profile,request);if(id===generation.current)apply(value);}
    catch(e){if(id===generation.current)setError(String(e)+((request.operation==="send"||request.operation==="reply")&&request.preview===false?" 若发送中断，先检查回执，避免重复投递。":""));}
    finally{if(id===generation.current){pending.current=false;setBusy(false);}}
  };
  const refresh=()=>execute({operation:"context"},value=>{
    const data:unknown=JSON.parse(value);
    if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("看板返回格式无效");
    setContext(data as Row);
  });
  useEffect(()=>{
    setBusy(false);
    setContext(null);setMailOutput("");setPreview(null);setError("");setStatus("");setTask("");setUid("");setTo("");setBody("");
    if(profile.enabled&&profile.taskboardEnabled&&sessionId)void refresh();
    return()=>{generation.current++;pending.current=false;};
  },[sessionId,profile]);
  const edit=(fn:()=>void)=>{setPreview(null);setStatus("");fn();};
  const makePreview=()=>{
    const request:CollaborationRequest={operation:mode,task,uid,to,kind,body,preview:true};
    setPreview(null);
    void execute(request,content=>{
      const data=JSON.parse(content) as {dry_run?:boolean;message?:Row};
      if(data.dry_run!==true||!data.message||typeof data.message.body!=="string"||!Array.isArray(data.message.recipients)||typeof data.message.project!=="string"||typeof data.message.task!=="string"||typeof data.message.kind!=="string")throw new Error("消息预览格式无效，请确认远端 amail 已更新");
      setPreview({request,message:data.message});
    });
  };
  const send=()=>{
    if(!preview)return;
    const request={...preview.request,preview:false};
    setPreview(null);
    void execute(request,value=>{
      const result=JSON.parse(value) as {status?:string};
      if(result.status!=="submitted")throw new Error("投递结果未知，请检查收件箱或回执后再决定是否重发");
      setStatus("消息已提交邮件服务器；等待对方回执，不代表任务已完成。");
    });
  };
  const disabled=busy||!sessionId||!profile.enabled;
  const tasks=rows(context?.tasks);
  const checkpoints=rows(context?.checkpoints).filter(cp=>!task||cp.task_code===task);
  return <aside className="workspace-panel collaboration-panel">
    <header data-panel-drag-handle tabIndex={0}><strong>Agent 协作 · {profile.project}</strong><Button variant="ghost" size="icon-sm" aria-label="关闭 Agent 协作" onClick={onClose}><IconClose/></Button></header>
    <div className="collaboration-content">
      <p>{profile.tmuxName || profile.tmuxId} · {profile.workdir}</p>
      <details><summary>发送接入手册给 Agent</summary><AgentGuide profile={profile}/></details>
      {!sessionId&&<p role="status">SSH 已断开，请先连接此服务器。</p>}
      {error&&<p role="alert" className="collaboration-error">{error}</p>}
      {status&&<p role="status">{status}</p>}
      {busy&&<p role="status">正在请求远端服务…</p>}
      <label className="collaboration-field">任务编号<Input disabled={disabled} value={task} placeholder="例如 T1（发消息时必填）" onChange={e=>edit(()=>setTask(e.target.value))}/></label>
      {profile.taskboardEnabled&&<section>
        <div className="collaboration-actions"><strong>任务看板</strong><Button size="sm" disabled={disabled} onClick={()=>void refresh()}>刷新看板</Button></div>
        {context&&<>
          <p>{text((context.project as Row|undefined)?.note)}</p>
          {tasks.length===0&&<p>暂无任务。</p>}
          {tasks.map(t=><article key={text(t.id)||text(t.code)}>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={()=>edit(()=>setTask(text(t.code)))}>{text(t.code)} · {text(t.title)}</Button>
            <p>{text(t.status_key)} · {text(t.summary)}</p>
            {rows(context.leases).filter(l=>l.task_code===t.code).map(l=><p key={text(l.task_code)}>正在处理：{text(l.agent)}</p>)}
          </article>)}
          <h4>最近交接{task?` · ${task}`:""}</h4>
          {checkpoints.length===0&&<p>暂无交接记录。</p>}
          {checkpoints.map(cp=><article key={text(cp.id)}><strong>{text(cp.summary)}</strong><p>{text(cp.agent)} · {text(cp.created_at)}</p>
            {[['下一步','next_step'],['分支','branch'],['提交','commit'],['验证','tests'],['阻塞','blockers'],['决策','decisions']].map(([label,key])=>cp[key]?<p key={key}>{label}：{text(cp[key])}</p>:null)}
          </article>)}
          {!!context.has_more&&<p>显示项目最近 50 条交接；更早记录可通过 taskboard 的增量接口读取。</p>}
        </>}
      </section>}
      {profile.mailEnabled&&<section>
        <h4>Agent 通信</h4>
        <div className="collaboration-actions">
          <Button size="sm" disabled={disabled} onClick={()=>void execute({operation:"inbox"},setMailOutput)}>最近邮件</Button>
        </div>
        <label className="collaboration-field">邮件 UID<Input disabled={disabled} value={uid} placeholder="从最近邮件中选择，例如 42" onChange={e=>edit(()=>setUid(e.target.value))}/></label>
        <Button size="sm" disabled={disabled||!uid} onClick={()=>void execute({operation:"read",uid},setMailOutput)}>读取结构化消息</Button>
        {mailOutput&&<pre aria-label="邮件查询结果">{mailOutput}</pre>}
        <label className="collaboration-field">发送方式<select disabled={disabled} value={mode} onChange={e=>edit(()=>{setMode(e.target.value as "send"|"reply");setKind("request");})}><option value="send">新消息</option><option value="reply">回复上述 UID</option></select></label>
        {mode==="send"&&<label className="collaboration-field">收件邮箱<Input disabled={disabled} value={to} placeholder="agent@example.com" onChange={e=>edit(()=>setTo(e.target.value))}/></label>}
        <label className="collaboration-field">消息类型<select disabled={disabled} value={kind} onChange={e=>edit(()=>setKind(e.target.value))}>{Object.entries(kinds).filter(([k])=>mode==="reply"||!["ack","answer"].includes(k)).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
        <label className="collaboration-field">消息正文<textarea disabled={disabled} value={body} onChange={e=>edit(()=>setBody(e.target.value))}/></label>
        <Button size="sm" disabled={disabled||!body.trim()||(mode==="send"?(!to||!task):!uid)} onClick={makePreview}>预览消息</Button>
        {preview&&<><article aria-label="待发送消息"><strong>消息预览</strong><p>项目 / 任务：{text(preview.message.project)} / {text(preview.message.task)}</p><p>收件人：{(preview.message.recipients as unknown[]).map(text).join(", ")}</p><p>类型：{kinds[text(preview.message.kind)]??text(preview.message.kind)}</p><pre>{text(preview.message.body)}</pre></article><Button disabled={disabled} onClick={send}>发送预览中的消息</Button></>}
        <p>仅在点击发送后投递。看板状态与邮件独立，消息不会自动执行命令或标记任务完成。</p>
      </section>}
    </div>
  </aside>;
}
