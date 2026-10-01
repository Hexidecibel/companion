import { beforeEach, describe, expect, it } from 'vitest';
import { collectDiagnostics, diag, diagnosticsJson, redactSnapshot, registerDiagnostics, voiceDiag } from '../diagnostics';
import { diagnosticSections } from '../../components/herald/setup/HeraldDiagnostics';
import { matchDiagnosticsCommand } from '../voice/voiceCommands';

const find = (sections: ReturnType<typeof diagnosticSections>, title: string, label: string) =>
  sections.find((s) => s.title === title)!.rows.find((r) => r.label === label)!;

describe('Herald diagnostics', () => {
  beforeEach(() => diag.reset());

  it('records the wake pipeline: streaming, the score and how the utterance ended', () => {
    diag.vadRunning(true);
    diag.speechStart();
    diag.wakeOpened('w1');
    expect(voiceDiag.wake.streaming).toBe(true);
    diag.wakeDetected(0.95);
    diag.wakeClosed('transcribed');
    diag.speechEnd();
    const s = diagnosticSections(collectDiagnostics(), Date.now());
    expect(find(s, 'Wake word', 'Wake audio').value).toBe('not streaming');
    expect(find(s, 'Wake word', 'Last wake').value).toMatch(/^score 0\.950, \d+ s ago$/);
    expect(find(s, 'Wake word', 'Last utterance').value).toMatch(/^transcribed/);
    expect(find(s, 'Voice detection (VAD)', 'State').value).toBe('silence');
  });

  it('explains why hands-free is not listening (hidden window, stand-down)', () => {
    const off = registerDiagnostics('handsFree', () => ({ pref: true, active: false, note: 'Paused while the app is in the background', pageVisible: false, keepListeningWhenHidden: false, wakeReadyOnHub: true }));
    diag.standDown('Hands-free moved to another device (the hub allows one listening device)');
    const s = diagnosticSections(collectDiagnostics(), Date.now());
    expect(find(s, 'Hands-free', 'State')).toMatchObject({ level: 'bad', value: 'on, not listening: Paused while the app is in the background' });
    expect(find(s, 'Hands-free', 'Window').level).toBe('bad');
    expect(find(s, 'Hands-free', 'Stand-down').value).toMatch(/moved to another device/);
    off();
  });

  it('shows speaking-elsewhere suppression with the time left, and the hub round trip', () => {
    const a = registerDiagnostics('speakingElsewhere', () => ({ suppressed: true, speaker: 'Phone', remainingMs: 2300 }));
    const b = registerDiagnostics('hub', () => ({ rttMs: 42, voice: 'tts, stt, wake ready' }));
    const s = diagnosticSections(collectDiagnostics(), Date.now());
    expect(find(s, 'Speaking elsewhere', 'Suppression').value).toMatch(/speaking on Phone.*2\.3 s left/);
    expect(find(s, 'Hub', 'Round trip')).toMatchObject({ value: '42 ms', level: 'ok' });
    a();
    b();
  });

  it('flags a failed asset load and a missing audio stream', () => {
    diag.asset('vad', 'error', 'failed to fetch /vad/silero_vad_v5.onnx', '/vad/');
    diag.vadRunning(true);
    const s = diagnosticSections(collectDiagnostics(), Date.now());
    expect(find(s, 'Assets', 'VAD (Silero + ORT)')).toMatchObject({ level: 'bad' });
    expect(find(s, 'Microphone', 'Input level')).toMatchObject({ level: 'bad', value: 'no audio frames arriving' });
    diag.level(0.05);
    const s2 = diagnosticSections(collectDiagnostics(), Date.now());
    expect(find(s2, 'Microphone', 'Input level').meter).toBeGreaterThan(0);
  });

  it('lists shortcuts with Mac glyphs, their mode and registration errors', () => {
    const off = registerDiagnostics('shortcuts', () => ({
      os: 'macos', enabled: true, inputMonitoring: 'not allowed',
      registered: [
        { name: 'talk', accelerator: 'Alt+Super+Space', ok: true, mode: 'exclusive', passthroughError: 'needs_permission' },
        { name: 'stop', accelerator: 'Alt+Shift+Super+KeyS', ok: false, mode: 'exclusive', error: 'HotKey already registered' },
      ],
    }));
    const s = diagnosticSections(collectDiagnostics(), Date.now(), true);
    expect(find(s, 'Shortcuts', 'talk')).toMatchObject({ level: 'warn', value: '⌘⌥Space (exclusive; passthrough: needs_permission)' });
    expect(find(s, 'Shortcuts', 'stop')).toMatchObject({ level: 'bad', value: '⌘⌥⇧S: could not be registered (HotKey already registered)' });
    expect(find(s, 'Shortcuts', 'Input Monitoring').value).toBe('not allowed');
    off();
  });

  it('the copied JSON never carries secrets', () => {
    const off = registerDiagnostics('leaky', () => ({ token: 'abc', nested: { authorization: 'Bearer xyz', note: 'key sk-ant-REDACTME12345 here' } }));
    const json = diagnosticsJson(collectDiagnostics());
    expect(json).not.toMatch(/abc|xyz|sk-ant-REDACTME/);
    expect(redactSnapshot({ id: 'a1b2c3d4-0000-4000-8000-000000000000', pcm: 'AAAA' })).toEqual({ id: 'a1b2c3d4-0000-4000-8000-000000000000', pcm: '[redacted]' });
    off();
  });

  it('"diagnostics" is a whole-utterance voice command', () => {
    expect(matchDiagnosticsCommand('Diagnostics.')).toBe(true);
    expect(matchDiagnosticsCommand('Hey Jarvis, show diagnostics')).toBe(true);
    expect(matchDiagnosticsCommand('Open the diagnostics, please')).toBe(true);
    expect(matchDiagnosticsCommand('run the diagnostics on the build server')).toBe(false);
    expect(matchDiagnosticsCommand('show me Out4')).toBe(false);
  });
});
