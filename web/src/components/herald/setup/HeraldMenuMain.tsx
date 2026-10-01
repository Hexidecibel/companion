import { useState } from 'react';
import { useHeraldData, useHeraldSetupCtx, useHeraldVoiceCtx, useHeraldVoiceInputCtx } from '../../../context/HeraldContext';
import { PROFILES, type ProfileId } from '../../../services/heraldSetup/profiles';
import { heraldSetupStore, overlayEnabled, setOverlayEnabled } from '../../../services/heraldSetup/setupStore';
import { nativeHeraldStore, useNativeHeraldState } from '../../../hooks/useNativeHerald';
import { HeraldVolumeSlider } from '../HeraldVolume';
import {
  IconBrief,
  IconCheckup,
  IconChevron,
  IconDeskSpeaker,
  IconDevice,
  IconGamepad,
  IconHeadphones,
  IconHelp,
  IconListen,
  IconPhone,
  IconSliders,
  IconSpeaker,
} from '../heraldIcons';

const PROFILE_ICON: Record<ProfileId, (p: { size?: number }) => JSX.Element> = {
  headphones: IconHeadphones,
  desk: IconDeskSpeaker,
  gaming: IconGamepad,
  phone: IconPhone,
};

function Switch({ on }: { on: boolean }) {
  return <span className={`herald-switch${on ? ' herald-switch--on' : ''}`} aria-hidden="true" />;
}

/**
 * The Herald menu's main view: the profile, who is in control, voice, volume and
 * hands-free, Brief me, the device check and Help. Every other knob lives in
 * Advanced.
 */
export function HeraldMenuMain({ onClose, onAdvanced }: { onClose: () => void; onAdvanced: () => void }) {
  const setup = useHeraldSetupCtx();
  const voice = useHeraldVoiceCtx();
  const input = useHeraldVoiceInputCtx();
  const { device, briefMe, available } = useHeraldData();
  const [picking, setPicking] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const current = setup.state.profile;
  const CurrentIcon = current ? PROFILE_ICON[current] : IconSliders;

  const pick = (id: ProfileId) => {
    setNotes(setup.applyProfile(id));
    setPicking(false);
  };

  return (
    <div className="hm" role="group" aria-label="Herald">
      <button
        type="button"
        role="menuitem"
        aria-expanded={picking}
        className="hm-profile"
        onClick={() => setPicking((p) => !p)}
      >
        <span className="hm-profile__icon" aria-hidden="true"><CurrentIcon size={18} /></span>
        <span className="hm-profile__text">
          <span className="hm-profile__label">Profile</span>
          <span className="hm-profile__name">{current ? PROFILES[current].name : 'Not set up'}</span>
        </span>
        <span className={`hm-chev${picking ? ' hm-chev--open' : ''}`} aria-hidden="true"><IconChevron size={14} /></span>
      </button>
      {picking && (
        <div className="hm-picker" role="radiogroup" aria-label="Profile">
          {setup.profiles.map((id) => {
            const Icon = PROFILE_ICON[id];
            const on = current === id;
            return (
              <button key={id} type="button" role="menuitemradio" aria-checked={on} className={`hm-pick${on ? ' hm-pick--on' : ''}`} onClick={() => pick(id)}>
                <span className="hm-pick__icon" aria-hidden="true"><Icon size={16} /></span>
                <span className="hm-pick__text">
                  <span className="hm-pick__name">{PROFILES[id].name}</span>
                  <span className="hm-pick__tag">{PROFILES[id].tagline}</span>
                </span>
                <span className={`hs-radio${on ? ' hs-radio--on' : ''}`} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      {!picking && current === 'headphones' && (
        <button type="button" role="menuitemcheckbox" aria-checked={setup.state.fullReplies} className="herald-menu__item herald-menu__item--sub" onClick={() => setup.setFullReplies(!setup.state.fullReplies)}>
          Read whole replies aloud
          <Switch on={setup.state.fullReplies} />
        </button>
      )}
      {notes.length > 0 && !picking && <p className="hm-notes">{notes.join(' ')}</p>}

      {device.supported && device.selfId && (
        device.isActive ? (
          <div className="hm-device" role="status">
            <span className="hm-device__dot hm-device__dot--on" aria-hidden="true" />
            <span className="hm-device__text">Main device: <strong>this one</strong>{device.activeDevice?.pinned ? ' · kept here' : ''}</span>
          </div>
        ) : (
          <button type="button" role="menuitem" className="herald-menu__item hm-take" onClick={() => { device.takeControl(); onClose(); }}>
            <IconDevice size={15} />
            <span className="hm-take__text">
              Take control
              <span className="hm-take__sub">Now on {device.activeDevice?.label ?? 'another device'}</span>
            </span>
          </button>
        )
      )}

      <div className="herald-menu__sep" role="separator" />
      {voice.supported && (
        <button type="button" role="menuitemcheckbox" aria-checked={voice.voiceOn} className="herald-menu__item" onClick={() => voice.setVoiceOn(!voice.voiceOn)}>
          <IconSpeaker size={15} /> Voice replies
          <Switch on={voice.voiceOn} />
        </button>
      )}
      {(voice.supported || voice.chimeSupported) && <HeraldVolumeSlider voice={voice} />}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={input.prefs.handsFree}
        className="herald-menu__item"
        onClick={() => input.setHandsFree(!input.prefs.handsFree)}
        disabled={!input.handsFreeAvailable && !input.prefs.handsFree}
        title={input.handsFreeAvailable ? 'Listen for "Hey Jarvis" on this device' : input.unavailableReason ?? 'Needs the voice service with the wake word loaded'}
      >
        <IconListen size={15} /> Hands-free
        <span className="hm-hint">“Hey Jarvis”</span>
        <Switch on={input.prefs.handsFree} />
      </button>
      {input.handsFreeNote && <div className="herald-voice-set__engine">{input.handsFreeNote}</div>}
      <button type="button" role="menuitem" className="herald-menu__item" onClick={() => { briefMe(); onClose(); }} disabled={!available}>
        <IconBrief size={15} /> Brief me
        <kbd className="herald-voice-set__kbd">{input.briefChordLabel}</kbd>
      </button>

      <div className="herald-menu__sep" role="separator" />
      <button type="button" role="menuitem" className="herald-menu__item" onClick={() => { setup.openCheck(); onClose(); }}>
        <IconCheckup size={15} /> Device check
      </button>
      <button type="button" role="menuitem" className="herald-menu__item" onClick={() => { setup.setHelpOpen(true); onClose(); }}>
        <IconHelp size={15} /> Help
      </button>
      <button type="button" role="menuitem" className="herald-menu__item" onClick={onAdvanced}>
        <IconSliders size={15} /> Advanced
        <span className="hm-chev" aria-hidden="true"><IconChevron size={14} /></span>
      </button>
    </div>
  );
}

/** Advanced: the profile-layer settings (switching, floating orb, bring to front, ducking). */
export function SetupAdvancedSettings() {
  const setup = useHeraldSetupCtx();
  const { prefs } = useNativeHeraldState();
  const s = setup.state;
  const gaming = s.profile === 'gaming';
  const desktop = setup.platform === 'desktop';
  const mobile = setup.platform === 'android' || setup.platform === 'ios';
  const orbOn = overlayEnabled(s, setup.platform);
  return (
    <div className="herald-voice-set" role="group" aria-label="Profile settings">
      <div className="herald-menu__label">Profile</div>
      <button type="button" role="menuitemcheckbox" aria-checked={s.autoSwitch} className="herald-menu__item" onClick={() => heraldSetupStore.set('autoSwitch', !s.autoSwitch)} title="When headphones are plugged in or removed">
        Switch profile automatically
        <Switch on={s.autoSwitch} />
      </button>
      {desktop && (
        <>
          <button type="button" role="menuitemcheckbox" aria-checked={orbOn} className="herald-menu__item" onClick={() => setOverlayEnabled(!orbOn)} title="A small orb over other apps while Herald listens, thinks or speaks">
            Show floating orb
            <Switch on={orbOn} />
          </button>
          {gaming && <div className="herald-voice-set__engine">Gaming profile: {orbOn ? 'shown over games (this profile only).' : 'off unless you turn it on here.'}</div>}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={s.bringToFront && !gaming}
            className="herald-menu__item"
            onClick={() => heraldSetupStore.set('bringToFront', !s.bringToFront)}
            disabled={gaming}
            title='"Hey Jarvis" or a trigger shows the Companion window'
          >
            Bring Companion to front on wake
            <Switch on={s.bringToFront && !gaming} />
          </button>
          {gaming && <div className="herald-voice-set__engine">Never in the Gaming profile (it would pull you out of the game).</div>}
        </>
      )}
      {mobile && (
        <button type="button" role="menuitemcheckbox" aria-checked={prefs.duckOthers} className="herald-menu__item" onClick={() => nativeHeraldStore.setPref('duckOthers', !prefs.duckOthers)}>
          Lower other audio while Herald speaks
          <Switch on={prefs.duckOthers} />
        </button>
      )}
    </div>
  );
}
