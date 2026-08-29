export const contextCompact__compacting_will_condense_messages_into_a_single_summary = ({ count }: { count: number }): string => (
  `${count === 1 ? 'A compactação condensará a primeira mensagem' : `A compactação condensará as primeiras ${count} mensagens`} em um único resumo. Isso reduz o uso de tokens preservando o contexto principal.`
);
