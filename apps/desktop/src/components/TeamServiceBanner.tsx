import type { TeamServiceProject, TeamServiceStatus } from '../lib/teamService';

export default function TeamServiceBanner({ project, status }: { project?: TeamServiceProject; status: TeamServiceStatus }) {
  if (status.state === 'unauthorized') return <p role="alert">团队服务令牌已失效，请在设置中重新配置。</p>;
  if (status.state === 'offline' || project?.offline) {
    const time = project?.receivedAt;
    return <p role="status">团队服务离线 · {typeof time === 'number'
      ? `数据截至 ${new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : '数据时间未知'}</p>;
  }
  if (status.state === 'connecting') return <p role="status">正在连接团队服务…</p>;
  if (status.state === 'error') return <p role="alert">团队服务暂不可用，请检查服务配置。</p>;
  return null;
}
