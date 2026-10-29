import { beforeEach, expect, it, vi } from 'vitest';
import { startModelLaunch, registerModelLaunchEntryContext, modelLaunchCommand, modelLaunchEntryState, TEST_ONLY, type ModelLaunchCommandContext } from './entry-state';
import { targetForSelection } from './target';

beforeEach(() => TEST_ONLY.reset());

it('passes a prepared existing-chat selection and destination synchronously to its owner', () => {
  const permission = vi.fn(async () => ({ destination: { kind: 'host' as const, directoryId: 'root-a' }, expectedRoot: undefined }));
  const applyTarget = vi.fn<NonNullable<ModelLaunchCommandContext['applyTarget']>>(({ destination, authorizeDestination }) => {
    void authorizeDestination?.({ destination });
  });
  const unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: Symbol('chat'), isCurrent: () => true, defaults: Promise.resolve(undefined), applyTarget }) });
  using _cleanup = {
    [Symbol.dispose]() {
      unregister();
    },
  };
  const target = targetForSelection({ selection: { repository: 'owner/Model', revision: 'a'.repeat(40), files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } });
  const destination = { kind: 'host' as const, directoryId: 'root-a' };
  startModelLaunch({ target, request: { input: 'owner/Model', requestedVariant: target.mainFilePath, multimodal: 'off', destination, source: 'hugging-face' }, authorizeDestination: permission });
  expect(applyTarget).toHaveBeenCalledWith({ target, destination, authorizeDestination: permission });
  expect(applyTarget.mock.calls[0]![0].target).not.toBe(target);
  expect(permission).toHaveBeenCalledOnce();
  expect(modelLaunchCommand.value).toBeUndefined();
  expect(modelLaunchEntryState.value.status).toBe('idle');
});

it('does not apply or authorize a prepared target after its chat owner has changed', () => {
  const applyTarget = vi.fn(), permission = vi.fn();
  const unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: Symbol('chat'), isCurrent: () => false, defaults: Promise.resolve(undefined), applyTarget }) });
  using _cleanup = {
    [Symbol.dispose]() {
      unregister();
    },
  };
  const target = targetForSelection({ selection: { repository: 'owner/Model', revision: 'a'.repeat(40), files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } });
  startModelLaunch({ target, request: { input: 'owner/Model', requestedVariant: target.mainFilePath, multimodal: 'off', destination: { kind: 'opfs' }, source: 'hugging-face' }, authorizeDestination: permission });
  expect(applyTarget).not.toHaveBeenCalled();
  expect(permission).not.toHaveBeenCalled();
  expect(modelLaunchCommand.value).toBeUndefined();
});
