import type { ComputedRef } from 'vue';
import type { createBenchmarkForm } from './benchmark-form';
import type { ImageBenchmarkTarget } from './library-view';
import type { ParameterChange } from './benchmark/types';
import type { ModelSlot, Parameters, ImageInputs } from './types';
import type { ImageLoraSelection } from './lora-form';
export type ImageBenchmarkView = ReturnType<typeof createBenchmarkForm> & {
  available: ComputedRef<boolean>;
  targets: ComputedRef<ImageBenchmarkTarget[]>; busy: ComputedRef<boolean>; canStart: ComputedRef<boolean>; plannedRuns: ComputedRef<number>;
  start(): Promise<void>; stop(): void; clear(): void; download(): Promise<void>;
  select({ mode }: { mode: 'all' | 'none' }): void;
  toggle({ id, selected }: { id: string, selected: boolean }): void;
  effective({ target }: { target: ImageBenchmarkTarget }): Parameters;
  change({ id, change }: { id: string, change: ParameterChange }): void;
  inherit({ id, key }: { id: string, key: keyof Parameters }): void;
  chooseComponent({ targetId, slot, id }: { targetId: string, slot: ModelSlot, id: string }): void;
  chooseLoras({ targetId, selections }: { targetId: string, selections: ImageLoraSelection[] }): void;
  chooseImageInputs({ targetId, inputs }: { targetId: string, inputs: ImageInputs }): void;
};
export const TEST_ONLY = {
};
