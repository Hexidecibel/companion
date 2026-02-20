// Centralized localStorage key constants
// All localStorage keys should be defined here to prevent typos and duplication

// Static keys
export const SERVERS_KEY = 'companion_servers';
export const FONT_SCALE_KEY = 'companion_font_scale';
export const OPEN_FILES_KEY = 'companion_open_files';
export const DEVICE_ID_KEY = 'companion_device_id';
export const BROWSER_NOTIFICATIONS_KEY = 'companion_browser_notifications';
export const RECENT_DIRS_KEY = 'companion_recent_dirs';
export const HISTORY_KEY = 'companion_history';
export const AWAY_KEY = 'companion_last_active';
export const AUTO_APPROVE_KEY = 'companion_auto_approve_sessions';
export const SIDEBAR_WIDTH_KEY = 'companion_sidebar_width';

// Dynamic key builders
export function bookmarksKey(serverId: string): string {
  return `companion_bookmarks:${serverId}`;
}

export function hideToolsKey(sessionId: string): string {
  return `hideTools:${sessionId}`;
}

export function crmCommentsKey(sessionId: string): string {
  return `crm-comments:${sessionId}`;
}
