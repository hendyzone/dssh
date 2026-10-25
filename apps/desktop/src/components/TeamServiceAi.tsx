import {useEffect, useRef, useState} from "react";
import {refreshServiceAi} from "../lib/teamService";
import type {ServiceAi} from "../lib/serviceAi";

const labels = {working: "工作中", waiting: "等待中", idle: "空闲", unknown: "未知"};
function relativeTime(value: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
/** Evidence is untrusted text, never HTML or Markdown. */
export default function TeamServiceAi({ai, enabled, target, compact = false}: {
  ai?: ServiceAi; enabled?: boolean | null;
  target?: {project: string; key: string; identity: string}; compact?: boolean;
}) {
  const [notice, setNotice] = useState("");
  const [disabledByService, setDisabledByService] = useState(false);
  const [pending, setPending] = useState(false);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const busy = useRef(false);
  const identity = target ? JSON.stringify([target.identity, target.project, target.key]) : "";
  useEffect(() => {
    generation.current++; busy.current = false;
    setNotice(""); setDisabledByService(false); setPending(false); setDeadline(0); setNow(Date.now());
    return () => { generation.current++; };
  }, [identity]);
  useEffect(() => {
    if (!ai && !deadline) return;
    const timer = window.setInterval(() => setNow(Date.now()), deadline ? 1000 : 60000);
    return () => window.clearInterval(timer);
  }, [ai?.updatedAt, deadline]);
  useEffect(() => {
    setNotice(previous => previous === "已请求，等待服务更新" ? "" : previous);
  }, [ai?.updatedAt, ai?.summary]);
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => { if (deadline && !remaining) setDeadline(0); }, [deadline, remaining]);
  const refresh = async () => {
    if (!target || busy.current || remaining || enabled === false || disabledByService) return;
    busy.current = true; setPending(true); setNotice("");
    const epoch = generation.current;
    try {
      const result = await refreshServiceAi(target.project, target.key);
      if (epoch !== generation.current) return;
      if (result.status === 202) setNotice("已请求，等待服务更新");
      else if (result.status === 429) {
        const seconds = Number.isInteger(result.retry_after) && result.retry_after! > 0 ? Math.min(3600, result.retry_after!) : 30;
        setNow(Date.now()); setDeadline(Date.now() + seconds * 1000); setNotice("请求受限，请稍后重试");
      } else if (result.status === 409 && result.code === "no_live_session") setNotice("该成员当前没有在线会话");
      else if (result.status === 503 && result.code === "ai_disabled") setDisabledByService(true);
      else setNotice("重新总结失败，请稍后重试");
    } catch { if (epoch === generation.current) setNotice("重新总结失败，请稍后重试"); }
    finally { if (epoch === generation.current) { busy.current = false; setPending(false); } }
  };
  return <span className="team-service-ai" data-ai-view={compact ? "row" : "detail"}>
    {(enabled === false || disabledByService) && <span>AI 摘要未启用</span>}
    {ai ? <><span className="team-service-ai-summary">{ai.summary || "暂无 AI 摘要"}</span>
      <small>{labels[ai.status]} · AI · {ai.model} · {relativeTime(ai.updatedAt, now)}</small>
      {!compact && ai.evidence && <details><summary>AI 摘要依据</summary><pre>{ai.evidence}</pre></details>}
    </> : enabled !== false && !disabledByService && <span>暂无 AI 摘要</span>}
    {target && <button type="button" disabled={pending || remaining > 0 || enabled === false || disabledByService} onClick={event => {event.preventDefault(); event.stopPropagation(); void refresh();}}>
      {pending ? "请求中…" : remaining ? `重新总结（${remaining} 秒）` : "重新总结"}
    </button>}
    {notice && <span role="status">{notice}</span>}
  </span>;
}
