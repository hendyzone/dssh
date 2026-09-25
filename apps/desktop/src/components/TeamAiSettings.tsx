import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {AI_PROVIDERS,loadTeamAi,loadTeamAiProfiles,protocolOf,protocolEndpoint,providerOf,configName,type TeamAiConfig,type AiProtocol,TEAM_AI_CONFIG,TEAM_AI_PROFILES} from "../lib/teamAi";
import {Button} from "./ui/button";
import {Input} from "./ui/input";

type KeyStatus="checking"|"saved"|"missing"|"error";
const initialConfig=()=>{const c=loadTeamAi();return c.endpoint?c:{...c,id:crypto.randomUUID()};};
export default function TeamAiSettings(){
  const [config,setConfig]=useState<TeamAiConfig>(initialConfig);
  const [profiles,setProfiles]=useState(loadTeamAiProfiles);
  const [selected,setSelected]=useState(()=>{const active=loadTeamAi();return Object.entries(loadTeamAiProfiles()).find(([,c])=>active.id?c.id===active.id:!c.id&&c.endpoint===active.endpoint)?.[0]??"";});
  const [models,setModels]=useState<string[]>([]);
  const [key,setKey]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [keyState,setKeyState]=useState<{identity:string;status:KeyStatus}>({identity:"",status:"missing"});
  const [keyRefresh,setKeyRefresh]=useState(0);
  const keyCheck=useRef(0);
  const provider=providerOf(config);
  const endpoint=config.endpoint.trim();
  const identity=JSON.stringify([config.id,endpoint]);
  const keyStatus=keyState.identity===identity?keyState.status:"checking";
  const keyArgs={endpointUrl:endpoint,profileId:config.id??null};
  const resetDraft=()=>{setKey("");setModels([]);setMessage("");};
  const notify=()=>window.dispatchEvent(new Event("dssh-team-ai-config"));
  useEffect(()=>{
    const refresh=()=>{setKeyRefresh(value=>value+1);setProfiles(loadTeamAiProfiles());};
    window.addEventListener("dssh-team-ai-config",refresh);
    return()=>window.removeEventListener("dssh-team-ai-config",refresh);
  },[]);
  useEffect(()=>{
    const version=++keyCheck.current;
    if(!endpoint){setKeyState({identity,status:"missing"});return;}
    setKeyState({identity,status:"checking"});
    void invoke<boolean>("team_ai_key",{endpointUrl:endpoint,profileId:config.id??null,key:null}).then(saved=>{
      if(keyCheck.current===version)setKeyState({identity,status:saved?"saved":"missing"});
    }).catch(()=>{if(keyCheck.current===version)setKeyState({identity,status:"error"});});
    return()=>{keyCheck.current++;};
  },[identity,keyRefresh]);
  const perform=async(action:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setMessage("");
    try{await action();}catch(e){setMessage(String(e));setKeyRefresh(value=>value+1);}finally{setBusy(false);}
  };
  return <section className="collaboration-settings">
    <h3>团队动态 · 云端摘要</h3>
    <p>同一供应商可添加多套配置，每套独立保存 Key 和模型。配置及 Key 随完整备份加密同步。</p>
    <div className="team-ai-profile-toolbar">
      <label className="collaboration-field">模型配置<select disabled={busy} value={selected} onChange={e=>{
        const next=profiles[e.target.value];if(!next)return;
        try{localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify(next));setSelected(e.target.value);setConfig(next);resetDraft();notify();setMessage(`已启用“${configName(next)}”。`);}catch(error){setMessage(String(error));}
      }}><option value="" disabled>新配置 · 尚未保存</option>{Object.entries(profiles).map(([id,c])=><option key={id} value={id}>{configName(c)} · {c.model}</option>)}</select></label>
      <Button variant="outline" disabled={busy||Object.keys(profiles).length>=100} onClick={()=>{setSelected("");setConfig({...config,id:crypto.randomUUID(),name:`${AI_PROVIDERS.find(p=>p.id===provider)!.name} 备用`});resetDraft();}}>新增配置</Button>
    </div>
    <label className="collaboration-field">配置名称<Input disabled={busy} maxLength={80} value={config.name??""} placeholder="例如 DeepSeek 主账号 / 备用账号" onChange={e=>setConfig({...config,name:e.target.value})}/></label>
    <label className="collaboration-field">供应商<select disabled={busy} value={provider} onChange={e=>{
      const p=AI_PROVIDERS.find(p=>p.id===e.target.value)!;
      setConfig({...config,id:config.id??crypto.randomUUID(),endpoint:protocolEndpoint(p.endpoint,"responses"),model:"",protocol:"responses"});resetDraft();
    }}>{AI_PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="collaboration-field">接口协议<select disabled={busy} value={protocolOf(config)} onChange={e=>{const protocol=e.target.value as AiProtocol;setConfig({...config,protocol,endpoint:protocolEndpoint(config.endpoint,protocol)});setModels([]);setMessage("");}}><option value="responses">Responses（默认）</option><option value="chat">Chat Completions</option></select></label>
    {provider==="siliconflow"&&protocolOf(config)==="responses"&&<p>硅基流动官方文档目前列出 Chat Completions；如果 Responses 不可用，请切换协议。</p>}
    <label className="collaboration-field">完整接口地址<Input disabled={busy} value={config.endpoint} readOnly={provider!=="custom"} placeholder="https://服务商/v1/responses" onChange={e=>{setConfig({...config,endpoint:e.target.value});setModels([]);setMessage("");}}/></label>
    <div className="team-ai-key-heading"><label htmlFor="team-ai-key">API Key</label><span aria-live="polite" className={`team-ai-key-state team-ai-key-${keyStatus}`}>{keyStatus==="saved"?"✓ 已保存":keyStatus==="checking"?"正在检查…":keyStatus==="error"?"无法读取保存状态":"未配置"}</span></div>
    <Input id="team-ai-key" aria-describedby="team-ai-key-help" disabled={busy} type="password" autoComplete="off" value={key} placeholder={keyStatus==="saved"?"留空继续使用，输入新 Key 可替换":"填写此配置的 API Key"} onChange={e=>{setKey(e.target.value);setModels([]);}}/>
    <small id="team-ai-key-help">{key.trim()?"新 Key 尚未保存，点击“保存模型配置”后生效。":keyStatus==="saved"?"已存入系统凭据库，无需重复填写；不代表已验证接口可用。":keyStatus==="error"?"请重新打开设置重试；也可填写 Key 后保存。":"每套配置独立保存 Key，不会沿用另一套配置的 Key。"}</small>
    <Button variant="outline" disabled={busy||!endpoint} onClick={()=>void perform(async()=>{
      setModels([]);
      const list=await invoke<string[]>("team_ai_models",{...keyArgs,key:key.trim()||null});setModels(list);setMessage(list.length?`已获取 ${list.length} 个模型，请选择。列表不保证每个模型都支持当前协议。`:"没有返回模型，可手动填写模型 ID。");
    })}>{busy?"处理中…":"拉取模型列表"}</Button>
    {!!models.length&&<label className="collaboration-field">选择模型<select disabled={busy} value={models.includes(config.model)?config.model:""} onChange={e=>{if(e.target.value)setConfig({...config,model:e.target.value});}}><option value="">请选择模型</option>{models.map(model=><option key={model} value={model}>{model}</option>)}</select></label>}
    <label className="collaboration-field">模型名称<Input disabled={busy} maxLength={200} value={config.model} placeholder="从列表选择，或手动填写模型 ID" onChange={e=>setConfig({...config,model:e.target.value})}/></label>
    <Button disabled={busy||!config.model.trim()||!endpoint} onClick={()=>void perform(async()=>{
      keyCheck.current++;
      const saved=await invoke<boolean>("team_ai_key",{...keyArgs,key:key.trim()||null});
      setKeyState({identity,status:saved?"saved":"missing"});
      if(!saved)throw new Error("请填写此配置的 API Key");
      const savedConfig={...config,endpoint,model:config.model.trim(),name:config.name?.trim()||configName(config),protocol:protocolOf(config)};
      const updated={...profiles,[selected||config.id||"legacy-active"]:savedConfig};
      localStorage.setItem(TEAM_AI_PROFILES,JSON.stringify(updated));
      localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify(savedConfig));
      setSelected(selected||config.id||"legacy-active");setConfig(savedConfig);setProfiles(updated);setKey("");notify();setMessage(`已保存并启用“${savedConfig.name}”。`);
    })}>保存模型配置</Button>
    <div className="team-ai-profile-actions">
      <Button variant="ghost" disabled={busy||!endpoint||keyStatus!=="saved"} onClick={()=>void perform(async()=>{
        keyCheck.current++;
        const remains=await invoke<boolean>("team_ai_key",{...keyArgs,key:""});
        setKeyState({identity,status:remains?"saved":"missing"});if(remains)throw new Error("Key 未删除，请重试");
        setKey("");notify();setMessage("此配置的 API Key 已删除。");
      })}>删除已保存的 Key</Button>
      <Button variant="ghost" disabled={busy||!selected} onClick={()=>void perform(async()=>{
        // Delete the saved profile's credential, even if the form endpoint was edited.
        const saved=profiles[selected];
        const remains=await invoke<boolean>("team_ai_key",{endpointUrl:saved.endpoint,profileId:saved.id??null,key:""});
        if(remains)throw new Error("Key 未删除，请重试");
        const updated={...profiles};delete updated[selected];
        const next=Object.values(updated)[0];
        localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify(next??{}));
        localStorage.setItem(TEAM_AI_PROFILES,JSON.stringify(updated));
        setSelected(Object.keys(updated)[0]??"");setProfiles(updated);setConfig(next??{endpoint:"",model:"",protocol:"responses",id:crypto.randomUUID()});resetDraft();notify();setMessage("配置已删除，其他配置保留。");
      })}>删除此配置</Button>
    </div>
    {message&&<p role="status">{message}</p>}
  </section>;
}
