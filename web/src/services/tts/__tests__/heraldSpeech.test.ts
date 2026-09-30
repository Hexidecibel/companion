import { describe, it, expect, beforeEach } from 'vitest';
import { BRIEFING_SPOKEN_LIMIT, HeraldSpeechController, InboxChimeTracker, MAX_REMINDERS, MORE_TAIL, REMINDER_AFTER_MS, countWords } from '../heraldSpeech';
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

describe('HeraldSpeechController: spoken length, repeat, go on, stop', () => {
  let engine: MockEngine;
  let length: 'short' | 'full';
  let ctl: HeraldSpeechController;
  const push = (e: HeraldEvent) => ctl.handleEvent(e, 'push');
  const reply = (id: string, text: string) => {
    push({ kind: 'busy', busy: true });
    push({ kind: 'message_start', message: msg(id, 'herald', '', true) });
    push({ kind: 'message_delta', messageId: id, delta: text });
    push({ kind: 'message_end', message: msg(id, 'herald', text, false) });
    push({ kind: 'busy', busy: false });
  };
  const LONG =
    'Out4 is blocked on your approval to run the refund migration. Doc Upload Site finished its deploy to prod ten minutes ago. ' +
    'Companion is still running the web tests. Nothing else changed since you last asked.';

  beforeEach(() => {
    engine = new MockEngine();
    length = 'short';
    ctl = new HeraldSpeechController(engine, {
      isEnabled: () => true,
      isVisible: () => true,
      speakOptions: () => ({ rate: 1 }),
      spokenLength: () => length,
    });
  });

  it('short: speaks at most two sentences / 40 words, then a spoken tail; the rest waits', () => {
    reply('r1', LONG);
    expect(engine.spoken).toEqual([
      'Out4 is blocked on your approval to run the refund migration.',
      'Doc Upload Site finished its deploy to prod ten minutes ago.',
      MORE_TAIL,
    ]);
    expect(ctl.hasRemainder).toBe(true);
  });

  it('the word cap wins over the sentence cap, sentence-aligned; the first sentence is always whole', () => {
    const first = `${'word '.repeat(45).trim()}.`;
    reply('r1', `${first} Second sentence here. Third.`);
    expect(engine.spoken).toEqual([first, MORE_TAIL]);
    expect(countWords(first)).toBe(45);
  });

  it('a reply within the cap is spoken whole with no tail', () => {
    reply('r1', 'Out4 is waiting on you. Everything else is running.');
    expect(engine.spoken).toEqual(['Out4 is waiting on you.', 'Everything else is running.']);
    expect(ctl.hasRemainder).toBe(false);
  });

  it('full: no cap', () => {
    length = 'full';
    reply('r1', LONG);
    expect(engine.spoken).toHaveLength(4);
    expect(engine.spoken).not.toContain(MORE_TAIL);
  });

  it('go on: continues from the truncation point, capped again', () => {
    reply('r1', LONG);
    engine.spoken = [];
    expect(ctl.continueRemainder()).toBe(true);
    expect(engine.spoken).toEqual(['Companion is still running the web tests.', 'Nothing else changed since you last asked.']);
    expect(ctl.hasRemainder).toBe(false);
    expect(ctl.continueRemainder()).toBe(false); // nothing held back: the caller asks the brain
  });

  it('go on mid-stream lifts the cap for the rest of the reply', () => {
    push({ kind: 'busy', busy: true });
    push({ kind: 'message_start', message: msg('r1', 'herald', '', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'One is first. Two is second. Three is third. ' });
    expect(engine.spoken).toEqual(['One is first.', 'Two is second.']);
    expect(ctl.continueRemainder()).toBe(true);
    expect(engine.spoken).toEqual(['One is first.', 'Two is second.', 'Three is third.']);
    push({ kind: 'message_delta', messageId: 'r1', delta: 'Four is fourth.' });
    push({ kind: 'message_end', message: msg('r1', 'herald', 'One is first. Two is second. Three is third. Four is fourth.', false) });
    expect(engine.spoken.slice(3)).toEqual(['Four is fourth.']);
  });

  it('repeat: replays exactly what was spoken (plus the tail), cancelling first', () => {
    reply('r1', LONG);
    const said = engine.spoken.slice();
    engine.spoken = [];
    const cancels = engine.cancels;
    expect(ctl.repeat()).toBe(true);
    expect(engine.cancels).toBe(cancels + 1);
    expect(engine.spoken).toEqual(said);
  });

  it('repeat with nothing said yet returns false', () => {
    expect(ctl.canRepeat).toBe(false);
    expect(ctl.repeat()).toBe(false);
    expect(engine.spoken).toEqual([]);
  });

  it('stop during thinking (the STOP command) keeps that reply silent; plain barge-in does not', () => {
    push({ kind: 'busy', busy: true });
    ctl.stop({ muteTurn: true });
    push({ kind: 'message_start', message: msg('r1', 'herald', '', true) });
    push({ kind: 'message_end', message: msg('r1', 'herald', 'Here is the answer.', false) });
    push({ kind: 'busy', busy: false });
    expect(engine.spoken).toEqual([]);
    // "go on" can still hear it afterwards.
    expect(ctl.continueRemainder()).toBe(true);
    expect(engine.spoken).toEqual(['Here is the answer.']);

    engine.spoken = [];
    push({ kind: 'busy', busy: true });
    ctl.stop();
    reply('r2', 'Second answer.');
    expect(engine.spoken).toEqual(['Second answer.']);
  });

  it('a briefing gets a longer spoken allowance, once', () => {
    ctl.setNextLimit(BRIEFING_SPOKEN_LIMIT);
    reply('b1', 'Out4 needs your approval. Docs finished its deploy. Companion finished the tests. And 2 more.');
    expect(engine.spoken).toHaveLength(4);
    engine.spoken = [];
    reply('r2', LONG);
    expect(engine.spoken).toHaveLength(3); // back to short: two sentences + tail
  });

  it('say(): a short confirmation replaces whatever was playing', () => {
    reply('r1', LONG);
    const cancels = engine.cancels;
    ctl.say('Okay.');
    expect(engine.cancels).toBe(cancels + 1);
    expect(engine.spoken[engine.spoken.length - 1]).toBe('Okay.');
  });
});

describe('InboxChimeTracker reminders', () => {
  const item = (id: string, priority: 'blocked' | 'finished', heard = false): HeraldInboxItem => ({
    id, serverId: 's', sessionId: id, sessionName: id, priority, headline: 'h', createdAt: 1, heard,
  });

  it('a toned blocked item still unheard gets at most two reminders, 5 minutes apart', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'state', state: state([], []) }, 'fetch', 0);
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('a', 'blocked')] }, 'push', 1000)).toBe('blocked');
    expect(t.dueReminder(1000 + REMINDER_AFTER_MS - 1)).toBeNull();
    expect(t.dueReminder(1000 + REMINDER_AFTER_MS)).toBe('blocked');
    expect(t.dueReminder(1000 + REMINDER_AFTER_MS + 1000)).toBeNull();
    expect(t.dueReminder(1000 + 2 * REMINDER_AFTER_MS)).toBe('blocked');
    expect(t.dueReminder(1000 + 10 * REMINDER_AFTER_MS)).toBeNull();
    expect(MAX_REMINDERS).toBe(2);
  });

  it('hearing the item (briefing, tap) or it leaving the inbox cancels its reminders', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'state', state: state([], []) }, 'fetch', 0);
    t.handleEvent({ kind: 'inbox', inbox: [item('a', 'blocked'), item('b', 'blocked')] }, 'push', 0);
    expect(t.pendingReminders).toBe(2);
    t.handleEvent({ kind: 'inbox', inbox: [item('a', 'blocked', true), item('b', 'blocked')] }, 'push', 10);
    expect(t.pendingReminders).toBe(1);
    t.handleEvent({ kind: 'inbox', inbox: [] }, 'push', 20);
    expect(t.pendingReminders).toBe(0);
    expect(t.dueReminder(REMINDER_AFTER_MS * 3)).toBeNull();
  });

  it('finished items and items present at load never remind', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'state', state: state([], [item('old', 'blocked')]) }, 'fetch', 0);
    t.handleEvent({ kind: 'inbox', inbox: [item('old', 'blocked'), item('f', 'finished')] }, 'push', 0);
    expect(t.dueReminder(REMINDER_AFTER_MS * 2)).toBeNull();
  });
});
