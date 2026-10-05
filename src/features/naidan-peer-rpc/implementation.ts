import type { NaidanPeerImplementation } from './contract';
import { listChatModels, generateChat, listImageModels, generateImage } from './handlers/inference/handlers';
import type { InferenceDependencies } from './handlers/inference/handlers';

/** The single implementation index. Method access is enforced by naidan-rpc
 * before input streams are accepted; handlers enforce argument/resource bounds. */
export function createNaidanPeerImplementation({ inference }: { inference: InferenceDependencies }): NaidanPeerImplementation {
  return {
    listChatModels({ input, notify, signal, ...rest }) {
      rest satisfies Record<PropertyKey, never>;
      return listChatModels({ resources: inference.resources, input, notify, signal });
    },
    generateChat({ input, notify, signal, ...rest }) {
      rest satisfies Record<PropertyKey, never>;
      return generateChat({ ...inference, input, notify, signal });
    },
    listImageModels({ input, notify, signal, ...rest }) {
      rest satisfies Record<PropertyKey, never>;
      return listImageModels({ resources: inference.resources, input, notify, signal });
    },
    generateImage({ input, notify, signal, ...rest }) {
      rest satisfies Record<PropertyKey, never>;
      return generateImage({ ...inference, input, notify, signal });
    },
  };
}
export const TEST_ONLY = {
};
