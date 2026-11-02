// --- profiles protocol v1 ---
/**
 * Account profiles: several logins per coding agent (personal + work Claude,
 * more than one Codex). Mirrored byte for byte by web/src/types/profiles.ts.
 *
 * Requests: `profiles_list` -> ProfilesListResponse; `profile_login`
 * (ProfileLoginRequest) -> ProfileLoginResponse. Global event
 * `profiles_changed` (ProfilesListResponse) when the config's profiles change.
 * One-tap login: `profile_login_code` (ProfileLoginCodeRequest),
 * `profile_login_cancel` (ProfileLoginRequest), both -> ProfileLoginResponse;
 * `profile_login_status` -> ProfileLoginStatusResponse. Event
 * `profile_login_update` (ProfileLoginUpdate) goes only to clients allowed to
 * dispatch, because it can carry the sign-in link and device code.
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
  /** The login flow behind the session (absent on an older daemon). */
  flow?: ProfileLoginFlow;
}

export type ProfileLoginFlowState =
  | 'starting'
  | 'open_link'
  | 'awaiting_code'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface ProfileLoginFlow {
  /** New for each login attempt. */
  flowId: string;
  profileId: string;
  profileLabel: string;
  agent: ProfileAgent;
  state: ProfileLoginFlowState;
  /** Hidden tmux session running the login (the "Open terminal" fallback). */
  sessionName: string;
  startedAt: number;
  expiresAt: number;
  /** https sign-in link on an allowed host; dropped once the flow has ended. */
  url?: string;
  /** Codex: the one-time code to type on the website; dropped once ended. */
  deviceCode?: string;
  /** The login's output could not be read; the terminal is the way forward. */
  unparsed?: boolean;
  /** Plain text for the user; never contains terminal output. */
  message?: string;
}

export interface ProfileLoginCodeRequest {
  profileId: string;
  code: string;
}

export interface ProfileLoginStatusResponse {
  flows: ProfileLoginFlow[];
}

export interface ProfileLoginUpdate {
  flow: ProfileLoginFlow;
}

export const PROFILES_CHANGED_EVENT = 'profiles_changed';
export const PROFILE_LOGIN_UPDATE_EVENT = 'profile_login_update';
// --- end profiles protocol ---
