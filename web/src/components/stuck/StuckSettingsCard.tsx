import { useCallback, useEffect, useState } from 'react';
import { useStuckSettings } from '../../hooks/useStuck';
import { ensureStuckStore, stuckStore } from '../../services/stuckStore';
import { STUCK_DEFAULTS, STUCK_SETTING_RANGES } from '../../types/stuck';
import type { StuckSettings, StuckSettingsResponse } from '../../types/stuck';

type NumKey = Exclude<keyof StuckSettings, 'enabled'>;

const ADVANCED: Array<{ key: NumKey; label: string; unit: string }> = [
  { key: 'failureRepeats', label: 'Same failure, times', unit: '×' },
  { key: 'failureWindowMin', label: '... within', unit: 'min' },
  { key: 'loopRepeats', label: 'Same call + result, times', unit: '×' },
  { key: 'loopWindowMin', label: '... within', unit: 'min' },
  { key: 'oscillationFlips', label: 'Back-and-forth edits', unit: '×' },
  { key: 'oscillationWindowMin', label: '... within', unit: 'min' },
  { key: 'stalledBashMin', label: 'Hanging command after', unit: 'min' },
  { key: 'stalledToolMin', label: 'Hanging other tool after', unit: 'min' },
  { key: 'longCommandCapMin', label: 'Builds / tests / agents allowed', unit: 'min' },
];

/** Notification Settings: stuck-session detection (lives on the daemon). */
export function StuckSettingsCard({ serverId }: { serverId: string }) {
  const { settings, supported } = useStuckSettings(serverId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureStuckStore();
    void stuckStore.refresh(serverId);
  }, [serverId]);

  const save = useCallback(async (patch: Partial<StuckSettings>) => {
    setError(null);
    try {
      const r = await stuckStore.request<StuckSettingsResponse>(serverId, 'stuck_set_settings', { settings: patch });
      stuckStore.setSettings(serverId, r.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }, [serverId]);

  if (supported === false) return null;
  const s = settings ?? STUCK_DEFAULTS;
  const num = (key: NumKey) => (
    <input
      type="number"
      className="stuck-settings__num"
      min={STUCK_SETTING_RANGES[key][0]}
      max={STUCK_SETTING_RANGES[key][1]}
      defaultValue={s[key]}
      key={`${key}-${s[key]}`}
      disabled={!settings}
      onBlur={(e) => {
        const v = Number(e.currentTarget.value);
        if (Number.isFinite(v) && v !== s[key]) void save({ [key]: v });
      }}
      aria-label={key}
    />
  );

  return (
    <div className="notif-card stuck-settings">
      <div className="notif-card-top">
        <div>
          <div className="notif-card-name">Stuck sessions</div>
          <div className="notif-card-detail">
            Flag a working session that keeps failing the same way, repeats itself, undoes its own edits, or makes no progress. A soft tone plays on the active device; nothing is spoken. Quiet hours keep it silent.
          </div>
        </div>
        <label className="notif-toggle">
          <input type="checkbox" checked={s.enabled} disabled={!settings} onChange={(e) => void save({ enabled: e.target.checked })} />
          <span className="notif-toggle-slider" />
        </label>
      </div>
      {s.enabled && (
        <>
          <div className="stuck-settings__row">
            <span className="notif-card-detail">No progress after</span>
            {num('noProgressMin')}
            <span className="notif-card-detail">min</span>
          </div>
          <details className="stuck-settings__advanced">
            <summary>Advanced</summary>
            <div className="stuck-settings__grid">
              {ADVANCED.map((a) => (
                <label key={a.key} className="stuck-settings__row">
                  <span className="notif-card-detail">{a.label}</span>
                  {num(a.key)}
                  <span className="notif-card-detail">{a.unit}</span>
                </label>
              ))}
            </div>
            <button type="button" className="stuck-btn stuck-btn--quiet" onClick={() => { const { enabled: _e, ...rest } = STUCK_DEFAULTS; void save(rest); }}>
              Reset to defaults
            </button>
          </details>
        </>
      )}
      {error && <div className="notif-card-detail stuck-settings__error">{error}</div>}
    </div>
  );
}
