import { describe, it, expect, beforeEach } from 'vitest';
import { HeraldSpeechController, InboxChimeTracker } from '../heraldSpeech';
import type { TtsEngine, TtsEvent, TtsSpeakOptions, TtsVoice } from '../types';
import type { HeraldEvent, HeraldInboxItem, HeraldMessage, HeraldState } from '../../../types/herald';

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  available = true;
  spoken: string[] = [];
  cancels = 0;
  get speaking() { return false; }
  speak(text: string, _opts?: TtsSpeakOptions) { this.spoken.push(text); }
  cancel() { this.cancels++; }
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(_l: (e: TtsEvent) => void) { return () => {}; }
  dispose() {}
}

const msg = (id: string, role: 'user' | 'herald', text = '', streaming?: boolean): HeraldMessage =>
  ({ id, role, text, createdAt: 1, streaming });

const state = (messages: HeraldMessage[], inbox: HeraldInboxItem[] = []): HeraldState => ({
  displayName: 'Herald', enabled: true, model: 'm', busy: false, messages, inbox, actions: [],
});

describe('HeraldSpeechController', () => {
  let engine: MockEngine;
  let enabled: boolean;
  let visible: boolean;
  let ctl: HeraldSpeechController;
  const push = (e: HeraldEvent) => ctl.handleEvent(e, 'push');
  const stream = (id: string, deltas: string[], final?: string) => {
    push({ kind: 'message_start', message: msg(id, 'herald', '', true) });
    for (const d of deltas) push({ kind: 'message_delta', messageId: id, delta: d });
    push({ kind: 'message_end', message: msg(id, 'herald', final ?? deltas.join(''), false) });
  };

  beforeEach(() => {
    engine = new MockEngine();
    enabled = true;
    visible = true;
    ctl = new HeraldSpeechController(engine, {
      isEnabled: () => enabled,
      isVisible: () => visible,
      speakOptions: () => ({ rate: 1 }),
    });
  });

  it('speaks each sentence as it completes, then flushes the remainder at end', () => {
    push({ kind: 'message_start', message: msg('r1', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'API is **done**. We' });
    expect(engine.spoken).toEqual(['API is done.']);
    push({ kind: 'message_delta', messageId: 'r1', delta: 'b is blocked' });
    expect(engine.spoken).toEqual(['API is done.']);
    push({ kind: 'message_end', message: msg('r1', 'herald', 'API is **done**. Web is blocked', false) });
    expect(engine.spoken).toEqual(['API is done.', 'Web is blocked']);
  });

  it('speaks text appended only in message_end', () => {
    stream('r1', ['Sent it.'], 'Sent it. Needs your confirmation: yes.');
    expect(engine.spoken).toEqual(['Sent it.', 'Needs your confirmation: yes.']);
  });

  it('never speaks history from snapshots', () => {
    ctl.handleEvent({ kind: 'state', state: state([msg('old', 'herald', 'Old reply.', false)]) }, 'fetch');
    expect(engine.spoken).toEqual([]);
    // A replayed start/end for a known message stays silent too.
    push({ kind: 'message_start', message: msg('old', 'herald', 'Old reply.', false) });
    push({ kind: 'message_end', message: msg('old', 'herald', 'Old reply.', false) });
    expect(engine.spoken).toEqual([]);
  });

  it('ignores fetch-sourced stream events and user messages', () => {
    ctl.handleEvent({ kind: 'message_start', message: msg('x', 'herald', 'Hi there.', false) }, 'fetch');
    push({ kind: 'message_start', message: msg('u1', 'user', 'What is up?', false) });
    push({ kind: 'message_end', message: msg('u1', 'user', 'What is up?', false) });
    expect(engine.spoken).toEqual([]);
  });

  it('stays quiet when voice is off or the tab is hidden', () => {
    enabled = false;
    stream('a', ['One. Two.']);
    enabled = true;
    visible = false;
    stream('b', ['Three. Four.']);
    expect(engine.spoken).toEqual([]);
  });

  it('does not start speaking a reply that began while voice was off', () => {
    enabled = false;
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    enabled = true;
    push({ kind: 'message_delta', messageId: 'r', delta: 'Hello there. ' });
    push({ kind: 'message_end', message: msg('r', 'herald', 'Hello there. ', false) });
    expect(engine.spoken).toEqual([]);
  });

  it('goes quiet mid-reply when the tab becomes hidden', () => {
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r', delta: 'First. ' });
    visible = false;
    push({ kind: 'message_delta', messageId: 'r', delta: 'Second. ' });
    visible = true;
    push({ kind: 'message_end', message: msg('r', 'herald', 'First. Second. Third.', false) });
    expect(engine.spoken).toEqual(['First.']);
    expect(engine.cancels).toBeGreaterThan(0);
  });

  it('barge-in cancels the engine and drops the rest of the reply', () => {
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r', delta: 'One. ' });
    ctl.stop();
    expect(engine.cancels).toBe(1);
    expect(ctl.liveId).toBeNull();
    push({ kind: 'message_delta', messageId: 'r', delta: 'Two. ' });
    push({ kind: 'message_end', message: msg('r', 'herald', 'One. Two. Three', false) });
    expect(engine.spoken).toEqual(['One.']);
  });

  it('a new reply cancels the old one and is spoken instead', () => {
    push({ kind: 'message_start', message: msg('r1', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'Old news. More' });
    push({ kind: 'message_start', message: msg('r2', 'herald', '', true) });
    expect(engine.cancels).toBe(1);
    push({ kind: 'message_delta', messageId: 'r1', delta: ' old. ' });
    push({ kind: 'message_delta', messageId: 'r2', delta: 'Fresh news. ' });
    expect(engine.spoken).toEqual(['Old news.', 'Fresh news.']);
  });

  it('the next live reply speaks normally after a barge-in', () => {
    push({ kind: 'message_start', message: msg('r1', 'herald', '', true) });
    ctl.stop();
    stream('r2', ['Back again. ']);
    expect(engine.spoken).toEqual(['Back again.']);
  });

  it('flushes on busy=false when a turn ends without message_end', () => {
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r', delta: 'Partial thought' });
    push({ kind: 'busy', busy: false });
    expect(engine.spoken).toEqual(['Partial thought']);
  });

  it('finishes from a snapshot when message_end was missed', () => {
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r', delta: 'Half. ' });
    ctl.handleEvent({ kind: 'state', state: state([msg('r', 'herald', 'Half. Whole.', false)]) }, 'fetch');
    expect(engine.spoken).toEqual(['Half.', 'Whole.']);
  });

  it('speaks a complete non-streamed live herald message', () => {
    push({ kind: 'message_start', message: msg('n', 'herald', 'Sent to api.', false) });
    push({ kind: 'message_end', message: msg('n', 'herald', 'Sent to api.', false) });
    expect(engine.spoken).toEqual(['Sent to api.']);
  });

  it('never calls speak on an unavailable engine', () => {
    engine.available = false;
    stream('r', ['Hello. ']);
    expect(engine.spoken).toEqual([]);
  });

  it('reset forgets the live reply', () => {
    push({ kind: 'message_start', message: msg('r', 'herald', '', true) });
    ctl.reset();
    push({ kind: 'message_delta', messageId: 'r', delta: 'Late. ' });
    expect(engine.spoken).toEqual(['Late.']); // unknown id after reset: treated as new live message
  });
});

describe('InboxChimeTracker', () => {
  const item = (id: string, priority: HeraldInboxItem['priority'], heard = false): HeraldInboxItem =>
    ({ id, serverId: 's', sessionId: id, sessionName: id, priority, headline: 'h', createdAt: 1, heard });

  it('never chimes for items present at load', () => {
    const t = new InboxChimeTracker();
    expect(t.handleEvent({ kind: 'state', state: state([], [item('a', 'blocked')]) }, 'fetch')).toBeNull();
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('a', 'blocked')] }, 'push')).toBeNull();
  });

  it('first inbox push before any snapshot only seeds', () => {
    const t = new InboxChimeTracker();
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('a', 'finished')] }, 'push')).toBeNull();
  });

  it('chimes once per new unheard item, blocked beats finished', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'state', state: state([], []) }, 'fetch');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('f', 'finished')] }, 'push')).toBe('finished');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('f', 'finished')] }, 'push')).toBeNull();
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('f', 'finished'), item('g', 'finished'), item('b', 'blocked')] }, 'push')).toBe('blocked');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('p', 'progress'), item('h', 'finished', true)] }, 'push')).toBeNull();
  });

  it('reconnect snapshots are silent', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'state', state: state([], []) }, 'fetch');
    expect(t.handleEvent({ kind: 'state', state: state([], [item('x', 'blocked')]) }, 'fetch')).toBeNull();
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('x', 'blocked')] }, 'push')).toBeNull();
  });
});
