/**
 * Stuck signals on Codex transcripts: rollout records through the real
 * CodexAccumulator (exec code-mode calls), then the same digest + analysis.
 */
import { analyze, buildDigest, PaneTrack } from '../signals';
import { STUCK_DEFAULTS, StuckSettings } from '../protocol';
import { readPane } from '../normalize';
import { CodexAccumulator } from '../../agents/codex/parse';
import { MIN, jestFail } from './fixtures';

const S: StuckSettings = { ...STUCK_DEFAULTS };
const HORIZON = 60 * MIN;
const T0 = Date.parse('2026-10-28T20:00:00Z');

class Rollout {
  recs: unknown[] = [];
  t = T0;
  private n = 0;
  private push(type: string, payload: Record<string, unknown>, dt = 1000): this {
    this.t += dt;
    this.recs.push({ timestamp: new Date(this.t).toISOString(), type, payload });
    return this;
  }
  prompt(text: string): this {
    this.push('event_msg', { type: 'task_started' });
    return this.push('response_item', {
      type: 'message',
      role: 'user',
      id: `u${this.n++}`,
      content: [{ type: 'input_text', text }],
    });
  }
  say(text: string): this {
    return this.push('response_item', {
      type: 'message',
      role: 'assistant',
      id: `a${this.n++}`,
      content: [{ type: 'output_text', text }],
    });
  }
  exec(cmd: string, output: string | null, exit = 0, dt = 1000): string {
    const id = `call_${this.n++}`;
    this.push(
      'response_item',
      {
        type: 'custom_tool_call',
        call_id: id,
        name: 'exec',
        input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));\n`,
      },
      dt
    );
    if (output !== null)
      this.push('response_item', {
        type: 'custom_tool_call_output',
        call_id: id,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 1 seconds\nOutput:\n' },
          { type: 'input_text', text: JSON.stringify({ exit_code: exit, output }) },
        ],
      });
    return id;
  }
  patch(file: string, from: string, to: string): this {
    const id = `call_${this.n++}`;
    const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-${from}\n+${to}\n*** End Patch`;
    this.push('response_item', {
      type: 'custom_tool_call',
      call_id: id,
      name: 'exec',
      input: `text(await tools.apply_patch(${JSON.stringify(patch)}));\n`,
    });
    return this.push('response_item', {
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        { type: 'input_text', text: 'Script completed\n' },
        { type: 'input_text', text: '{}' },
      ],
    });
  }
  messages() {
    const acc = new CodexAccumulator();
    acc.append(this.recs);
    return acc.messages();
  }
}

const CODEX_WORKING_PANE = [
  '• Ran curl -s http://localhost:9/slow',
  '',
  '• Working (24m 03s • esc to interrupt)',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol default · ~/proj',
].join('\n');

describe('stuck signals on Codex sessions', () => {
  it('repeated failure: the same failing test across patch / run cycles', () => {
    const r = new Rollout().prompt('fix the retry test');
    for (let i = 0; i < 6; i++) {
      r.say('Adjusting the backoff.').patch('/home/u/proj/src/api.ts', `d = ${i}`, `d = ${i + 1}`);
      r.exec('cd /home/u/proj && npm test 2>&1 | tail -40', jestFail(i), 1, 150_000);
    }
    const out = analyze(buildDigest(r.messages(), r.t, HORIZON), r.t, S, null);
    expect(out.map((f) => f.kind)).toEqual(['repeated_failure']);
    expect(out[0].summary).toMatch(/^Same test failing 6 times/);
    expect(out[0].evidence[0]).toMatch(/^\$ cd \/home\/u\/proj && npm test/);
  });

  it('apply_patch counts as progress (an edit), exec_command as a shell run', () => {
    const r = new Rollout().prompt('x');
    r.patch('/p/a.ts', 'a', 'b');
    r.exec('ls', 'a.ts', 0);
    const d = buildDigest(r.messages(), r.t, HORIZON);
    const patch = d.events.find((e) => e.name === 'apply_patch')!;
    expect(patch.isEdit).toBe(true);
    expect(patch.file).toBe('/p/a.ts');
    expect(d.lastEditAt).toBeGreaterThan(0);
    const sh = d.events.find((e) => e.name === 'exec_command')!;
    expect(sh.rawCommand).toBe('ls');
    expect(sh.cmdKey).toBeTruthy();
  });

  it('stalled tool: a long exec_command with an unchanged Codex screen', () => {
    const r = new Rollout().prompt('check the service');
    r.say('Querying it.');
    const id = r.exec('curl -s http://localhost:9/slow', null);
    const now = r.t + 25 * MIN;
    const p: PaneTrack = {
      reading: readPane(CODEX_WORKING_PANE),
      stableSince: now - 6 * MIN,
      stableChecks: 3,
      checkedAt: now,
      pendingId: id,
    };
    expect(p.reading.alive).toBe(true);
    const out = analyze(buildDigest(r.messages(), now, HORIZON), now, S, p);
    expect(out.map((f) => f.kind)).toEqual(['stalled_tool']);
    expect(out[0].summary).toMatch(/exec_command has been running 25 min.*curl/);
  });

  it('no progress: a long silence while Codex works', () => {
    const r = new Rollout().prompt('investigate');
    r.say('Looking.');
    r.exec('cat a.ts', 'x', 0);
    const now = r.t + 34 * MIN;
    const p: PaneTrack = {
      reading: readPane(
        CODEX_WORKING_PANE.replace('Ran curl -s http://localhost:9/slow', 'Ran cat a.ts')
      ),
      stableSince: now - 3 * MIN,
      stableChecks: 2,
      checkedAt: now,
      pendingId: null,
    };
    const out = analyze(buildDigest(r.messages(), now, HORIZON), now, S, p);
    expect(out.map((f) => f.kind)).toEqual(['no_progress']);
  });

  it('phase: ended / interrupted turns are idle; an escalation request waits', () => {
    const done = new Rollout().prompt('x').say('ok');
    done.recs.push({
      timestamp: new Date(done.t).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
    expect(buildDigest(done.messages(), done.t, HORIZON).phase).toBe('idle');
    const ab = new Rollout().prompt('x');
    ab.exec('sleep 100', null);
    ab.recs.push({
      timestamp: new Date(ab.t).toISOString(),
      type: 'event_msg',
      payload: { type: 'turn_aborted' },
    });
    expect(buildDigest(ab.messages(), ab.t, HORIZON).phase).toBe('idle');
    const esc = new Rollout().prompt('x');
    esc.recs.push({
      timestamp: new Date(esc.t).toISOString(),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'c9',
        name: 'exec',
        input:
          'text(await tools.exec_command({cmd:"rm -rf build",sandbox_permissions:"require_escalated"}));',
      },
    });
    expect(buildDigest(esc.messages(), esc.t, HORIZON).phase).toBe('waiting');
  });
});
