function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isNaidanIdImplementationFile({ filePath }) {
  return normalizePath(filePath).endsWith('/src/01-models/ids.ts');
}

const NAIDAN_ID_TYPES = new Set([
  'ChatId',
  'MessageId',
  'ChatGroupId',
  'AttachmentId',
  'BinaryObjectId',
  'VolumeId',
  'ProviderProfileId',
  'ToolCallId',
  'GlobalEventId',
  'VolumeCopyOperationId',
  'EditableHistoryItemId',
  'RecipeImportCandidateId',
  'RecipeModelPatternEditorItemId',
  'PrivacyFetchRequestId',
  'ToolChoicesRequestId',
  'ToolApprovalRequestId',
  'OPFSTmpOwnerScopeId',
  'OPFSTmpDirectoryId',
  'NaidanId',
]);

function isNaidanIdType({ node, sourceCode }) {
  const text = sourceCode.getText(node.typeAnnotation);
  return [...NAIDAN_ID_TYPES].some(typeName => new RegExp(`\\b${typeName}\\b`, 'u').test(text));
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow casting to Naidan branded ID types outside the ID module.',
    },
    messages: {
      noNaidanIdCast: 'Do not cast directly to a Naidan ID type. Use generateId<SpecificId>() for new IDs or the appropriate toXId({ raw }) helper at a validated raw-string boundary.',
    },
    schema: [],
  },
  create(context) {
    if (isNaidanIdImplementationFile({ filePath: context.filename ?? context.getFilename?.() ?? '' })) {
      return {};
    }

    const sourceCode = context.sourceCode;
    return {
      TSAsExpression(node) {
        if (isNaidanIdType({ node, sourceCode })) {
          context.report({ node, messageId: 'noNaidanIdCast' });
        }
      },
      TSTypeAssertion(node) {
        if (isNaidanIdType({ node, sourceCode })) {
          context.report({ node, messageId: 'noNaidanIdCast' });
        }
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  plugins: {
    'local-rules-naidan-id-cast': {
      rules: {
        'no-naidan-id-cast': rule,
      },
    },
  },
  rules: {
    'local-rules-naidan-id-cast/no-naidan-id-cast': 'error',
  },
};
