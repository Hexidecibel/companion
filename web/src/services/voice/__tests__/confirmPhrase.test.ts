import { describe, expect, it, vi } from 'vitest';
import { detectVoiceConfirm, hintText, runVoiceConfirm, voiceConfirmable } from '../confirmPhrase';
import type { HeraldAction } from '../../../types/herald';

const NOW = 1_000_000;

function card(over: Partial<HeraldAction> = {}): HeraldAction {
  return {
    id: 'a1',
    tier: 'hard_confirm',
    kind: 'send_input',
    serverId: 'local',
    sessionId: 'out4',
    sessionName: 'Out4',
    payload: 'deploy',
    readback: 'Out4: "deploy"',
    reasons: ['your request involves: deploy'],
    status: 'pending',
    createdAt: NOW - 1000,
    confirmPhrase: 'confirm deploy',
    voiceAttemptsLeft: 3,
    ...over,
  };
}

describe('detectVoiceConfirm', () => {
  it('ignores everything when no red card waits', () => {
    expect(detectVoiceConfirm('confirm deploy', [], NOW)).toBeNull();
    expect(detectVoiceConfirm('confirm deploy', [card({ tier: 'echo' })], NOW)).toBeNull();
    expect(detectVoiceConfirm('confirm deploy', [card({ status: 'sent' })], NOW)).toBeNull();
    expect(detectVoiceConfirm('confirm deploy', [card({ voiceAttemptsLeft: 0 })], NOW)).toBeNull();
  });

  it('"confirm <words>" goes to the hub for the matching card', () => {
    const cards = [card(), card({ id: 'a2', confirmPhrase: 'confirm deploy out four', createdAt: NOW })];
    expect(detectVoiceConfirm('Hey Jarvis, confirm deploy.', cards, NOW)).toMatchObject({ kind: 'confirm', action: { id: 'a1' } });
    expect(detectVoiceConfirm('Confirm deploy out four', cards, NOW)).toMatchObject({ kind: 'confirm', action: { id: 'a2' } });
    // Misheard words still go to the hub (it counts the try and says the phrase).
    expect(detectVoiceConfirm('confirm deplore', [card()], NOW)).toMatchObject({ kind: 'confirm', action: { id: 'a1' } });
  });

  it('a bare yes never confirms: it gets the phrase as a hint', () => {
    for (const t of ['Yes.', 'yeah', 'do it', 'Go ahead.', 'confirm', 'Confirmed.', 'yes please']) {
      const m = detectVoiceConfirm(t, [card()], NOW);
      expect(m?.kind).toBe('hint');
    }
    // Only while the card is fresh.
    expect(detectVoiceConfirm('yes', [card({ createdAt: NOW - 10 * 60_000 })], NOW)).toBeNull();
  });

  it('other speech passes through', () => {
    expect(detectVoiceConfirm("what's up", [card()], NOW)).toBeNull();
    expect(detectVoiceConfirm('tell Out4 to confirm the build', [card()], NOW)).toBeNull();
    expect(detectVoiceConfirm('stop', [card()], NOW)).toBeNull();
  });

  it('newest red card first', () => {
    expect(voiceConfirmable([card({ id: 'old', createdAt: 1 }), card({ id: 'new', createdAt: 2 })]).map((a) => a.id)).toEqual(['new', 'old']);
  });
});

describe('runVoiceConfirm', () => {
  it('a hint says the phrase and confirms nothing', async () => {
    const d = { confirmByVoice: vi.fn(), say: vi.fn(), tone: vi.fn() };
    await runVoiceConfirm({ kind: 'hint', action: card(), phrase: 'confirm deploy' }, d);
    expect(d.confirmByVoice).not.toHaveBeenCalled();
    expect(d.say).toHaveBeenCalledWith(hintText('confirm deploy'));
    expect(hintText('confirm deploy')).toMatch(/say "confirm deploy" to go ahead/);
  });

  it('the hub verdict is heard: ok tone on success, the reason on rejection', async () => {
    const ok = { confirmByVoice: vi.fn(async () => ({ action: card({ status: 'sent' }), error: null })), say: vi.fn(), tone: vi.fn() };
    expect(await runVoiceConfirm({ kind: 'confirm', action: card(), phrase: 'confirm deploy' }, ok)).toBe(true);
    expect(ok.confirmByVoice).toHaveBeenCalledWith('a1', 'confirm deploy');
    expect(ok.tone).toHaveBeenCalledWith('ok');
    expect(ok.say).not.toHaveBeenCalled();
    const no = { confirmByVoice: vi.fn(async () => ({ action: null, error: "That didn't match. Say \"confirm deploy\" to go ahead." })), say: vi.fn(), tone: vi.fn() };
    expect(await runVoiceConfirm({ kind: 'confirm', action: card(), phrase: 'confirm deplore' }, no)).toBe(false);
    expect(no.tone).toHaveBeenCalledWith('error');
    expect(no.say).toHaveBeenCalledWith(expect.stringMatching(/didn't match/));
  });
});
