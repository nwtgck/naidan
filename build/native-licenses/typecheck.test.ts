import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNativeLicenseTypeContract } from './typecheck';

function fixture({ dynamic }: { dynamic: boolean }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-license-types-'));
  copyFileSync(path.resolve('build/native-licenses/index-types.ts'), path.join(root, 'index-types.ts'));
  const fileName = path.join(root, 'import.ts');
  writeFileSync(fileName, dynamic ? `\
import type { NativeLicenseIndex } from './index-types';
export async function read() {
  const { default: data } = await import('./index.json', { with: { type: 'json' } });
  return data satisfies NativeLicenseIndex;
}
` : `\
import data from './index.json' with { type: 'json' };
import type { NativeLicenseIndex } from './index-types';
export const checked = data satisfies NativeLicenseIndex;
`);
  return {
    root,
    fileName,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const component = { id: 'library', name: 'Library', version: null, license: null, notices: [{ path: 'LICENSE' }] };

describe('actual JSON import type contract', () => {
  it.each([false, true])('accepts additive metadata and nullable values without a version gate (dynamic=%s)', dynamic => {
    using test = fixture({ dynamic });
    writeFileSync(path.join(test.root, 'index.json'), JSON.stringify({ components: [component], futureMetadata: { note: 'allowed' } }));
    expect(() => assertNativeLicenseTypeContract({ fileName: test.fileName })).not.toThrow();
  });

  it.each([
    { label: 'missing name', value: { ...component, name: undefined } },
    { label: 'numeric version', value: { ...component, version: 4 } },
    { label: 'numeric path', value: { ...component, notices: [{ path: 7 }] } },
    { label: 'wrong notices', value: { ...component, notices: {} } },
  ])('rejects $label from the actual JSON, not a cast or declaration file', ({ value }) => {
    using test = fixture({ dynamic: true });
    writeFileSync(path.join(test.root, 'index.json'), JSON.stringify({ components: [value] }));
    expect(() => assertNativeLicenseTypeContract({ fileName: test.fileName })).toThrow('TypeScript contract');
  });
});
