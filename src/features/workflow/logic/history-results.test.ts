import { describe, it, expect, vi } from 'vitest';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { openWorkflowHistoryResults } from './history-results';

describe('Workflow history result locations', () => {
  it('opens a retained folder without creating a missing replacement', async () => {
    using files = createWorkflowTestFileSystem();
    const root = await files.root.getDirectoryHandle('naidan-tmp', { create: true });
    const owner = await root.getDirectoryHandle('owner', { create: true });
    await owner.getDirectoryHandle('workflow-results-one', { create: true });
    const path = ['naidan-tmp', 'owner', 'workflow-results-one'];
    expect((await openWorkflowHistoryResults({ root: files.root, path }))?.name).toBe('workflow-results-one');
    await owner.removeEntry('workflow-results-one', { recursive: true });
    const spy = vi.spyOn(files.root, 'getDirectoryHandle');
    expect(await openWorkflowHistoryResults({ root: files.root, path })).toBeUndefined();
    expect(spy).toHaveBeenCalledWith('naidan-tmp');
  });

  it('does not navigate into settings or parent directories', async () => {
    using files = createWorkflowTestFileSystem();
    const spy = vi.spyOn(files.root, 'getDirectoryHandle');
    for (const path of [['naidan-storage', 'settings'], ['naidan-tmp', '..', 'workflow-results-one']]) {
      await expect(openWorkflowHistoryResults({ root: files.root, path })).rejects.toThrow('Invalid');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
