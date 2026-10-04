import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useServers } from '../../hooks/useServers';
import { eventBus } from '../../utils/eventBus';
import { SETUP_DISMISSED_KEY } from '../../services/storageKeys';

const SetupWizard = lazy(() => import('./SetupWizard').then((m) => ({ default: m.SetupWizard })));

/** Saved servers can arrive a moment after start (native store write-through). */
const FIRST_RUN_DELAY_MS = 800;

function dismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(SETUP_DISMISSED_KEY, '1');
  } catch {
    /* private mode: it may open again next time, which is fine */
  }
}

/**
 * Opens the setup wizard: by itself on a device with no servers (first app
 * launch), and on request from Settings > Setup for a connected server.
 */
export function SetupHost() {
  const { servers } = useServers();
  const [open, setOpen] = useState<{ serverId?: string } | null>(null);
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    const t = setTimeout(() => {
      if (serversRef.current.length === 0 && !dismissed()) setOpen({});
    }, FIRST_RUN_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => eventBus.on('open-setup', ({ serverId }) => setOpen({ serverId })), []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SetupWizard
        serverId={open.serverId}
        onClose={() => {
          if (!open.serverId) markDismissed();
          setOpen(null);
        }}
      />
    </Suspense>
  );
}
