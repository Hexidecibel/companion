import { useState, useEffect, useCallback } from 'react';
import { openFilesService, OpenFile } from '../services/openFiles';

interface UseOpenFilesReturn {
  openFiles: OpenFile[];
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  closeAllFiles: () => void;
}

export function useOpenFiles(serverId: string | null, sessionId: string | null): UseOpenFilesReturn {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);

  // Load from storage on session change
  useEffect(() => {
    if (!serverId || !sessionId) {
      setOpenFiles([]);
      return;
    }
    setOpenFiles(openFilesService.getFiles(serverId, sessionId));
  }, [serverId, sessionId]);

  const openFile = useCallback(
    (path: string) => {
      if (serverId && sessionId) {
        openFilesService.openFile(serverId, sessionId, path);
        setOpenFiles(openFilesService.getFiles(serverId, sessionId));
      }
    },
    [serverId, sessionId],
  );

  const closeFile = useCallback(
    (path: string) => {
      if (serverId && sessionId) {
        openFilesService.closeFile(serverId, sessionId, path);
        setOpenFiles(openFilesService.getFiles(serverId, sessionId));
      }
    },
    [serverId, sessionId],
  );

  const closeAllFiles = useCallback(() => {
    if (serverId && sessionId) {
      openFilesService.closeAllFiles(serverId, sessionId);
      setOpenFiles([]);
    }
  }, [serverId, sessionId]);

  return { openFiles, openFile, closeFile, closeAllFiles };
}
