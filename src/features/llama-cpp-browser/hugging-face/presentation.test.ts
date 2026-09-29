import { describe, expect, it } from 'vitest';
import { preferredProjector, quantizationChoices, quantizationName } from './presentation';
import { variantLabel } from './model-variants';
function model({ path }: { path: string }) {
  return { label: path, files: [{ path, size: 128 }], size: 128 };
}
describe('Hugging Face candidate presentation', () => {
  it('labels Ornith quantizations when the repository has an extra architecture descriptor', () => {
    const repository = 'ornith-ai/Ornith-1.5-35B-A3B-GGUF';
    const paths = ['BF16', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'].map(quantization => `Ornith-1.5-35B-${quantization}.gguf`);
    const choices = quantizationChoices({ repository, models: paths.map(path => model({ path })) });
    expect(choices.map(choice => choice.label)).toEqual(['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'BF16']);
    expect(choices.map(choice => choice.id).sort()).toEqual([...paths].sort());
    for (const choice of choices) {
      expect(quantizationChoices({ repository, models: choice.models })[0]?.label).toBe(choice.label);
    }
  });
  it('preserves unknown modifiers, casing and subdirectories after removing a shared model prefix', () => {
    const repository = 'owner/Ornith-1.5-35B-A3B-GGUF';
    for (const variant of ['QAD-Q4_0', 'AWQ-Q4_K_M', 'UD-Q4_K_XL', 'FutureMethod-q4_Custom']) {
      expect(variantLabel({ repository, path: `nested/ornith-1.5-35b-${variant}-00001-of-00002.gguf` })).toBe(`nested/${variant}`);
    }
  });
  it('does not strip partial model names, dotted versions or size components', () => {
    const repository = 'owner/Ornith-1.5-35B-A3B-GGUF';
    expect(variantLabel({ repository, path: 'OrnithExtra-1.5-35B-Q4_K_M.gguf' })).toBe('OrnithExtra-1.5-35B-Q4_K_M');
    expect(variantLabel({ repository, path: 'Ornith-1.50-35B-Q4_K_M.gguf' })).toBe('1.50-35B-Q4_K_M');
    expect(variantLabel({ repository, path: 'Ornith-1.5-35BExtra-Q4_K_M.gguf' })).toBe('35BExtra-Q4_K_M');
    expect(variantLabel({ repository, path: 'Other-1.5-35B-Q4_K_M.gguf' })).toBe('Other-1.5-35B-Q4_K_M');
  });
  it('keeps separate file identities when shortened variant labels coincide', () => {
    const paths = ['Model-Q4_K_M.gguf', 'Model-A3B-Q4_K_M.gguf'];
    const choices = quantizationChoices({ repository: 'owner/Model-A3B-GGUF', models: paths.map(path => model({ path })) });
    expect(choices.map(choice => choice.label)).toEqual(['Q4_K_M', 'Q4_K_M']);
    expect(choices.map(choice => choice.id).sort()).toEqual([...paths].sort());
    expect(choices.every(choice => choice.models.length === 1)).toBe(true);
  });
  it('uses a fixed Q4_K_M-first preference independently of discovery order', () => {
    const models = ['model-Q8_0.gguf', 'model-Q4_0.gguf', 'model-Q5_K_M.gguf', 'model-Q4_K_M.gguf'].map(path => model({ path }));
    const expected = ['Q4_K_M', 'Q4_0', 'Q5_K_M', 'Q8_0'];
    expect(quantizationChoices({ repository: 'owner/model-GGUF', models }).map(choice => choice.quantization)).toEqual(expected);
    expect(quantizationChoices({ repository: 'owner/model-GGUF', models: [...models].reverse() }).map(choice => choice.quantization)).toEqual(expected);
  });
  it('keeps same-quant variants as separate choices and does not invent unknown quantizations', () => {
    const choices = quantizationChoices({ repository: 'owner/model-GGUF', models: ['base-Q4_K_M.gguf', 'base-Q4_K_M-QAD.gguf', 'model-unknown.gguf'].map(path => model({ path })) });
    expect(choices).toHaveLength(3); expect(choices[0]?.models).toHaveLength(1); expect(choices[2]?.quantization).toBeUndefined();
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
