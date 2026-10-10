import { performanceProtocol, planSchema, type PerformancePlan, type PerformanceStep } from './types';

// Public, versioned English fixtures. Changing these changes the workload, so
// retain both the protocol identity and exact input messages in every archive.
const shortPrompt = 'Explain in English how a language model can generate text locally inside a web browser. Describe the mechanism, practical benefits, and limitations in that order. Use paragraphs rather than bullet points, and include a concrete example.';
const longPrompt = `The following records describe a fictional public library. Summarize the changes in usage and propose practical improvements in English, using only the information provided. Do not invent additional facts.\n\n${Array.from({ length: 12 }, (_, index) => `Week ${index + 1}: Reading seats were busy on weekday afternoons, while many seats remained empty in the mornings. More families visited during the weekend. Returned books were mainly sorted before closing time, and a dedicated shelf was introduced for reserved books. After the quiet reading room was separated from the collaborative workspace, visitors asked for clearer signs explaining where conversation was allowed. Consultations about electronic resources required an appointment. Staff summarized the topics of these consultations without recording information that could identify individual visitors.`).join('\n')}`;
const followUp = 'Choose the most important limitation from your previous explanation and describe a concrete way to reduce its impact. Answer in English.';

export function createPerformancePlan({ id, createdAt, models, settings, options, notes }: Omit<PerformancePlan, 'version' | 'protocol' | 'steps'>): PerformancePlan {
  const steps: PerformanceStep[] = [];
  for (const [modelIndex] of models.entries()) {
    const add = ({ scenario, position, repetition, dependsOn, prompt, maxTokens }: Pick<PerformanceStep, 'scenario' | 'position' | 'repetition' | 'dependsOn' | 'prompt' | 'maxTokens'>): string => {
      const id = `m${modelIndex}-${steps.length}`;
      steps.push({
        id,
        modelIndex,
        scenario,
        position,
        role: 'measurement',
        repetition,
        dependsOn,
        prompt,
        maxTokens,
        sequence: dependsOn === undefined ? 'fresh' : 'continue',
      });
      return id;
    };
    // The initial call already warms the short-prompt and single-token graphs.
    // Do not repeat a full decode solely to label it a separate warm-up.
    add({ scenario: 'initial', position: 'initial', repetition: 0, dependsOn: undefined, prompt: shortPrompt, maxTokens: Math.min(8, settings.maxTokens) });
    for (let repetition = 1; repetition <= settings.repeats; repetition++) {
      const parent = add({ scenario: 'short', position: 'before', repetition, dependsOn: undefined, prompt: shortPrompt, maxTokens: settings.maxTokens });
      // Reuse a measurement's real response rather than generate another parent.
      add({ scenario: 'continuation', position: 'workload', repetition, dependsOn: parent, prompt: followUp, maxTokens: Math.min(16, settings.maxTokens) });
      // This probes input evaluation, not a second long decode throughput test.
      // Its first graph shape is explicitly not claimed to be warmed.
      add({ scenario: 'long', position: 'workload', repetition, dependsOn: undefined, prompt: longPrompt, maxTokens: Math.min(8, settings.maxTokens) });
      // Identical fresh input before/after: expose drift instead of blending it
      // into an apparently more precise median of exchangeable repetitions.
      add({ scenario: 'short', position: 'after', repetition, dependsOn: undefined, prompt: shortPrompt, maxTokens: settings.maxTokens });
    }
    switch (settings.diagnostics) {
    case 'placement':
      add({ scenario: 'placement', position: 'diagnostic', repetition: 0, dependsOn: undefined, prompt: longPrompt, maxTokens: 2 });
      break;
    case 'none': case undefined: break;
    default: { const exhaustive: never = settings.diagnostics; throw new Error(String(exhaustive)); }
    }
  }
  const plan = planSchema.parse({ version: 1, protocol: performanceProtocol, id, createdAt, models, settings, options, notes, steps });
  if (new Set(models.map(model => model.id)).size !== models.length || new Set(models.map(model => model.name)).size !== models.length) {
    throw new Error('Duplicate model identifiers or names');
  }
  return plan;
}

export const TEST_ONLY = {
};
