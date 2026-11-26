// Public, versioned English fixtures. Preserve the existing 12-week workload.
export const shortPrompt = 'Explain in English how a language model can generate text locally inside a web browser. Describe the mechanism, practical benefits, and limitations in that order. Use paragraphs rather than bullet points, and include a concrete example.';

export function libraryPrompt({ weeks }: { weeks: number }): string {
  return `The following records describe a fictional public library. Summarize the changes in usage and propose practical improvements in English, using only the information provided. Do not invent additional facts.\n\n${Array.from({ length: weeks }, (_, index) => `Week ${index + 1}: Reading seats were busy on weekday afternoons, while many seats remained empty in the mornings. More families visited during the weekend. Returned books were mainly sorted before closing time, and a dedicated shelf was introduced for reserved books. After the quiet reading room was separated from the collaborative workspace, visitors asked for clearer signs explaining where conversation was allowed. Consultations about electronic resources required an appointment. Staff summarized the topics of these consultations without recording information that could identify individual visitors.`).join('\n')}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
