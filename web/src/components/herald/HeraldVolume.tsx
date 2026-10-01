import type { HeraldVoice } from '../../hooks/useHeraldVoice';
import { VOLUME_MAX, volumePercent } from '../../services/tts/volume';
import { nativePlatform } from '../../utils/platform';
import { IconSpeaker } from './heraldIcons';

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
}

/**
 * Herald's own volume on this device (main menu): 0-150 %, independent of the
 * system volume. Also on the tray (desktop app) and by voice ("louder").
 */
export function HeraldVolumeSlider({ voice }: { voice: Pick<HeraldVoice, 'volume' | 'setVolume'> }) {
  const pct = volumePercent(voice.volume.voice);
  return (
    <div className="herald-voice-set" role="group" aria-label="Herald volume">
      <label className="herald-voice-set__rate hm-volume">
        <span className="herald-voice-set__rate-label hm-volume__label"><IconSpeaker size={15} /> Volume</span>
        <input
          type="range"
          min={0}
          max={VOLUME_MAX * 100}
          step={5}
          value={pct}
          onChange={(e) => voice.setVolume(Number(e.target.value) / 100)}
          aria-valuetext={`${pct} percent`}
          title={'Herald\'s own volume (this device). Above 100% is a boost. Say "louder" or "quieter".'}
        />
        <span className="herald-voice-set__rate-val">{pct}%</span>
      </label>
      {nativePlatform() === 'desktop' && isWindows() && (
        <div className="herald-voice-set__engine">In the Windows volume mixer Herald is listed as "Microsoft Edge WebView2" (its audio runs in the WebView2 process).</div>
      )}
    </div>
  );
}

/** Advanced > Voice: the tones' own volume, or relative to the voice. */
export function HeraldTonesVolume({ voice }: { voice: Pick<HeraldVoice, 'volume' | 'setTonesVolume' | 'setTonesFollowVoice'> }) {
  const pct = volumePercent(voice.volume.tones);
  const follow = voice.volume.tonesFollowVoice;
  return (
    <>
      <label className="herald-voice-set__rate">
        <span className="herald-voice-set__rate-label">Tones</span>
        <input
          type="range"
          min={0}
          max={VOLUME_MAX * 100}
          step={5}
          value={pct}
          onChange={(e) => voice.setTonesVolume(Number(e.target.value) / 100)}
          aria-valuetext={`${pct} percent${follow ? ' of the voice volume' : ''}`}
        />
        <span className="herald-voice-set__rate-val">{pct}%</span>
      </label>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={follow}
        className="herald-menu__item herald-menu__item--sub"
        onClick={() => voice.setTonesFollowVoice(!follow)}
        title="On: the tones scale with Herald's volume. Off: the tones keep their own level."
      >
        Tones follow the voice volume
        <span className={`herald-switch${follow ? ' herald-switch--on' : ''}`} aria-hidden="true" />
      </button>
    </>
  );
}
