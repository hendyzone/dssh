import { AppDialog } from "./ui/app-dialog";
import { Button } from "./ui/button";
import type { UpdateOffer } from "../lib/appUpdater";

export type UpdatePromptState =
  | { kind: "idle" }
  | { kind: "offer"; offer: UpdateOffer; linkOnly: boolean }
  | { kind: "progress"; message: string }
  | { kind: "error"; message: string };

interface Props {
  state: UpdatePromptState;
  onLater: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
}

/** 有新版时的提示；无新版时不渲染。 */
export default function UpdatePrompt({ state, onLater, onInstall, onOpenRelease }: Props) {
  if (state.kind === "idle") return null;
  if (state.kind === "progress") {
    return (
      <AppDialog title="正在更新" onClose={() => {}} busy>
        <p role="status">{state.message}</p>
      </AppDialog>
    );
  }
  if (state.kind === "error") {
    return (
      <AppDialog title="更新失败" onClose={onLater}>
        <p role="alert">{state.message}</p>
        <div className="modal-actions">
          <Button onClick={onLater}>关闭</Button>
        </div>
      </AppDialog>
    );
  }
  const { offer, linkOnly } = state;
  return (
    <AppDialog title={`发现新版本 ${offer.version}`} onClose={onLater}>
      {offer.notes ? <pre className="update-notes">{offer.notes}</pre> : null}
      {linkOnly ? (
        <p>此安装方式不支持自动更新</p>
      ) : (
        <p>更新后将自动重启</p>
      )}
      <div className="modal-actions">
        <Button variant="ghost" onClick={onLater}>
          稍后
        </Button>
        {linkOnly ? (
          <Button onClick={onOpenRelease}>打开下载页</Button>
        ) : (
          <Button onClick={onInstall}>更新</Button>
        )}
      </div>
    </AppDialog>
  );
}
