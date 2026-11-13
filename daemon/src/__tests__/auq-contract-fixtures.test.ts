/**
 * Frozen Claude Code AskUserQuestion screens (real ANSI pane captures saved by
 * bin/test-cc-contract, CLI version in the file name) and what the reader must
 * make of each. A new Claude Code release that changes the box shows up in
 * the live canary first; promote its candidates here once the reader handles
 * them (docs/cc-contract-tests.md).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseClaudeAuqBox } from '../agents/claude/auq-box';
import { KNOWN_AUQ_FOOTERS, auqContractView, contractJson } from '../agents/claude/auq-contract';

const DIR = path.join(__dirname, 'fixtures', 'cc-contract');
const cases = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.txt'))
  .sort();

describe('Claude Code AskUserQuestion contract fixtures', () => {
  it('has fixtures', () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  it.each(cases)('%s', (file) => {
    const pane = fs.readFileSync(path.join(DIR, file), 'utf8');
    const expected = JSON.parse(
      fs.readFileSync(path.join(DIR, file.replace(/\.txt$/, '.expected.json')), 'utf8')
    );
    const box = parseClaudeAuqBox(pane);
    expect(box).not.toBeNull();
    expect(contractJson(auqContractView(box!))).toBe(contractJson(expected));
    expect(box!.auq.unparsed).toBeUndefined();
    if (box!.auq.screen === 'question') expect(KNOWN_AUQ_FOOTERS).toContain(box!.auq.footer);
  });

  it('JSONL samples carry the shapes the parser reads', () => {
    const samples = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));
    expect(samples.length).toBeGreaterThan(0);
    for (const f of samples) {
      const [use, result] = fs
        .readFileSync(path.join(DIR, f), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(use.name).toBe('AskUserQuestion');
      for (const q of use.input.questions) {
        expect(typeof q.question).toBe('string');
        expect(typeof q.header).toBe('string');
        for (const o of q.options) {
          expect(typeof o.label).toBe('string');
          expect(typeof o.description).toBe('string');
        }
      }
      expect(result.type).toBe('user');
      const answers = result.toolUseResult.answers as Record<string, unknown>;
      expect(Object.values(answers).every((v) => typeof v === 'string')).toBe(true);
    }
  });
});
