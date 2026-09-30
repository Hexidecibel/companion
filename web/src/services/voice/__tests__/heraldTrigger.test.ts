import { describe, expect, it, vi } from 'vitest';
import { DeferredNotice, runHeraldTrigger, type TriggerActions } from '../heraldTrigger';

function actions(over: Partial<TriggerActions> & { isSpeaking?: boolean; isCapturing?: boolean } = {}) {
  const log: string[] = [];
  const a: TriggerActions = {
    speaking: () => over.isSpeaking ?? false,
    capturing: () => over.isCapturing ?? false,
    stopSpeech: vi.fn(() => log.push('stopSpeech')),
    cancelCapture: vi.fn(() => log.push('cancelCapture')),
    listen: vi.fn(async () => { log.push('listen'); return null; }),
    brief: vi.fn(() => log.push('brief')),
    repeat: vi.fn(() => { log.push('repeat'); return true; }),
    allowBackground: vi.fn(() => log.push('allowBackground')),
    tone: vi.fn((k) => log.push(`tone:${k}`)),
    notice: vi.fn((m) => log.push(`notice:${m}`)),
    ...over,
  };
  return { a, log };
}

describe('runHeraldTrigger', () => {
  it('brief: allows background speech, then asks for the briefing', async () => {
    const { a, log } = actions();
    expect(await runHeraldTrigger('brief', a)).toBe('briefing');
    expect(log).toEqual(['allowBackground', 'brief']);
  });

  it('listen: opens the mic, then plays the listening earcon', async () => {
    const { a, log } = actions();
    expect(await runHeraldTrigger('listen', a)).toBe('listening');
    expect(log).toEqual(['allowBackground', 'listen', 'tone:wake']);
  });

  it('listen while Herald talks barges in first; while capturing it is a no-op', async () => {
    const talking = actions({ isSpeaking: true });
    expect(await runHeraldTrigger('listen', talking.a)).toBe('listening');
    expect(talking.log).toEqual(['stopSpeech', 'allowBackground', 'listen', 'tone:wake']);
    const busy = actions({ isCapturing: true });
    expect(await runHeraldTrigger('listen', busy.a)).toBe('already_listening');
    expect(busy.log).toEqual([]);
  });

  it('listen failure (background tab without mic permission): error tone + notice, no earcon', async () => {
    const { a, log } = actions({ listen: vi.fn(async () => 'Microphone not allowed yet') });
    expect(await runHeraldTrigger('listen', a)).toBe('failed');
    expect(log).toEqual(['allowBackground', 'tone:error', 'notice:Microphone not allowed yet']);
    const thrown = actions({ listen: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    expect(await runHeraldTrigger('listen', thrown.a)).toBe('failed');
    expect(thrown.log).toContain('notice:NotAllowedError');
  });

  it('stop: silences and cancels any capture, with a soft ack', async () => {
    const { a, log } = actions({ isSpeaking: true });
    expect(await runHeraldTrigger('stop', a)).toBe('stopped');
    expect(log).toEqual(['stopSpeech', 'cancelCapture', 'tone:ok']);
  });

  it('repeat: replays, or says there is nothing to repeat', async () => {
    const ok = actions();
    expect(await runHeraldTrigger('repeat', ok.a)).toBe('repeating');
    expect(ok.log).toEqual(['allowBackground', 'repeat']);
    const none = actions({ repeat: vi.fn(() => false) });
    expect(await runHeraldTrigger('repeat', none.a)).toBe('nothing_to_repeat');
    expect(none.log).toEqual(['allowBackground', 'tone:error', 'notice:Nothing to repeat yet']);
  });

  it('toggle: speaking -> stop; listening -> cancel; idle -> listen', async () => {
    const speaking = actions({ isSpeaking: true, isCapturing: true });
    expect(await runHeraldTrigger('toggle', speaking.a)).toBe('stopped');
    expect(speaking.log).toEqual(['stopSpeech', 'tone:ok']);
    const listening = actions({ isCapturing: true });
    expect(await runHeraldTrigger('toggle', listening.a)).toBe('cancelled');
    expect(listening.log).toEqual(['cancelCapture', 'tone:ok']);
    const idle = actions();
    expect(await runHeraldTrigger('toggle', idle.a)).toBe('listening');
    expect(idle.log).toEqual(['allowBackground', 'listen', 'tone:wake']);
  });
});

describe('runHeraldTrigger claim', () => {
  it('claim: the daemon already moved control here; just acknowledge', async () => {
    const { a, log } = actions();
    expect(await runHeraldTrigger('claim', a)).toBe('claimed');
    expect(log).toEqual(['tone:ok']);
  });
});

describe('DeferredNotice', () => {
  it('shows at once when visible, else on the next flush while visible', () => {
    let visible = false;
    const show = vi.fn();
    const n = new DeferredNotice(show, () => visible);
    n.post('Mic blocked');
    expect(show).not.toHaveBeenCalled();
    n.flush();
    expect(show).not.toHaveBeenCalled();
    visible = true;
    n.flush();
    expect(show).toHaveBeenCalledWith('Mic blocked');
    n.flush();
    expect(show).toHaveBeenCalledTimes(1);
    n.post('Now');
    expect(show).toHaveBeenLastCalledWith('Now');
    expect(n.waiting).toBeNull();
  });
});
