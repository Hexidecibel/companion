import { Bookmark } from '../hooks/useBookmarks';

interface BookmarkListProps {
  bookmarks: Bookmark[];
  onNavigate: (messageId: string) => void;
  onRemove: (messageId: string) => void;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function BookmarkList({ bookmarks, onNavigate, onRemove, onClose }: BookmarkListProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="bookmark-list-dropdown">
        <div className="bookmark-list-empty">No bookmarks yet</div>
      </div>
    );
  }

  return (
    <div className="bookmark-list-dropdown">
      {bookmarks.map(bm => (
        <div key={bm.messageId} className="bookmark-list-item" onClick={() => { onNavigate(bm.messageId); onClose(); }}>
          <div className="bookmark-list-content">
            {bm.content.slice(0, 80)}{bm.content.length > 80 ? '...' : ''}
          </div>
          <div className="bookmark-list-meta">
            <span className="bookmark-list-time">{timeAgo(bm.timestamp)}</span>
            <button
              className="bookmark-list-remove"
              onClick={(e) => { e.stopPropagation(); onRemove(bm.messageId); }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
