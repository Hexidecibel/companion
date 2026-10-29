import { describe, it, expect } from 'vitest';
import { describeSendError } from '../useConversation';

describe('describeSendError (daemon input guard)', () => {
  it('uses the daemon message for a refused send', () => {
    expect(describeSendError('prompt_has_draft', { message: 'Not sent: draft.' })).toBe('Not sent: draft.');
  });
  it('falls back to its own wording for draft / typing', () => {
    expect(describeSendError('prompt_has_draft')).toMatch(/unsent draft/);
    expect(describeSendError('user_typing')).toMatch(/typing in the terminal/);
  });
  it('shows a prompt on screen (trust / choice box) as a refusal too', () => {
    expect(describeSendError('prompt_waiting', { message: 'Not sent: trust.' })).toBe('Not sent: trust.');
    expect(describeSendError('prompt_waiting')).toMatch(/Trust this folder/);
  });
  it('returns null for other failures', () => {
    expect(describeSendError('Failed to send input to session')).toBeNull();
    expect(describeSendError(undefined)).toBeNull();
  });
});
