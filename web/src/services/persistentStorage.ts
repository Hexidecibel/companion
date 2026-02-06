import { isTauri } from '../utils/platform';

let tauriStore: any = null;
let storeLoaded = false;

/**
 * Initialize Tauri persistent store. Call once at startup before rendering.
 * On Tauri: restores saved data to localStorage so all existing sync code works.
 * On browser: no-op.
 */
export async function initStorage(): Promise<void> {
  if (!isTauri()) return;

  try {
    const { load } = await import('@tauri-apps/plugin-store');
    tauriStore = await load('companion-data.json', { defaults: {}, autoSave: true });

    // Restore Tauri store data to localStorage (survives WebView data clears)
    const keys: string[] = await tauriStore.keys();
    for (const key of keys) {
      if (key === '_store_init') continue;
      const value = await tauriStore.get(key);
      if (value !== null && value !== undefined) {
        localStorage.setItem(key, String(value));
      }
    }

    // If store was empty but localStorage has data, seed the store (first migration)
    if (keys.length === 0 && localStorage.length > 0) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          await tauriStore.set(key, localStorage.getItem(key));
        }
      }
      await tauriStore.set('_store_init', true);
    }

    storeLoaded = true;
  } catch (err) {
    console.log('Tauri store init failed, using localStorage only:', err);
  }
}

/** Write-through: saves to Tauri store after localStorage.setItem. */
export function syncToStore(key: string, value: string): void {
  if (!storeLoaded || !tauriStore) return;
  tauriStore.set(key, value).catch(() => {});
}

/** Remove from Tauri store after localStorage.removeItem. */
export function removeFromStore(key: string): void {
  if (!storeLoaded || !tauriStore) return;
  tauriStore.delete(key).catch(() => {});
}

/** Clear all data from Tauri store. */
export function clearStore(): void {
  if (!storeLoaded || !tauriStore) return;
  tauriStore.clear().catch(() => {});
}
