// @vitest-environment node
import { expect, it } from 'vitest';
import { nativeRecognitionFixture } from '@/features/speech-cpp-browser/recognition/worker/native-model.test-support';
import { readSpeechPointer, speechCallbackPointer } from './native-memory';

it('reads unsigned wasm32 pointers without including adjacent bytes and normalizes signed callback i32 values', () => {
  const { core, writePointer } = nativeRecognitionFixture({ pointerBytes: 4 });
  const address = core.alloc(4);
  writePointer({ output: address, value: 0xf1234567n });
  expect(readSpeechPointer({ core, address })).toBe(0xf1234567n);
  expect(speechCallbackPointer({ core, value: -249346713 })).toBe(0xf1234567n);
  expect(() => speechCallbackPointer({ core, value: 0x100000000 })).toThrow();
});

it('preserves wasm64 pointers above the uint32 range', () => {
  const { core, writePointer } = nativeRecognitionFixture({ pointerBytes: 8 });
  const address = core.alloc(8), pointer = 0x100000001n;
  writePointer({ output: address, value: pointer });
  expect(readSpeechPointer({ core, address })).toBe(pointer);
  expect(speechCallbackPointer({ core, value: pointer })).toBe(pointer);
});
