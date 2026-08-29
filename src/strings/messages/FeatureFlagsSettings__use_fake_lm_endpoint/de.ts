export const FeatureFlagsSettings__use_fake_lm_endpoint = ({ endpointUrl }: { endpointUrl: string }): string => (
  `${endpointUrl} als OpenAI-kompatiblen oder Ollama-Endpunkt verwenden.`
);
