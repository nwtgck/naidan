export const FeatureFlagsSettings__use_fake_lm_endpoint = ({ endpointUrl }: { endpointUrl: string }): string => (
  `将 ${endpointUrl} 用作 OpenAI 兼容或 Ollama 端点。`
);
