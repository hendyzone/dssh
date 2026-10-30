import { Crown, Gauge, Users } from "lucide-react";
import { IconChanges, IconFolder, IconForward, IconMonitor, IconTasks } from "./Icons";

/** Same glyphs as the previous tool rail, keyed by the shared panel registry. */
export default function PanelIcon({id}: {id: string}) {
  if (id === "adventure") return <Crown size={18}/>;
  if (id === "team") return <Users size={18}/>;
  if (id === "quota") return <Gauge size={18}/>;
  if (id === "sftp") return <IconFolder/>;
  if (id === "forward") return <IconForward/>;
  if (id === "tasks") return <IconTasks/>;
  if (id === "changes") return <IconChanges/>;
  if (id === "monitor") return <IconMonitor/>;
  if (id === "connections") return <span aria-hidden="true">▤</span>;
  if (id === "tmux") return <span aria-hidden="true">tm</span>;
  if (id === "collaboration") return <span aria-hidden="true">协</span>;
  return <span aria-hidden="true">•</span>;
}
