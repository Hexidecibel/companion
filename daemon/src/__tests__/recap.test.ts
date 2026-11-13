import {
  cleanRecapText,
  parseRecapEntry,
  latestRecapOf,
  parseRecapsFromContent,
  parseConversationFile,
  extractHighlights,
  detectWaitingForInput,
  ConversationAccumulator,
  parseJsonlLines,
} from '../parser';

const recapLine = (content: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'system',
    subtype: 'away_summary',
    content,
    timestamp: ts,
    uuid: `u-${ts}`,
    isSidechain: false,
    ...extra,
  });

const assistantLine = (text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    uuid: `a-${ts}`,
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });

describe('recaps', () => {
  it('strips the config hint suffix, tolerantly', () => {
    expect(cleanRecapText('Did a thing. (disable recaps in /config)')).toBe('Did a thing.');
    expect(cleanRecapText('Did a thing. (turn these off in /config settings)  ')).toBe(
      'Did a thing.'
    );
    expect(cleanRecapText('Keep (this) parenthetical.')).toBe('Keep (this) parenthetical.');
  });

  it('parses an away_summary entry and ignores others', () => {
    const entry = JSON.parse(
      recapLine('Back up. (disable recaps in /config)', '2026-11-13T09:15:10.726Z')
    );
    const msg = parseRecapEntry(entry);
    expect(msg).toMatchObject({ type: 'system', content: 'Back up.', isRecap: true });
    expect(msg?.timestamp).toBe(Date.parse('2026-11-13T09:15:10.726Z'));
    expect(parseRecapEntry({ type: 'system', subtype: 'compact_boundary' })).toBeNull();
    expect(parseRecapEntry({ ...entry, isSidechain: true })).toBeNull();
  });

  it('latestRecapOf picks the most recent by timestamp; absent case is undefined', () => {
    const text = [
      recapLine('Second', '2026-11-13T10:00:00.000Z'),
      recapLine('First', '2026-11-13T09:00:00.000Z'),
    ].join('\n');
    const recaps = parseRecapsFromContent(text);
    expect(latestRecapOf(recaps)).toEqual({
      text: 'Second',
      timestamp: '2026-11-13T10:00:00.000Z',
    });
    expect(latestRecapOf([])).toBeUndefined();
    expect(latestRecapOf(undefined)).toBeUndefined();
  });

  it('accumulator keeps recaps out of messages() (waiting detection) but exposes them', () => {
    const lines = [
      assistantLine('Done. Anything else?', '2026-11-13T09:00:00.000Z'),
      recapLine('Recap text (disable recaps in /config)', '2026-11-13T09:30:00.000Z'),
    ].join('\n');
    const acc = new ConversationAccumulator();
    acc.append(parseJsonlLines(lines));
    const messages = acc.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('assistant');
    expect(detectWaitingForInput(messages)).toBe(true);
    const recaps = acc.recaps();
    expect(recaps).toHaveLength(1);
    expect(latestRecapOf(recaps)?.text).toBe('Recap text');
  });

  it('extractHighlights interleaves recaps by timestamp as isRecap system highlights', () => {
    const lines = [
      assistantLine('one', '2026-11-13T09:00:00.000Z'),
      recapLine('Between', '2026-11-13T09:30:00.000Z'),
      assistantLine('two', '2026-11-13T10:00:00.000Z'),
    ].join('\n');
    const acc = new ConversationAccumulator();
    acc.append(parseJsonlLines(lines));
    const hs = extractHighlights(acc.messages(), acc.recaps());
    expect(hs.map((h) => h.content)).toEqual(['one', 'Between', 'two']);
    expect(hs[1]).toMatchObject({ type: 'system', isRecap: true });
    // Without recaps the output is unchanged
    expect(extractHighlights(acc.messages())).toHaveLength(2);
  });

  it('parseConversationFile does not turn recaps into messages', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recap-')), 'x.jsonl');
    fs.writeFileSync(
      f,
      [
        assistantLine('hi', '2026-11-13T09:00:00.000Z'),
        recapLine('R', '2026-11-13T09:05:00.000Z'),
      ].join('\n')
    );
    expect(parseConversationFile(f)).toHaveLength(1);
  });
});
