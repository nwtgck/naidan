import { z } from 'zod';

const jsonValueSchema = z.json();

export function parseJsonValue({ value }: { value: unknown }) {
  return jsonValueSchema.parse(value);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
