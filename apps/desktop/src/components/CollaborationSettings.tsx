import { useState } from "react";
import type { ServerEntry } from "../types";
import { emptyProfile, loadCollaboration, saveCollaboration, type CollaborationProfile } from "../lib/collaboration";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./Collaboration.css";

export default function CollaborationSettings({servers}: {servers:ServerEntry[]}) {
  const [serverId,setServerId]=useState(servers[0]?.id ?? "");
  const [profile,setProfile]=useState(()=>loadCollaboration()[serverId] ?? emptyProfile());
  const [message,setMessage]=useState("");
  const update=(patch:Partial<CollaborationProfile>)=>{setProfile(p=>({...p,...patch}));setMessage("");};
  const field=(key:keyof CollaborationProfile,label:string,placeholder:string)=>(
    <label className="collaboration-field" key={key}>{label}<Input value={String(profile[key])} placeholder={placeholder} onChange={e=>update({[key]:e.target.value})}/></label>
  );
  return <div className="collaboration-settings">
    <p>可选功能，默认关闭。通过当前 SSH 连接调用远端服务；每台服务器分别配置。</p>
    {!servers.length ? <p>先添加服务器，再配置 Agent 协作。</p> : <>
      <label className="collaboration-field">服务器<select value={serverId} onChange={e=>{setServerId(e.target.value);setProfile(loadCollaboration()[e.target.value]??emptyProfile());setMessage("");}}>
        {servers.map(s=><option key={s.id} value={s.id}>{s.name} · {s.host}</option>)}
      </select></label>
      <label className="collaboration-toggle"><input type="checkbox" checked={profile.enabled} onChange={e=>update({enabled:e.target.checked})}/> 开启此服务器的 Agent 协作</label>
      {field("project","项目编号","与看板和 amail 中的项目一致")}
      {field("workdir","远端工作目录","/srv/workspace/my-project")}
      <fieldset><legend><label className="collaboration-toggle"><input type="checkbox" checked={profile.taskboardEnabled} onChange={e=>update({taskboardEnabled:e.target.checked})}/> 任务看板</label></legend>
        {profile.taskboardEnabled&&<>
          {field("taskboardUrl","看板服务地址（从远端访问）","https://taskboard.example.com")}
          {field("taskboardBin","taskboard 命令或绝对路径","taskboard")}
          {field("tokenFile","远端令牌文件（可选）","/path/to/taskboard-token")}
        </>}
      </fieldset>
      <fieldset><legend><label className="collaboration-toggle"><input type="checkbox" checked={profile.mailEnabled} onChange={e=>update({mailEnabled:e.target.checked})}/> Agent 通信 · amail</label></legend>
        {profile.mailEnabled&&<>
          {field("pythonBin","远端 Python 命令","python3")}
          {field("mailctlPath","mailctl.py 远端路径","/srv/workspace/amail/client/mailctl.py")}
          <p>使用该工作目录已有的 .agent-mail 邮箱身份，密码留在远端。</p>
        </>}
      </fieldset>
      <Button onClick={()=>{try{saveCollaboration(serverId,profile);setMessage(profile.enabled?"已保存并开启；连接服务器后从工具栏打开 Agent 协作。":"已保存，Agent 协作保持关闭。");}catch(e){setMessage(String(e));}}}>保存协作配置</Button>
      {message&&<p role="status">{message}</p>}
      <p>关闭并保存后停止后续查询；已提交的操作可能仍在远端完成。配置仅保存在本机，不随连接备份自动开启。</p>
    </>}
  </div>;
}
