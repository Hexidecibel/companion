// @vitest-environment node
/**
 * web/src/types/herald.ts must mirror daemon/src/herald/protocol.ts. The voice
 * section is required to be byte-identical (between its markers); the rest is
 * compared structurally (comments and whitespace ignored).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const daemon = readFileSync(resolve(root, 'daemon/src/herald/protocol.ts'), 'utf-8');
const web = readFileSync(resolve(root, 'web/src/types/herald.ts'), 'utf-8');

const START = '// --- voice protocol';
const END = '// --- end voice protocol ---';

function section(src: string): string {
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b + END.length);
}

function normalize(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '')
    .replace(/;}/g, '}');
}

describe('Herald protocol mirror', () => {
  it('voice section is byte-identical', () => {
    expect(section(web)).toBe(section(daemon));
  });

  it('the whole file is structurally identical', () => {
    expect(normalize(web)).toBe(normalize(daemon));
  });
});
