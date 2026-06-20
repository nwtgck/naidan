import { describe, expect, it } from 'vitest';
import { SCOPED_SETTING_FIELDS } from './scoped-setting-change';

describe('scoped setting fields', () => {
  it('contains_each_field_exactly_once', () => {
    expect(SCOPED_SETTING_FIELDS).toEqual([
      'endpoint',
      'model_id',
      'auto_title_enabled',
      'title_model_id',
      'system_prompt',
      'lm_param_temperature',
      'lm_param_top_p',
      'lm_param_max_completion_tokens',
      'lm_param_presence_penalty',
      'lm_param_frequency_penalty',
      'lm_param_stop',
      'lm_param_reasoning_effort',
    ]);
    expect(new Set(SCOPED_SETTING_FIELDS).size).toBe(SCOPED_SETTING_FIELDS.length);
  });
});
