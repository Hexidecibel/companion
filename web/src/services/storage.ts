import { Server } from '../types';

const SERVERS_KEY = 'companion_servers';

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
