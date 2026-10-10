import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';

function inspect({ body }: { body: string }) {
  const fixture = createFixture({ files: { 'main.ts': `async function inspect() { const root = await navigator.storage.getDirectory(); ${body} }` }, entries: ['main.ts'] });
  try {
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'inspect')!;
    return {
      diagnostics: analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds'),
      effects: (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
    };
  } finally {
    fixture.dispose();
  }
}

describe('filesystem lookup options without mutation-history reconstruction', () => {
  it.each([
    "root.getDirectoryHandle('x');",
    "root.getDirectoryHandle('x', {});",
    "root.getDirectoryHandle('x', ({ create: false }));",
    "root.getDirectoryHandle('x', { create: false } as const);",
    "root.getDirectoryHandle('x', { create: false } satisfies FileSystemGetDirectoryOptions);",
    "root.getFileHandle('x', { create: (false) });",
    "root.getFileHandle('x', { create: false as boolean });",
    "root.getFileHandle('x', void 0);",
    "root.getFileHandle('x', { ...(Math.random() ? { create: true } : {}), create: false });",
  ])('keeps provably non-creating lookup read-only: %s', body => {
    const result = inspect({ body });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['opfs.read(*)']);
  });

  it.each([
    "root.getDirectoryHandle('x', { create: false, ...(Math.random() ? { create: true } : {}) });",
    "root.getFileHandle('x', { create: true });",
    "const options = { create: false }; options.create = true; root.getFileHandle('x', options);",
    "const options = { create: false }; root.getFileHandle('x', options);",
  ])('does not discard a possible creation: %s', body => {
    const result = inspect({ body });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['opfs.read(*)', 'opfs.write(*)']);
  });

  it('still accounts for evaluating a void option expression', () => {
    const result = inspect({ body: "root.getFileHandle('x', void fetch('/probe'));" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['network.http(*)', 'opfs.read(*)']);
  });

  it('does not mistake a shadowed undefined binding for omitted options', () => {
    const result = inspect({ body: "const undefined = { create: true }; root.getFileHandle('x', undefined);" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['opfs.read(*)', 'opfs.write(*)']);
  });

  it('keeps a structural optional-shape limitation explicit', () => {
    const result = inspect({ body: "const patch: { create?: boolean } = Math.random() ? { create: true } : {}; root.getDirectoryHandle('x', { create: false, ...patch });" });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(result.effects).toEqual(['opfs.read(*)', 'opfs.write(*)']);
  });

  it('rejects a getter option even when an earlier false field is visible', () => {
    const result = inspect({ body: "const options = { get create() { localStorage.clear(); return true; } }; root.getFileHandle('x', options);" });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });
});
