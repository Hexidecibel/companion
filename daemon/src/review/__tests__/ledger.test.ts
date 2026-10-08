import * as fs from 'fs';
import * as path from 'path';
import { SessionLedger, classifyPrompt } from '../ledger';
import { JsonlTail, MAX_LINE_BYTES } from '../jsonl-tail';
import { prompt, toolUse, toolResult, editResult, jsonl, tmpDir } from './helpers';

const FIXTURE = path.join(__dirname, 'fixtures', 'session-basic.jsonl');

async function load(file: string, project = '/proj'): Promise<SessionLedger> {
  const led = new SessionLedger('s1', project);
  led.setChain([file], []);
  await led.update();
  return led;
}

describe('SessionLedger (fixture)', () => {
  let led: SessionLedger;
  beforeAll(async () => {
    led = await load(FIXTURE);
  });

  it('opens turns for prompts, commands and task notifications only', () => {
    expect(led.turns.map((t) => t.id)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(led.turns[0].prompt).toBe('fix the echo guard please');
    expect(led.turns[1].prompt).toBe('/review src');
    expect(led.turns[2].prompt).toBe('Background task');
    expect(led.turns.map((t) => t.index)).toEqual([1, 2, 3]);
  });

  it('closes a turn at the last entry before the next opener', () => {
    expect(led.turns[0].closedAt).toBe(Date.parse('2026-09-30T07:00:08.000Z'));
    expect(led.turns[2].closedAt).toBeNull();
  });

  it('Edit with structuredPatch -> hunks and stats', () => {
    const e = led.edits.get('toolu_edit1')!;
    expect(e.turnId).toBe('turn-1');
    expect(e.kind).toBe('update');
    expect(e.hunks).toHaveLength(1);
    expect(e.additions).toBe(2);
    expect(e.deletions).toBe(1);
    expect(e.at).toBe(Date.parse('2026-09-30T07:00:02.000Z'));
  });

  it('Write create -> all-plus hunk; Write update -> structuredPatch', () => {
    const c = led.edits.get('toolu_write1')!;
    expect(c.kind).toBe('create');
    expect(c.hunks[0].lines).toEqual(['+one', '+two']);
    expect(c.additions).toBe(2);
    const u = led.edits.get('toolu_write2')!;
    expect(u.kind).toBe('update');
    expect(u.deletions).toBe(1);
    expect(u.turnId).toBe('turn-3');
  });

  it('MultiEdit hunks, is_error failed, pending tool_use', () => {
    expect(led.edits.get('toolu_multi')!.hunks).toHaveLength(2);
    expect(led.edits.get('toolu_multi')!.turnId).toBe('turn-2');
    expect(led.edits.get('toolu_bad')!.failed).toBe(true);
    expect(led.edits.get('toolu_pending')!.pending).toBe(true);
  });

  it('tracks Bash use and the last assistant text', () => {
    expect(led.turns[0].usedBash).toBe(true);
    expect(led.turns[0].lastAssistantText).toMatch(/I've fixed the echo guard/);
    expect(led.turns[1].usedBash).toBe(false);
  });
});

describe('classifyPrompt', () => {
  it('handles prompt shapes', () => {
    expect(classifyPrompt('<local-command-stdout>x</local-command-stdout>', false)).toBe('attach');
    expect(classifyPrompt('[Request interrupted by user]', false)).toBe('attach');
    expect(classifyPrompt('', true)).toEqual({ label: '(image)' });
    expect(classifyPrompt('', false)).toBeNull();
  });
});

describe('incremental tail', () => {
  it('appends with a partial last line and picks up the rest later', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'c.jsonl');
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    const first = jsonl([
      prompt('t1', 'hello', t0),
      toolUse('e1', 'Edit', { file_path: '/p/a.ts' }, t0 + 1000),
    ]);
    const second = JSON.stringify(
      toolResult(
        'e1',
        editResult('/p/a.ts', [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
        ]),
        t0 + 2000
      )
    );
    fs.writeFileSync(f, first + second.slice(0, 40));
    const led = await load(f, '/p');
    expect(led.edits.get('e1')!.pending).toBe(true);
    const v = led.version;
    fs.appendFileSync(f, second.slice(40) + '\n');
    expect(await led.update()).toBe(true);
    expect(led.version).toBeGreaterThan(v);
    expect(led.edits.get('e1')!.pending).toBe(false);
    expect(led.edits.get('e1')!.additions).toBe(1);
    const changes = led.drainChanges().map((c) => c.phase);
    expect(changes).toEqual(['started', 'completed']);
  });

  it('skips oversized lines and keeps going', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'big.jsonl');
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    const huge = JSON.stringify({ type: 'assistant', pad: 'x'.repeat(MAX_LINE_BYTES + 10) });
    fs.writeFileSync(f, huge + '\n' + jsonl([prompt('t1', 'after big', t0)]));
    const tail = new JsonlTail(f);
    const r = await tail.read();
    expect(r.skipped).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0]).uuid).toBe('t1');
  });

  it('rescans when the file shrinks', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 's.jsonl');
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    fs.writeFileSync(f, jsonl([prompt('t1', 'one', t0), prompt('t2', 'two', t0 + 1)]));
    const led = await load(f);
    fs.writeFileSync(f, jsonl([prompt('t3', 'x', t0)]));
    await led.update();
    expect(led.stale).toBe(true);
  });
});

describe('subagent attribution', () => {
  it('attributes sidechain edits to the turn that spawned the agent', async () => {
    const { listSubagentFiles } = await import('../sources');
    const dir = tmpDir();
    const conv = path.join(dir, 'conv1.jsonl');
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    fs.writeFileSync(
      conv,
      jsonl([
        prompt('t1', 'dispatch', t0),
        toolUse('agent-call', 'Agent', { prompt: 'x' }, t0 + 10),
        prompt('t2', 'next', t0 + 100_000),
      ])
    );
    const subDir = path.join(dir, 'conv1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'agent-abc.meta.json'),
      JSON.stringify({ toolUseId: 'agent-call' })
    );
    fs.writeFileSync(
      path.join(subDir, 'agent-abc.jsonl'),
      jsonl([
        { ...prompt('sp', 'sub prompt', t0 + 20), isSidechain: true },
        { ...toolUse('se', 'Edit', { file_path: '/p/x.ts' }, t0 + 200_000), isSidechain: true },
        {
          ...toolResult(
            'se',
            editResult('/p/x.ts', [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
            ]),
            t0 + 200_001
          ),
          isSidechain: true,
        },
      ])
    );
    const subs = await listSubagentFiles([conv]);
    expect(subs).toEqual([
      { path: path.join(subDir, 'agent-abc.jsonl'), agentId: 'abc', parentToolUseId: 'agent-call' },
    ]);
    const led = new SessionLedger('s', '/p');
    led.setChain([conv], subs);
    await led.update();
    expect(led.turns.map((t) => t.id)).toEqual(['t1', 't2']);
    const e = led.edits.get('se')!;
    // Time alone would say t2; the meta's toolUseId says t1.
    expect(e.turnId).toBe('t1');
    expect(e.agentId).toBe('abc');
    expect(led.turns[0].editIds).toContain('se');
  });
});

describe('scan budget', () => {
  it('bounds one update, not the ledger lifetime: big sessions keep picking up new edits', async () => {
    // Regression: the budget used to be a lifetime cap. A session whose
    // transcripts (main + subagents) passed it read 1 byte per update from
    // then on, so new edits were never attributed and the summary froze.
    const dir = tmpDir();
    const conv = path.join(dir, 'big.jsonl');
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    const filler = 'x'.repeat(2000);
    const lines: unknown[] = [prompt('t1', 'start', t0)];
    for (let i = 0; i < 40; i++)
      lines.push({ ...prompt(`f${i}`, filler, t0 + 1 + i), isMeta: true });
    fs.writeFileSync(conv, jsonl(lines));
    const led = new SessionLedger('s', '/p');
    led.setChain([conv], []);
    const budget = 30_000; // < file size: the first pass is partial
    await led.update(budget);
    expect(led.scannedBytes).toBeLessThanOrEqual(budget);
    for (let i = 0; i < 5 && led.scannedBytes < fs.statSync(conv).size; i++)
      await led.update(budget);
    expect(led.scannedBytes).toBe(fs.statSync(conv).size);

    const t = t0 + 60_000;
    fs.appendFileSync(
      conv,
      jsonl([
        prompt('t2', 'more', t),
        toolUse('late', 'Edit', { file_path: '/p/late.ts' }, t + 1),
        toolResult(
          'late',
          editResult('/p/late.ts', [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
          ]),
          t + 2
        ),
      ])
    );
    await led.update(budget);
    expect(led.edits.get('late')).toMatchObject({ turnId: 't2', additions: 1 });
  });
});
