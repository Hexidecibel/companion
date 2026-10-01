import { describe, expect, it, vi } from 'vitest';
import { routeVoiceTranscript, type VoiceCommandActions } from '../voiceCommandRouter';

function actions(over: Partial<VoiceCommandActions> = {}) {
  const a = {
    stop: vi.fn(),
    repeat: vi.fn(() => true),
    goOn: vi.fn(() => true),
    stepRate: vi.fn(),
    expectBriefing: vi.fn(),
    sendIntent: vi.fn(),
    notice: vi.fn(),
    undo: vi.fn(),
    ...over,
  };
  return a;
}

describe('routeVoiceTranscript', () => {
  it('STOP is local: nothing is sent', () => {
    const a = actions();
    expect(routeVoiceTranscript('Herald, stop.', a)).toEqual({ command: 'stop', send: null });
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(a.sendIntent).not.toHaveBeenCalled();
  });

  it('REPEAT replays locally; with nothing to replay it says so and sends nothing', () => {
    const a = actions();
    routeVoiceTranscript('Say that again?', a);
    expect(a.repeat).toHaveBeenCalledTimes(1);
    const none = actions({ repeat: vi.fn(() => false) });
    expect(routeVoiceTranscript('repeat that', none).send).toBeNull();
    expect(none.notice).toHaveBeenCalledWith('Nothing to repeat yet');
    expect(none.sendIntent).not.toHaveBeenCalled();
  });

  it('MORE continues the held-back remainder, else asks the brain for more', () => {
    const local = actions();
    routeVoiceTranscript('Go on.', local);
    expect(local.goOn).toHaveBeenCalled();
    expect(local.sendIntent).not.toHaveBeenCalled();
    const brain = actions({ goOn: vi.fn(() => false) });
    routeVoiceTranscript('Tell me more.', brain);
    expect(brain.sendIntent).toHaveBeenCalledWith('Tell me more.', 'more');
  });

  it('SHORTER and BRIEF are structured brain requests; BRIEF gets a longer spoken allowance', () => {
    const a = actions();
    routeVoiceTranscript('TL;DR', a);
    expect(a.sendIntent).toHaveBeenLastCalledWith('TL;DR', 'shorter');
    routeVoiceTranscript("Hey Jarvis, what's up?", a);
    expect(a.expectBriefing).toHaveBeenCalledTimes(1);
    expect(a.sendIntent).toHaveBeenLastCalledWith("What's up?", 'brief');
  });

  it('SLOWER / FASTER step the rate', () => {
    const stepRate = vi.fn();
    const a = actions({ stepRate });
    routeVoiceTranscript('Slow down.', a);
    routeVoiceTranscript('Faster.', a);
    expect(stepRate.mock.calls).toEqual([[-1], [1]]);
  });

  it('anything else is an ordinary message, with a leading "Hey Jarvis" removed', () => {
    const a = actions();
    expect(routeVoiceTranscript('Stop the build.', a)).toEqual({ command: null, send: 'Stop the build.' });
    expect(routeVoiceTranscript('Hey Jarvis, tell Out4 to hold the refunds.', a).send).toBe('Tell Out4 to hold the refunds.');
    expect(routeVoiceTranscript('Hey Jarvis.', a).send).toBeNull();
    expect(a.stop).not.toHaveBeenCalled();
    expect(a.sendIntent).not.toHaveBeenCalled();
  });

  it('UNDO is local: the undo action runs and nothing is sent to the brain', () => {
    for (const t of ['Undo that.', "Don't send that!", 'Herald, take that back', 'cancel that', 'Scratch that.']) {
      const a = actions();
      expect(routeVoiceTranscript(t, a)).toEqual({ command: 'undo', send: null });
      expect(a.undo).toHaveBeenCalledTimes(1);
      expect(a.sendIntent).not.toHaveBeenCalled();
      expect(a.stop).not.toHaveBeenCalled();
    }
  });

  it('a sentence that starts like UNDO goes to the brain untouched', () => {
    const a = actions();
    expect(routeVoiceTranscript('Undo the migration on Out4', a)).toEqual({ command: null, send: 'Undo the migration on Out4' });
    expect(routeVoiceTranscript("Don't send that email yet, ask me first", a).command).toBeNull();
    expect(a.undo).not.toHaveBeenCalled();
  });
});
