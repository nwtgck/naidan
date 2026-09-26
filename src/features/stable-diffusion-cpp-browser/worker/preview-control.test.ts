import { expect, it, vi } from 'vitest';
import { createNativePreviewControl } from './preview-control';
import { defaultPreviewSettings, type PreviewControl } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core } from './core-types';
function fixture() {
  const set = vi.fn(async (..._args: unknown[]): Promise<void> => undefined), raw = vi.fn();
  const core = { api: { sd_set_preview_callback: set }, module: { _sdc_sd_set_preview_callback: raw }, constant: (name: string) => ({ PREVIEW_PROJ: 1, PREVIEW_VAE: 3 })[name as 'PREVIEW_PROJ' | 'PREVIEW_VAE'] } as unknown as Core;
  const control = createNativePreviewControl({ core, callback: 123, runId: 4, initial: { ...defaultPreviewSettings } });
  const message = ({ revision, enabled, startStep = 1 }: { revision: number, enabled: boolean, startStep?: number }): PreviewControl => ({ type: 'naidan-image-preview-control-v1', runId: 4, revision, settings: { ...defaultPreviewSettings, enabled, startStep, interval: 1 } });
  return { control, core, set, raw, message };
}
it('passes the actual six-argument ABI in mode/interval/denoised/noisy order and keeps OFF callback nonnull', async () => {
  const h = fixture(); await h.control.start();
  expect(h.set).toHaveBeenCalledExactlyOnceWith(123n, 3, 2, 0, 0, 0n);
  expect(h.raw).not.toHaveBeenCalled();
  h.control.update({ control: h.message({ revision: 1, enabled: true }) });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 1, 0, 0n);
  h.control.observeStep({ step: 1 });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 1, 0, 0n);
  h.control.update({ control: h.message({ revision: 2, enabled: false }) });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 0, 0, 0n);
  expect(h.set).toHaveBeenCalledTimes(1);
});
it('rejects malformed, old, foreign and mode-changing updates; close never calls native', async () => {
  const h = fixture(); await h.control.start(); const valid = h.message({ revision: 2, enabled: true });
  expect(h.control.update({ control: valid })).toBe(true);
  for (const input of [valid, { ...valid, runId: 99, revision: 3 }, { ...valid, revision: 3, settings: { ...valid.settings, interval: 0 } }, { ...valid, revision: 3, settings: { ...valid.settings, mode: 'projection' as const } }]) expect(h.control.update({ control: input })).toBe(false);
  expect(h.raw).toHaveBeenCalledTimes(1); h.control.close();
  expect(h.control.update({ control: h.message({ revision: 3, enabled: false }) })).toBe(false);
  expect(h.raw).toHaveBeenCalledTimes(1); expect(h.set).toHaveBeenCalledTimes(1);
});
it('accepts configuration changes before startup and reconciles the await handoff', async () => {
  const h = fixture(), wait = Promise.withResolvers<void>();
  h.set.mockReturnValueOnce(wait.promise);
  h.control.update({ control: h.message({ revision: 1, enabled: true }) });
  const start = h.control.start();
  expect(h.set).toHaveBeenLastCalledWith(123n, 3, 1, 1, 0, 0n);
  h.control.update({ control: h.message({ revision: 2, enabled: false }) });
  wait.resolve(); await start;
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 0, 0, 0n);
});
it('waits until the configured step threshold before enabling previews', async () => {
  const h = fixture(); const c = createNativePreviewControl({ core: h.core, callback: 99n, runId: 1, initial: { ...defaultPreviewSettings, enabled: true, startStep: 4, interval: 7 } });
  await c.start(); expect(h.set).toHaveBeenLastCalledWith(99n, 3, 7, 0, 0, 0n);
  c.observeStep({ step: 2 }); expect(h.raw).not.toHaveBeenCalled();
  c.observeStep({ step: 3 }); expect(h.raw).toHaveBeenLastCalledWith(99n, 3, 7, 1, 0, 0n);
  c.observeStep({ step: 4 }); expect(h.raw).toHaveBeenCalledTimes(1);
});
it('fails explicitly rather than re-entering the generic API if the reviewed scalar setter is absent', async () => {
  const h = fixture(); delete h.core.module._sdc_sd_set_preview_callback; await h.control.start();
  expect(() => h.control.update({ control: h.message({ revision: 1, enabled: true }) })).toThrow('live preview control');
  expect(h.set).toHaveBeenCalledTimes(1);
});

it('allows an enabled step-one preview before the first completion callback', async () => {
  const h = fixture();
  const c = createNativePreviewControl({ core: h.core, callback: 99n, runId: 1, initial: { ...defaultPreviewSettings, enabled: true, interval: 1 } });
  await c.start();
  expect(h.set).toHaveBeenCalledExactlyOnceWith(99n, 3, 1, 1, 0, 0n);
});
it('re-evaluates a live threshold against the next denoising step without changing the native interval', async () => {
  const h = fixture();
  h.control.update({ control: h.message({ revision: 1, enabled: true, startStep: 6 }) });
  await h.control.start();
  h.control.observeStep({ step: 3 });
  expect(h.raw).not.toHaveBeenCalled();
  h.control.update({ control: h.message({ revision: 2, enabled: true, startStep: 4 }) });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 1, 0, 0n);
  h.control.update({ control: h.message({ revision: 3, enabled: true, startStep: 6 }) });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 0, 0, 0n);
  h.control.observeStep({ step: 5 });
  expect(h.raw).toHaveBeenLastCalledWith(123n, 3, 1, 1, 0, 0n);
});
