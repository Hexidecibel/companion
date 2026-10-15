import * as fs from 'fs';
import { SubagentTracker, FILE_BUDGET, LARGE_FILE, TAIL_START } from '../tracker';
import { deriveStatus } from '../completion';
import { parseNotifications, notificationsInEntry } from '../notify';
import { SUBAGENT_LIMITS } from '../protocol';
import { MAX_STUCK_EVENTS } from '../state';
import {
  T0,
  tmpProjects,
  prompt,
  toolUse,
  text,
  result,
  notification,
  queuedNotification,
  meta,
  agentFile,
  append,
  line,
  iso,
} from './fixtures';

const MIN = 60_000;

function setup(nowStart = T0) {
  const env = tmpProjects();
  let now = nowStart;
  const tracker = new SubagentTracker({ now: () => now, passDelayMs: 1_000_000 });
  return {
    ...env,
    tracker,
    setNow: (n: number) => {
      now = n;
    },
    async settle() {
      // Passes until nothing is dirty (budgets may split work across passes).
      for (let i = 0; i < 200; i++) {
        await tracker.pass();
        const t = tracker as unknown as { dirty: Set<string>; parentDirty: Set<string> };
        if (!t.dirty.size && !t.parentDirty.size) break;
      }
    },
  };
}

afterEach(() => jest.useRealTimers());

describe('notify parsing', () => {
  it('parses status, summary, result and usage', () => {
    const n = parseNotifications(
      '<task-notification>\n<task-id>a1b2c3d4e5</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>failed</status>\n<summary>Agent "x" failed</summary>\n<result>boom</result>\n<usage><subagent_tokens>1234</subagent_tokens><tool_uses>7</tool_uses><duration_ms>5000</duration_ms></usage>\n</task-notification>',
      5
    );
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      taskId: 'a1b2c3d4e5',
      toolUseId: 'toolu_1',
      status: 'failed',
      result: 'boom',
      tokens: 1234,
      toolUses: 7,
      durationMs: 5000,
      at: 5,
    });
  });

  it('maps killed to stopped and ignores quoted notifications in tool results / assistant text', () => {
    expect(
      parseNotifications(
        '<task-notification><task-id>abc123</task-id><status>killed</status></task-notification>',
        0
      )[0].status
    ).toBe('stopped');
    const body =
      '<task-notification><task-id>abc123</task-id><status>completed</status></task-notification>';
    expect(
      notificationsInEntry({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: body }] },
      } as never)
    ).toEqual([]);
    expect(
      notificationsInEntry({
        type: 'assistant',
        message: { content: [{ type: 'text', text: body }] },
      } as never)
    ).toEqual([]);
    expect(
      notificationsInEntry({
        type: 'user',
        message: { content: [{ type: 'text', text: body }] },
      } as never)
    ).toHaveLength(1);
    expect(
      notificationsInEntry({
        type: 'queue-operation',
        operation: 'dequeue',
        content: body,
      } as never)
    ).toEqual([]);
  });
});

describe('completion state machine (pure)', () => {
  const base = {
    now: T0 + 10 * MIN,
    startedAt: T0,
    lastEntryAt: T0 + MIN,
    lastBytesAt: T0 + MIN,
    assistantEntries: 5,
    pendingCount: 0,
    pendingAgentCall: false,
    childActive: false,
    lastStopReason: null as string | null,
    notification: null as { status: 'completed' | 'failed' | 'stopped'; at: number } | null,
    stoppedByUser: false,
    parentKnown: true,
  };
  it('a long quiet agent with a pending tool stays running', () => {
    expect(deriveStatus({ ...base, now: T0 + 6 * 60 * MIN, pendingCount: 1 })).toBe('running');
  });
  it('a text-only last entry (no end_turn) never completes', () => {
    expect(deriveStatus({ ...base, now: T0 + 5 * MIN })).toBe('running');
  });
  it('lost after 30 min of nothing', () => {
    expect(deriveStatus({ ...base, now: T0 + 40 * MIN })).toBe('lost');
  });
  it('end_turn without a notification: unconfirmed after the wait', () => {
    expect(
      deriveStatus({
        ...base,
        now: T0 + MIN + 20_000,
        lastStopReason: 'end_turn',
        parentKnown: false,
      })
    ).toBe('running');
    expect(
      deriveStatus({
        ...base,
        now: T0 + MIN + 40_000,
        lastStopReason: 'end_turn',
        parentKnown: false,
      })
    ).toBe('done_unconfirmed');
    expect(deriveStatus({ ...base, now: T0 + MIN + 40_000, lastStopReason: 'end_turn' })).toBe(
      'running'
    );
    expect(deriveStatus({ ...base, now: T0 + 4 * MIN, lastStopReason: 'end_turn' })).toBe(
      'done_unconfirmed'
    );
  });
  it('notification decides; newer entries mean resumed', () => {
    const n = { status: 'completed' as const, at: T0 + 2 * MIN };
    expect(deriveStatus({ ...base, notification: n })).toBe('done');
    expect(deriveStatus({ ...base, notification: { ...n, status: 'failed' } })).toBe('failed');
    expect(deriveStatus({ ...base, notification: n, stoppedByUser: true })).toBe('stopped');
    expect(
      deriveStatus({
        ...base,
        notification: n,
        lastEntryAt: T0 + 3 * MIN,
        lastBytesAt: T0 + 3 * MIN,
      })
    ).toBe('running');
  });
  it('waiting on a child', () => {
    expect(deriveStatus({ ...base, childActive: true, lastStopReason: 'end_turn' })).toBe(
      'waiting_child'
    );
    expect(deriveStatus({ ...base, pendingAgentCall: true, pendingCount: 1 })).toBe(
      'waiting_child'
    );
  });
});

describe('SubagentTracker', () => {
  it('tails across partial lines (each entry folded once)', async () => {
    const s = setup();
    const f = agentFile(s.subDir, 'a1111111111111111');
    const p = prompt('a1111111111111111', T0);
    fs.writeFileSync(f, p.slice(0, 40));
    s.tracker.register(f, { mtimeMs: T0 });
    await s.settle();
    expect(s.tracker.get('a1111111111111111')!.entries).toBe(0);
    append(
      f,
      p.slice(40) + toolUse('a1111111111111111', T0 + 1000, 'm1', 't1', 'Bash', { command: 'ls' })
    );
    s.tracker.markDirty('a1111111111111111', true);
    await s.settle();
    const rec = s.tracker.get('a1111111111111111')!;
    expect(rec.entries).toBe(2);
    expect(rec.prompt).toBe('Do the thing');
    expect(rec.pendingCount).toBe(1);
  });

  it('a text entry followed by a tool_use entry never marks the agent done', async () => {
    const s = setup();
    const id = 'a2222222222222222';
    const f = agentFile(s.subDir, id);
    fs.writeFileSync(f, prompt(id, T0) + text(id, T0 + 1000, 'm1', 'Let me check.'));
    s.tracker.register(f, { mtimeMs: T0 + 1000 });
    await s.settle();
    s.setNow(T0 + 20 * MIN);
    await s.tracker.tick();
    expect(s.tracker.get(id)!.status).toBe('running');
    append(f, toolUse(id, T0 + 20 * MIN, 'm1', 't1', 'Bash', { command: 'npm test' }, 'tool_use'));
    s.tracker.markDirty(id, true);
    await s.settle();
    s.setNow(T0 + 80 * MIN);
    await s.tracker.tick();
    const st = s.tracker.summary(s.tracker.get(id)!);
    expect(st.status).toBe('running');
    expect(st.pendingTool).toBe('Bash');
  });

  it('mid-file end_turn followed by more bytes is running; notification completes; resume reopens', async () => {
    const s = setup();
    const id = 'a3333333333333333';
    const f = agentFile(s.subDir, id);
    fs.writeFileSync(f, prompt(id, T0) + text(id, T0 + 1000, 'm1', 'Done for now.', 'end_turn'));
    meta(s.subDir, id, {
      agentType: 'Explore',
      description: 'Audit things',
      toolUseId: 'toolu_p1',
    });
    s.tracker.register(f, { mtimeMs: T0 + 1000 });
    await s.settle();
    append(
      f,
      prompt(id, T0 + 5000, 'more') +
        toolUse(id, T0 + 6000, 'm2', 't9', 'Read', { file_path: '/x/a.ts' })
    );
    s.tracker.markDirty(id, true);
    s.setNow(T0 + 10_000);
    await s.settle();
    expect(s.tracker.get(id)!.status).toBe('running');
    append(
      f,
      result(id, T0 + 7000, 't9', 'ok') + text(id, T0 + 8000, 'm3', 'All done.', 'end_turn')
    );
    append(s.convPath, notification(id, T0 + 9000, 'completed', { tokens: 99999 }));
    s.tracker.markDirty(id, true);
    s.tracker.markParentDirty(s.convPath);
    await s.settle();
    let rec = s.tracker.get(id)!;
    expect(rec.status).toBe('done');
    expect(rec.endedAt).toBe(T0 + 9000);
    const sum = s.tracker.summary(rec);
    expect(sum.name).toBe('Audit things');
    expect(sum.type).toBe('Explore');
    expect(sum.tokens).toBe(99999);
    expect(sum.notifySummary).toContain('finished');
    // Resumed via SendMessage: new entries after the notification.
    s.setNow(T0 + 5 * MIN);
    append(f, prompt(id, T0 + 4 * MIN, 'one more thing'));
    s.tracker.markDirty(id, true);
    await s.settle();
    rec = s.tracker.get(id)!;
    expect(rec.status).toBe('running');
    expect(rec.endedAt).toBeUndefined();
    expect(rec.timeline.some((e) => e.kind === 'resume')).toBe(true);
    append(f, text(id, T0 + 4 * MIN + 1000, 'm4', 'ok', 'end_turn'));
    append(s.convPath, notification(id, T0 + 4 * MIN + 2000, 'completed', { tokens: 120000 }));
    s.tracker.markDirty(id, true);
    s.tracker.markParentDirty(s.convPath);
    await s.settle();
    rec = s.tracker.get(id)!;
    expect(rec.status).toBe('done');
    expect(rec.notifications).toBe(2);
  });

  it('failed and stopped notifications; queued + delivered copies count once', async () => {
    const s = setup();
    const a = 'a4444444444444444';
    const b = 'a5555555555555555';
    for (const id of [a, b]) {
      fs.writeFileSync(
        agentFile(s.subDir, id),
        prompt(id, T0) + text(id, T0 + 1000, 'm1', 'x', 'end_turn')
      );
      s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0 + 1000 });
    }
    meta(s.subDir, b, { stoppedByUser: true, toolUseId: 'toolu_b' });
    await s.tracker.loadMeta(s.tracker.get(b)!);
    append(
      s.convPath,
      queuedNotification(a, T0 + 2000, 'failed') +
        notification(a, T0 + 30_000, 'failed', { summary: `Agent "${a}" finished`, preamble: true })
    );
    append(s.convPath, notification(b, T0 + 3000, 'completed'));
    // A background Bash task in the same envelope is ignored.
    append(s.convPath, notification('bqu2xme83', T0 + 3000, 'failed'));
    await s.settle();
    expect(s.tracker.get(a)!.status).toBe('failed');
    expect(s.tracker.get(a)!.notifications).toBe(1);
    expect(s.tracker.get(b)!.status).toBe('stopped');
    expect(s.tracker.agents.has('bqu2xme83')).toBe(false);
  });

  it('a notification seen before the agent file is applied when it registers', async () => {
    const s = setup();
    const id = 'a6666666666666666';
    s.tracker.register(agentFile(s.subDir, 'a7777777777777777'), { mtimeMs: T0 });
    fs.writeFileSync(agentFile(s.subDir, 'a7777777777777777'), prompt('a7777777777777777', T0));
    append(s.convPath, notification(id, T0 + 2000, 'completed'));
    await s.settle();
    fs.writeFileSync(
      agentFile(s.subDir, id),
      prompt(id, T0) + text(id, T0 + 1000, 'm1', 'x', 'end_turn')
    );
    s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0 + 1000 });
    await s.settle();
    expect(s.tracker.get(id)!.status).toBe('done');
  });

  it('no notification: unconfirmed after end_turn; lost after 30 quiet minutes', async () => {
    const s = setup();
    const a = 'a8888888888888888';
    const b = 'a9999999999999999';
    fs.writeFileSync(
      agentFile(s.subDir, a),
      prompt(a, T0) + text(a, T0 + 1000, 'm1', 'done', 'end_turn')
    );
    fs.writeFileSync(
      agentFile(s.subDir, b),
      prompt(b, T0) + text(b, T0 + 1000, 'm1', 'thinking...')
    );
    for (const x of [a, b])
      fs.utimesSync(agentFile(s.subDir, x), (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    s.tracker.register(agentFile(s.subDir, a), { mtimeMs: T0 + 1000 });
    s.tracker.register(agentFile(s.subDir, b), { mtimeMs: T0 + 1000 });
    await s.settle();
    s.setNow(T0 + 3 * MIN);
    await s.tracker.tick();
    expect(s.tracker.get(a)!.status).toBe('done_unconfirmed');
    expect(s.tracker.get(b)!.status).toBe('running');
    s.setNow(T0 + 32 * MIN);
    await s.tracker.tick();
    expect(s.tracker.get(b)!.status).toBe('lost');
  });

  it('nesting via meta toolUseId; the parent waits on an active child', async () => {
    const s = setup();
    const parent = 'ab000000000000001';
    const child = 'ab000000000000002';
    fs.writeFileSync(
      agentFile(s.subDir, parent),
      prompt(parent, T0) +
        toolUse(parent, T0 + 1000, 'm1', 'toolu_child', 'Agent', {
          description: 'Child job',
          prompt: 'x',
        }) +
        result(parent, T0 + 1100, 'toolu_child', 'Async agent launched successfully.') +
        text(parent, T0 + 2000, 'm2', 'Waiting for the child.', 'end_turn')
    );
    fs.writeFileSync(
      agentFile(s.subDir, child),
      prompt(child, T0 + 1200) +
        toolUse(child, T0 + 1300, 'c1', 'tc', 'Bash', { command: 'sleep 1' })
    );
    meta(s.subDir, child, { toolUseId: 'toolu_child', description: 'Child job', spawnDepth: 2 });
    s.tracker.register(agentFile(s.subDir, child), { mtimeMs: T0 + 1300 });
    s.tracker.register(agentFile(s.subDir, parent), { mtimeMs: T0 + 2000 });
    await s.tracker.loadMeta(s.tracker.get(child)!);
    await s.settle();
    s.setNow(T0 + 10 * MIN);
    await s.tracker.tick();
    const c = s.tracker.summary(s.tracker.get(child)!);
    expect(c.parentAgentId).toBe(parent);
    expect(c.depth).toBe(2);
    expect(s.tracker.get(parent)!.status).toBe('waiting_child');
    // The child's notification lands in the parent AGENT's sidechain.
    append(
      agentFile(s.subDir, child),
      result(child, T0 + 9 * MIN, 'tc', 'ok') + text(child, T0 + 9 * MIN, 'c2', 'fin', 'end_turn')
    );
    append(
      agentFile(s.subDir, parent),
      notification(child, T0 + 9 * MIN + 1000, 'completed').replace(
        '"isSidechain":false',
        '"isSidechain":true'
      )
    );
    s.tracker.markDirty(child, true);
    s.tracker.markDirty(parent, true);
    await s.settle();
    expect(s.tracker.get(child)!.status).toBe('done');
  });

  it('counts tools, edits, files, tests, tokens (usage once per message id) and checklist', async () => {
    const s = setup();
    const id = 'ac000000000000001';
    const f = agentFile(s.subDir, id);
    let body = prompt(id, T0);
    body += text(id, T0 + 100, 'm1', '**Step 2/5:** wiring the handler');
    body += toolUse(id, T0 + 200, 'm1', 'e1', 'Edit', {
      file_path: '/r/src/a.ts',
      old_string: 'a',
      new_string: 'b',
    });
    body += result(id, T0 + 300, 'e1', 'The file /r/src/a.ts has been updated.');
    body += toolUse(id, T0 + 400, 'm2', 'b1', 'Bash', { command: 'cd daemon && npx jest foo' });
    body += result(
      id,
      T0 + 500,
      'b1',
      'FAIL src/foo.test.ts\n  ● foo › bar\nTests: 1 failed, 3 passed',
      true
    );
    body += toolUse(id, T0 + 600, 'm3', 'td', 'TodoWrite', {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
        { content: 'c', status: 'pending' },
      ],
    });
    fs.writeFileSync(f, body);
    s.tracker.register(f, { mtimeMs: T0 });
    await s.settle();
    const st = s.tracker.state(s.tracker.get(id)!);
    expect(st.tools).toEqual({ Edit: 1, Bash: 1, TodoWrite: 1 });
    expect(st.edits).toBe(1);
    expect(st.files).toEqual([{ path: '/r/src/a.ts', count: 1 }]);
    expect(st.tests).toMatchObject({ runs: 1, failed: 1, lastFailed: true });
    expect(st.checklist).toEqual({ done: 1, total: 3, current: 'Doing b', source: 'todo' });
    // m1 appears in 2 entries: counted once (input 2 + cc 100 + cr 1000 + out 50 = 1152) + m2 + m3.
    expect(st.tokenDetail.cacheRead).toBe(3000);
    expect(st.timeline.find((e) => e.id === 'b1')).toMatchObject({ failed: true, pending: false });
    expect(st.pendingTool).toBe('TodoWrite');
  });

  it('flags a repeated failure as stuck (no pane, no subprocess)', async () => {
    const s = setup();
    const id = 'ad000000000000001';
    const f = agentFile(s.subDir, id);
    let body = prompt(id, T0);
    for (let i = 0; i < 6; i++) {
      const at = T0 + i * 2 * MIN;
      body += toolUse(id, at, `m${i}`, `b${i}`, 'Bash', { command: 'npx jest api' });
      body += result(
        id,
        at + 5000,
        `b${i}`,
        'FAIL src/api.test.ts\n  ● api › retries\nTests: 1 failed',
        true
      );
      body += text(id, at + 6000, `n${i}`, 'Trying another fix');
    }
    fs.writeFileSync(f, body);
    s.tracker.register(f, { mtimeMs: T0 + 11 * MIN });
    await s.settle();
    s.setNow(T0 + 11 * MIN);
    s.tracker.evaluateStuck(T0 + 11 * MIN);
    const st = s.tracker.summary(s.tracker.get(id)!);
    expect(st.stuck?.kind).toBe('repeated_failure');
    expect(st.stuck?.headline).toMatch(/failing 6 times/);
  });

  it('a stalled pending tool with nothing written becomes stalled_tool', async () => {
    const s = setup();
    const id = 'ad000000000000002';
    const f = agentFile(s.subDir, id);
    fs.writeFileSync(
      f,
      prompt(id, T0) +
        text(id, T0 + 500, 'm0', 'go') +
        toolUse(id, T0 + 1000, 'm1', 'g1', 'Grep', { pattern: 'x' })
    );
    fs.utimesSync(f, (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    s.tracker.register(f, { mtimeMs: T0 + 1000 });
    await s.settle();
    s.tracker.evaluateStuck(T0 + 15 * MIN);
    expect(s.tracker.get(id)!.stuck?.kind).toBe('stalled_tool');
    expect(s.tracker.get(id)!.stuck?.summary).not.toMatch(/screen/);
  });

  it('large never-seen file: only the newest TAIL_START bytes are read (partial)', async () => {
    const s = setup();
    const id = 'ae000000000000001';
    const f = agentFile(s.subDir, id);
    const fd = fs.openSync(f, 'w');
    fs.writeSync(fd, prompt(id, T0));
    const filler = result(id, T0 + 1000, 'zz', 'x'.repeat(10_000));
    let size = 0;
    while (size < LARGE_FILE + 1024 * 1024) size += fs.writeSync(fd, filler);
    fs.writeSync(fd, toolUse(id, T0 + 2000, 'm9', 'last', 'Bash', { command: 'npm test' }));
    fs.closeSync(fd);
    const total = fs.statSync(f).size;
    s.tracker.register(f, { mtimeMs: T0 + 2000 });
    await s.settle();
    const rec = s.tracker.get(id)!;
    expect(rec.partial).toBe(true);
    expect(s.tracker.stats.bytesRead).toBeLessThanOrEqual(TAIL_START);
    expect(rec.tail!.offset).toBe(total);
    expect(s.tracker.summary(rec).pendingTool).toBe('Bash');
  });

  it('budgets: a growing file is read in <= FILE_BUDGET slices, every byte once, fold slices stay short', async () => {
    const s = setup();
    const id = 'ae000000000000002';
    const f = agentFile(s.subDir, id);
    fs.writeFileSync(f, prompt(id, T0));
    s.tracker.register(f, { mtimeMs: T0 });
    await s.settle();
    const chunk = Array.from(
      { length: 2000 },
      (_, i) =>
        toolUse(id, T0 + i, `m${i}`, `t${i}`, 'Read', { file_path: `/r/f${i}.ts` }) +
        result(id, T0 + i, `t${i}`, 'y'.repeat(2000))
    ).join('');
    append(f, chunk + chunk); // ~17 MB appended at once
    const target = fs.statSync(f).size;
    const before = s.tracker.stats.bytesRead;
    s.tracker.markDirty(id, true);
    await s.tracker.pass();
    expect(s.tracker.stats.bytesRead - before).toBeLessThanOrEqual(FILE_BUDGET);
    await s.settle();
    expect(s.tracker.stats.bytesRead).toBe(target);
    expect(s.tracker.stats.maxSliceMs).toBeLessThan(50);
    const rec = s.tracker.get(id)!;
    expect(rec.timeline.length).toBeLessThanOrEqual(SUBAGENT_LIMITS.timeline);
    expect(rec.stuckEvents.length).toBeLessThanOrEqual(MAX_STUCK_EVENTS);
  });

  it('memory per agent stays bounded and shrinks when it finishes', async () => {
    const s = setup();
    const id = 'af000000000000001';
    const f = agentFile(s.subDir, id);
    let body = prompt(id, T0);
    for (let i = 0; i < 3000; i++) {
      body += toolUse(id, T0 + i, `m${i}`, `e${i}`, 'Edit', {
        file_path: `/repo/src/very/long/path/name/file${i}.ts`,
        old_string: 'a'.repeat(500),
        new_string: 'b'.repeat(500),
      });
      body += result(id, T0 + i, `e${i}`, 'ok');
      body += text(id, T0 + i, `m${i}`, 'z'.repeat(1000));
    }
    fs.writeFileSync(f, body);
    s.tracker.register(f, { mtimeMs: T0 + 3000 });
    await s.settle();
    const rec = s.tracker.get(id)!;
    expect(rec.files.size).toBe(SUBAGENT_LIMITS.files);
    expect(rec.approxBytes()).toBeLessThan(200 * 1024);
    append(s.convPath, notification(id, T0 + 10_000));
    s.tracker.markParentDirty(s.convPath);
    await s.settle();
    expect(rec.status).toBe('done');
    expect(rec.approxBytes()).toBeLessThan(40 * 1024);
  });

  it('evicts finished agents after 24 h, caps the agent count, reports removals', async () => {
    const s = setup();
    const removedSeen: string[] = [];
    s.tracker.on('changed', (_ids: string[], removed: string[]) => removedSeen.push(...removed));
    const id = 'aa000000000000001';
    fs.writeFileSync(
      agentFile(s.subDir, id),
      prompt(id, T0) + text(id, T0 + 1000, 'm', 'x', 'end_turn')
    );
    s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0 });
    append(s.convPath, notification(id, T0 + 2000));
    await s.settle();
    expect(s.tracker.get(id)!.status).toBe('done');
    s.setNow(T0 + 23 * 60 * MIN);
    await s.tracker.tick();
    expect(s.tracker.get(id)).toBeDefined();
    s.setNow(T0 + 25 * 60 * MIN);
    await s.tracker.tick();
    expect(s.tracker.get(id)).toBeUndefined();
    expect(removedSeen).toContain(id);
    for (let i = 0; i < SUBAGENT_LIMITS.maxAgents + 10; i++)
      s.tracker.register(agentFile(s.subDir, `ab${String(i).padStart(15, '0')}`), {
        mtimeMs: T0,
        history: true,
      });
    expect(s.tracker.agents.size).toBe(SUBAGENT_LIMITS.maxAgents);
  });

  it('history agents are not read until asked; hydrate reads them', async () => {
    const s = setup();
    const id = 'ab100000000000001';
    fs.writeFileSync(
      agentFile(s.subDir, id),
      prompt(id, T0) + text(id, T0 + 1000, 'm', 'x', 'end_turn')
    );
    s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0, history: true });
    await s.settle();
    expect(s.tracker.stats.bytesRead).toBe(0);
    const rec = await s.tracker.hydrate(id);
    expect(rec!.entries).toBe(2);
  });

  it('backstop tick finds growth when no fs event arrived', async () => {
    const s = setup();
    const id = 'ab200000000000001';
    const f = agentFile(s.subDir, id);
    fs.writeFileSync(f, prompt(id, T0));
    s.tracker.register(f, { mtimeMs: T0 });
    await s.settle();
    append(f, toolUse(id, T0 + 1000, 'm', 't', 'Bash', { command: 'ls' }));
    await s.tracker.tick();
    await s.settle();
    expect(s.tracker.get(id)!.pendingCount).toBe(1);
  });

  it('change events carry ids, and redact secrets in displays', async () => {
    const s = setup();
    const id = 'ab300000000000001';
    const changed: string[] = [];
    s.tracker.on('changed', (ids: string[]) => changed.push(...ids));
    fs.writeFileSync(
      agentFile(s.subDir, id),
      prompt(id, T0) +
        toolUse(id, T0 + 1, 'm', 't', 'Bash', {
          command:
            'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"',
        })
    );
    s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0 });
    await s.settle();
    s.tracker.flush();
    expect(changed).toContain(id);
    const st = s.tracker.state(s.tracker.get(id)!);
    expect(JSON.stringify(st)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('a line for an unknown timestamp still folds (uses now)', async () => {
    const s = setup();
    const id = 'ab400000000000001';
    fs.writeFileSync(
      agentFile(s.subDir, id),
      line({ type: 'user', message: { content: 'hi' } }) +
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
          timestamp: iso(T0),
        })
    );
    s.tracker.register(agentFile(s.subDir, id), { mtimeMs: T0 });
    await s.settle();
    expect(s.tracker.get(id)!.entries).toBe(2);
  });
});
