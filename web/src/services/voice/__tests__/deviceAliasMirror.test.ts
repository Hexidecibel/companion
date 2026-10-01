// @vitest-environment node
/**
 * Device words ("on my PC") resolve the same on the web (spoken "show me") and
 * on the hub (the brain's show_session): the two copies are byte-identical.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../..');

describe('device alias mirror', () => {
  it('web deviceAlias.ts and daemon device-alias.ts are byte-identical', () => {
    const web = readFileSync(resolve(root, 'web/src/services/voice/deviceAlias.ts'), 'utf-8');
    const daemon = readFileSync(resolve(root, 'daemon/src/herald/device-alias.ts'), 'utf-8');
    expect(daemon).toBe(web);
  });
});
