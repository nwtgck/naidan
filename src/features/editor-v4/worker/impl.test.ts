import { describe, expect, it } from 'vitest';
import { createEditorSearchWorker } from './impl';

describe('EditorV4 search worker', () => {
  it('searches the incremented document and rejects an old version', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    await worker.setDocument({ snapshot: { text: 'one two one', version: 0 } });
    await worker.applyChanges({ changes: { baseVersion: 0, version: 1, edits: [{ start: 4, end: 7, text: 'ONE' }] } });
    const request = {
      version: 1,
      options: { mode: 'literal', caseSensitivity: 'case-sensitive', query: 'one' },
      visible: { start: 0, end: 11 },
      target: { kind: 'index', index: -1 },
    } as const;

    await expect(worker.search({ request })).resolves.toMatchObject({
      kind: 'matches',
      count: 2,
      active: { start: 8, end: 11, index: 1 },
    });
    await expect(worker.search({ request: { ...request, version: 0 } })).rejects.toThrow('version changed');
  });

  it('returns the exact match count and a bounded number of highlights', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const text = 'a '.repeat(600);
    await worker.setDocument({ snapshot: { text, version: 0 } });
    const result = await worker.search({
      request: {
        version: 0,
        options: { mode: 'literal', caseSensitivity: 'case-sensitive', query: 'a' },
        visible: { start: 0, end: text.length },
        target: { kind: 'index', index: 499 },
      },
    });
    expect(result).toMatchObject({ kind: 'matches', count: 600, active: { start: 998, end: 999, index: 499 } });
    expect(result.kind === 'matches' && result.highlights.length).toBe(400);
  });

  it('finds viewport boundaries and wraps navigation after thinning a dense search index', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const count = 4_195_000;
    await worker.setDocument({ snapshot: { text: 'a'.repeat(count), version: 0 } });
    const request = {
      version: 0,
      options: { mode: 'literal', caseSensitivity: 'case-sensitive', query: 'a' },
      visible: { start: 0, end: 0 },
      target: { kind: 'index', index: 0 },
    } as const;
    await expect(worker.search({ request })).resolves.toMatchObject({ kind: 'matches', count });

    const boundary = 4_194_304;
    const highlights = [
      { start: boundary - 1, end: boundary, index: boundary - 1 },
      { start: boundary, end: boundary + 1, index: boundary },
    ];
    await expect(worker.search({
      request: { ...request, visible: { start: boundary, end: boundary }, target: { kind: 'index', index: -1 } },
    })).resolves.toEqual({ kind: 'matches', count, active: { start: count - 1, end: count, index: count - 1 }, highlights });
    await expect(worker.search({
      request: { ...request, visible: { start: boundary, end: boundary }, target: { kind: 'index', index: count } },
    })).resolves.toEqual({ kind: 'matches', count, active: { start: 0, end: 1, index: 0 }, highlights });
    await expect(worker.search({
      request: { ...request, target: { kind: 'offset', offset: boundary + 13 } },
    })).resolves.toMatchObject({ active: { start: boundary + 13, end: boundary + 14, index: boundary + 13 } });
  });

  it('resumes Unicode zero-length regex matches on the original text and preserves replacement captures', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const text = 'x😀'.repeat(790);
    await worker.setDocument({ snapshot: { text, version: 0 } });
    const options = { mode: 'regex', caseSensitivity: 'case-sensitive', query: '^|(?<=(x))(?=😀)|$' } as const;
    const request = {
      version: 0,
      options,
      visible: { start: 0, end: 0 },
      target: { kind: 'index', index: 0 },
    } as const;
    await expect(worker.search({ request })).resolves.toMatchObject({ count: 792 });

    const expected = { start: 769, end: 769, index: 257 };
    const targets = [{ kind: 'index', index: expected.index }, { kind: 'offset', offset: expected.start }] as const;
    for (const target of targets) {
      await expect(worker.search({ request: { ...request, visible: { start: 768, end: 770 }, target } })).resolves.toEqual({
        kind: 'matches',
        count: 792,
        active: expected,
        highlights: [expected],
      });
    }
    await expect(worker.replace({
      request: { version: 0, options, target: { kind: 'match', index: expected.index }, replacement: '<$1>' },
    })).resolves.toEqual({ kind: 'edits', edits: [{ start: expected.start, end: expected.end, text: '<x>' }] });
  });

  it('invalidates indexed searches when options or the worker document change', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    await worker.setDocument({ snapshot: { text: 'A.a', version: 0 } });
    const request = {
      version: 0,
      options: { mode: 'literal', caseSensitivity: 'case-sensitive', query: 'a' },
      visible: { start: 0, end: 3 },
      target: { kind: 'index', index: 0 },
    } as const;
    await expect(worker.search({ request })).resolves.toMatchObject({ count: 1, active: { start: 2 } });
    const insensitive = { ...request, options: { ...request.options, caseSensitivity: 'case-insensitive' } } as const;
    await expect(worker.search({ request: insensitive })).resolves.toMatchObject({ count: 2, active: { start: 0 } });
    const dot = { ...request, options: { ...request.options, query: '.' } } as const;
    await expect(worker.search({ request: dot })).resolves.toMatchObject({ count: 1, active: { start: 1 } });
    const regex = { ...dot, options: { ...dot.options, mode: 'regex' } } as const;
    await expect(worker.search({ request: regex })).resolves.toMatchObject({ count: 3, active: { start: 0 } });

    await worker.applyChanges({ changes: { baseVersion: 0, version: 1, edits: [{ start: 1, end: 2, text: 'zz' }] } });
    await expect(worker.search({ request: { ...regex, version: 1 } })).resolves.toMatchObject({ count: 4 });
    await worker.setDocument({ snapshot: { text: '', version: 1 } });
    await expect(worker.search({ request: { ...regex, version: 1 } })).resolves.toEqual({ kind: 'matches', count: 0, highlights: [] });
  });

  it('reports invalid regex and expands captures only in regex mode', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const text = 'pre-ab-post';
    await worker.setDocument({ snapshot: { text, version: 0 } });
    const options = { mode: 'regex', caseSensitivity: 'case-sensitive', query: '(?<part>a)(b)' } as const;
    const replacement = '<$<part>>:$2:$$:$&';
    await expect(worker.replace({ request: { version: 0, options, replacement, target: { kind: 'all' } } })).resolves.toEqual({
      kind: 'edits',
      edits: [{ start: 4, end: 6, text: '<a>:b:$:ab' }],
    });
    await expect(worker.replace({
      request: {
        version: 0,
        options: { mode: 'literal', caseSensitivity: 'case-sensitive', query: 'ab' },
        replacement,
        target: { kind: 'all' },
      },
    })).resolves.toEqual({ kind: 'edits', edits: [{ start: 4, end: 6, text: replacement }] });
    await expect(worker.search({
      request: {
        version: 0,
        options: { ...options, query: '(' },
        visible: { start: 0, end: text.length },
        target: { kind: 'offset', offset: 0 },
      },
    })).resolves.toEqual({ kind: 'invalid-regex' });
  });
});
