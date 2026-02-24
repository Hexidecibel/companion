import { useState, useEffect, useRef, useMemo } from 'react';
import { connectionManager } from '../services/ConnectionManager';

// Module-level cache so results persist across components/renders
// serverId -> (path -> exists)
const existenceCache = new Map<string, Map<string, boolean>>();

// Track in-flight requests to avoid duplicate calls across components
// serverId -> Set of paths currently being checked
const inflightPaths = new Map<string, Set<string>>();

// Pending callbacks for in-flight paths: serverId -> (path -> callbacks[])
const inflightCallbacks = new Map<string, Map<string, Array<(exists: boolean) => void>>>();

export function useFileExistence(serverId: string | undefined, paths: string[]): Set<string> {
  const [existingFiles, setExistingFiles] = useState<Set<string>>(new Set());
  const checkedRef = useRef<Set<string>>(new Set());

  // Stable dependency: join paths to avoid array reference issues
  const pathsKey = useMemo(() => paths.join('\n'), [paths]);

  useEffect(() => {
    if (!serverId || paths.length === 0) return;

    // Get or create server cache
    if (!existenceCache.has(serverId)) {
      existenceCache.set(serverId, new Map());
    }
    const serverCache = existenceCache.get(serverId)!;

    // Get or create inflight tracking
    if (!inflightPaths.has(serverId)) {
      inflightPaths.set(serverId, new Set());
    }
    const serverInflight = inflightPaths.get(serverId)!;

    if (!inflightCallbacks.has(serverId)) {
      inflightCallbacks.set(serverId, new Map());
    }
    const serverCallbacks = inflightCallbacks.get(serverId)!;

    // Split into cached, in-flight, and unchecked
    const unchecked: string[] = [];
    const known = new Set<string>();

    for (const p of paths) {
      if (serverCache.has(p)) {
        if (serverCache.get(p)) known.add(p);
      } else if (serverInflight.has(p)) {
        // Path is already being checked by another component — register a callback
        if (!serverCallbacks.has(p)) {
          serverCallbacks.set(p, []);
        }
        serverCallbacks.get(p)!.push((exists) => {
          if (exists) {
            setExistingFiles(prev => {
              const next = new Set(prev);
              next.add(p);
              return next;
            });
          }
        });
      } else if (!checkedRef.current.has(p)) {
        unchecked.push(p);
        checkedRef.current.add(p);
      }
    }

    // Apply cached results immediately
    if (known.size > 0) {
      setExistingFiles(prev => {
        const next = new Set(prev);
        let changed = false;
        known.forEach(p => {
          if (!next.has(p)) { next.add(p); changed = true; }
        });
        return changed ? next : prev;
      });
    }

    // Check unchecked paths via daemon
    if (unchecked.length > 0) {
      // Mark as in-flight
      unchecked.forEach(p => serverInflight.add(p));

      const conn = connectionManager.getConnection(serverId);
      if (conn) {
        conn.sendRequest('check_files_exist', { paths: unchecked })
          .then((response) => {
            if (response.success && response.payload) {
              const results = (response.payload as { results: Record<string, boolean> }).results;
              const newExisting = new Set<string>();
              for (const [filePath, exists] of Object.entries(results)) {
                serverCache.set(filePath, exists);
                if (exists) newExisting.add(filePath);

                // Notify any waiting callbacks
                const callbacks = serverCallbacks.get(filePath);
                if (callbacks) {
                  callbacks.forEach(cb => cb(exists));
                  serverCallbacks.delete(filePath);
                }

                // Remove from in-flight
                serverInflight.delete(filePath);
              }
              if (newExisting.size > 0) {
                setExistingFiles(prev => {
                  const next = new Set(prev);
                  let changed = false;
                  newExisting.forEach(p => {
                    if (!next.has(p)) { next.add(p); changed = true; }
                  });
                  return changed ? next : prev;
                });
              }
            } else {
              // Request failed — remove from inflight so they can be retried
              unchecked.forEach(p => serverInflight.delete(p));
            }
          })
          .catch(() => {
            // On error, remove from inflight, don't highlight anything
            unchecked.forEach(p => serverInflight.delete(p));
          });
      } else {
        // No connection — remove from inflight
        unchecked.forEach(p => serverInflight.delete(p));
      }
    }
  }, [serverId, pathsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return existingFiles;
}
