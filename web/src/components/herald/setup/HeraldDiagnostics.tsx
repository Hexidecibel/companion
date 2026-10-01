import { useEffect, useRef, useState } from 'react';
import { useHeraldData, useHeraldSetupCtx } from '../../../context/HeraldContext';
import { IconBack } from '../heraldIcons';
import { collectDiagnostics, diagnosticsJson, registerDiagnostics, type DiagnosticsSnapshot } from '../../../services/diagnostics';
import { getMicCapture } from '../../../services/voice/micCapture';
import { getAudioGraph } from '../../../services/voice/audioGraph';
import { lastEchoMeasurement } from '../../../services/voice/audioEnvironment';
import { openInputMonitoringSettings } from '../../../services/nativeBridge';
import { displayChordText } from '../../../services/voice/hotkeys';
import { isMacDesktop } from '../../../hooks/useNativeHerald';
import type { HeraldVoiceStatus } from '../../../types/herald';

export type DiagLevel = 'ok' | 'warn' | 'bad' | 'info';
export interface DiagRow {
  label: string;
  value: string;
  level: DiagLevel;
  /** 0..1: draws a meter instead of plain text. */
  meter?: number;
}
export interface DiagSection {
  title: string;
  rows: DiagRow[];
}

const POLL_MS = 250;
const RTT_EVERY_MS = 3000;

function ago(at: number | null | undefined, now: number): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});

/**
 * Turn a diagnostics snapshot into labelled rows with a status level. Pure (no
 * DOM), so what the view says for each state is unit tested.
 */
export function diagnosticSections(s: DiagnosticsSnapshot, now: number, mac = false): DiagSection[] {
  const v = s.voice;
  const audio = rec(s.audio);
  const hf = rec(s.handsFree);
  const fleet = rec(s.speakingElsewhere);
  const dev = rec(s.devices);
  const hub = rec(s.hub);
  const sc = s.shortcuts ? rec(s.shortcuts) : null;
  const sections: DiagSection[] = [];

  const perm = String(audio.micPermission ?? 'unknown');
  const levelFresh = v.levelAt !== null && now - v.levelAt < 1500;
  sections.push({
    title: 'Microphone',
    rows: [
      { label: 'Permission', value: perm, level: perm === 'granted' ? 'ok' : perm === 'denied' || perm === 'unavailable' ? 'bad' : 'warn' },
      { label: 'Device in use', value: audio.micLabel ? `${audio.micLabel} (${audio.micKind ?? 'unknown'})` : audio.micOpen ? 'open (no label)' : 'not open', level: audio.micOpen ? 'ok' : 'info' },
      levelFresh
        ? { label: 'Input level', value: `${Math.round(Math.min(1, v.level * 8) * 100)} %`, level: v.level > 0.0005 ? 'ok' : 'warn', meter: Math.min(1, v.level * 8) }
        : { label: 'Input level', value: v.vad.running ? 'no audio frames arriving' : 'not listening (the VAD is off)', level: v.vad.running ? 'bad' : 'info' },
    ],
  });

  const erle = audio.erleDb as number | null | undefined;
  const aecState = String(audio.aecState ?? 'idle');
  sections.push({
    title: 'Echo cancellation',
    rows: [
      { label: 'Mode', value: `${audio.aecMode ?? 'none'}${aecState !== 'idle' ? ` (canceller ${aecState})` : ''}`, level: aecState === 'failed' ? 'warn' : 'ok' },
      ...(audio.aecError ? [{ label: 'Canceller error', value: String(audio.aecError), level: 'warn' as DiagLevel }] : []),
      {
        label: 'Last measured ERLE',
        value: typeof erle === 'number' ? `${erle.toFixed(1)} dB (${ago(audio.erleAt as number, now)})` : 'not measured yet (Help > Run the device check)',
        level: typeof erle === 'number' ? (erle >= 25 ? 'ok' : 'warn') : 'info',
      },
      ...(typeof audio.liveCancelDb === 'number' && Number.isFinite(audio.liveCancelDb) ? [{ label: 'Live cancellation', value: `${(audio.liveCancelDb as number).toFixed(1)} dB`, level: 'info' as DiagLevel }] : []),
    ],
  });

  sections.push({
    title: 'Voice detection (VAD)',
    rows: [
      { label: 'State', value: v.vad.running ? (v.vad.speech ? 'speech' : 'silence') : 'off', level: v.vad.running ? 'ok' : 'info' },
      { label: 'Last speech', value: `${ago(v.vad.lastSpeechStartAt, now)}; ${v.vad.misfires} misfire${v.vad.misfires === 1 ? '' : 's'}`, level: 'info' },
    ],
  });

  const hfActive = hf.active === true;
  const standDown = v.handsFree.lastStandDown;
  sections.push({
    title: 'Hands-free',
    rows: [
      {
        label: 'State',
        value: hfActive ? 'listening for "Hey Jarvis"' : hf.pref ? `on, not listening: ${hf.note ?? 'starting'}` : 'off',
        level: hfActive ? 'ok' : hf.pref ? 'bad' : 'info',
      },
      {
        label: 'Window',
        value: `${hf.pageVisible === false ? 'hidden' : 'visible'}; keep listening when hidden: ${hf.keepListeningWhenHidden ? 'on' : 'off'}`,
        level: hf.pref && hf.pageVisible === false && !hf.keepListeningWhenHidden ? 'bad' : 'info',
      },
      { label: 'Wake word on the hub', value: hf.wakeReadyOnHub ? 'loaded' : 'not loaded', level: hf.wakeReadyOnHub ? 'ok' : 'warn' },
      { label: 'Stand-down', value: standDown ? `${standDown.reason} (${ago(standDown.at, now)})` : 'none', level: standDown && now - standDown.at < 60_000 ? 'warn' : 'info' },
    ],
  });

  const remaining = Number(fleet.remainingMs ?? 0);
  sections.push({
    title: 'Speaking elsewhere',
    rows: [
      fleet.suppressed
        ? { label: 'Suppression', value: `Herald is speaking on ${fleet.speaker ?? 'another device'}: hands-free waits (${(remaining / 1000).toFixed(1)} s left at most)`, level: 'warn' }
        : { label: 'Suppression', value: 'none', level: 'ok' },
    ],
  });

  const w = v.wake;
  sections.push({
    title: 'Wake word',
    rows: [
      { label: 'Wake audio', value: w.streaming ? `streaming (for ${ago(w.openedAt, now).replace(' ago', '')})` : 'not streaming', level: w.streaming ? 'ok' : 'info' },
      { label: 'Last wake', value: w.lastScore !== null ? `score ${w.lastScore.toFixed(3)}, ${ago(w.lastScoreAt, now)}` : 'never', level: w.lastScore !== null ? 'ok' : 'info' },
      { label: 'Last utterance', value: w.lastOutcome ? `${w.lastOutcome} (${ago(w.lastOutcomeAt, now)})` : 'none yet', level: w.lastOutcome && /dropped after/.test(w.lastOutcome) ? 'warn' : 'info' },
      { label: 'Since start', value: `${w.streams} checked, ${w.detections} woke`, level: 'info' },
    ],
  });

  const a = v.assets;
  const st = (x: string): DiagLevel => (x === 'ok' ? 'ok' : x === 'error' ? 'bad' : 'info');
  sections.push({
    title: 'Assets',
    rows: [
      { label: 'VAD (Silero + ORT)', value: `${a.vad}${a.vadBase ? ` from ${a.vadBase}` : ''}${a.vadError ? `: ${a.vadError}` : ''}`, level: st(a.vad) },
      { label: 'Echo canceller', value: aecState === 'ready' ? 'ok' : aecState, level: aecState === 'ready' ? 'ok' : aecState === 'failed' ? 'warn' : 'info' },
      { label: 'Capture worklet', value: `${a.worklet}${a.workletError ? `: ${a.workletError}` : ''}`, level: st(a.worklet) },
    ],
  });

  const active = rec(dev.activeDevice);
  const sp = v.speech;
  sections.push({
    title: 'Devices',
    rows: [
      { label: 'This device', value: `${dev.selfLabel ?? '?'}${dev.isActive ? ' (active)' : ''}`, level: dev.isActive ? 'ok' : 'info' },
      { label: 'Active device', value: active.label ? `${active.label} (${active.reason ?? '?'}${active.pinned ? ', pinned' : ''})` : 'none', level: 'info' },
      {
        label: 'Last line spoken on',
        value: sp.lastSpeakOnAt ? `${sp.lastSpeakOnSelf ? 'this device' : sp.lastSpeakOn ? 'another device' : 'every device (older hub)'} (${ago(sp.lastSpeakOnAt, now)})` : 'none yet',
        level: 'info',
      },
      { label: 'Herald hub', value: `${dev.hostName || '?'}${Array.isArray(dev.hubs) && dev.hubs.length > 1 ? ` (of ${dev.hubs.length} servers)` : ''}`, level: 'info' },
      { label: 'Profile', value: String(dev.profile ?? 'not chosen'), level: 'info' },
    ],
  });

  const rtt = hub.rttMs as number | null | undefined;
  sections.push({
    title: 'Hub',
    rows: [
      { label: 'Round trip', value: typeof rtt === 'number' ? `${Math.round(rtt)} ms` : hub.error ? String(hub.error) : 'measuring…', level: typeof rtt === 'number' ? (rtt < 300 ? 'ok' : 'warn') : hub.error ? 'bad' : 'info' },
      { label: 'Voice service', value: hub.voice ? String(hub.voice) : '?', level: hub.voice === 'tts, stt, wake ready' ? 'ok' : 'warn' },
    ],
  });

  if (sc) {
    const rows: DiagRow[] = [];
    const regs = Array.isArray(sc.registered) ? (sc.registered as Rec[]) : [];
    if (!sc.enabled) rows.push({ label: 'System-wide shortcuts', value: 'off', level: 'info' });
    for (const r of regs) {
      const label = displayChordText(String(r.accelerator ?? '').replace(/Super/g, 'Meta').replace(/Key([A-Z])/g, '$1'), mac) ?? String(r.accelerator);
      rows.push({
        label: String(r.name),
        value: r.ok ? `${label} (${r.mode ?? 'exclusive'}${r.passthroughError ? `; passthrough: ${r.passthroughError}` : ''})` : `${label}: could not be registered${r.error ? ` (${r.error})` : ''}`,
        level: r.ok ? (r.passthroughError ? 'warn' : 'ok') : 'bad',
      });
    }
    if (sc.os === 'macos') {
      rows.push({ label: 'Input Monitoring', value: String(sc.inputMonitoring), level: sc.inputMonitoring === 'allowed' ? 'ok' : 'warn' });
    }
    sections.push({ title: 'Shortcuts', rows });
  }
  return sections;
}

/**
 * Help > Diagnostics: live state of everything between the mic and Herald, with
 * "Copy diagnostics" (a redacted JSON snapshot: no tokens, no transcripts).
 */
export function HeraldDiagnostics({ onClose }: { onClose: () => void }) {
  const setup = useHeraldSetupCtx();
  const data = useHeraldData();
  const rootRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<DiagnosticsSnapshot>(() => collectDiagnostics());
  const [copied, setCopied] = useState<string | null>(null);
  const mac = isMacDesktop(setup.platform);
  useEffect(() => { rootRef.current?.focus(); }, []);

  // Audio state lives in singletons: expose it while the view is open.
  const liveCancel = useRef<number | null>(null);
  useEffect(() => {
    const graph = getAudioGraph();
    const off = graph.onStats((x) => {
      if (x.refPow > 1e-7 && x.outPow > 0 && x.micPow > 0) {
        const db = 10 * Math.log10(x.micPow / x.outPow);
        if (Number.isFinite(db)) liveCancel.current = db;
      }
    });
    const unreg = registerDiagnostics('audio', () => {
      const mic = getMicCapture();
      const m = lastEchoMeasurement();
      return {
        micPermission: mic.permission,
        micOpen: mic.isOpen,
        micLabel: mic.label,
        micKind: mic.kind,
        aecMode: graph.micMode,
        aecState: graph.aecState,
        aecError: graph.lastAecError,
        erleDb: m ? m.erleDb : null,
        erleAt: m ? m.at : null,
        liveCancelDb: liveCancel.current,
      };
    });
    return () => { off(); unreg(); };
  }, []);

  // Daemon round trip (and the voice service's readiness), every few seconds.
  const hubRef = useRef<Record<string, unknown>>({});
  const getTransport = data.getTransport;
  useEffect(() => {
    let stopped = false;
    const ping = async () => {
      const t = getTransport();
      if (!t || !t.isConnected()) {
        hubRef.current = { rttMs: null, error: 'not connected to the Herald hub' };
        return;
      }
      const t0 = performance.now();
      try {
        const res = await t.request('herald_voice_status', {}, 5000);
        const st = res.payload as HeraldVoiceStatus | undefined;
        const ready = st ? (['tts', 'stt', 'wake'] as const).filter((k) => st[k]?.ready) : [];
        hubRef.current = {
          rttMs: performance.now() - t0,
          voice: !res.success ? res.error ?? 'error' : !st?.available ? 'offline' : ready.length === 3 ? 'tts, stt, wake ready' : `ready: ${ready.join(', ') || 'nothing'}`,
          handsFreeOwnerHere: st?.handsFreeOwner ?? null,
        };
      } catch (err) {
        hubRef.current = { rttMs: null, error: (err as Error)?.message || 'no answer' };
      }
    };
    void ping();
    const id = setInterval(() => { if (!stopped) void ping(); }, RTT_EVERY_MS);
    const unreg = registerDiagnostics('hub', () => hubRef.current);
    return () => { stopped = true; clearInterval(id); unreg(); };
  }, [getTransport]);

  useEffect(() => {
    const extra = { version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '', platform: setup.platform };
    const tick = () => setSnap(collectDiagnostics(extra));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [setup.platform]);

  const copy = async () => {
    const extra = { version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '', platform: setup.platform };
    const json = diagnosticsJson(collectDiagnostics(extra));
    try {
      await navigator.clipboard.writeText(json);
      setCopied('Copied');
    } catch {
      setCopied('Could not copy (clipboard blocked)');
    }
    setTimeout(() => setCopied(null), 2500);
  };

  const sections = diagnosticSections(snap, Date.now(), mac);
  const sc = snap.shortcuts as Record<string, unknown> | undefined;
  return (
    <div
      className="hh hd"
      role="region"
      aria-label="Herald diagnostics"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className="hh-head">
        <button type="button" className="herald-icon-btn" onClick={onClose} aria-label="Back">
          <IconBack size={18} />
        </button>
        <h2 className="hh-head__title">Diagnostics</h2>
        <span className="hd-spacer" />
        <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={() => void copy()}>
          {copied ?? 'Copy diagnostics'}
        </button>
      </header>
      <div className="hh-body">
        {sections.map((sec) => (
          <section key={sec.title} className="hh-sec">
            <h3 className="hh-sec__title">{sec.title}</h3>
            <dl className="hh-defs hd-rows">
              {sec.rows.map((r) => (
                <div key={r.label} className={`hh-defs__row hd-row hd-row--${r.level}`}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.meter !== undefined ? (
                      <span className="hd-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.meter * 100)} aria-label={r.label}>
                        <span className="hd-meter__fill" style={{ width: `${Math.round(r.meter * 100)}%` }} />
                      </span>
                    ) : (
                      <span className="hd-val">{r.value}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {sec.title === 'Shortcuts' && sc?.os === 'macos' && sc.inputMonitoring !== 'allowed' && (
              <p className="hh-p hh-p--note">
                Passthrough shortcuts (other apps see the keys too) need Input Monitoring. Without it they still work, but only
                Companion gets the keys.{' '}
                <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={() => void openInputMonitoringSettings()}>
                  Open System Settings &gt; Privacy &gt; Input Monitoring
                </button>
              </p>
            )}
          </section>
        ))}
        <p className="hh-foot">The copied JSON has no tokens, transcripts or audio.</p>
      </div>
    </div>
  );
}
