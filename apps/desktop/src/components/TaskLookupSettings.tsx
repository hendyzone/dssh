import {useEffect,useState} from "react";
import {boardSource,boardUrlError,clearBoardCache,listProjects,saveLookupSettings,useLookupSettings} from "../lib/taskLookup";
import {Button} from "./ui/button";
import {Input} from "./ui/input";

export default function TaskLookupSettings(){
  const settings=useLookupSettings();
  const [url,setUrl]=useState(settings.boardUrl);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>setUrl(settings.boardUrl),[settings.boardUrl]);
  return <fieldset><legend>看板</legend>
    <p>任务查询只通过本机直连看板。</p>
    <label className="collaboration-field">本机可访问的看板地址<Input value={url} placeholder="https://board.example.invalid" onChange={event=>{setUrl(event.target.value);setMessage("");}}/></label>
    <Button disabled={busy||!!boardUrlError(url)} onClick={()=>{try{saveLookupSettings({boardUrl:url});clearBoardCache();setMessage("已保存看板地址。");}catch{setMessage("看板地址无效。");}}}>保存地址</Button>
    <Button disabled={busy||!url.trim()||!!boardUrlError(url)} onClick={async()=>{
      const source=boardSource({...settings,boardUrl:url});if(!source)return;setBusy(true);
      try{const projects=await listProjects(source,true);setMessage(`连接成功：${projects.length} 个项目。`);}catch{setMessage("看板连接失败，请检查地址。");}finally{setBusy(false);}
    }}>测试连接</Button>
    <label className="collaboration-toggle"><input type="checkbox" checked={settings.terminalLinks} onChange={event=>saveLookupSettings({terminalLinks:event.target.checked})}/>识别终端里的任务编号</label>
    {message&&<p role="status">{message}</p>}
  </fieldset>;
}
