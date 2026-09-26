import { previewControlSchema, type PreviewControl, type PreviewSettings } from '@/features/stable-diffusion-cpp-browser/types';
import type { Core } from './core-types';

/** The pinned sampler snapshots mode/callback at entry but reads flags and
 * interval per step. Never null that callback while a run may turn preview ON. */
export function createNativePreviewControl({ core, callback, runId, initial }: {
  core: Core, callback: number | bigint, runId: number, initial: PreviewSettings,
}) {
  let settings = { ...initial }, revision = 0, running = false, closed = false, nextStep = 1;
  const mode = (() => {
    switch (initial.mode) {
    case 'projection': return core.constant('PREVIEW_PROJ');
    case 'vae': return core.constant('PREVIEW_VAE');
    default: { const exhaustive: never = initial.mode; throw new Error(String(exhaustive)); }
    }
  })();
  function enabledFor({ target, step }: { target: PreviewSettings, step: number }): boolean {
    return target.enabled && step >= target.startStep;
  }
  const args = () => [BigInt(callback), mode, settings.interval, Number(enabledFor({ target: settings, step: nextStep })), 0, 0n] as const;
  function writeLive(): void {
    const set = core.module._sdc_sd_set_preview_callback;
    if (!set) throw new Error('This image runtime does not support live preview control');
    set(...args());
  }
  return {
    snapshot() {
      return { settings: { ...settings }, revision };
    },
    async start(): Promise<void> {
      if (closed) throw new Error('Preview control closed');
      const before = revision;
      await core.api.sd_set_preview_callback(...args());
      running = true;
      if (revision !== before) writeLive();
    },
    update({ control }: { control: PreviewControl }): boolean {
      const parsed = previewControlSchema.safeParse(control);
      if (!parsed.success || closed || control.runId !== runId || control.revision <= revision || control.settings.mode !== initial.mode) return false;
      settings = { ...control.settings }; revision = control.revision;
      if (running) {
        // Deliberately narrow exception to the host helper's general busy guard.
        // The reviewed generated export calls util.cpp's six scalar assignments:
        // no graph/context access, allocation, callback invocation or suspension.
        // Never use core.api/ccall or any other native export to re-enter a run.
        writeLive();
      }
      return true;
    },
    observeStep({ step }: { step: number }): void {
      if (closed || !running || !Number.isInteger(step) || step < 0) return;
      const before = enabledFor({ target: settings, step: nextStep });
      // Native progress reports completed denoising steps AFTER their preview.
      // Configure capture for the following step, not the just-completed one.
      nextStep = step + 1;
      const after = enabledFor({ target: settings, step: nextStep });
      if (before !== after) writeLive();
    },
    close(): void {
      closed = true; running = false;
    },
  };
}
export const TEST_ONLY = {
};
