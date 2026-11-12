import { describe, expect, it } from 'vitest';
import { parseImageGenerationInput, validateImageGenerationInputs, IMAGE_COMPOSITION_MAX_TEXT_BYTES } from './input';

describe('image generation pasted input', () => {
  it('reads multiple object documents, multiline prompts and overrides', async () => {
    const result = await parseImageGenerationInput({
      text: `\
prompt: lake
---
prompt: |
  cat
  ---
negativePrompt: ""
count: 4
seed: "9223372036854775804"
uiModelConfigurationSlot: illustration`,
    });
    expect(result.format).toBe('YAML');
    expect(result.inputs).toEqual([{ prompt: 'lake' }, {
      prompt: `\
cat
---
`,
      negativePrompt: '',
      count: 4,
      seed: '9223372036854775804',
      uiModelConfigurationSlot: 'illustration',
    }]);
  });

  it('prefers JSONL including a single object, handles BOM and CRLF', async () => {
    const result = await parseImageGenerationInput({ text: '\uFEFF{"prompt":"a"}\r\n\r\n{"prompt":"b\\nc","seed":null,"steps":"auto","guidance":0}\r\n' });
    expect(result).toEqual({
      format: 'JSONL',
      inputs: [{ prompt: 'a' }, {
        prompt: `\
b
c`,
        seed: null,
        steps: 'auto',
        guidance: 0,
      }],
    });
  });

  it('accepts pretty JSON as YAML without requiring a format switch', async () => {
    expect((await parseImageGenerationInput({
      text: `\
{
 "prompt": "a",
 "width": 512
}`,
    })).inputs).toEqual([{ prompt: 'a', width: 512 }]);
  });

  it.each([
    '', '# only a comment', '---\n', `\
prompt: a
---`, 'a', '- prompt: a', '{"count":2}', '{"prompt":null}',
    '{"prompt":42}', '{"prompt":""}', '{"prompt":"a","unknown":1}', '{"prompt":"a","negativePromt":"b"}',
    '{"prompt":"a","prompt":"b"}', '{"prompt":"a","pro\\u006dpt":"b"}', `\
prompt: a
prompt: b`,
    `\
prompt: a
width: 511`, `\
prompt: a
width: "512"`, `\
prompt: a
count: 0`, `\
prompt: a
count: 65`, `\
prompt: a
count: 1.5`,
    `\
prompt: a
seed: 9223372036854775807`, `\
prompt: a
seed: "-1"`, `\
prompt: a
seed: "9223372036854775808"`,
    `\
prompt: a
seed: "9223372036854775807"
count: 2`, `\
prompt: a
steps: .nan`, `\
prompt: a
guidance: .inf`,
    `\
prompt: a
uiModelConfigurationSlot: " "`, 'prompt: a\nuiModelConfigurationSlot: "a\\nb"',
    `\
prompt: &x a
negativePrompt: *x`, 'prompt: !!str a', 'prompt: {nested: a}', `\
%YAML 1.1
---
prompt: a`,
    `\
prompt: a
__proto__: {polluted: true}`, `\
prompt: a
<<: {negativePrompt: b}`,
  ])('rejects malformed/ambiguous input without silently discarding fields: %s', async text => {
    await expect(parseImageGenerationInput({ text })).rejects.toThrow();
  });

  it('has bounded input and operation sizes', async () => {
    await expect(parseImageGenerationInput({ text: 'x'.repeat(IMAGE_COMPOSITION_MAX_TEXT_BYTES + 1) })).rejects.toThrow('MiB');
    await expect(parseImageGenerationInput({ text: Array.from({ length: 129 }, () => '{"prompt":"a"}').join('\n') })).rejects.toThrow('128');
    expect(() => validateImageGenerationInputs({ inputs: Array.from({ length: 9 }, () => ({ prompt: 'a', count: 64 })), defaultCount: 1 })).toThrow('512');
    expect(validateImageGenerationInputs({ inputs: [{ prompt: 'a' }, { prompt: 'b', count: 4 }], defaultCount: 2 }).totalImages).toBe(6);
  });
});
