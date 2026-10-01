import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOCUS_TTL_MS,
  _resetSessionFocus,
  findPromptElement,
  hasSessionFocus,
  onSessionFocus,
  requestSessionFocus,
  takeSessionFocus,
} from '../sessionFocus';
import { resolveHeraldServerId } from '../heraldNav';

afterEach(() => _resetSessionFocus());

describe('session focus requests ("show me")', () => {
  it('is taken once, by the right session, while fresh', () => {
    const cb = vi.fn();
    onSessionFocus(cb);
    requestSessionFocus('srv', 'out4', true, 1000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(hasSessionFocus('docs', 1000)).toBe(false);
    expect(takeSessionFocus('docs', 1000)).toBeNull();
    expect(hasSessionFocus('out4', 1000)).toBe(true);
    expect(takeSessionFocus('out4', 1001)).toMatchObject({ serverId: 'srv', sessionId: 'out4', pending: true });
    expect(takeSessionFocus('out4', 1002)).toBeNull();
  });

  it('a stale request is dropped', () => {
    requestSessionFocus('srv', 'out4', false, 0);
    expect(hasSessionFocus('out4', FOCUS_TTL_MS + 1)).toBe(false);
    expect(takeSessionFocus('out4', FOCUS_TTL_MS + 1)).toBeNull();
  });

  it('finds the LAST waiting question / choice, else the approval prompt, else nothing', () => {
    const root = document.createElement('div');
    expect(findPromptElement(root)).toBeNull();
    root.innerHTML = '<div class="msg-approval-prompt" id="ap"></div>';
    expect(findPromptElement(root)?.id).toBe('ap');
    root.innerHTML += '<div class="question-block" id="q1"></div><div class="question-block" id="q2"></div>';
    expect(findPromptElement(root)?.id).toBe('q2');
  });
});

describe('resolveHeraldServerId', () => {
  it("maps the hub's own 'local' id to the Herald host connection", () => {
    expect(resolveHeraldServerId('local', 'conn-1', ['conn-1', 'conn-2'])).toBe('conn-1');
    expect(resolveHeraldServerId('conn-2', 'conn-1', ['conn-1', 'conn-2'])).toBe('conn-2');
    expect(resolveHeraldServerId('local', null, [])).toBe('local');
  });
});
