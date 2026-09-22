// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';

beforeAll(async () => {
  await gitCommandDefinition.load();
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

describe('git apply without consuming reconstructed Blobs in the Worker', () => {
  it('checks, applies and reverses a working-tree patch with native reads disabled', async () => {
    expect((await fixture.execute({ script: 'git init -q /repo', stdinText: undefined })).result.exitCode).toBe(0);
    await fixture.writeFile({ path: '/repo/target.txt', data: `\
one
two
three
` });
    await fixture.writeFile({ path: '/change.patch', data: patchText }); fixture.blockNativeReads();
    const checked = await fixture.execute({ script: 'cd /repo; git apply --check /change.patch', stdinText: undefined });
    expect(checked.result.exitCode).toBe(0); expect(checked.stderr.text).toBe('');
    const applied = await fixture.execute({ script: 'cd /repo; git apply /change.patch', stdinText: undefined });
    expect(applied.result.exitCode).toBe(0); expect(applied.stderr.text).toBe('');
    const repo = await fixture.root.getDirectoryHandle('repo');
    expect(new TextDecoder().decode((await repo.getFileHandle('target.txt')).content)).toBe(`\
one
TWO
three
`);
    const reversed = await fixture.execute({ script: 'cd /repo; git apply -R /change.patch', stdinText: undefined });
    expect(reversed.result.exitCode).toBe(0); expect(reversed.stderr.text).toBe('');
    expect(new TextDecoder().decode((await repo.getFileHandle('target.txt')).content)).toBe(`\
one
two
three
`);
  });
});
