// @vitest-environment node
/**
 * web/src/types/profiles.ts must mirror daemon/src/profiles/protocol.ts
 * byte-for-byte (the whole contract lives between the markers; nothing else
 * is allowed in either file).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const daemon = readFileSync(resolve(root, 'daemon/src/profiles/protocol.ts'), 'utf-8');
const web = readFileSync(resolve(root, 'web/src/types/profiles.ts'), 'utf-8');

const START = '// --- profiles protocol v1 ---';
const END = '// --- end profiles protocol ---';

function section(src: string): string {
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b + END.length);
}

describe('Profiles protocol mirror', () => {
  it('protocol section is byte-identical', () => {
    expect(section(web)).toBe(section(daemon));
  });

  it('the whole file is byte-identical', () => {
    expect(web).toBe(daemon);
  });

  it('has no imports (self-contained contract)', () => {
    expect(/^\s*import\s/m.test(web)).toBe(false);
  });
});
