// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { patchCommandDefinition } from '@/features/wesh/commands/patch/definition';

beforeAll(async () => {
  await patchCommandDefinition.load();
});
let fixture: Awaited<ReturnType<typeof createBlobViewShellFixture>>;
beforeEach(async () => {
  fixture = await createBlobViewShellFixture();
});
afterEach(() => {
  fixture?.dispose(); vi.restoreAllMocks();
});
const patchText = `\
--- a/target.txt
+++ b/target.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

describe('patch with safe efficient BlobView line sources', () => {
  it('indexes, checks and applies a native target without unsafe Blob consumption', async () => {
    const file = await fixture.writeFile({ path: '/target.txt', data: `\
one
two
three
` });
    await fixture.writeFile({ path: '/change.patch', data: patchText }); fixture.blockNativeReads();
    const dry = await fixture.execute({ script: 'patch --dry-run -p1 -i /change.patch', stdinText: undefined });
    expect(dry.stderr.text).toBe(''); expect(dry.result.exitCode).toBe(0);
    expect(new TextDecoder().decode(file.content)).toContain('two');
    const applied = await fixture.execute({ script: 'patch -p1 -i /change.patch', stdinText: undefined });
    expect(applied.stderr.text).toBe(''); expect(applied.result.exitCode).toBe(0);
    expect(new TextDecoder().decode((await fixture.root.getFileHandle('target.txt')).content)).toBe(`\
one
TWO
three
`);
  });

  it('keeps no-final-newline matching and stdin patches in the safe source path', async () => {
    await fixture.writeFile({ path: '/target.txt', data: 'old' }); fixture.blockNativeReads();
    const text = `\
--- a/target.txt
+++ b/target.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const applied = await fixture.execute({ script: 'patch -p1', stdinText: text });
    expect(applied.stderr.text).toBe(''); expect(applied.result.exitCode).toBe(0);
    expect(new TextDecoder().decode((await fixture.root.getFileHandle('target.txt')).content)).toBe('new');
  });

  it('does not treat a failed target read as an empty target or write partial output', async () => {
    const original = new TextEncoder().encode(`\
one
two
three
`);
    const file = await fixture.writeFile({ path: '/target.txt', data: original });
    fixture.blockNativeReads(); fixture.read.mockRejectedValue(new Error('Unavailable host'));
    const result = await fixture.execute({ script: 'patch -p1', stdinText: patchText });
    expect(result.result.exitCode).not.toBe(0); expect(result.stderr.text).not.toBe('');
    expect((await fixture.root.getFileHandle('target.txt')).content).toEqual(original);
    expect(file.content).toEqual(original);
  });
});
