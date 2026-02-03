import { useState, useEffect } from 'react';
import { ConversationHighlight } from '../types';
import { ArchivedConversation, getArchives, deleteArchive, clearAllArchives } from '../services/archiveService';
import { MessageBubble } from './MessageBubble';

interface ArchiveModalProps {
  onClose: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ArchiveModal({ onClose }: ArchiveModalProps) {
  const [archives, setArchives] = useState<ArchivedConversation[]>([]);
  const [viewing, setViewing] = useState<ArchivedConversation | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  useEffect(() => {
    setArchives(getArchives());
  }, []);

  const handleDelete = (id: string) => {
    deleteArchive(id);
    setArchives(getArchives());
    if (viewing?.id === id) setViewing(null);
  };

  const handleClearAll = () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      return;
    }
    clearAllArchives();
    setArchives([]);
    setViewing(null);
    setConfirmClearAll(false);
  };

  if (viewing) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content archive-viewer" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{viewing.name}</h3>
            <div className="archive-viewer-actions">
              <button className="archive-back-btn" onClick={() => setViewing(null)}>
                {'\u2039'} Back
              </button>
              <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
            </div>
          </div>
          <div className="archive-viewer-meta">
            <span>{formatDate(viewing.savedAt)}</span>
            <span>{viewing.messageCount} messages</span>
          </div>
          <div className="archive-viewer-messages">
            {viewing.highlights.map((msg: ConversationHighlight) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content archive-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Archives ({archives.length})</h3>
          <div className="archive-header-actions">
            {archives.length > 0 && (
              <button
                className={`archive-clear-all-btn ${confirmClearAll ? 'confirming' : ''}`}
                onClick={handleClearAll}
              >
                {confirmClearAll ? 'Confirm' : 'Clear All'}
              </button>
            )}
            <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>

        <div className="archive-list-body">
          {archives.length === 0 && (
            <div className="archive-empty">No saved archives</div>
          )}
          {archives.map((arc) => (
            <div key={arc.id} className="archive-item">
              <div className="archive-item-info" onClick={() => setViewing(arc)}>
                <span className="archive-item-name">{arc.name}</span>
                <span className="archive-item-meta">
                  {formatDate(arc.savedAt)} -- {arc.messageCount} messages
                </span>
              </div>
              <button
                className="archive-item-delete"
                onClick={() => handleDelete(arc.id)}
                title="Delete archive"
              >
                {'\u2715'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
