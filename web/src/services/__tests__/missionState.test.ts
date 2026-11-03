import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../types';
import { missionSection, missionState, needsYou } from '../missionState';

const s = (p: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'x', name: 'x', projectPath: '/p/x', status: 'idle', lastActivity: 1000, ...p,
});

describe('missionState', () => {
  it('waiting + needs_you (prompt or question) -> needs_you, active', () => {
    const st = missionState(s({ status: 'waiting', attention: 'needs_you' }), false);
    expect(st).toBe('needs_you');
    expect(missionSection(st)).toBe('active');
  });

  it('absent attention (older daemon): waiting counts as needs_you', () => {
    expect(needsYou(s({ status: 'waiting' }))).toBe(true);
    expect(missionState(s({ status: 'waiting' }), false)).toBe('needs_you');
  });

  it('done + unseen -> done (active); done + seen -> idle (quiet)', () => {
    const done = s({ status: 'waiting', attention: 'done' });
    expect(needsYou(done)).toBe(false);
    expect(missionState(done, true)).toBe('done');
    expect(missionSection(missionState(done, true))).toBe('active');
    expect(missionState(done, false)).toBe('idle');
    expect(missionSection(missionState(done, false))).toBe('quiet');
  });

  it('working active, idle quiet, error active', () => {
    expect(missionSection(missionState(s({ status: 'working' }), false))).toBe('active');
    expect(missionSection(missionState(s({ status: 'idle' }), true))).toBe('quiet');
    expect(missionState(s({ status: 'error' }), false)).toBe('error');
    expect(missionSection('error')).toBe('active');
  });
});
