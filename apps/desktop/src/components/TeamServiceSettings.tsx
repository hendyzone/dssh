import {useEffect,useRef,useState} from "react";
import {configureTeamService,normalizeServiceUrl,ProjectValidationError,subscribeTeamService,useTeamService,visibleProjects} from "../lib/teamService";
import {Button} from "./ui/button";
import {Input} from "./ui/input";

export default function TeamServiceSettings(){
  const service=useTeamService();
  const [url,setUrl]=useState(service.url);
  const [token,setToken]=useState("");
  const [selected,setSelected]=useState(service.projects);
  const [available,setAvailable]=useState<string[]|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const generation=useRef(0);
  const pendingSaveUrl=useRef<string>();
  useEffect(()=>{if(pendingSaveUrl.current!==service.url){generation.current++;pendingSaveUrl.current=undefined;setBusy(false);setMessage("");}setUrl(service.url);setToken("");setAvailable(null);setSelected(service.projects);},[service.url]);
  useEffect(()=>setSelected(service.projects),[service.projects]);
  useEffect(()=>()=>{generation.current++;},[]);
  const sameUrl=(()=>{try{return normalizeServiceUrl(url)===service.url;}catch{return false;}})();
  const projects=available ?? (!token&&sameUrl&&service.catalog?.state==="ready"?service.catalog.projects:null);
  const invalidate=()=>{generation.current++;setAvailable(null);setSelected([]);setMessage("");};
  const errorText=(error:unknown)=>error instanceof ProjectValidationError?error.message:"团队服务操作失败，请检查地址和令牌。";
  return <fieldset><legend>团队服务</legend>
    <p>连接团队服务，勾选需要订阅的项目。</p>
    <label className="collaboration-field">团队服务地址<Input value={url} disabled={busy} placeholder="https://team.example.invalid/api/v1" onChange={event=>{invalidate();setUrl(event.target.value);}}/></label>
    <p>令牌：{service.status.token_configured?"已配置":"未配置"}</p>
    <label className="collaboration-field">团队服务令牌<Input type="password" autoComplete="new-password" value={token} disabled={busy} placeholder="输入新令牌；留空使用已配置令牌" onChange={event=>{invalidate();setToken(event.target.value);}}/></label>
    <Button disabled={busy||!url.trim()||(!token&&(!sameUrl||!service.status.token_configured))} onClick={async()=>{
      const epoch=++generation.current;setBusy(true);setMessage("");
      try{const result=await visibleProjects(token?{url:normalizeServiceUrl(url),token}:undefined);if(epoch===generation.current){setAvailable(result);setSelected(current=>current.filter(name=>result.includes(name)));}}
      catch(error){if(epoch===generation.current){setAvailable(null);setMessage(errorText(error));}}
      finally{if(epoch===generation.current)setBusy(false);}
    }}>读取可见项目</Button>
    {projects && <fieldset><legend>订阅项目</legend>{projects.length?projects.map(project=><label className="collaboration-toggle" key={project}>
      <input type="checkbox" disabled={busy} checked={selected.includes(project)} onChange={event=>setSelected(current=>event.target.checked?[...current,project]:current.filter(name=>name!==project))}/>{project}
    </label>):<p>当前令牌没有可见项目。</p>}</fieldset>}
    <Button disabled={busy||projects===null||(!token&&!sameUrl)} onClick={async()=>{
      const credential=token;pendingSaveUrl.current=normalizeServiceUrl(url);setToken("");setBusy(true);setMessage("");const epoch=generation.current;
      try{if(credential)await configureTeamService(url,credential,selected);else await subscribeTeamService(selected);if(epoch===generation.current)setMessage("已保存团队订阅。");}
      catch(error){if(epoch===generation.current)setMessage(errorText(error));}
      finally{if(epoch===generation.current){pendingSaveUrl.current=undefined;setBusy(false);}}
    }}>保存团队订阅</Button>
    {message&&<p role="status">{message}</p>}
  </fieldset>;
}
