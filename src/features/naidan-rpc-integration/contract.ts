import { z } from 'zod';
import { contract, describeMethods, methodDescriptorSchema, methodNames, procedure, rpc } from '@/features/naidan-rpc';
import type { NaidanRpcClient, NaidanRpcImplementation } from '@/features/naidan-rpc';

/** This file is the complete peer-facing surface, including documents carried
 * by byte streams. Native schemas must not silently expand this contract.
 * Object schemas strip unknown fields while validating required fields and
 * bounds. RPC checks raw resource references before projecting known fields. */
export const peerDocumentLimits = Object.freeze({ depth: 32, nodes: 65536 });

export const relativeModelPathSchema = z.string().min(1).max(4096).refine(path => {
  if (/[\\:%]/.test(path) || path.startsWith('/')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}, 'Use a relative path inside an existing model root');

export const chatModelReferenceSchema = z.string().min(1).max(512).refine(value => {
  if (!value.startsWith('hf.co/') || !value.includes(':')) {
    return relativeModelPathSchema.safeParse(value).success;
  }
  const at = value.indexOf(':');
  return value.slice(0, at).split('/').length === 3 && relativeModelPathSchema.safeParse(value.slice(0, at)).success &&
    !value.slice(at + 1).includes('/') && relativeModelPathSchema.safeParse(value.slice(at + 1)).success;
});

export const imageLocationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opfs'),
    path: relativeModelPathSchema,
  }),
  z.object({
    kind: z.literal('host'),
    directoryId: z.string().min(1).max(128),
    path: relativeModelPathSchema,
  }),
]);

const expectedFileSchema = z.object({
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const imageFileSchema = z.object({
  location: imageLocationSchema,
  expected: expectedFileSchema.optional(),
});

export const imageComponentSlotSchema = z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']);

export const imageModelSelectionSchema = z.object({
  primary: z.object({
    slot: z.enum(['model', 'diffusion']),
    file: imageFileSchema,
  }),
  components: z.array(z.object({
    slot: imageComponentSlotSchema,
    file: imageFileSchema,
  })).max(5),
  loras: z.array(z.object({
    file: imageFileSchema,
    strength: z.number().finite().min(-10).max(10),
  })).max(8),
}).superRefine((selection, context) => {
  if (new Set(selection.components.map(item => item.slot)).size !== selection.components.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate image component slot' });
  }
});

export type PeerImageModelSelection = z.infer<typeof imageModelSelectionSchema>;
export type PeerImageFile = z.infer<typeof imageFileSchema>;

export const peerImageParametersSchema = z.object({
  prompt: z.string().min(1).max(4096),
  negativePrompt: z.string().max(4096),
  width: z.number().int().min(128).max(2048).multipleOf(64),
  height: z.number().int().min(128).max(2048).multipleOf(64),
  steps: z.number().int().min(1).max(100),
  guidance: z.number().finite().min(0).max(30),
  seed: z.string().regex(/^(0|[1-9][0-9]*)$/).max(19).refine(value => /^[0-9]{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n),
  sampler: z.string().min(1).max(64),
  scheduler: z.string().min(1).max(64),
  distilledGuidance: z.number().finite().min(0).max(30),
});

export const peerImagePreviewSchema = z.object({
  enabled: z.boolean(),
  interval: z.number().int().min(1).max(100),
  startStep: z.number().int().min(1).max(100),
  mode: z.enum(['projection', 'vae']),
  maxEdge: z.number().int().min(0).max(1024),
});

export const imageCatalogItemSchema = z.object({
  label: z.string().min(1).max(1024),
  file: imageFileSchema,
  roles: z.array(z.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm', 'lora'])).min(1).max(8),
  selection: imageModelSelectionSchema.optional(),
  facts: z.object({
    family: z.string().min(1).max(64),
    classes: z.array(z.string().min(1).max(64)).max(16),
  }).optional(),
});

export type PeerImageCatalogItem = z.infer<typeof imageCatalogItemSchema>;

export const peerProgressSchema = z.object({
  phase: z.enum(['waiting', 'loading', 'computing', 'decoding', 'encoding']),
  completed: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative(),
});

const uploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  byteLength: z.number().int().min(1).max(16 * 1024 * 1024),
  data: rpc.byteStream(),
});

export type PeerImageUpload = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteLength: number;
  data: ReadableStream<Uint8Array>;
};

export const peerToolCallSchema = z.object({
  id: z.string().max(1024),
  type: z.literal('function'),
  function: z.object({
    name: z.string().max(1024),
    arguments: z.string().max(4 * 1024 * 1024),
  }),
});

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('text'),
        text: z.string(),
      }),
      z.object({
        type: z.literal('image'),
        attachment: z.number().int().min(0).max(7),
      }),
    ])).max(256),
  ]),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(peerToolCallSchema).max(64).optional(),
  tool_call_id: z.string().max(1024).optional(),
  name: z.string().max(1024).optional(),
});

/** Bounded UTF-8 document over generateChat.transcript, not OPEN metadata. */
export const peerChatTranscriptSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(2048),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1).max(1024),
      description: z.string().max(65536),
      parameters: z.record(z.string(), z.json()),
    }),
  })).max(64).optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  temperature: z.number().finite().min(0).max(10),
  topP: z.number().finite().min(0).max(1),
  maxTokens: z.number().int().min(1).max(32768),
  presencePenalty: z.number().finite().min(-2).max(2),
  frequencyPenalty: z.number().finite().min(-2).max(2),
  stop: z.array(z.string().min(1).max(512)).max(32),
});

export const peerChatEventSchema = z.discriminatedUnion('type', [
  // A narrow, typed rejection, not an arbitrary provider error message. Only
  // title generation may apply its existing pre-output compatibility policy.
  z.object({
    type: z.literal('rejected'),
    reason: z.literal('reasoning-unsupported'),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call_start'),
    index: z.number().int().min(0).max(63),
  }),
  z.object({
    type: z.literal('tool_call_draft'),
    index: z.number().int().min(0).max(63),
    name: z.string().max(1024).optional(),
    arguments: z.object({
      offset: z.number().int().min(0).max(4 * 1024 * 1024),
      text: z.string(),
    }).optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    index: z.number().int().min(0).max(63),
    toolCall: peerToolCallSchema,
  }),
  z.object({
    type: z.literal('finish'),
    reason: z.enum(['stop', 'length', 'stop_sequence']),
  }),
]);

/** Image previews use bounded chunks; a completed preview is never interleaved
 * with a replacement. A terminal event confirms the actual generation. */
export const PEER_IMAGE_PREVIEW_CHUNK_BYTES = 8 * 1024;

export const peerImageEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('preview-start'),
    revision: z.number().int().positive(),
    step: z.number().int().nonnegative(),
    steps: z.number().int().positive(),
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(1024),
    mode: z.enum(['projection', 'vae']),
    byteLength: z.number().int().positive().max(4 * 1024 * 1024),
  }),
  z.object({
    type: z.literal('preview-chunk'),
    data: z.string().max(Math.ceil(PEER_IMAGE_PREVIEW_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.object({
    type: z.literal('preview-end'),
  }),
  z.object({
    type: z.literal('completed'),
    seed: z.string().min(1).max(19),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    modelVersion: z.string().max(1024),
    uniformOutput: z.boolean(),
  }),
]);

export type PeerImageEvent = z.infer<typeof peerImageEventSchema>;

/** Inference methods controlled by each connection's grants. Status discovery
 * is added separately and is never part of the stored inference allow-list. */
const controlledMethods = {
  listChatModels: procedure({
    input: z.object({}),
    result: rpc.stream({
      item: z.object({
        ref: chatModelReferenceSchema,
        label: z.string().min(1).max(1024),
      }),
    }),
    notifications: {},
  }),

  generateChat: procedure({
    input: z.object({
      model: chatModelReferenceSchema,
      // Encodes peerChatTranscriptSchema above, not an opaque native request.
      transcript: rpc.byteStream(),
      images: z.array(uploadSchema).max(8),
    }),
    // Encodes the peerChatEventSchema defined in this file.
    result: z.object({
      events: rpc.byteStream(),
    }),
    notifications: { progress: peerProgressSchema },
  }),

  listImageModels: procedure({
    input: z.object({}),
    result: rpc.stream({ item: imageCatalogItemSchema }),
    notifications: {},
  }),

  generateImage: procedure({
    input: z.object({
      modelSelection: imageModelSelectionSchema,
      parameters: peerImageParametersSchema,
      preview: peerImagePreviewSchema,
      imageInputs: z.object({
        initial: uploadSchema.optional(),
        references: z.array(uploadSchema).max(8),
        strength: z.number().finite().min(0).max(1),
      }),
    }),
    // Both streams belong to one image job; events carry its confirmation.
    result: z.object({
      image: rpc.byteStream(),
      events: rpc.stream({ item: peerImageEventSchema }),
    }),
    notifications: { progress: peerProgressSchema },
  }),
};

export type NaidanPeerControlledMethodName = Extract<keyof typeof controlledMethods, string>;

const controlledMethodNameSchema = z.enum([...methodNames({ contract: { name: 'naidan.peer', methods: controlledMethods } })]);
export const peerAllowedMethodsSchema = z.array(controlledMethodNameSchema).max(64).refine(names => new Set(names).size === names.length);

export const peerProvidedMethodsSchema = z.object({
  status: z.enum(['ready', 'checking']),
  methods: z.array(methodDescriptorSchema).max(64).refine(methods => new Set(methods.map(method => method.name)).size === methods.length),
}).refine(value => value.status !== 'checking' || value.methods.length === 0);

export type PeerProvidedMethods = z.infer<typeof peerProvidedMethodsSchema>;

export const naidanPeerContract = contract({
  name: 'naidan.peer',
  methods: {
    getProvidedMethods: procedure({
      input: z.object({}),
      result: peerProvidedMethodsSchema,
      notifications: {},
    }),
    ...controlledMethods,
  },
});

export type NaidanPeerMethodName = Extract<keyof typeof naidanPeerContract.methods, string>;
export type NaidanPeerClient = NaidanRpcClient<typeof naidanPeerContract>;
export type NaidanPeerImplementation = NaidanRpcImplementation<typeof naidanPeerContract>;

export function describePeerMethods({ names }: { names: readonly NaidanPeerControlledMethodName[] }) {
  return describeMethods({ contract: naidanPeerContract, names });
}

export const peerMethodNameSchema = z.custom<NaidanPeerMethodName>((value): value is NaidanPeerMethodName => typeof value === 'string' && Object.hasOwn(naidanPeerContract.methods, value));

export const TEST_ONLY = {
};
