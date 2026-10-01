import { registerHeraldHandlers } from '../src/handlers/herald';
import { HeraldRequestError } from '../src/herald/service';

function setup(herald: any) {
  const sent: any[] = [];
  const ctx: any = {
    herald,
    config: { listeners: [{ port: 9877, token: 't', tls: false }] },
    send: (_ws: unknown, r: unknown) => sent.push(r),
  };
  const client: any = { id: 'c1', ws: {}, isLocal: true, listenerPort: 9877, origin: null, authenticated: true };
  return { h: registerHeraldHandlers(ctx), sent, client };
}

describe('herald WS handlers', () => {
  it('responds with the request type, success + payload, and echoes requestId', async () => {
    const state = { displayName: 'Herald', enabled: false, model: '', busy: false, messages: [], inbox: [], actions: [] };
    const { h, sent, client } = setup({ getState: () => state });
    await h.herald_get_state(client, {}, 'r1');
    expect(sent).toEqual([{ type: 'herald_get_state', success: true, payload: state, requestId: 'r1' }]);
  });

  it('herald_send acks with messageId; request errors surface as error strings', async () => {
    const send = jest.fn().mockReturnValueOnce({ messageId: 'm1' }).mockImplementationOnce(() => {
      throw new HeraldRequestError('Message is empty.');
    });
    const { h, sent, client } = setup({ send });
    await h.herald_send(client, { text: 'hi' }, 'a');
    await h.herald_send(client, { text: '' }, 'b');
    expect(send).toHaveBeenCalledWith('hi', {
      mode: undefined,
      intent: undefined,
      clientId: 'c1',
      gesture: undefined,
    });
    expect(sent[0]).toEqual({ type: 'herald_send', success: true, payload: { messageId: 'm1' }, requestId: 'a' });
    expect(sent[1]).toEqual({ type: 'herald_send', success: false, error: 'Message is empty.', requestId: 'b' });
  });

  it('herald_send passes mode / intent through; herald_set_verbosity routes to the service', async () => {
    const send = jest.fn(() => ({ messageId: 'm2' }));
    const setVerbosity = jest.fn((v: unknown) => {
      if (v !== 'brief') throw new HeraldRequestError('verbosity must be one of auto, brief, normal, detailed');
      return { verbosity: v };
    });
    const { h, sent, client } = setup({ send, setVerbosity });
    await h.herald_send(client, { text: 'Shorter.', mode: 'voice', intent: 'shorter', gesture: true }, 'a');
    expect(send).toHaveBeenCalledWith('Shorter.', {
      mode: 'voice',
      intent: 'shorter',
      clientId: 'c1',
      gesture: true,
    });
    await h.herald_set_verbosity(client, { verbosity: 'brief' }, 'b');
    await h.herald_set_verbosity(client, { verbosity: 'loud' }, 'c');
    expect(sent[1]).toEqual({ type: 'herald_set_verbosity', success: true, payload: { verbosity: 'brief' }, requestId: 'b' });
    expect(sent[2]).toMatchObject({ type: 'herald_set_verbosity', success: false, error: expect.stringMatching(/verbosity must be/) });
  });

  it('herald_confirm passes an audit origin; unexpected errors are masked', async () => {
    const confirm = jest.fn(async () => ({ id: 'x', status: 'sent' }));
    const { h, sent, client } = setup({ confirm });
    await h.herald_confirm(client, { actionId: 'x', decision: 'confirm' }, 'q');
    expect(confirm).toHaveBeenCalledWith(
      'x',
      'confirm',
      { addr: '', clientId: 'c1', isLocal: true, tls: false, origin: null },
      { method: undefined, phrase: undefined, streamId: undefined, clientId: 'c1' }
    );
    // Voice confirmation: method, phrase and stream pass through with the connection id.
    await h.herald_confirm(client, { actionId: 'x', decision: 'confirm', method: 'voice', phrase: 'confirm deploy', streamId: 's1' }, 'q2');
    expect(confirm).toHaveBeenLastCalledWith('x', 'confirm', expect.any(Object), {
      method: 'voice',
      phrase: 'confirm deploy',
      streamId: 's1',
      clientId: 'c1',
    });
    expect(sent[0].payload).toEqual({ id: 'x', status: 'sent' });
    expect(sent[1].payload).toEqual({ id: 'x', status: 'sent' });

    const boom = setup({ confirm: jest.fn(async () => Promise.reject(new Error('kaboom'))) });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await boom.h.herald_confirm(boom.client, { actionId: 'x', decision: 'confirm' }, 'q');
    errSpy.mockRestore();
    expect(boom.sent[0]).toEqual({ type: 'herald_confirm', success: false, error: 'Internal error handling herald_confirm', requestId: 'q' });
  });

  it('herald_mark_heard validates and returns ok', async () => {
    const markHeard = jest.fn();
    const { h, sent, client } = setup({ markHeard });
    await h.herald_mark_heard(client, { itemIds: ['a'] }, '1');
    await h.herald_mark_heard(client, { itemIds: 'a' }, '2');
    expect(sent[0]).toEqual({ type: 'herald_mark_heard', success: true, payload: { ok: true }, requestId: '1' });
    expect(sent[1].success).toBe(false);
    expect(markHeard).toHaveBeenCalledTimes(1);
  });

  it('herald_reset returns state; missing service is reported', async () => {
    const { h, sent, client } = setup({ reset: () => ({ messages: [] }) });
    await h.herald_reset(client, {}, 'z');
    expect(sent[0]).toEqual({ type: 'herald_reset', success: true, payload: { messages: [] }, requestId: 'z' });
    const none = setup(null);
    await none.h.herald_get_state(none.client, {}, 'n');
    expect(none.sent[0]).toEqual({ type: 'herald_get_state', success: false, error: 'Herald is not available on this daemon', requestId: 'n' });
  });
});
