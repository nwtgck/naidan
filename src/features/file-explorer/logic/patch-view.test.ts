import { describe, expect, it } from 'vitest';
import { buildPatchView } from './patch-view';

describe('buildPatchView', () => {
  it('assigns both line numbers and keeps old and new comment state independent', () => {
    const text = `\
--- a/build.ts
+++ b/build.ts
@@ -10,4 +20,4 @@ setup
-/*
+const enabled = true;
 dependency();
-*/
+const result = 1;
 return result;
`;
    const view = buildPatchView({ text });
    expect(view.kind).toBe('structured');
    if (view.kind !== 'structured') {
      throw new Error('Expected a structured diff');
    }

    const file = view.files[0]!;
    expect([file.oldPath, file.newPath]).toEqual(['a/build.ts', 'b/build.ts']);
    const hunk = file.hunks[0]!;
    expect(hunk.label).toBe('@@ -10,4 +20,4 @@ setup');
    expect(hunk.rows.map(row => [row.kind, row.oldLine, row.newLine])).toEqual([
      ['remove', 10, undefined],
      ['add', undefined, 20],
      ['context', 11, 21],
      ['remove', 12, undefined],
      ['add', undefined, 22],
      ['context', 13, 23],
    ]);
    expect(hunk.rows[0]?.tokens).toEqual([{ kind: 'comment', text: '/*' }]);
    expect(hunk.rows[1]?.tokens[0]).toEqual({ kind: 'keyword', text: 'const' });
    expect(hunk.rows[2]?.tokens[0]).toEqual({ kind: 'plain', text: 'dependency' });
    expect(hunk.rows[3]?.tokens).toEqual([{ kind: 'comment', text: '*/' }]);
  });

  it('preserves missing final newlines and displays unsupported source languages as plain text', () => {
    const text = `\
--- /dev/null
+++ notes.txt
@@ -0,0 +1 @@
+  const statement
\\ No newline at end of file
`;
    expect(buildPatchView({ text })).toEqual({
      kind: 'structured',
      files: [{
        oldPath: undefined,
        newPath: 'notes.txt',
        hunks: [{
          label: '@@ -0,0 +1,1 @@',
          rows: [{
            kind: 'add',
            oldLine: undefined,
            newLine: 1,
            tokens: [{ kind: 'plain', text: '  const statement' }],
            terminator: 'none',
          }],
        }],
      }],
    });
  });

  it('falls back to raw source for unrecognized, malformed, and oversized input', () => {
    const malformed = `\
--- notes.txt
+++ notes.txt
@@ -1,2 +1,2 @@
-old
+new
`;
    expect(buildPatchView({ text: '<p>Not a patch</p>' })).toEqual({ kind: 'source' });
    expect(buildPatchView({ text: malformed })).toEqual({ kind: 'source' });
    expect(buildPatchView({ text: '界'.repeat(130_000) })).toEqual({ kind: 'source' });
  });
});
