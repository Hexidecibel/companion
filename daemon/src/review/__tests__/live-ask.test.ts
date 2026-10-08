import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { ReviewStore } from '../store';
import { GitRunner } from '../git-runner';
import {
  prompt,
  toolUse,
  toolResult,
  editResult,
  assistantText,
  jsonl,
  tmpDir,
  fakeWatcher,
} from './helpers';

const T0 = Date.parse('2026-09-30T08:00:00Z');

function mk(extra: Partial<ConstructorParameters<typeof ReviewService>[0]> = {}) {
  const conv = path.join(tmpDir(), 'c.jsonl');
  fs.writeFileSync(
    conv,
    jsonl([
      prompt('t1', 'fix it', T0),
      toolUse('e1', 'Edit', { file_path: '/proj/src/a.ts' }, T0 + 1),
      toolResult(
        'e1',
        editResult('/proj/src/a.ts', [
          {
            oldStart: 10,
            oldLines: 2,
            newStart: 10,
            newLines: 3,
            lines: [' x', '-old', '+new', '+more'],
          },
        ]),
        T0 + 2
      ),
      assistantText("I've fixed the parser.", T0 + 3),
    ])
  );
  const pushed: Array<{ clientId: string; type: string; payload: any }> = [];
  const svc = new ReviewService({
    watcher: fakeWatcher([{ id: 'sess', projectPath: '/proj', files: [conv], waiting: false }]),
    gitEnabled: () => false,
    runner: new GitRunner({ enabled: () => false }),
    store: new ReviewStore(tmpDir(), 5),
    sendToClient: (clientId, type, payload) => {
      pushed.push({ clientId, type, payload });
      return true;
    },
    debounceMs: 0,
    throttleMs: 0,
    ...extra,
  });
  return { svc, conv, pushed };
}

describe('review_watch / review_live', () => {
  it('streams started/completed edits to watching connections only', async () => {
    const { svc, conv, pushed } = mk();
    const w = await svc.watch('c1', 'sess', true);
    expect(w.watching).toBe(true);
    fs.appendFileSync(conv, jsonl([toolUse('e2', 'Write', { file_path: '/proj/b.ts' }, T0 + 10)]));
    await svc.refresh('sess');
    fs.appendFileSync(
      conv,
      jsonl([
        toolResult(
          'e2',
          { type: 'create', filePath: '/proj/b.ts', content: 'hi\n', structuredPatch: [] },
          T0 + 11
        ),
      ])
    );
    await svc.refresh('sess');
    const live = pushed.filter((p) => p.type === 'review_live');
    expect(live.map((p) => [p.clientId, p.payload.phase, p.payload.edit.id])).toEqual([
      ['c1', 'started', 'e2'],
      ['c1', 'completed', 'e2'],
    ]);
    expect(live[0].payload.edit.pending).toBe(true);
    expect(live[1].payload.sessionId).toBe('sess');
    svc.dropClient('c1');
    fs.appendFileSync(conv, jsonl([toolUse('e3', 'Edit', { file_path: '/proj/c.ts' }, T0 + 20)]));
    await svc.refresh('sess');
    expect(pushed.filter((p) => p.type === 'review_live')).toHaveLength(2);
    expect(svc.watcherCount()).toBe(0);
  });
});

describe('review_ask', () => {
  it('relays through Herald with the composed question', async () => {
    const calls: any[] = [];
    const { svc } = mk();
    svc.setHerald({
      featureEnabled: true,
      relayAsk: async (r) => {
        calls.push(r);
        return { askId: 'ask-1' };
      },
    });
    const r = await svc.ask(
      { sessionId: 'sess', absPath: '/proj/src/a.ts', hunkId: 'e1#0', question: 'is this safe?' },
      'c1'
    );
    expect(r.via).toBe('herald');
    expect(r.askId).toBe('ask-1');
    expect(r.sentText).toBe(
      'Why did you make this change? (from Companion review)\nsrc/a.ts:10-12 (turn 1: "Fix it")\n```diff\n x\n-old\n+new\n+more\n```\nis this safe?'
    );
    expect(calls[0]).toMatchObject({
      sessionId: 'sess',
      userText: 'is this safe?',
      clientId: 'c1',
    });
  });

  it('maps Herald refusals (choice on screen) to session_waiting', async () => {
    const { svc } = mk();
    svc.setHerald({
      featureEnabled: true,
      relayAsk: async () => {
        throw Object.assign(new Error('waiting'), { code: 'session_waiting' });
      },
    });
    await expect(
      svc.ask({ sessionId: 'sess', absPath: '/proj/src/a.ts', hunkId: 'e1#0' })
    ).rejects.toMatchObject({ code: 'session_waiting' });
  });

  it('without Herald sends directly, refusing when a choice is on screen', async () => {
    const sent: string[] = [];
    let choice = true;
    const { svc } = mk({
      sendDirect: async (_id, t) => {
        sent.push(t);
        return true;
      },
      hasLiveChoice: async () => choice,
    });
    await expect(
      svc.ask({ sessionId: 'sess', absPath: '/proj/src/a.ts', hunkId: 'e1#0' })
    ).rejects.toMatchObject({ code: 'session_waiting' });
    choice = false;
    const r = await svc.ask({ sessionId: 'sess', absPath: '/proj/src/a.ts', hunkId: 'e1#0' });
    expect(r).toMatchObject({ via: 'direct', askId: null });
    expect(sent).toHaveLength(1);
    await expect(
      svc.ask({ sessionId: 'sess', absPath: '/proj/src/a.ts', hunkId: 'zz#0' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
