import { z } from 'zod';

export const workflowChoicesSchema = z.array(
  z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/[\r\n\u0085\u2028\u2029]/.test(value), 'Choices require nonblank single-line text.'),
).min(2).max(10).refine(values => new Set(values.map(value => value.trim())).size === values.length, 'Choices must be distinct.');

export const TEST_ONLY = {
};
