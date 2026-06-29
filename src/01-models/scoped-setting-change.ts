import type { Endpoint, Reasoning } from '@/01-models/types';

export type ScopedSettingChange =
  | Readonly<{
      field: 'endpoint',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'endpoint',
      behavior: 'override',
      value: Endpoint,
    }>
  | Readonly<{
      field: 'model_id',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'model_id',
      behavior: 'override',
      value: string,
    }>
  | Readonly<{
      field: 'auto_title_enabled',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'auto_title_enabled',
      behavior: 'override',
      value: boolean,
    }>
  | Readonly<{
      field: 'title_model_id',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'title_model_id',
      behavior: 'override',
      value: string,
    }>
  | Readonly<{
      field: 'system_prompt',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'system_prompt',
      behavior: 'clear',
    }>
  | Readonly<{
      field: 'system_prompt',
      behavior: 'replace',
      content: string,
    }>
  | Readonly<{
      field: 'system_prompt',
      behavior: 'append',
      content: string,
    }>
  | Readonly<{
      field: 'lm_param_temperature',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_temperature',
      behavior: 'override',
      value: number,
    }>
  | Readonly<{
      field: 'lm_param_top_p',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_top_p',
      behavior: 'override',
      value: number,
    }>
  | Readonly<{
      field: 'lm_param_max_completion_tokens',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_max_completion_tokens',
      behavior: 'override',
      value: number,
    }>
  | Readonly<{
      field: 'lm_param_presence_penalty',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_presence_penalty',
      behavior: 'override',
      value: number,
    }>
  | Readonly<{
      field: 'lm_param_frequency_penalty',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_frequency_penalty',
      behavior: 'override',
      value: number,
    }>
  | Readonly<{
      field: 'lm_param_stop',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_stop',
      behavior: 'override',
      value: readonly string[],
    }>
  | Readonly<{
      field: 'lm_param_reasoning_effort',
      behavior: 'inherit',
    }>
  | Readonly<{
      field: 'lm_param_reasoning_effort',
      behavior: 'override',
      value: Exclude<Reasoning['effort'], undefined>,
    }>;

export type LmParameterSettingChange = Extract<
  ScopedSettingChange,
  Readonly<{ field: `lm_param_${string}` }>
>;

export type LmParameterSettingField = LmParameterSettingChange['field'];

const scopedSettingFieldRecord: Readonly<Record<ScopedSettingChange['field'], true>> = {
  endpoint: true,
  model_id: true,
  auto_title_enabled: true,
  title_model_id: true,
  system_prompt: true,
  lm_param_temperature: true,
  lm_param_top_p: true,
  lm_param_max_completion_tokens: true,
  lm_param_presence_penalty: true,
  lm_param_frequency_penalty: true,
  lm_param_stop: true,
  lm_param_reasoning_effort: true,
};

// This record intentionally duplicates every discriminant. Record<> makes a new
// ScopedSettingChange field a compile-time error until all field-wide operations
// are reviewed. A plain hand-maintained array would not detect missing entries.
export const SCOPED_SETTING_FIELDS: readonly ScopedSettingChange['field'][] = Object.freeze(
  Object.keys(scopedSettingFieldRecord) as ScopedSettingChange['field'][],
);
