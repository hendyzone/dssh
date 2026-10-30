import { Button } from "./ui/button";
import { IconClose } from "./Icons";
import type { FileBookmark } from "../lib/bookmarks";
import type { ServerEntry } from "../types";
import "./FileBookmarks.css";

/** Icon-only entry plus the list of saved remote files. Rows say file and server; nothing explains. */
export default function FileBookmarks({bookmarks, servers, error, onOpen, onRemove, onClose}: {
  bookmarks: FileBookmark[];
  servers: ServerEntry[];
  error: string;
  onOpen: (bookmark: FileBookmark) => void;
  onRemove: (bookmark: FileBookmark) => void;
  onClose: () => void;
}) {
  return <div className="file-bookmarks" role="dialog" aria-label="文件书签">
    <div className="file-bookmarks-head">
      <strong>文件书签</strong>
      <Button variant="ghost" size="icon-sm" aria-label="关闭文件书签" title="关闭" onClick={onClose}><IconClose size={12}/></Button>
    </div>
    {error && <p className="file-bookmarks-error" role="alert">{error}</p>}
    {bookmarks.length === 0
      ? <p className="file-bookmarks-empty">暂无书签</p>
      : <ul className="file-bookmarks-list">
          {bookmarks.map(bookmark => {
            const server = servers.find(item => item.id === bookmark.serverId);
            const serverName = server?.name ?? bookmark.serverName;
            return <li key={bookmark.id}>
              <Button variant="ghost" size="sm" className="file-bookmark-open" aria-label={`打开书签 ${bookmark.title}`} title={`${bookmark.title}\n${serverName}\n${bookmark.path}`} onClick={() => onOpen(bookmark)}>
                <span className="file-bookmark-name">{bookmark.title}</span>
                <span className="file-bookmark-server" data-missing={server ? undefined : "true"}>{serverName}</span>
              </Button>
              <Button variant="ghost" size="icon-sm" className="file-bookmark-remove" aria-label={`取消收藏 ${bookmark.title}`} title="取消收藏" onClick={() => onRemove(bookmark)}><IconClose size={12}/></Button>
            </li>;
          })}
        </ul>}
  </div>;
}
