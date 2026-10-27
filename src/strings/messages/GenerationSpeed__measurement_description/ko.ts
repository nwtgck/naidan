export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Ollama가 보고한 출력 수와 생성 시간으로 계산합니다. 도구 실행과 입력 처리 시간은 제외합니다.",
  llama_cpp_predicted: "llama.cpp server의 생성 시간 측정값입니다. 도구 실행과 입력 처리 시간은 제외합니다.",
  worker_sample_interval: "Worker의 토큰 샘플 간격으로 계산하며 첫 토큰과 생성 종료 토큰은 제외합니다. 실행 환경과 전달 지연을 포함하므로 네이티브 연산만의 속도는 아닙니다.",
  client_request: "보고된 토큰 사용량과 요청 시간으로 계산한 대략적인 실효 속도입니다. 대기, 입력 처리, 네트워크, 클라이언트 처리를 포함하며 디코딩 속도가 아닙니다.",
  received_text: "수신 텍스트의 Unicode 코드 포인트 수에 따른 근삿값입니다. 가능한 경우 추론과 도구 인수도 포함합니다. 네트워크와 클라이언트 지연을 포함하며 토큰 생성 속도가 아닙니다.",
}[measurement]);
