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

  it.each([
    { path: 'Model-UD-IQ4_NL.gguf', label: 'UD-IQ4_NL', quantization: 'IQ4_NL' },
    { path: 'Model-IQ4_NL.gguf', label: 'IQ4_NL', quantization: 'IQ4_NL' },
    { path: 'Model-UD-Q4_K_XL.gguf', label: 'UD-Q4_K_XL', quantization: 'Q4_K_XL' },
    { path: 'Model-AWQ-Q4_K_M.gguf', label: 'AWQ-Q4_K_M', quantization: 'Q4_K_M' },
    { path: 'Model-QAD-Q4_0.gguf', label: 'QAD-Q4_0', quantization: 'Q4_0' },
    { path: 'Model-FutureMethod-q4_Custom.gguf', label: 'FutureMethod-q4_Custom', quantization: 'Q4_CUSTOM' },
    { path: 'Model-KQuant-17GB-Q4_K_M.gguf', label: 'KQuant-17GB-Q4_K_M', quantization: 'Q4_K_M' },
    { path: 'imatrix/Model-UD-Q4_K_XL/Model-UD-Q4_K_XL-00001-of-00004.gguf', label: 'imatrix/UD-Q4_K_XL', quantization: 'Q4_K_XL' },
  ])('keeps the complete variant order in the choice label: $label', ({ path, label, quantization }) => {
    const candidate = model({ path });
    expect(quantizationChoices({ repository: 'owner/Model-GGUF', models: [candidate] })).toEqual([
      { id: path, label, quantization, models: [candidate] },
    ]);
  });

  it.each(['-', '.', '_'])('removes the repository model prefix followed by the %s separator', separator => {
    const repository = 'owner/Model-v0.2-GGUF';
    expect(variantLabel({ repository, path: `model-v0.2${separator}Q4_K_M.gguf` })).toBe('Q4_K_M');
  });

  it('removes repeated variant directories while retaining a meaningful ancestor', () => {
    expect(variantLabel({ repository: 'owner/Model-GGUF', path: 'imatrix/Model-UD-Q4_K_XL/Model-UD-Q4_K_XL-00001-of-00004.gguf' })).toBe('imatrix/UD-Q4_K_XL');
  });

  it('does not strip partial model names, dotted versions or size components', () => {
    const repository = 'owner/Ornith-1.5-35B-A3B-GGUF';
    expect(variantLabel({ repository, path: 'OrnithExtra-1.5-35B-Q4_K_M.gguf' })).toBe('OrnithExtra-1.5-35B-Q4_K_M');
    expect(variantLabel({ repository, path: 'Ornith-1.50-35B-Q4_K_M.gguf' })).toBe('1.50-35B-Q4_K_M');
    expect(variantLabel({ repository, path: 'Ornith-1.5-35BExtra-Q4_K_M.gguf' })).toBe('35BExtra-Q4_K_M');
    expect(variantLabel({ repository, path: 'Ornith-1.5.1-35B-Q4_K_M.gguf' })).toBe('1.5.1-35B-Q4_K_M');
    expect(variantLabel({ repository, path: 'Other-1.5-35B-Q4_K_M.gguf' })).toBe('Other-1.5-35B-Q4_K_M');
  });

  it('preserves a longer dotted version while accepting a dot before the variant', () => {
    const repository = 'owner/Model-v0.2-GGUF';
    expect(variantLabel({ repository, path: 'model-v0.2.1.Q4_K_M.gguf' })).toBe('v0.2.1.Q4_K_M');
    expect(variantLabel({ repository, path: 'model-v0.2.Q4_K_M.gguf' })).toBe('Q4_K_M');
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

  it('preserves variant tie-breaks and unknown four-bit priority independently of displayed names', () => {
    const paths = ['Model-Q5_K_M.gguf', 'Model-Q4_K_M-beta.gguf', 'nested/Model-Q4_K_XL.gguf', 'Model-base-Q4_K_M.gguf', 'Model-Q4_K_M.gguf'];
    const models = paths.map(path => model({ path }));
    const expected = ['Model-Q4_K_M.gguf', 'Model-base-Q4_K_M.gguf', 'Model-Q4_K_M-beta.gguf', 'nested/Model-Q4_K_XL.gguf', 'Model-Q5_K_M.gguf'];
    for (const candidates of [models, [...models].reverse()]) {
      expect(quantizationChoices({ repository: 'owner/Model-GGUF', models: candidates }).map(choice => choice.id)).toEqual(expected);
    }
  });

  it('keeps same-quant variants as separate choices and does not invent unknown quantizations', () => {
    const choices = quantizationChoices({ repository: 'owner/model-GGUF', models: ['base-Q4_K_M.gguf', 'base-Q4_K_M-QAD.gguf', 'model-unknown.gguf'].map(path => model({ path })) });
    expect(choices).toHaveLength(3);
    expect(choices[0]?.models).toHaveLength(1);
    expect(choices[2]?.quantization).toBeUndefined();
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
