export const FeatureFlagsSettings__use_fake_lm_endpoint = ({ endpointUrl }: { endpointUrl: string }): string => (
  `Usa ${endpointUrl} como endpoint compatible con OpenAI u Ollama.`
);
