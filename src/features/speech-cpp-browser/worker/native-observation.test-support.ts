import { vi } from 'vitest';
import { nativeRecognitionFixture } from '@/features/speech-cpp-browser/recognition/worker/native-model.test-support';

export function observedNativeFixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const native = nativeRecognitionFixture({ pointerBytes });
  Object.defineProperty(native.core.module, 'HEAPU8', { value: native.heap });
  native.api.speech_log_set = vi.fn(async () => {});
  native.api.speech_model_info_json = vi.fn(async () => 500n);
  native.api.speech_model_info_device = vi.fn(async () => 600n);
  native.api.speech_model_info_threads = vi.fn(async () => 0);
  native.api.speech_model_info_weight_type = vi.fn(async () => 700n);
  native.api.speech_model_info_weight_bytes = vi.fn(async () => 1234567890123456789n);
  native.api.speech_device_count = vi.fn(async () => 1n);
  native.api.speech_device_name = vi.fn(async () => 600n);
  native.api.speech_device_description = vi.fn(async () => 800n);
  native.api.speech_device_get_kind = vi.fn(async (_index, pointer) => {
    new DataView(native.heap.buffer).setInt32(Number(pointer), 1, true);
    return 0;
  });
  native.api.speech_device_memory = vi.fn(async () => 0);
  native.api.speech_result_seed = vi.fn(async () => -1n);
  native.strings.set(500n, '{"source":{"repository":"model-source","revision":"pinned"},"options":[{"name":"language","default":"auto"}]}');
  native.strings.set(600n, 'WebGPU0');
  native.strings.set(700n, 'Q8_0');
  native.strings.set(800n, 'Runtime GPU');
  return native;
}

export const TEST_ONLY = {
};
