export const FeatureFlagsSettings__use_fake_lm_endpoint = ({ endpointUrl }: { endpointUrl: string }): string => (
  `OpenAI 호환 또는 Ollama 엔드포인트로 다음 URL을 사용합니다: ${endpointUrl}`
);
