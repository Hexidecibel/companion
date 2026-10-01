import { useState } from 'react';
import type { HeraldDeviceControl } from '../../context/HeraldContext';
import { MAX_LABEL_CHARS } from '../../services/heraldDevice';

/** The bar is worth showing: several devices, another one in control, a pin, or a hand-off note. */
export function showDeviceBar(d: HeraldDeviceControl): boolean {
  if (!d.supported || !d.selfId) return false;
  return d.devices.length > 1 || !d.isActive || !!d.handoffNote || !!d.activeDevice?.pinned;
}

function activeName(d: HeraldDeviceControl): string {
  const a = d.activeDevice;
  if (!a) return 'No device';
  return a.id === d.selfId ? 'This device' : a.label;
}

/**
 * Which device is active (it plays tones, runs hands-free and gets remote
 * triggers), with "Take control" when it is another one and a pin toggle.
 */
export function HeraldDeviceBar({ device: d }: { device: HeraldDeviceControl }) {
  if (!showDeviceBar(d)) return null;
  const a = d.activeDevice;
  if (d.takeControlNudge && !d.isActive) {
    return (
      <div className="herald-device herald-device--nudge" role="status" aria-live="polite">
        <span className="herald-device__dot" aria-hidden="true" />
        <span className="herald-device__text" title={a ? `Active now: ${a.label}` : undefined}>
          Use Herald here?
        </span>
        <button
          type="button"
          className="herald-btn herald-btn--primary herald-btn--xs"
          onClick={() => { d.dismissNudge(); d.takeControl(); }}
        >
          Take control
        </button>
        <button type="button" className="herald-device__dismiss" onClick={d.dismissNudge} aria-label="Dismiss" title="Not now">
          {'\u00d7'}
        </button>
      </div>
    );
  }
  return (
    <div className={`herald-device${d.isActive ? ' herald-device--here' : ''}`} role="status" aria-live="polite">
      <span className="herald-device__dot" aria-hidden="true" />
      <span className="herald-device__text" title={a ? `${a.label}${a.pinned ? ' (pinned)' : ''}` : undefined}>
        {d.handoffNote && !d.isActive ? (
          <span className="herald-device__note">{d.handoffNote}</span>
        ) : (
          <>
            Active: <strong>{activeName(d)}</strong>
            {a?.pinned && <span className="herald-device__pin"> {'·'} pinned</span>}
          </>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={d.keepPinned}
        className="herald-device__keep"
        onClick={() => d.setKeepPinned(!d.keepPinned)}
        title={d.isActive
          ? 'Keep Herald on this device until another device takes control'
          : 'When you take control, keep it here until another device takes it'}
      >
        Keep on this device
        <span className={`herald-switch${d.keepPinned ? ' herald-switch--on' : ''}`} aria-hidden="true" />
      </button>
      {!d.isActive && (
        <button type="button" className="herald-btn herald-btn--primary herald-btn--xs" onClick={d.takeControl}>
          Take control
        </button>
      )}
    </div>
  );
}

/** Overflow-menu section: switch the active device, rename this one. */
export function HeraldDevicesMenu({ device: d, onDone }: { device: HeraldDeviceControl; onDone: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(d.label);
  if (!d.supported) return null;
  const save = () => {
    d.rename(draft);
    setRenaming(false);
  };
  return (
    <div className="herald-devices" role="group" aria-label="Devices">
      <div className="herald-menu__label">Devices</div>
      {d.devices.map((dev) => {
        const active = d.activeDevice?.id === dev.id;
        const self = dev.id === d.selfId;
        return (
          <button
            key={dev.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            className={`herald-menu__item herald-devices__item${active ? ' herald-devices__item--active' : ''}`}
            onClick={() => { if (!active || (d.keepPinned && !d.activeDevice?.pinned)) d.switchTo(dev.id); onDone(); }}
            title={active ? 'Active: plays tones, runs hands-free, gets remote triggers' : `Make ${self ? 'this device' : dev.label} the active device`}
          >
            <span className={`herald-devices__radio${active ? ' herald-devices__radio--on' : ''}`} aria-hidden="true" />
            <span className="herald-devices__name">{dev.label}</span>
            {self && <span className="herald-devices__tag">this device</span>}
            {active && d.activeDevice?.pinned && <span className="herald-devices__tag">pinned</span>}
            {dev.handsFree && <span className="herald-devices__tag herald-devices__tag--hf">hands-free</span>}
          </button>
        );
      })}
      {renaming ? (
        <form className="herald-devices__rename" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input
            className="herald-devices__input"
            value={draft}
            maxLength={MAX_LABEL_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Name for this device"
            placeholder="e.g. Windows PC"
            autoFocus
          />
          <button type="submit" className="herald-btn herald-btn--primary herald-btn--xs">Save</button>
        </form>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="herald-menu__item herald-menu__item--sub"
          onClick={() => { setDraft(d.label); setRenaming(true); }}
          title="The name other devices and remote triggers (device=) use for this one"
        >
          Rename this device ({d.label})
        </button>
      )}
    </div>
  );
}
