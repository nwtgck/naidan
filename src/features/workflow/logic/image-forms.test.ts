import { beforeEach, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { workflowImageParameterChoices, workflowImageParameterLabel } from './image-forms';
import { workflowImageParametersSchema } from './image-input';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('offers explicit BF16 storage as a workflow literal without claiming support from the authoring environment', () => {
  expect(workflowImageParameterLabel({ key: 'bf16WeightType' })).toBe('BF16 weight storage');
  expect(workflowImageParameterChoices({ key: 'bf16WeightType' })).toEqual(['bf16', 'f32', 'f16']);
  for (const value of workflowImageParameterChoices({ key: 'bf16WeightType' })) {
    expect(workflowImageParametersSchema.shape.bf16WeightType.parse(value)).toBe(value);
  }
  expect(workflowImageParametersSchema.shape.bf16WeightType.parse(undefined)).toBe('f32');
});
