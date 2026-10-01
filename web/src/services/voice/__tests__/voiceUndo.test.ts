import { describe, expect, it, vi } from 'vitest';
import type { HeraldAction } from '../../../types/herald';
import { runUndo, undoTarget, UNDO_LINES, type UndoDeps } from '../voiceUndo';

function action(over: Partial<HeraldAction> = {}): HeraldAction {
  return {
    id: 'a1', tier: 'echo', kind: 'send_input', serverId: 's', sessionId: 'x', sessionName: 'Out4',
    payload: 'yes', readback: 'Sending yes to Out4', reasons: [], status: 'pending', autoSendAt: 10_000, createdAt: 1000,
    ...over,
  };
}

function deps(actions: HeraldAction[], over: Partial<UndoDeps> = {}) {
  const d = {
    actions: () => actions,
    cancel: vi.fn(async (id: string) => ({ ...actions.find((a) => a.id === id)!, status: 'cancelled' as const })),
    speaking: vi.fn(() => false),
    stopSpeech: vi.fn(),
    say: vi.fn(),
    ...over,
  };
  return d;
}

describe('undoTarget', () => {
  it('picks the newest pending echo-tier action', () => {
    const list = [
      action({ id: 'old', createdAt: 1 }),
      action({ id: 'new', createdAt: 5 }),
      action({ id: 'hard', tier: 'hard_confirm', createdAt: 9 }),
      action({ id: 'sent', status: 'sent', createdAt: 10 }),
    ];
    expect(undoTarget(list)?.id).toBe('new');
  });

  it('ignores hard-confirm cards and resolved actions', () => {
    expect(undoTarget([action({ tier: 'hard_confirm' }), action({ id: 'b', status: 'cancelled' })])).toBeNull();
    expect(undoTarget([])).toBeNull();
  });
});

describe('runUndo', () => {
  it('cancels the pending send through herald_confirm and says "Cancelled."', async () => {
    const d = deps([action({ id: 'p' })]);
    await expect(runUndo(d)).resolves.toBe('cancelled');
    expect(d.stopSpeech).toHaveBeenCalled();
    expect(d.cancel).toHaveBeenCalledWith('p');
    expect(d.say).toHaveBeenCalledWith(UNDO_LINES.cancelled);
  });

  it('nothing pending and quiet: says so briefly, cancels nothing', async () => {
    const d = deps([action({ status: 'sent' })]);
    await expect(runUndo(d)).resolves.toBe('nothing');
    expect(d.cancel).not.toHaveBeenCalled();
    expect(d.say).toHaveBeenCalledWith(UNDO_LINES.nothing);
  });

  it('nothing pending while Herald talks: just stops it (no "nothing to undo")', async () => {
    const d = deps([], { speaking: vi.fn(() => true) });
    await expect(runUndo(d)).resolves.toBe('stopped');
    expect(d.stopSpeech).toHaveBeenCalled();
    expect(d.say).not.toHaveBeenCalled();
  });

  it('too late: the hub reports it was already sent', async () => {
    const d = deps([action()], { cancel: vi.fn(async () => action({ status: 'sent' })) });
    await expect(runUndo(d)).resolves.toBe('too_late');
    expect(d.say).toHaveBeenCalledWith(UNDO_LINES.tooLate);
  });

  it('refused (null): says it could not cancel, or too late once state shows it sent', async () => {
    const list = [action()];
    const d = deps(list, { cancel: vi.fn(async () => null) });
    await expect(runUndo(d)).resolves.toBe('failed');
    expect(d.say).toHaveBeenCalledWith(UNDO_LINES.failed);
    const sentNow = [action()];
    const d2 = deps(sentNow, {
      cancel: vi.fn(async () => {
        sentNow[0] = action({ status: 'sent' });
        return null;
      }),
    });
    await expect(runUndo(d2)).resolves.toBe('too_late');
  });

  it('a throwing cancel is a failure, never an unhandled rejection', async () => {
    const d = deps([action()], { cancel: vi.fn(async () => { throw new Error('socket'); }) });
    await expect(runUndo(d)).resolves.toBe('failed');
  });
});
