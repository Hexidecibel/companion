import { Server } from '../types';

const SERVERS_KEY = 'companion_servers';
const FONT_SCALE_KEY = 'companion_font_scale';

export function getServers(): Server[] {
  try {
    const json = localStorage.getItem(SERVERS_KEY);
    if (json) {
      return JSON.parse(json);
    }
  } catch (error) {
    console.error('Error loading servers:', error);
  }
  return [];
}

export function saveServers(servers: Server[]): void {
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
  } catch (error) {
    console.error('Error saving servers:', error);
  }
}

export function addServer(server: Server): void {
  const servers = getServers();
  servers.push(server);
  saveServers(servers);
}

export function updateServer(server: Server): void {
  const servers = getServers();
  const index = servers.findIndex((s) => s.id === server.id);
  if (index !== -1) {
    servers[index] = server;
    saveServers(servers);
  }
}

export function deleteServer(id: string): void {
  const servers = getServers();
  const filtered = servers.filter((s) => s.id !== id);
  saveServers(filtered);
}

export function getFontScale(): number {
  try {
    const val = localStorage.getItem(FONT_SCALE_KEY);
    if (val) return parseFloat(val) || 1;
  } catch {
    // ignore
  }
  return 1;
}

export function saveFontScale(scale: number): void {
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(scale));
    document.documentElement.style.setProperty('--font-scale', String(scale));
  } catch {
    // ignore
  }
}

/** Apply saved font scale to CSS custom property on startup */
export function applyFontScale(): void {
  const scale = getFontScale();
  if (scale !== 1) {
    document.documentElement.style.setProperty('--font-scale', String(scale));
  }
}
