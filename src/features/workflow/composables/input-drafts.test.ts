import { describe, it, expect, vi } from 'vitest';
import { createWorkflowInputDrafts } from './input-drafts';

describe('Workflow inline draft ownership', () => {
  it('does not let an old confirmation discard a newer edit', () => {
    const drafts = createWorkflowInputDrafts(), owner = Symbol();
    const discard = vi.fn();
    drafts.update({ owner, text: '{', discard });
    const snapshot = drafts.checkpoint();
    drafts.update({ owner, text: '{"value":', discard });
    expect(drafts.unchanged({ snapshot })).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it('only clears the owner that unmounts and discards all remaining owners explicitly', () => {
    const drafts = createWorkflowInputDrafts(), a = Symbol(), b = Symbol();
    const first = vi.fn(), second = vi.fn();
    drafts.update({ owner: a, text: 'a', discard: first });
    drafts.update({ owner: b, text: 'b', discard: second });
    drafts.update({ owner: a, text: undefined, discard: first });
    expect(drafts.dirty.value).toBe(true);
    expect(drafts.hasOther({ owner: a })).toBe(true);
    drafts.discardAll();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(drafts.dirty.value).toBe(false);
  });
});
