/**
 * User-facing voice hints that differ between a browser tab and the native
 * apps. A browser hint ("the browser's site settings", "this tab", "open over
 * https") is wrong inside the Companion app, and vice versa.
 */
import { nativePlatform, type NativePlatform } from '../../utils/platform';

export interface VoiceCopy {
  /** getUserMedia refused (permission denied). */
  micDenied: string;
  /** No secure context (browser over plain http). */
  micInsecure: string;
  /** The page has no getUserMedia at all. */
  micMissing: string;
  /** Hands-free "keep listening in the background" toggle label. */
  keepListeningHidden: string;
  /** Hands-free paused note. */
  pausedHidden: string;
  /** A trigger asked for the mic before it was ever allowed here. */
  micNotYetAllowed: string;
}

const BROWSER: VoiceCopy = {
  micDenied: "Microphone blocked. Allow it in the browser's site settings.",
  micInsecure: 'The microphone needs HTTPS. Open Herald over https (bin/herald-sandbox https).',
  micMissing: 'This browser has no microphone access.',
  keepListeningHidden: 'Keep listening when this tab is hidden',
  pausedHidden: 'Paused while this tab is hidden',
  micNotYetAllowed: 'Microphone not allowed yet: use the mic once in this tab, then triggers can open it from anywhere',
};

const APP_BASE: Omit<VoiceCopy, 'micDenied'> = {
  micInsecure: 'The microphone is unavailable in this build of the app.',
  micMissing: 'This build of the app has no microphone access.',
  keepListeningHidden: 'Keep listening when the app is in the background',
  pausedHidden: 'Paused while the app is in the background',
  micNotYetAllowed: 'Microphone not allowed yet: use the mic once in the app, then triggers can open it from anywhere',
};

const DENIED: Record<Exclude<NativePlatform, 'browser'>, string> = {
  desktop: 'Microphone blocked. Allow Companion in your system privacy settings, then try again.',
  android: 'Microphone blocked. Allow it in Settings > Apps > Companion > Permissions.',
  ios: 'Microphone blocked. Allow it in Settings > Companion > Microphone.',
};

export function voiceCopy(platform: NativePlatform = nativePlatform()): VoiceCopy {
  if (platform === 'browser') return BROWSER;
  return { ...APP_BASE, micDenied: DENIED[platform] };
}
