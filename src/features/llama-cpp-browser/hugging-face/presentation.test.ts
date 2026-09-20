import { describe, expect, it } from 'vitest';
import { preferredProjector, quantizationChoices, quantizationName } from './presentation';
function model({ path }: { path: string }) {
  return { label: path, files: [{ path, size: 128 }], size: 128 };
}
describe('Hugging Face candidate presentation', () => {
  it('uses a fixed Q4_K_M-first preference independently of discovery order', () => {
    const models = ['model-Q8_0.gguf', 'model-Q4_0.gguf', 'model-Q5_K_M.gguf', 'model-Q4_K_M.gguf'].map(path => model({ path }));
    const expected = ['Q4_K_M', 'Q4_0', 'Q5_K_M', 'Q8_0'];
    expect(quantizationChoices({ models }).map(choice => choice.quantization)).toEqual(expected);
    expect(quantizationChoices({ models: [...models].reverse() }).map(choice => choice.quantization)).toEqual(expected);
  });
  it('keeps same-quant variants separate inside one choice and does not invent unknown quantizations', () => {
    const choices = quantizationChoices({ models: ['base-Q4_K_M.gguf', 'base-Q4_K_M-QAD.gguf', 'model-unknown.gguf'].map(path => model({ path })) });
    expect(choices).toHaveLength(2); expect(choices[0]?.models).toHaveLength(2); expect(choices[1]?.quantization).toBeUndefined();
    expect(quantizationName({ path: 'Q4_K_M/other.gguf' })).toBeUndefined();
    expect(quantizationName({ path: 'model-Q4_K_M-00001-of-00003.gguf' })).toBe('Q4_K_M');
  });
  it('selects one projector or precision variants of one family without guessing between families', () => {
    const files = ['mmproj-Q8_0.gguf', 'mmproj-F16.gguf', 'mmproj-BF16.gguf'].map(path => ({ path, size: 128 }));
    expect(preferredProjector({ files })?.path).toBe('mmproj-Q8_0.gguf');
    expect(preferredProjector({ files: [...files].reverse() })?.path).toBe('mmproj-Q8_0.gguf');
    expect(preferredProjector({ files: files.filter(file => file.path !== 'mmproj-Q8_0.gguf') })?.path).toBe('mmproj-F16.gguf');
    expect(preferredProjector({ files: [{ path: 'special-mmproj.gguf', size: 128 }] })?.path).toBe('special-mmproj.gguf');
    expect(preferredProjector({ files: [{ path: 'base-mmproj-F16.gguf', size: 128 }, { path: 'other-mmproj-F16.gguf', size: 128 }] })).toBeUndefined();
  });
});
