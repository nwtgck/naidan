import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFixture } from './project-fixture.ts';

describe('effect project fixture cleanup', () => {
  it('removes the temporary project when its scope exits', () => {
    let root: string;
    {
      using fixture = createFixture({ files: { 'main.ts': '' }, entries: ['main.ts'] });
      root = fixture.root;
      expect(fs.existsSync(root)).toBe(true);
    }
    expect(fs.existsSync(root)).toBe(false);
  });

  it('removes the temporary project when the test body throws', () => {
    let root: string | undefined;
    expect(() => {
      using fixture = createFixture({ files: { 'main.ts': '' }, entries: ['main.ts'] });
      root = fixture.root;
      expect(fs.existsSync(root)).toBe(true);
      throw new Error('Injected test body failure');
    }).toThrow('Injected test body failure');
    if (root === undefined) throw new Error('The fixture was not created');
    expect(fs.existsSync(root)).toBe(false);
  });
});
