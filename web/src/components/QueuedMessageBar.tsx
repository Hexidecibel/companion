import { useState } from 'react';
import { QueuedMessage } from '../services/messageQueue';

interface QueuedMessageBarProps {
  messages: QueuedMessage[];
  onCancel: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onClearAll: () => void;
}

export function QueuedMessageBar({ messages, onCancel, onEdit, onClearAll }: QueuedMessageBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  if (messages.length === 0) return null;

  const startEdit = (msg: QueuedMessage) => {
    setEditingId(msg.id);
    setEditText(msg.text);
  };

  const saveEdit = () => {
    if (editingId && editText.trim()) {
      onEdit(editingId, editText.trim());
      setEditingId(null);
      setEditText('');
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  return (
    <div className="queued-bar">
      <div className="queued-bar-header">
        <span className="queued-bar-count">
          {messages.length} queued message{messages.length !== 1 ? 's' : ''}
        </span>
        {messages.length > 1 && (
          <button className="queued-bar-clear" onClick={onClearAll}>
            Clear All
          </button>
        )}
      </div>
      {messages.map((msg, i) => {
        const isEditing = editingId === msg.id;
        const preview = msg.text.length > 80 ? msg.text.slice(0, 80) + '...' : msg.text;

        return (
          <div key={msg.id} className="queued-bar-item">
            {isEditing ? (
              <div className="queued-bar-edit">
                <textarea
                  className="queued-bar-textarea"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  autoFocus
                  rows={2}
                />
                <div className="queued-bar-edit-actions">
                  <button className="queued-bar-save" onClick={saveEdit}>Save</button>
                  <button className="queued-bar-cancel-edit" onClick={cancelEdit}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <span className="queued-bar-preview">
                  {i === 0 ? 'Next: ' : ''}{preview}
                </span>
                <div className="queued-bar-actions">
                  <button className="queued-bar-edit-btn" onClick={() => startEdit(msg)} title="Edit">
                    Edit
                  </button>
                  <button className="queued-bar-cancel" onClick={() => onCancel(msg.id)} title="Cancel">
                    &times;
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
