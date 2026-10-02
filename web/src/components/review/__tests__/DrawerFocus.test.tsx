/**
 * "Hotkeys don't work in the review window (focus stolen by keyboard)": the
 * drawer takes focus on open, its shortcuts work even if the composer had
 * focus, typing in its own fields stays text, and focus returns on close.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { ReviewProvider, useReviewContext } from '../ReviewContext';
import { ReviewShell } from '../ReviewShell';
import { reviewStore } from '../../../services/reviewStore';
import type { ReviewRequestFn } from '../../../services/reviewApi';
import { fxGet, fxSummary } from '../__fixtures__/reviewFixtures';
import { focusTrapActive } from '../../../utils/focusTrap';

let n = 0;
let views: string[];
const request = (async (type: string, payload: any) => {
  if (type === 'review_get') {
    views.push(payload.view);
    return fxGet(payload.view);
  }
  if (type === 'review_get_edits') return { edits: [], missing: [] };
  return {};
}) as unknown as ReviewRequestFn;

function Opener({ open }: { open: boolean }) {
  const ctx = useReviewContext()!;
  useEffect(() => { if (open) ctx.openDrawer(); else ctx.closeDrawer(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function tree(serverId: string, open: boolean) {
  return (
    <ReviewProvider serverId={serverId} sessionId="sess-1" request={request}>
      <textarea className="input-bar-textarea" data-testid="composer" />
      <Opener open={open} />
      <ReviewShell />
    </ReviewProvider>
  );
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('review drawer focus', () => {
  let serverId: string;
  beforeEach(() => {
    views = [];
    serverId = `focus-srv-${++n}`;
    reviewStore.replaceAll(serverId, [fxSummary()]);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('takes focus on open and gives it back on close', async () => {
    const r = render(tree(serverId, false));
    const composer = screen.getByTestId('composer');
    composer.focus();
    expect(document.activeElement).toBe(composer);
    r.rerender(tree(serverId, true));
    await flush();
    const drawer = screen.getByTestId('rv-drawer');
    expect(document.activeElement).toBe(drawer);
    expect(focusTrapActive()).toBe(true);
    // Focus that lands outside (composer autofocus) comes back.
    act(() => { composer.focus(); });
    expect(document.activeElement).toBe(drawer);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await flush();
    expect(screen.queryByTestId('rv-drawer')).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(focusTrapActive()).toBe(false);
  });

  it('a shortcut works even when the key event comes from the composer', async () => {
    const r = render(tree(serverId, false));
    const composer = screen.getByTestId('composer');
    composer.focus();
    r.rerender(tree(serverId, true));
    await flush();
    expect(views).toEqual(['turns']);
    fireEvent.keyDown(composer, { key: 'v' });
    await flush();
    expect(views).toEqual(['turns', 'files']);
    fireEvent.keyDown(screen.getByTestId('rv-drawer'), { key: 'v' });
    await flush();
    expect(views).toEqual(['turns', 'files', 'turns']);
  });

  it('typing in the ask-why field does not trigger shortcuts', async () => {
    render(tree(serverId, true));
    await flush();
    const drawer = screen.getByTestId('rv-drawer');
    fireEvent.keyDown(drawer, { key: 'j' }); // focus the first hunk
    fireEvent.keyDown(drawer, { key: 'w' }); // ask why
    await flush();
    const ask = screen.getByTestId('rv-ask');
    const field = ask.querySelector('textarea, input') as HTMLElement;
    expect(field).toBeTruthy();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'v' });
    fireEvent.keyDown(field, { key: 'Escape' });
    await flush();
    expect(views).toEqual(['turns']);
    expect(screen.getByTestId('rv-drawer')).toBeInTheDocument();
  });

  it('Tab stays inside the drawer', async () => {
    render(tree(serverId, true));
    await flush();
    const drawer = screen.getByTestId('rv-drawer');
    const buttons = Array.from(drawer.querySelectorAll('button:not([disabled])')) as HTMLElement[];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });
});
