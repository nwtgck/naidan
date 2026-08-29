export const contextCompact__compacting_will_condense_messages_into_a_single_summary = ({ count }: { count: number }): string => (
  `${count === 1 ? 'La compactación condensará el primer mensaje' : `La compactación condensará los primeros ${count} mensajes`} en un único resumen. Esto reduce el uso de tokens y conserva el contexto principal.`
);
