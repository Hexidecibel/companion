// @vitest-environment node
/**
 * web/src/types/setup.ts must mirror daemon/src/setup/protocol.ts
 * byte-for-byte (the whole contract lives between the markers; nothing else
 * is allowed in either file).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const daemon = readFileSync(resolve(root, 'daemon/src/setup/protocol.ts'), 'utf-8');
const web = readFileSync(resolve(root, 'web/src/types/setup.ts'), 'utf-8');

const START = '// --- setup protocol v1 ---';
const END = '// --- end setup protocol ---';

function section(src: string): string {
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b + END.length);
}

describe('Setup protocol mirror', () => {
  it('protocol section is byte-identical', () => {
    expect(section(web)).toBe(section(daemon));
  });

  it('the whole file is byte-identical', () => {
    expect(web).toBe(daemon);
  });

  it('has no imports (self-contained contract)', () => {
    expect(/^\s*import\s/m.test(web)).toBe(false);
  });

  it('the web skippable steps match the daemon', () => {
    const d = readFileSync(resolve(root, 'daemon/src/setup/state.ts'), 'utf-8');
    const w = readFileSync(resolve(root, 'web/src/services/setupWizard.ts'), 'utf-8');
    const list = (src: string, marker: string) => {
      const i = src.indexOf(marker);
      const body = src.slice(src.indexOf('[', i), src.indexOf(']', i));
      return Array.from(body.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    };
    expect(list(w, 'SKIPPABLE')).toEqual(list(d, 'SKIPPABLE_STEPS'));
  });
});
