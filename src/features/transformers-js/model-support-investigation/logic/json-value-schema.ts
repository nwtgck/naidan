import { z } from "zod";
import type { ModelSupportInvestigationJsonValue } from "@/features/transformers-js/model-support-investigation/types";

export type InvestigationJsonValue = ModelSupportInvestigationJsonValue;

export const investigationJsonValueSchema: z.ZodType<InvestigationJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(investigationJsonValueSchema),
  z.record(z.string(), investigationJsonValueSchema),
]));

export const investigationJsonObjectSchema = z.record(z.string(), investigationJsonValueSchema);

export function parseInvestigationJson({ value, label }: {
  value: unknown,
  label: string,
}): InvestigationJsonValue {
  const result = investigationJsonValueSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} is not a valid JSON value`, { cause: result.error });
  }
  return result.data;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
