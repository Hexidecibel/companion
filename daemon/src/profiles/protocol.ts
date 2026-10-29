// --- profiles protocol v1 ---
/**
 * Account profiles: several logins per coding agent (personal + work Claude,
 * more than one Codex). Mirrored byte for byte by web/src/types/profiles.ts.
 *
 * Requests: `profiles_list` -> ProfilesListResponse; `profile_login`
 * (ProfileLoginRequest) -> ProfileLoginResponse. Global event
 * `profiles_changed` (ProfilesListResponse) when the config's profiles change.
 * Optional fields elsewhere: `profileId` on create_tmux_session /
 * scaffold_open_session; `profileId` + `profileLabel` on summary sessions
 * (only for a non-default profile).
 */

export type ProfileAgent = 'claude' | 'codex';

/**
 * logged_in = the agent's credentials file exists in the profile home (never
 * read); api_key = the profile's env / env file sets the agent's API key
 * variable (names only); logged_out = neither.
 */
export type ProfileLoginState = 'logged_in' | 'api_key' | 'logged_out';

export interface AccountProfileInfo {
  id: string;
  label: string;
  agent: ProfileAgent;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME of the profile. */
  home: string;
  /** The implicit profile of each agent (code_home / the Codex home). */
  isDefault: boolean;
  loginState: ProfileLoginState;
  /** Variable NAMES the profile sets (env + env file); never values. */
  envKeys?: string[];
}

export interface ProfilesListResponse {
  profiles: AccountProfileInfo[];
}

export interface ProfileLoginRequest {
  profileId: string;
}

export interface ProfileLoginResponse {
  /** tmux session running the agent's login in the profile's environment. */
  sessionName: string;
  /** What runs there (for display). */
  command: string;
  /** The login session was already open. */
  alreadyRunning?: boolean;
}

export const PROFILES_CHANGED_EVENT = 'profiles_changed';
// --- end profiles protocol ---
