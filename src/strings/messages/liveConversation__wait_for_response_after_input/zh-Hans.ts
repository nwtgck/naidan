export const liveConversation__wait_for_response_after_input = ({ seconds }: { seconds: number }): string => `输入结束后发送 ${seconds} 秒静音以等待回复。同一段输入音频会保留，便于再次运行。`;
