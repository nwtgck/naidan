export const contextCompact__preparing_messages_and_keeping_recent_messages = ({ compactedMessageCount, suffixMessageCount }: { compactedMessageCount: number; suffixMessageCount: number }): string => (
  `Preparando ${compactedMessageCount} ${compactedMessageCount === 1 ? 'mensagem' : 'mensagens'} e mantendo ${suffixMessageCount} ${suffixMessageCount === 1 ? 'recente' : 'recentes'}.`
);
