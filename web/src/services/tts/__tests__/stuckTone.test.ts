import { describe, expect, it } from 'vitest';
import { InboxChimeTracker, inboxToneAllowed } from '../heraldSpeech';
import { TONES } from '../chime';
import type { HeraldInboxItem } from '../../../types/herald';

const item = (id: string, over: Partial<HeraldInboxItem> = {}): HeraldInboxItem =>
  ({ id, serverId: 's', sessionId: id, sessionName: id, priority: 'finished', headline: 'h', createdAt: 1, heard: false, ...over });
const stuck = (id: string, heard = false) =>
  item(id, { heard, headline: 'Out4 looks stuck: same test failing 6 times', stuck: { kind: 'repeated_failure', kinds: ['repeated_failure'], findingId: 'f', summary: 's', count: 6 } });

describe('stuck tone', () => {
  it('a new stuck item plays the stuck tone once; blocked and risk beat it', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'inbox', inbox: [] }, 'push');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('f'), stuck('s')] }, 'push')).toBe('stuck');
    // Updated in place (same id): no second tone.
    expect(t.handleEvent({ kind: 'inbox', inbox: [stuck('s')] }, 'push')).toBeNull();
    expect(t.handleEvent({ kind: 'inbox', inbox: [stuck('s2'), item('b', { priority: 'blocked' })] }, 'push')).toBe('blocked');
    expect(
      t.handleEvent({ kind: 'inbox', inbox: [stuck('s3'), item('r', { review: { level: 'high', kinds: ['ci'], paths: [] } })] }, 'push')
    ).toBe('risk');
    expect(t.handleEvent({ kind: 'inbox', inbox: [stuck('s4', true)] }, 'push')).toBeNull();
  });

  it('never reminds (only blocked items do)', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'inbox', inbox: [] }, 'push');
    expect(t.handleEvent({ kind: 'inbox', inbox: [stuck('s')] }, 'push', 1000)).toBe('stuck');
    expect(t.dueReminder(1000 + 60 * 60_000)).toBeNull();
  });

  it('is its own, soft tone (never louder than finished)', () => {
    expect(TONES.stuck.length).toBeGreaterThan(0);
    expect(JSON.stringify(TONES.stuck)).not.toBe(JSON.stringify(TONES.finished));
    expect(JSON.stringify(TONES.stuck)).not.toBe(JSON.stringify(TONES.risk));
    const peak = (k: keyof typeof TONES) => Math.max(...TONES[k].map((n) => n.gain));
    expect(peak('stuck')).toBeLessThanOrEqual(peak('finished'));
  });

  it('plays on the active device only; Gaming plays the tone even when the page is hidden', () => {
    expect(inboxToneAllowed({ chimeOn: true, announcer: true, visible: true, gaming: false })).toBe(true);
    expect(inboxToneAllowed({ chimeOn: true, announcer: false, visible: true, gaming: true })).toBe(false);
    expect(inboxToneAllowed({ chimeOn: true, announcer: true, visible: false, gaming: false })).toBe(false);
    expect(inboxToneAllowed({ chimeOn: true, announcer: true, visible: false, gaming: true })).toBe(true);
    expect(inboxToneAllowed({ chimeOn: false, announcer: true, visible: true, gaming: true })).toBe(false);
  });
});
