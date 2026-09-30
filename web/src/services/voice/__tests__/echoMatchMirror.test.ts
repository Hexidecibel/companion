// @vitest-environment node
/**
 * The self-echo matcher runs on both sides (client filter + daemon backstop)
 * and must behave identically: the two copies are byte-identical.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../..');

describe('echo matcher mirror', () => {
  it('web echoMatch.ts and daemon echo-match.ts are byte-identical', () => {
    const web = readFileSync(resolve(root, 'web/src/services/voice/echoMatch.ts'), 'utf-8');
    const daemon = readFileSync(resolve(root, 'daemon/src/herald/voice/echo-match.ts'), 'utf-8');
    expect(daemon).toBe(web);
  });
});
