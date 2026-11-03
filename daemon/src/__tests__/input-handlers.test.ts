import { registerInputHandlers } from '../handlers/input';
import type { HandlerContext } from '../handler-context';

function makeCtx(
  opts: {
    pane?: string;
    signature?: string | null;
    onScreen?: Array<{ label: string }> | null;
    fallbackSig?: string | null;
  } = {}
) {
  const sent: Array<Record<string, unknown>> = [];
  const ctx = {
    send: jest.fn((_ws: unknown, msg: Record<string, unknown>) => sent.push(msg)),
    injector: {
      checkSessionExists: jest.fn(async () => true),
      sendChoice: jest.fn(async () => true),
      sendInputDetailed: jest.fn(async () => ({ ok: true })),
      captureTmuxPane: jest.fn(async () => opts.pane ?? 'pane text'),
      getActiveSession: jest.fn(() => 'active-one'),
    },
    watcher: {
      getActiveSessionId: jest.fn(() => 'active-one'),
      noteStartupPane: jest.fn(),
      pendingPromptFor: jest.fn(() =>
        opts.signature === null ? null : { signature: opts.signature ?? 'sig-1' }
      ),
      clearPaneChoice: jest.fn(),
      onScreenChoiceFor: jest.fn(() =>
        opts.onScreen ? { question: 'Do you want to proceed?', options: opts.onScreen } : null
      ),
      transcriptPromptSignatureFor: jest.fn(() => opts.fallbackSig ?? null),
    },
    escalation: { acknowledgeSession: jest.fn() },
    tmux: { listSessions: jest.fn(async () => []) },
    pendingSentMessages: new Map(),
    tmuxSessionConfigs: new Map(),
  };
  const handlers = registerInputHandlers(ctx as unknown as HandlerContext);
  const client = { ws: {} } as never;
  return { ctx, handlers, client, sent };
}

const choice = (extra: Record<string, unknown> = {}) => ({
  selectedIndices: [0],
  optionCount: 3,
  multiSelect: false,
  tmuxSessionName: 'target-sess',
  ...extra,
});

describe('send_choice', () => {
  it('matching expectSignature: sends, acks the TARGET session', async () => {
    const { ctx, handlers, client, sent } = makeCtx({ signature: 'sig-1' });
    await handlers.send_choice(client, choice({ expectSignature: 'sig-1' }), 'r1');
    expect(ctx.injector.captureTmuxPane).toHaveBeenCalledWith('target-sess', 60);
    expect(ctx.watcher.noteStartupPane).toHaveBeenCalledWith('target-sess', 'pane text');
    expect(ctx.injector.sendChoice).toHaveBeenCalled();
    expect(sent).toEqual([
      { type: 'choice_sent', success: true, error: undefined, requestId: 'r1' },
    ]);
    expect(ctx.escalation.acknowledgeSession).toHaveBeenCalledWith('target-sess');
    expect(ctx.escalation.acknowledgeSession).not.toHaveBeenCalledWith('active-one');
    expect(ctx.watcher.clearPaneChoice).toHaveBeenCalledWith('target-sess');
  });

  it('stale expectSignature: nothing injected, stale_prompt reply', async () => {
    const { ctx, handlers, client, sent } = makeCtx({ signature: 'sig-2' });
    await handlers.send_choice(client, choice({ expectSignature: 'sig-1' }), 'r2');
    expect(ctx.injector.sendChoice).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: 'choice_sent', success: false, error: 'stale_prompt', requestId: 'r2' },
    ]);
  });

  it('prompt gone or screen unreadable: stale_prompt (fails closed)', async () => {
    for (const o of [{ signature: null }, { pane: '' }]) {
      const { ctx, handlers, client, sent } = makeCtx(o);
      await handlers.send_choice(client, choice({ expectSignature: 'sig-1' }), 'r3');
      expect(ctx.injector.sendChoice).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({ success: false, error: 'stale_prompt' });
    }
  });

  it('without expectSignature: unchanged (no capture), acks the target', async () => {
    const { ctx, handlers, client } = makeCtx();
    await handlers.send_choice(client, choice(), 'r4');
    expect(ctx.injector.captureTmuxPane).not.toHaveBeenCalled();
    expect(ctx.injector.sendChoice).toHaveBeenCalled();
    expect(ctx.escalation.acknowledgeSession).toHaveBeenCalledWith('target-sess');
  });
});

describe('send_choice selectedLabels', () => {
  const FOUR = [
    { label: 'Yes' },
    { label: 'Yes, always allow' },
    { label: 'Yes, and switch to auto mode' },
    { label: 'No' },
  ];

  it('"no" resolves to the on-screen No (index 3 of 4), not the tapped index', async () => {
    const { ctx, handlers, client, sent } = makeCtx({ signature: 'sig-1', onScreen: FOUR });
    await handlers.send_choice(
      client,
      choice({
        selectedIndices: [2],
        optionCount: 3,
        selectedLabels: ['no'],
        expectSignature: 'sig-1',
      }),
      'l1'
    );
    expect(ctx.injector.sendChoice).toHaveBeenCalledWith(
      [3],
      4,
      false,
      undefined,
      'target-sess',
      expect.anything()
    );
    expect(sent[0]).toMatchObject({ success: true });
  });

  it('unknown label: stale_prompt, nothing injected (no positional fallback)', async () => {
    const { ctx, handlers, client, sent } = makeCtx({ signature: 'sig-1', onScreen: FOUR });
    await handlers.send_choice(
      client,
      choice({ selectedLabels: ['maybe later'], expectSignature: 'sig-1' }),
      'l2'
    );
    expect(ctx.injector.sendChoice).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ success: false, error: 'stale_prompt' });
  });

  it('labels but no box on screen: stale_prompt', async () => {
    const { ctx, handlers, client, sent } = makeCtx({ signature: 'sig-1', onScreen: null });
    await handlers.send_choice(
      client,
      choice({ selectedLabels: ['no'], expectSignature: 'sig-1' }),
      'l3'
    );
    expect(ctx.injector.sendChoice).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ error: 'stale_prompt' });
  });

  it('tile saw the transcript fallback: accepted by label only, resolved on screen', async () => {
    const { ctx, handlers, client } = makeCtx({
      signature: 'pane-sig',
      fallbackSig: 'transcript-sig',
      onScreen: FOUR,
    });
    await handlers.send_choice(
      client,
      choice({ selectedIndices: [2], selectedLabels: ['no'], expectSignature: 'transcript-sig' }),
      'l4'
    );
    expect(ctx.injector.sendChoice).toHaveBeenCalledWith(
      [3],
      4,
      false,
      undefined,
      'target-sess',
      expect.anything()
    );

    // The same stale signature WITHOUT labels is refused (indices may not match the screen).
    const b = makeCtx({ signature: 'pane-sig', fallbackSig: 'transcript-sig', onScreen: FOUR });
    await b.handlers.send_choice(b.client, choice({ expectSignature: 'transcript-sig' }), 'l5');
    expect(b.ctx.injector.sendChoice).not.toHaveBeenCalled();
    expect(b.sent[0]).toMatchObject({ error: 'stale_prompt' });
  });

  it('labels without expectSignature (chat view): still resolved on screen', async () => {
    const { ctx, handlers, client } = makeCtx({ onScreen: FOUR });
    await handlers.send_choice(
      client,
      choice({ selectedIndices: [2], selectedLabels: ['no'] }),
      'l6'
    );
    expect(ctx.injector.captureTmuxPane).toHaveBeenCalled();
    expect(ctx.injector.sendChoice).toHaveBeenCalledWith(
      [3],
      4,
      false,
      undefined,
      'target-sess',
      expect.anything()
    );
  });
});

describe('send_input', () => {
  it('acks the TARGET session, not the active one', async () => {
    const { ctx, handlers, client } = makeCtx();
    await handlers.send_input(client, { input: 'hi', tmuxSessionName: 'target-sess' }, 'r5');
    expect(ctx.escalation.acknowledgeSession).toHaveBeenCalledWith('target-sess');
    expect(ctx.escalation.acknowledgeSession).not.toHaveBeenCalledWith('active-one');
  });
});
