type TitleModelInheritance =
  | { readonly type: 'none' }
  | {
    readonly type: 'inherited',
    readonly state: 'enabled' | 'disabled',
    readonly source: 'chat' | 'chat_group' | 'global',
  };

export const ChatSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: TitleModelInheritance }): string => {
  const description = 'El modelo de título se usa una sola vez para resumir el primer mensaje del usuario.';

  switch (inheritance.type) {
  case 'none':
    return description;
  case 'inherited': {
    const state = (() => {
      switch (inheritance.state) {
      case 'enabled':
        return 'Activado';
      case 'disabled':
        return 'Desactivado';
      default: {
        const _ex: never = inheritance.state;
        throw new Error(`Unhandled title model state: ${_ex}`);
      }
      }
    })();

    switch (inheritance.source) {
    case 'chat':
      return `${description} Actualmente hereda “${state}” de la configuración del chat.`;
    case 'chat_group':
      return `${description} Actualmente hereda “${state}” de la configuración del grupo.`;
    case 'global':
      return `${description} Actualmente hereda “${state}” de la configuración global.`;
    default: {
      const _ex: never = inheritance.source;
      throw new Error(`Unhandled settings source: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${JSON.stringify(_ex)}`);
  }
  }
};
