import { gistFromReply, summarizeTurn, clipWords } from '../summarize';

describe('summarize', () => {
  it('strips filler and turns "I\'ve fixed" into "Fixed"', () => {
    expect(gistFromReply("Done. I've fixed the echo guard so Herald ignores itself. Tests pass.")).toBe(
      'Fixed the echo guard so Herald ignores itself'
    );
    expect(gistFromReply('All set! **Summary:** I added a retry to the uploader.')).toBe('Added a retry to the uploader');
  });

  it('clips at a word boundary to 60 chars', () => {
    const g = gistFromReply('Refactored the websocket reconnection logic to use exponential backoff with jitter and caps')!;
    expect(g.length).toBeLessThanOrEqual(60);
    expect(g.endsWith('…')).toBe(true);
    expect(g).not.toMatch(/\s…$/);
    expect(clipWords('short')).toBe('short');
  });

  it('empty reply falls back to prompt, then files', () => {
    const p = summarizeTurn({ reply: 'Done.', prompt: 'fix the build', files: ['a.ts'], inProgress: false, additions: 3, deletions: 1 });
    expect(p).toEqual({ gist: 'Fix the build', summary: 'Fix the build: 1 file, +3 -1', summarySource: 'prompt' });
    const f = summarizeTurn({ reply: '', prompt: '', files: ['src/a.ts', 'b.ts', 'c.ts'], inProgress: false, additions: 0, deletions: 0 });
    expect(f.gist).toBe('Edited a.ts and 2 more');
    expect(f.summary).toBe('Edited a.ts and 2 more: 3 files, +0 -0');
  });

  it('in-progress turn uses the prompt, not the partial reply', () => {
    const s = summarizeTurn({ reply: "I've started on it", prompt: 'add dark mode', files: [], inProgress: true, additions: 0, deletions: 0 });
    expect(s.summarySource).toBe('prompt');
    expect(s.gist).toBe('Add dark mode');
  });

  it('keeps non-report first-person sentences', () => {
    expect(gistFromReply('I think the bug is in the parser.')).toBe('I think the bug is in the parser');
  });
});
