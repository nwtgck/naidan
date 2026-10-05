import { expect, it, vi } from 'vitest';
import { createMethodAccess } from './method-access';
import type { NaidanPeerMethodName } from '@/features/naidan-peer-rpc/contract';

type Names = readonly NaidanPeerMethodName[];
function temporary({ initial }: { initial: Names }) {
  const applied: Names[] = [];
  const controller = createMethodAccess({ initial, stored: initial, revision: 0, persist: undefined, apply: ({ allowedMethods }) => applied.push(allowedMethods), changed: () => {} });
  return { controller, applied };
}
it('derives valid names without a wildcard or group authority', async () => {
  const { controller, applied } = temporary({ initial: [] });
  const requested: NaidanPeerMethodName[] = ['listChatModels'];
  await controller.update({ allowedMethods: requested }); requested.push('generateImage');
  expect(controller.state().effective).toEqual(['listChatModels']); expect(applied.at(-1)).toEqual(['listChatModels']);
  expect(Object.isFrozen(controller.state().effective)).toBe(true);
});
it('allows an ephemeral session to grant methods without persisting trust', async () => {
  const { controller } = temporary({ initial: [] });
  await controller.update({ allowedMethods: ['generateImage'] });
  expect(controller.state()).toMatchObject({ effective: ['generateImage'], persistence: 'temporary' });
  controller.close(); expect(controller.state().effective).toEqual([]);
});
it('applies the intersection immediately and retains restrictions when persistence fails', async () => {
  const gate = Promise.withResolvers<number>();
  const apply = vi.fn();
  const controller = createMethodAccess({ initial: ['generateChat'], stored: ['generateChat'], revision: 2, persist: () => gate.promise, apply, changed: () => {} });
  const task = controller.update({ allowedMethods: ['generateImage'] }); const failed = expect(task).rejects.toThrow('Full');
  expect(controller.state().effective).toEqual([]); expect(controller.state().desired).toEqual(['generateImage']);
  gate.reject(new Error('Full')); await failed;
  expect(controller.state()).toMatchObject({ effective: [], saved: ['generateChat'], persistence: 'failed' });
  expect(apply).not.toHaveBeenCalledWith({ allowedMethods: ['generateImage'] });
});
it('a later revocation wins over an earlier save completion', async () => {
  const first = Promise.withResolvers<number>(), second = Promise.withResolvers<number>();
  const persist = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const apply = vi.fn(); const controller = createMethodAccess({ initial: [], stored: [], revision: 4, persist, apply, changed: () => {} });
  const granting = controller.update({ allowedMethods: ['generateChat'] }); await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  const revoking = controller.update({ allowedMethods: [] });
  first.resolve(5); await granting;
  expect(controller.state().effective).toEqual([]); expect(apply).not.toHaveBeenCalledWith({ allowedMethods: ['generateChat'] });
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2)); expect(persist.mock.calls[1]?.[0].expectedRevision).toBe(5);
  second.resolve(6); await revoking; expect(controller.state()).toMatchObject({ revision: 6, effective: [], saved: [], persistence: 'saved' });
});
it('does not regrant after the owner or session is closed during a save', async () => {
  const gate = Promise.withResolvers<number>(); const persist = vi.fn(() => gate.promise), apply = vi.fn();
  const controller = createMethodAccess({ initial: [], stored: [], revision: 0, persist, apply, changed: () => {} });
  const task = controller.update({ allowedMethods: ['generateImage'] }); await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  controller.close(); gate.resolve(1); await task;
  expect(controller.state().effective).toEqual([]); expect(apply).not.toHaveBeenCalledWith({ allowedMethods: ['generateImage'] });
  await expect(controller.update({ allowedMethods: [] })).rejects.toThrow('closed');
});
it('does not stop an unchanged allowed method during a mixed edit', async () => {
  const gate = Promise.withResolvers<number>(); const apply = vi.fn();
  const controller = createMethodAccess({ initial: ['listChatModels', 'generateChat'], stored: ['listChatModels', 'generateChat'], revision: 0, persist: () => gate.promise, apply, changed: () => {} });
  const task = controller.update({ allowedMethods: ['generateChat', 'generateImage'] });
  expect(apply).toHaveBeenLastCalledWith({ allowedMethods: ['generateChat'] });
  gate.resolve(1); await task; expect(controller.state().effective).toEqual(['generateChat', 'generateImage']);
});
it('fails closed on a storage revision mismatch and supports an explicit retry', async () => {
  const persist = vi.fn().mockResolvedValueOnce(20).mockResolvedValueOnce(1);
  const controller = createMethodAccess({ initial: [], stored: [], revision: 0, persist, apply: () => {}, changed: () => {} });
  await expect(controller.update({ allowedMethods: ['generateChat'] })).rejects.toThrow('revision');
  expect(controller.state().effective).toEqual([]);
  await controller.update({ allowedMethods: ['generateChat'] }); expect(controller.state().effective).toEqual(['generateChat']);
});
it('ignores observational exceptions without rolling back revocations', async () => {
  const controller = createMethodAccess({ initial: ['generateChat'], stored: ['generateChat'], revision: 0, persist: undefined, apply: () => {}, changed: () => {
    throw new Error('Observer');
  } });
  await controller.update({ allowedMethods: [] }); expect(controller.state().effective).toEqual([]);
});

it('publishes the restricted set before invoking synchronous revocation observers', async () => {
  const seen: Names[] = [];
  const controller = createMethodAccess({ initial: ['generateChat'], stored: ['generateChat'], revision: 0, persist: undefined,
    apply: () => {
      seen.push(controller.state().effective);
    }, changed: () => {} });
  await controller.update({ allowedMethods: [] });
  expect(seen).toEqual([[], []]);
});

it('does not restore a temporary grant when revocation synchronously closes its owner', async () => {
  let closeOnApply = true;
  const applied: Names[] = [];
  const controller = createMethodAccess({ initial: ['generateChat'], stored: ['generateChat'], revision: 0, persist: undefined,
    apply: ({ allowedMethods }) => {
      applied.push([...allowedMethods]);
      if (closeOnApply) {
        closeOnApply = false; controller.close();
      }
    }, changed: () => {} });
  await controller.update({ allowedMethods: ['generateImage'] });
  expect(controller.state().effective).toEqual([]);
  expect(applied).not.toContainEqual(['generateImage']);
});

it('keeps a newer temporary edit made synchronously during a revocation', async () => {
  let editOnApply = true;
  let newer: Promise<void> | undefined;
  const controller = createMethodAccess({ initial: ['generateChat'], stored: ['generateChat'], revision: 0, persist: undefined,
    apply: () => {
      if (editOnApply) {
        editOnApply = false; newer = controller.update({ allowedMethods: ['listChatModels'] });
      }
    }, changed: () => {} });
  await controller.update({ allowedMethods: ['generateImage'] }); await newer;
  expect(controller.state()).toMatchObject({ effective: ['listChatModels'], desired: ['listChatModels'] });
});

it('does not restore saved grants when installation synchronously closes the controller', async () => {
  let closeOnGrant = true;
  const controller = createMethodAccess({ initial: [], stored: [], revision: 0, persist: async () => 1,
    apply: ({ allowedMethods }) => {
      if (closeOnGrant && allowedMethods.includes('generateImage')) {
        closeOnGrant = false; controller.close();
      }
    }, changed: () => {} });
  await controller.update({ allowedMethods: ['generateImage'] });
  expect(controller.state().effective).toEqual([]);
});

it('keeps the stored method set separate from a retained unsaved restriction', async () => {
  const stored: NaidanPeerMethodName[] = ['listChatModels', 'generateChat'];
  const persist = vi.fn(async () => 8);
  const controller = createMethodAccess({ initial: ['listChatModels'], stored, revision: 7,
    persist, apply: () => {}, changed: () => {} });
  stored.length = 0;
  expect(controller.state()).toMatchObject({ effective: ['listChatModels'], desired: ['listChatModels'], saved: ['listChatModels', 'generateChat'], persistence: 'failed' });
  expect(persist).not.toHaveBeenCalled();
  await controller.update({ allowedMethods: ['listChatModels'] });
  expect(persist).toHaveBeenCalledWith({ allowedMethods: ['listChatModels'], expectedRevision: 7 });
  expect(controller.state()).toMatchObject({ revision: 8, saved: ['listChatModels'], persistence: 'saved' });
});

it('does not report a different array order as an unsaved policy', () => {
  const controller = createMethodAccess({ initial: ['generateChat', 'listChatModels'], stored: ['listChatModels', 'generateChat'], revision: 0,
    persist: async () => 1, apply: () => {}, changed: () => {} });
  expect(controller.state().persistence).toBe('saved');
});
