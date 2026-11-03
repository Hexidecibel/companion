import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();
let connected = true;
vi.mock('../ConnectionManager', () => ({
  connectionManager: {
    getConnection: (id: string) => (id === 'none' ? undefined : { isConnected: () => connected, sendRequest }),
  },
}));

import { sendChoice, buildSendChoicePayload } from '../sendChoice';

const choice = { selectedIndices: [1], optionCount: 3, multiSelect: false };

describe('sendChoice', () => {
  beforeEach(() => {
    sendRequest.mockReset();
    connected = true;
  });

  it('builds the SessionView payload (tmux name falls back to the session id)', () => {
    expect(buildSendChoicePayload(choice, { serverId: 's', sessionId: 'x' })).toEqual({
      selectedIndices: [1], optionCount: 3, multiSelect: false, sessionId: 'x', tmuxSessionName: 'x',
    });
    expect(buildSendChoicePayload({ ...choice, promptKind: 'trust' }, { serverId: 's', sessionId: 'x', tmuxSessionName: 't', expectSignature: 'sig' }))
      .toMatchObject({ tmuxSessionName: 't', expectSignature: 'sig', promptKind: 'trust' });
  });

  it('sends send_choice and reports success', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: true });
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x', expectSignature: 'sig' })).toEqual({ ok: true });
    expect(sendRequest).toHaveBeenCalledWith('send_choice', expect.objectContaining({ expectSignature: 'sig', sessionId: 'x' }));
  });

  it('a stale_prompt reply is "stale", whether it resolves or rejects', async () => {
    sendRequest.mockResolvedValueOnce({ type: 'send_choice', success: false, error: 'stale_prompt' });
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x' })).toMatchObject({ ok: false, reason: 'stale' });
    sendRequest.mockRejectedValueOnce(new Error('stale_prompt'));
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x' })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('other failures are errors; no connection is offline', async () => {
    sendRequest.mockResolvedValueOnce({ type: 'send_choice', success: false, error: 'No tmux session' });
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x' })).toMatchObject({ ok: false, reason: 'error', error: 'No tmux session' });
    sendRequest.mockRejectedValueOnce(new Error('Request timeout'));
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x' })).toMatchObject({ ok: false, reason: 'error' });
    expect(await sendChoice(choice, { serverId: 'none', sessionId: 'x' })).toEqual({ ok: false, reason: 'offline' });
    connected = false;
    expect(await sendChoice(choice, { serverId: 's', sessionId: 'x' })).toEqual({ ok: false, reason: 'offline' });
  });
});
