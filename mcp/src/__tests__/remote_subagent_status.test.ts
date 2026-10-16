import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteSubagentStatus, type SubagentStatusPool } from '../tools/remote_subagent_status';
import { McpRemoteError } from '../errors';

function fakePool(reply: unknown) {
  const calls: Array<{ server: string; type: string; payload: unknown }> = [];
  const pool: SubagentStatusPool = {
    get(server: string) {
      return {
        async sendRequest<T>(type: string, payload?: unknown): Promise<T> {
          calls.push({ server, type, payload });
          return reply as T;
        },
      };
    },
  };
  return { pool, calls };
}

const facts = {
  rollup: '2 of 3 done, 1 running. Bob is running tests (1 failing run, 4 min).',
  running: 1,
  total: 3,
  moreSessions: 0,
  generatedAt: 123,
  sessions: [
    {
      conversationId: 'conv-1',
      sessionId: 'out4',
      session: 'Out4',
      rollup: '2 of 3 done, 1 running.',
      running: 1,
      total: 3,
      failed: 0,
      more: 0,
      agents: [{ agentId: 'a1', name: 'Bob', status: 'running', line: 'Bob is running tests' }],
    },
  ],
};

test('asks subagent_rollup for facts (session optional) and passes them through', async () => {
  const { pool, calls } = fakePool({ success: true, payload: { text: 'x', running: 1, total: 3, facts } });
  const all = await remoteSubagentStatus(pool, { server: 'hexi' });
  assert.deepEqual(calls[0], { server: 'hexi', type: 'subagent_rollup', payload: { facts: true } });
  assert.equal(all.session, null);
  assert.equal(all.rollup, facts.rollup);
  assert.equal(all.sessions[0].session, 'Out4');
  assert.equal(all.generatedAt, 123);
  await remoteSubagentStatus(pool, { server: 'hexi', session: ' out4 ' });
  assert.deepEqual(calls[1].payload, { sessionId: 'out4', facts: true });
});

test('an older daemon without facts still answers with its rollup line', async () => {
  const { pool } = fakePool({ success: true, payload: { text: 'No subagents.', running: 0, total: 0 } });
  const r = await remoteSubagentStatus(pool, { server: 'mac' });
  assert.equal(r.rollup, 'No subagents.');
  assert.deepEqual(r.sessions, []);
});

test('daemon errors surface as McpRemoteError (unknown type = needs an update)', async () => {
  const { pool } = fakePool({ success: false, error: 'Unknown message type: subagent_rollup' });
  await assert.rejects(remoteSubagentStatus(pool, { server: 'old' }), (e: unknown) => {
    assert.ok(e instanceof McpRemoteError);
    assert.match((e as Error).message, /predates subagent tracking/);
    return true;
  });
});
