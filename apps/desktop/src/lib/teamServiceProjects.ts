import type {TeamServiceState} from "./teamService";

export function teamProjectIssue(service: TeamServiceState, project: string): string | undefined {
  if (!service.url || !service.catalog) return;
  if (service.catalog.state === "unknown") return "正在核对团队服务项目…";
  if (service.catalog.state === "error") return service.catalog.message;
  if (!service.catalog.projects.includes(project)) return `团队服务中没有项目 ${project}，或当前令牌无权访问。`;
}
