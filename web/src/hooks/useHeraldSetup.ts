import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldVoice } from './useHeraldVoice';
import type { HeraldVoiceInput } from './useHeraldVoiceInput';
import { nativeHeraldStore } from './useNativeHerald';
import {
  applyProfileSettings,
  availableProfiles,
  environmentSuggestion,
  gradeEcho,
  PROFILES,
  profileSettings,
  suggestProfile,
  type EchoCheck,
  type EnvSuggestion,
  type ProfileId,
} from '../services/heraldSetup/profiles';
import { heraldSetupStore, useHeraldSetupState, type HeraldSetupState } from '../services/heraldSetup/setupStore';
import { tipsStore } from '../services/heraldSetup/tips';
import { getAudioEnvironment, onAudioEnvironmentChange, type AudioEnvironment } from '../services/voice/audioEnvironment';
import { nativePlatform, type NativePlatform } from '../utils/platform';
import type { HeraldAction, HeraldInboxItem } from '../types/herald';

/** Touch phone / tablet in a browser tab (the Phone profile fits). */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export interface HeraldSetupControl {
  state: HeraldSetupState;
  platform: NativePlatform;
  mobileBrowser: boolean;
  /** Profiles offered on this device, in picker order. */
  profiles: ProfileId[];
  /** Latest audio environment (null until known). */
  env: AudioEnvironment | null;
  /** The profile that fits the current audio, for preselection. */
  recommended: ProfileId;
  /** Apply a profile now (explicit choice). Returns its notes. */
  applyProfile: (id: ProfileId) => string[];
  /** Headphones: read whole replies aloud. */
  setFullReplies: (on: boolean) => void;
  /** Store an echo measurement and re-apply the profile that depends on it. */
  recordEcho: (r: Omit<EchoCheck, 'at'>) => void;
  /** Profile switch worth suggesting after the audio changed. */
  suggestion: EnvSuggestion | null;
  acceptSuggestion: () => void;
  dismissSuggestion: () => void;
  /** Transient "Switched to Headphones" after an automatic switch. */
  autoNote: string | null;
  /** Device check. */
  checkOpen: boolean;
  openCheck: () => void;
  closeCheck: () => void;
  /** Help page (in the panel). */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

export interface SetupHost {
  voice: HeraldVoice;
  input: HeraldVoiceInput;
  /** Herald is usable (connected to its host). */
  available: boolean;
  actions: HeraldAction[];
  inbox: HeraldInboxItem[];
}

const AUTO_NOTE_MS = 6000;

/**
 * Profiles, environment suggestions, the device check's open state and the
 * one-time tips, for the Herald provider. Settings are applied through the
 * existing hooks' setters, so everything else keeps working unchanged.
 */
export function useHeraldSetup(host: SetupHost): HeraldSetupControl {
  const state = useHeraldSetupState();
  const platform = useMemo(() => nativePlatform(), []);
  const mobileBrowser = useMemo(() => platform === 'browser' && isMobileBrowser(), [platform]);
  const profiles = useMemo(() => availableProfiles(platform, mobileBrowser), [platform, mobileBrowser]);
  const hostRef = useRef(host);
  hostRef.current = host;

  const apply = useCallback((id: ProfileId, s: HeraldSetupState = heraldSetupStore.get()): string[] => {
    const { voice, input } = hostRef.current;
    const settings = profileSettings(id, { echo: s.echo, fullReplies: s.fullReplies });
    const native = nativeHeraldStore.get().prefs;
    applyProfileSettings(settings, {
      voice,
      input: {
        setPref: (k, v) => input.setPref(k, v as never),
        setHandsFree: input.setHandsFree,
      },
      native: { setPref: (k, v) => nativeHeraldStore.setPref(k, v) },
      current: {
        voiceOn: voice.voiceOn,
        chimeOn: voice.chimeOn,
        remind: voice.remind,
        spokenLength: voice.spokenLength,
        interrupt: input.prefs.interrupt,
        interruptExplicit: input.prefs.interruptOrigin === 'explicit',
        sensitivity: input.prefs.sensitivity,
        reviewBeforeSend: input.prefs.reviewBeforeSend,
        spaceToTalk: input.prefs.spaceToTalk,
        handsFree: input.prefs.handsFree,
        builtInMicWithBluetooth: input.prefs.builtInMicWithBluetooth,
        followUp: input.prefs.followUp,
        globalShortcuts: native.globalShortcuts,
        earbudButton: native.earbudButton,
        duckOthers: native.duckOthers,
      },
      platform,
    });
    if (s.profile !== id) heraldSetupStore.set('profile', id);
    return settings.notes;
  }, [platform]);

  const applyProfile = useCallback((id: ProfileId) => apply(id), [apply]);

  const setFullReplies = useCallback((on: boolean) => {
    heraldSetupStore.set('fullReplies', on);
    const s = heraldSetupStore.get();
    if (s.profile === 'headphones') apply('headphones', s);
  }, [apply]);

  const recordEcho = useCallback((r: Omit<EchoCheck, 'at'>) => {
    heraldSetupStore.set('echo', { ...r, at: Date.now() });
    const s = heraldSetupStore.get();
    if (s.profile === 'desk') apply('desk', s);
    // Failing the check never leaves talk-over on, whatever the profile.
    const grade = gradeEcho(r);
    if (grade !== 'good' && hostRef.current.input.prefs.interrupt && s.profile !== 'headphones' && s.profile !== 'phone') {
      hostRef.current.input.setPref('interrupt', false);
    }
  }, [apply]);

  // ---- audio environment -> suggestion / automatic switch -----------------
  const [env, setEnv] = useState<AudioEnvironment | null>(null);
  const [suggestion, setSuggestion] = useState<EnvSuggestion | null>(null);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let prev: AudioEnvironment | null = null;
    const onEnv = (next: AudioEnvironment) => {
      if (cancelled) return;
      const s = heraldSetupStore.get();
      const sug = environmentSuggestion({ prev, next, current: s.profile, platform, dismissed: s.dismissed, mobileBrowser });
      prev = next;
      setEnv(next);
      // Nothing chosen yet: the device check picks, not a banner.
      if (!sug || !s.profile) return;
      if (s.autoSwitch) {
        apply(sug.profile, s);
        setSuggestion(null);
        setAutoNote(`Switched to ${PROFILES[sug.profile].name}`);
        return;
      }
      setSuggestion(sug);
    };
    void getAudioEnvironment().then((e) => { if (!prev) onEnv(e); }).catch(() => {});
    const off = onAudioEnvironmentChange(onEnv);
    return () => {
      cancelled = true;
      off();
    };
  }, [platform, mobileBrowser, apply]);
  useEffect(() => {
    if (!autoNote) return;
    const t = setTimeout(() => setAutoNote(null), AUTO_NOTE_MS);
    return () => clearTimeout(t);
  }, [autoNote]);
  // The profile changed some other way: a stale suggestion goes.
  useEffect(() => {
    setSuggestion((sug) => (sug && sug.profile === state.profile ? null : sug));
  }, [state.profile]);

  const suggestionRef = useRef(suggestion);
  suggestionRef.current = suggestion;
  const acceptSuggestion = useCallback(() => {
    const sug = suggestionRef.current;
    setSuggestion(null);
    if (sug) apply(sug.profile);
  }, [apply]);
  const dismissSuggestion = useCallback(() => {
    const sug = suggestionRef.current;
    setSuggestion(null);
    if (sug) heraldSetupStore.dismissSuggestion(sug.key);
  }, []);

  const headphones = host.input.headphones;
  const recommended: ProfileId = useMemo(() => {
    const fromEnv = env ? suggestProfile(env, platform, state.profile, mobileBrowser) : null;
    if (fromEnv && profiles.includes(fromEnv)) return fromEnv;
    const mobile = platform === 'android' || platform === 'ios' || mobileBrowser;
    // The older label guess (needs mic permission) as a fallback.
    if (headphones === true) return mobile ? 'phone' : 'headphones';
    // Unknown: speakers are the safe assumption (no talk-over).
    return 'desk';
  }, [env, platform, state.profile, mobileBrowser, profiles, headphones]);

  // ---- device check ------------------------------------------------------
  const [checkOpen, setCheckOpen] = useState(false);
  const openCheck = useCallback(() => setCheckOpen(true), []);
  const closeCheck = useCallback(() => {
    setCheckOpen(false);
    heraldSetupStore.set('onboarded', true);
  }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  // First run on this device: the check opens by itself once Herald is usable
  // (it shows the next time the panel is open). Finishing or closing it ends that.
  const available = host.available;
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!available || state.onboarded || autoOpened.current) return;
    autoOpened.current = true;
    setCheckOpen(true);
  }, [available, state.onboarded]);

  // ---- one-time tips ------------------------------------------------------
  const handsFreeActive = host.input.handsFreeActive;
  useEffect(() => {
    if (handsFreeActive) tipsStore.trigger('handsfree');
  }, [handsFreeActive]);

  const hasRedCard = host.actions.some((a) => a.status === 'pending' && a.tier === 'hard_confirm');
  useEffect(() => {
    if (hasRedCard) tipsStore.trigger('red_card');
  }, [hasRedCard]);

  // First tone: a new unheard item arrived while this device plays tones.
  const unheard = host.inbox.filter((i) => !i.heard).length;
  const prevUnheard = useRef<number | null>(null);
  const tonesHere = host.voice.chimeOn && host.voice.announcer;
  useEffect(() => {
    const prev = prevUnheard.current;
    prevUnheard.current = unheard;
    if (prev !== null && unheard > prev && tonesHere) tipsStore.trigger('first_tone');
  }, [unheard, tonesHere]);

  return useMemo(() => ({
    state,
    platform,
    mobileBrowser,
    profiles,
    env,
    recommended,
    applyProfile,
    setFullReplies,
    recordEcho,
    suggestion,
    acceptSuggestion,
    dismissSuggestion,
    autoNote,
    checkOpen,
    openCheck,
    closeCheck,
    helpOpen,
    setHelpOpen,
  }), [state, platform, mobileBrowser, profiles, env, recommended, applyProfile, setFullReplies, recordEcho, suggestion, acceptSuggestion, dismissSuggestion, autoNote, checkOpen, openCheck, closeCheck, helpOpen]);
}
