import { it, expect, vi } from 'vitest';
import { toHostModelDirectoryId } from '@/01-models/ids';
import type { BrowserImageModelSelection } from '@/01-models/types';
import { imageSelection } from './image-generation.test-support';
import { createWorkflowImagePermissions } from './image-permissions';
import { createWorkflowModelPermissions } from './model-permissions';

it('never treats an imported literal image selection as a stored approval', async () => {
  const policy = createWorkflowImagePermissions();
  const request = vi.fn(async () => true);
  await policy.beginRun().authorize({ target: imageSelection(), sources: ['definition'], signal: new AbortController().signal, request });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ review: expect.objectContaining({ endpoint: 'stable-diffusion.cpp browser', modelId: expect.stringContaining('vae: —'), scope: 'editing_session' }) }));
});

it.each([
  {
    name: 'primary path',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
      target.primary.location = { kind: 'opfs', path: 'models/user/another/model.gguf' };
    },
  },
  {
    name: 'primary slot',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
      target.primary.slot = 'diffusion';
    },
  },
  {
    name: 'optional component',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
      target.components = [{ slot: 'vae', choice: { kind: 'file', location: { kind: 'opfs', path: 'models/user/vae/vae.gguf' } } }];
    },
  },
  {
    name: 'host namespace',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
      target.primary.location = { kind: 'host', path: 'model.gguf', directoryId: toHostModelDirectoryId({ raw: 'another' }) };
    },
  },
  {
    name: 'adapter path',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
 target.loras[0]!.location = { kind: 'opfs', path: 'models/user/another/adapter.gguf' };
    },
  },
  {
    name: 'adapter strength',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
 target.loras[0]!.strength = 0.5;
    },
  },
  {
    name: 'adapter activation',
    mutate: ({ target }: { target: BrowserImageModelSelection }) => {
 target.loras[0]!.enabled = 'disabled';
    },
  },
])('requires a new image approval after changing $name', async ({ mutate }) => {
  const policy = createWorkflowImagePermissions(), target = imageSelection();
  target.loras = [{ location: { kind: 'opfs', path: 'models/user/adapter/adapter.gguf' }, enabled: 'enabled', strength: 1 }];
  policy.review({ target });
  const request = vi.fn(async () => true), run = policy.beginRun(), signal = new AbortController().signal;
  await run.authorize({ target, sources: ['definition'], signal, request });
  expect(request).not.toHaveBeenCalled();
  mutate({ target });
  await run.authorize({ target, sources: ['definition'], signal, request });
  expect(request).toHaveBeenCalledOnce();
});

it('keeps dynamically supplied selections run-local even when an identical fixed model was selected', async () => {
  const policy = createWorkflowImagePermissions(), target = imageSelection();
  policy.review({ target });
  const request = vi.fn(async () => true), signal = new AbortController().signal;
  for (let index = 0; index < 2; index++) {
    const run = policy.beginRun();
    await run.authorize({ target, sources: ['model_output'], signal, request });
    await run.authorize({ target, sources: ['model_output'], signal, request });
  }
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not share image authority with model text/audio factories', async () => {
  const image = createWorkflowImagePermissions(), text = createWorkflowModelPermissions();
  image.review({ target: imageSelection() });
  const request = vi.fn(async () => true), signal = new AbortController().signal;
  await text.beginRun().authorize({ target: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'models/user/example/model.gguf' }, sources: ['definition'], signal, request });
  expect(request).toHaveBeenCalledOnce();
});

it('refuses a changed adapter choice after an asynchronous approval', async () => {
  const policy = createWorkflowImagePermissions(), target = imageSelection();
  await expect(policy.beginRun().authorize({
    target,
    sources: ['definition'],
    signal: new AbortController().signal,
    request: async () => {
      target.components = [];
      return true;
    },
  })).rejects.toThrow('changed');
});

export const TEST_ONLY = {
};
