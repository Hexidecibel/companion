import type { CodingAgent } from '../types';
import type { AccountProfileInfo } from '../types/profiles';

const PROFILE_STORAGE_PREFIX = 'new-session-profile:';

/** Last account profile picked for new sessions on a server (null = none stored). */
export function readStoredProfile(serverId: string): string | null {
  try {
    return localStorage.getItem(PROFILE_STORAGE_PREFIX + serverId);
  } catch {
    return null;
  }
}

export function writeStoredProfile(serverId: string, profileId: string) {
  try {
    localStorage.setItem(PROFILE_STORAGE_PREFIX + serverId, profileId);
  } catch {
    // ignore
  }
}

/**
 * The profile a new session uses: the stored one if it still exists, else the
 * default profile of `agent`.
 */
export function pickProfile(
  profiles: AccountProfileInfo[],
  stored: string | null,
  agent: CodingAgent,
): AccountProfileInfo | undefined {
  return (
    profiles.find((p) => p.id === stored) ??
    profiles.find((p) => p.isDefault && p.agent === agent)
  );
}

/** Button text: defaults keep "Claude" / "Codex"; others show their label + agent. */
export function profileButtonLabel(p: AccountProfileInfo): string {
  if (p.isDefault) return p.agent === 'codex' ? 'Codex' : 'Claude';
  return p.label;
}

interface ProfilePickerProps {
  profiles: AccountProfileInfo[];
  value: string | undefined;
  onChange: (profile: AccountProfileInfo) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Account choice for New Session / New Project, shown instead of the
 * Claude / Codex row once more than the default profiles exist. The agent
 * follows the profile.
 */
export function ProfilePicker({ profiles, value, onChange, disabled, className }: ProfilePickerProps) {
  return (
    <div
      className={`new-session-agent-row new-session-profile-row${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label="Account"
    >
      <span className="new-session-agent-label">Account</span>
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className={`new-session-agent-btn ${value === p.id ? 'active' : ''}`}
          onClick={() => onChange(p)}
          disabled={disabled}
          title={`${p.agent === 'codex' ? 'Codex' : 'Claude Code'}: ${p.home}${p.loginState === 'logged_out' ? ' (not logged in)' : ''}`}
        >
          {profileButtonLabel(p)}
          {!p.isDefault && (
            <span className="new-session-profile-agent"> {p.agent === 'codex' ? 'Codex' : 'Claude'}</span>
          )}
          {p.loginState === 'logged_out' && <span className="new-session-profile-warn" aria-label="not logged in"> !</span>}
        </button>
      ))}
    </div>
  );
}

/** "Work" badge for a session under a non-default profile. */
export function ProfileBadge({ label, className }: { label?: string; className?: string }) {
  if (!label) return null;
  return (
    <span className={`session-profile-badge${className ? ` ${className}` : ''}`} title={`Account: ${label}`}>
      {label}
    </span>
  );
}
