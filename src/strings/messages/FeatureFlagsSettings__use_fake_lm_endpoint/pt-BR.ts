export const FeatureFlagsSettings__use_fake_lm_endpoint = ({ endpointUrl }: { endpointUrl: string }): string => (
  `Use ${endpointUrl} como endpoint compatível com OpenAI ou Ollama.`
);
