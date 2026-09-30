import { resolveSession, sessionsMentioned } from '../src/herald/resolve';
import { resolveOption, validateToolCall } from '../src/herald/tools';
import { InboxTracker } from '../src/herald/inbox';
import { extractRecentTranscript } from '../src/herald/session-source';
import { trailingQuestion, firstSentence, flattenMarkdown } from '../src/herald/text';
import { snap } from './herald-helpers';

describe('resolveSession', () => {
  const sessions = [
    snap({ sessionId: 'companion', projectName: 'companion' }),
    snap({ sessionId: 'companion-herald', projectName: 'companion-herald' }),
    snap({ sessionId: 'notes-app', sessionName: 'Notes', projectName: 'notes' }),
    snap({ sessionId: 'deploy', projectName: 'infra' }),
    snap({ sessionId: 'old-thing', inactive: true, projectName: 'old-thing' }),
  ];

  it.each([
    ['companion', 'companion'],
    ['Companion', 'companion'],
    ['the companion session', 'companion'],
    ['companion-herald', 'companion-herald'],
    ['herald', 'companion-herald'],
    ['notes', 'notes-app'],
    ['Notes', 'notes-app'],
    ['infra', 'deploy'],
    ['the deploy one', 'deploy'],
  ])('%s -> %s', (ref, id) => {
    const r = resolveSession(ref, sessions);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.sessionId).toBe(id);
  });

  it('no match asks the user, lists live sessions only', () => {
    const r = resolveSession('billing', sessions);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/ask the user/i);
      expect(r.candidates).not.toContain('old-thing');
    }
  });

  it('ambiguous partial match never guesses', () => {
    const two = [snap({ sessionId: 'api-server', projectName: 'api-server' }), snap({ sessionId: 'api-client', projectName: 'api-client' })];
    const r = resolveSession('api', two);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/matches 2 sessions/);
      expect(r.candidates.sort()).toEqual(['api-client', 'api-server']);
    }
  });

  it('two sessions sharing a project name are ambiguous', () => {
    const two = [
      snap({ sessionId: 'a', sessionName: 'alpha', projectName: 'web' }),
      snap({ sessionId: 'b', sessionName: 'beta', projectName: 'web' }),
    ];
    const r = resolveSession('web', two);
    expect(r.ok).toBe(false);
  });

  it('prefers live over inactive when that disambiguates', () => {
    const list = [snap({ sessionId: 'x1', sessionName: 'web', inactive: true }), snap({ sessionId: 'x2', sessionName: 'web' })];
    const r = resolveSession('web', list);
    expect(r.ok && r.session.sessionId).toBe('x2');
  });

  it('empty and filler-only references are rejected', () => {
    expect(resolveSession('', sessions).ok).toBe(false);
    expect(resolveSession('the session', sessions).ok).toBe(false);
  });

  it('short substrings do not match everything', () => {
    expect(resolveSession('a', sessions).ok).toBe(false);
  });
});

describe('resolveOption', () => {
  const options = [{ label: 'Yes, run the tests' }, { label: 'Skip tests' }, { label: 'Cancel' }];
  it.each([
    ['2', 1],
    ['option 1', 0],
    ['Cancel', 2],
    ['skip tests', 1],
    ['skip', 1],
  ])('%s -> %d', (ref, idx) => {
    const r = resolveOption(ref, options);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.index).toBe(idx);
  });
  it('ambiguous option asks', () => {
    const r = resolveOption('tests', options);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Ask the user/);
  });
  it('out of range asks', () => {
    expect(resolveOption('7', options).ok).toBe(false);
  });
  it('never matches across a negation', () => {
    const opts = [{ label: 'Proceed' }, { label: "Don't go ahead" }];
    expect(resolveOption('go ahead', opts).ok).toBe(false);
    expect(resolveOption('go', opts).ok).toBe(false);
    const r = resolveOption("don't go ahead", opts);
    expect(r.ok && r.index).toBe(1);
  });
  it('does not match on character substrings inside words', () => {
    const opts = [{ label: 'Yes' }, { label: 'Nothing else' }];
    expect(resolveOption('no', opts).ok).toBe(false);
  });
});

describe('validateToolCall', () => {
  it('accepts valid args', () => {
    expect(validateToolCall('summarize_session', '{"session":"companion"}')).toEqual({ ok: true, value: { session: 'companion' } });
    expect(validateToolCall('list_sessions', '')).toEqual({ ok: true, value: {} });
  });
  it('coerces numeric option and string booleans', () => {
    const r = validateToolCall('propose_input', '{"session":"c","option":2,"confirm":"true"}');
    expect(r).toEqual({ ok: true, value: { session: 'c', option: '2', confirm: true } });
  });
  it.each([
    ['bad json', 'propose_input', '{"session": "c", "option": '],
    ['array', 'summarize_session', '["c"]'],
    ['missing required', 'summarize_session', '{}'],
    ['unknown arg', 'summarize_session', '{"session":"c","verbose":true}'],
    ['wrong type', 'summarize_session', '{"session":{"name":"c"}}'],
    ['both option and text', 'propose_input', '{"session":"c","option":"1","text":"hi"}'],
    ['neither option nor text', 'propose_input', '{"session":"c"}'],
    ['unknown tool', 'rm_rf', '{}'],
    ['too long', 'summarize_session', JSON.stringify({ session: 'x'.repeat(500) })],
  ])('rejects %s', (_n, name, args) => {
    const r = validateToolCall(name, args);
    expect(r.ok).toBe(false);
  });
});

describe('InboxTracker', () => {
  const choice = {
    question: 'Which approach?',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
    signature: 'sig1',
  };

  it('shows a live choice prompt immediately (even on first poll) and resolves it', () => {
    const t = new InboxTracker();
    expect(t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 1)).toBe(true);
    const items = t.list();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('blocked');
    expect(items[0].headline).toBe('s1 is asking: Which approach?');
    // Seen again: no change, same id.
    expect(t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 2)).toBe(false);
    // Answered -> working: resolved immediately.
    expect(t.update([snap({ sessionId: 's1', status: 'working' })], 3)).toBe(true);
    expect(t.list()).toHaveLength(0);
  });

  it('tolerates one flaky miss before resolving a blocked item', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 1);
    t.update([snap({ sessionId: 's1', status: 'idle' })], 2);
    expect(t.list()).toHaveLength(1);
    t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 3);
    t.update([snap({ sessionId: 's1', status: 'idle' })], 4);
    expect(t.list()).toHaveLength(1);
    t.update([snap({ sessionId: 's1', status: 'idle' })], 5);
    expect(t.list()).toHaveLength(0);
  });

  it('a recurring identical prompt gets a fresh (unheard) item', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 1000);
    const first = t.list()[0].id;
    t.markHeard([first]);
    t.update([snap({ sessionId: 's1', status: 'working' })], 2000);
    t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice, lastTurnKey: 'next-turn' })], 3000);
    const second = t.list()[0];
    expect(second.id).not.toBe(first);
    expect(second.heard).toBe(false);
  });

  it('finished only on observed transition, deduped, cleared when work resumes', () => {
    const t = new InboxTracker();
    // First poll: idle session with an old turn -> nothing (no flood on startup).
    t.update([snap({ sessionId: 's1', status: 'idle', lastTurnKey: 'm1', lastTurnGist: 'Old stuff.' })], 1);
    expect(t.list()).toHaveLength(0);
    t.update([snap({ sessionId: 's1', status: 'working', lastTurnKey: 'm1' })], 2);
    t.update([snap({ sessionId: 's1', status: 'idle', lastTurnKey: 'm2', lastTurnGist: '**Done.** Refactored the parser. More text.' })], 3);
    let items = t.list();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('finished');
    expect(items[0].headline).toBe('s1 finished: Done.');
    // Same state again: no duplicate.
    expect(t.update([snap({ sessionId: 's1', status: 'idle', lastTurnKey: 'm2' })], 4)).toBe(false);
    // Work resumes: finished note removed.
    t.update([snap({ sessionId: 's1', status: 'working', lastTurnKey: 'm2' })], 5);
    items = t.list();
    expect(items).toHaveLength(0);
  });

  it('question-ended turn becomes blocked on transition', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 's1', status: 'working', lastTurnKey: 'm1' })], 1);
    t.update([snap({ sessionId: 's1', status: 'waiting', lastTurnKey: 'm2', pendingQuestion: 'Want me to open a PR?' })], 2);
    const items = t.list();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('blocked');
    expect(items[0].headline).toBe('s1 is asking: Want me to open a PR?');
  });

  it('sorts blocked before finished and marks heard', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 'a', status: 'working' }), snap({ sessionId: 'b', status: 'idle' })], 1);
    t.update(
      [snap({ sessionId: 'a', status: 'idle', lastTurnKey: 'x' }), snap({ sessionId: 'b', status: 'waiting', pendingApproval: { tool: 'Bash', detail: 'npm test', toolUseId: 'tu1' } })],
      2
    );
    const items = t.list();
    expect(items.map((i) => i.priority)).toEqual(['blocked', 'finished']);
    expect(items[0].headline).toBe('b needs approval for Bash: npm test');
    expect(t.markHeard([items[1].id])).toBe(true);
    expect(t.list()[1].heard).toBe(true);
    expect(t.markHeard([items[1].id])).toBe(false);
    expect(t.heardIds()).toContain(items[1].id);
  });

  it('heard markers survive a restart via constructor', () => {
    const t1 = new InboxTracker();
    t1.update([snap({ sessionId: 's', status: 'waiting', pendingChoice: choice })], 5);
    const id = t1.list()[0].id;
    t1.markHeard([id]);
    const t2 = new InboxTracker(t1.heardIds());
    t2.update([snap({ sessionId: 's', status: 'waiting', pendingChoice: choice })], 5);
    expect(t2.list()[0].heard).toBe(true);
  });

  it('vanished session drops blocked items', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 's1', status: 'waiting', pendingChoice: choice })], 1);
    t.update([], 2);
    expect(t.list()).toHaveLength(0);
  });
});

describe('transcript + text helpers', () => {
  it('extractRecentTranscript groups assistant messages into turns', () => {
    const msgs: any[] = [
      { id: '1', type: 'user', content: 'do X', timestamp: 1 },
      { id: '2', type: 'assistant', content: 'working on X', timestamp: 2 },
      { id: '3', type: 'assistant', content: '', timestamp: 3 },
      { id: '4', type: 'assistant', content: 'done with X', timestamp: 4 },
      { id: '5', type: 'user', content: 'now Y', timestamp: 5 },
      { id: '6', type: 'assistant', content: 'Y done. Want Z?', timestamp: 6 },
    ];
    const t = extractRecentTranscript(msgs, 2);
    expect(t.lastUserPrompt?.text).toBe('now Y');
    expect(t.assistantTurns.map((x) => x.text)).toEqual(['working on X\n\ndone with X', 'Y done. Want Z?']);
    expect(extractRecentTranscript(msgs, 1).assistantTurns.map((x) => x.text)).toEqual(['Y done. Want Z?']);
  });

  it('trailingQuestion', () => {
    expect(trailingQuestion('I fixed it. Should I push to main?')).toBe('Should I push to main?');
    expect(trailingQuestion('All done.')).toBeNull();
    expect(trailingQuestion('Is this ok? I went ahead anyway.')).toBeNull();
  });

  it('firstSentence flattens markdown', () => {
    expect(firstSentence('## Summary\n**Fixed** the `parser` bug. Then more.')).toBe('Summary Fixed the parser bug.');
    expect(flattenMarkdown('see [docs](http://x)')).toBe('see docs');
  });
});

describe('sessionsMentioned', () => {
  const sessions = [
    snap({ sessionId: 'out4', sessionName: 'Out4', projectName: 'out4' }),
    snap({ sessionId: 'doc', sessionName: 'Doc Upload Site', projectName: 'doc-upload-site' }),
    snap({ sessionId: 'ap', sessionName: 'Apps', projectName: 'apps' }),
    snap({ sessionId: 'gone', sessionName: 'Legacy', projectName: 'legacy', inactive: true }),
  ];
  const names = (t: string) => sessionsMentioned(t, sessions).map((s) => s.sessionName);

  it('finds sessions named outright by display or project name', () => {
    expect(names('Where is Out4 at with the refunds?')).toEqual(['Out4']);
    expect(names('what did the doc-upload-site session decide')).toEqual(['Doc Upload Site']);
    expect(names('compare out4 and apps')).toEqual(['Out4', 'Apps']);
  });

  it('needs whole tokens and ignores inactive sessions', () => {
    expect(names('happy with the output?')).toEqual([]);
    expect(names('my apps are fine')).toEqual(['Apps']);
    expect(names('what about legacy')).toEqual([]);
    expect(names('anything for me?')).toEqual([]);
  });
});
