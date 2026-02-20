import { useState, useCallback } from 'react';
import { bookmarksKey } from '../services/storageKeys';

export interface Bookmark {
  messageId: string;
  sessionId: string;
  content: string;
  timestamp: number;
}

const storageKey = bookmarksKey;

function loadBookmarks(serverId: string): Bookmark[] {
  try {
    const raw = localStorage.getItem(storageKey(serverId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveBookmarks(serverId: string, bookmarks: Bookmark[]) {
  if (bookmarks.length === 0) {
    localStorage.removeItem(storageKey(serverId));
  } else {
    localStorage.setItem(storageKey(serverId), JSON.stringify(bookmarks));
  }
}

export function useBookmarks(serverId: string | null) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() =>
    serverId ? loadBookmarks(serverId) : []
  );

  const addBookmark = useCallback((messageId: string, sessionId: string, content: string) => {
    if (!serverId) return;
    const bm: Bookmark = { messageId, sessionId, content, timestamp: Date.now() };
    const updated = [...bookmarks, bm];
    setBookmarks(updated);
    saveBookmarks(serverId, updated);
  }, [serverId, bookmarks]);

  const removeBookmark = useCallback((messageId: string) => {
    if (!serverId) return;
    const updated = bookmarks.filter(b => b.messageId !== messageId);
    setBookmarks(updated);
    saveBookmarks(serverId, updated);
  }, [serverId, bookmarks]);

  const isBookmarked = useCallback((messageId: string) => {
    return bookmarks.some(b => b.messageId === messageId);
  }, [bookmarks]);

  const sessionBookmarks = useCallback((sessionId: string) => {
    return bookmarks.filter(b => b.sessionId === sessionId);
  }, [bookmarks]);

  return { bookmarks, addBookmark, removeBookmark, isBookmarked, sessionBookmarks };
}
