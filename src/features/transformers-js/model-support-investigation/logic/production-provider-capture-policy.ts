import { z } from 'zod';
import { capturePlanSchema, captureScenarioSchema, captureScenarios, type ProductionProviderCapturePlan, type CaptureScenario } from './production-provider-capture-plan';
import { PRODUCTION_PROVIDER_TRACE_LIMITS } from './production-provider-trace';
import { PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS } from './production-provider-capture-evidence';

// Fixed script reservation, not a generic bound for arbitrary conversations.
// Encoder tests cover fixed inputs, identities, undefined markers and failures.
const scaffoldCharacters = 65536;
// Includes two-space indentation at the deepest settled-event occurrence.
const eventMetadataCharacters = 512;
const traceLimits = Object.freeze({ maximumEvents: 1024, maximumCharacters: 65536 });
const reservationSchema = z.object({
  unit: z.literal('json-characters'), scenarioCount: z.number().int().min(1).max(13),
  maximumCharacters: z.literal(PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS),
  upperBoundCharacters: z.number().int().positive().max(PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS),
}).strict().readonly();
export const productionProviderCapturePolicySchema = z.object({
  format: z.literal('production-provider-capture-policy-v1'), plan: capturePlanSchema,
  // Exactly the two keys accepted by the trace recorder's strict input schema.
  traceLimits: z.object({ maximumEvents: z.literal(1024), maximumCharacters: z.literal(65536) }).strict().readonly(),
  maximumFieldCharacters: z.literal(16384), reservation: reservationSchema,
}).strict().readonly();
export type ProductionProviderCapturePolicy = z.infer<typeof productionProviderCapturePolicySchema>;

function preflightReservation({ scenarios, traceLimits }: {
  scenarios: readonly CaptureScenario[];
  traceLimits: { readonly maximumEvents: number; readonly maximumCharacters: number };
}) {
  const rows = z.array(captureScenarioSchema).min(1).max(13).safeParse(scenarios);
  if (!rows.success || new Set(rows.data).size !== rows.data.length) {
    throw new Error('Provider capture policy exceeds the fixed script contract');
  }
  const limits = z.object({
    maximumEvents: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents),
    maximumCharacters: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters),
  }).strict().parse(traceLimits);
  // Each UTF-16 unit needs at most six JSON characters. Settled events occur
  // twice; late events occur only once and are covered by the same reservation.
  // Continuity includes one further copy of the first settled chunk text.
  const continuityCharacters = rows.data.includes('continuity') ? 6 * limits.maximumCharacters : 0;
  const upperBoundCharacters = scaffoldCharacters
    + rows.data.length * (12 * limits.maximumCharacters + 2 * eventMetadataCharacters * limits.maximumEvents)
    + continuityCharacters;
  if (upperBoundCharacters > PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS) {
    throw new Error('Provider capture policy exceeds the JSON reservation');
  }
  return reservationSchema.parse({
    unit: 'json-characters', scenarioCount: rows.data.length,
    maximumCharacters: PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS, upperBoundCharacters,
  });
}

/**
 * Synchronous admission before starting the fixed script. This reserves one
 * Provider JSON document, not native bytes, batch capacity, or process memory.
 * Limits bound retained callbacks; they neither stop generation nor certify a
 * complete tool loop. Global ceilings and generation token budgets are unchanged.
 */
export function createProductionProviderCapturePolicy({ plan: inputPlan }: { plan: ProductionProviderCapturePlan }): ProductionProviderCapturePolicy {
  const plan = capturePlanSchema.parse(inputPlan);
  const reservation = preflightReservation({ scenarios: captureScenarios({ plan }), traceLimits });
  return productionProviderCapturePolicySchema.parse({
    format: 'production-provider-capture-policy-v1', plan, traceLimits,
    maximumFieldCharacters: PRODUCTION_PROVIDER_TRACE_LIMITS.maximumFieldCharacters, reservation,
  });
}

export const TEST_ONLY = {
  preflightReservation,
  scaffoldCharacters,
  eventMetadataCharacters,
};
