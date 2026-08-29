import ts from "typescript";

const DEFAULT_ANALYSIS_BUDGET = 5_000;

function getTypeName(type, checker) {
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(filename);
}

function hasProxyMarker(type) {
  const candidates = type.isIntersection() ? type.types : [type];
  return candidates.some(candidate => {
    const symbol = candidate.aliasSymbol ?? candidate.getSymbol();
    return symbol?.getName() === "ProxyMarked"
      || candidate.getProperties().some(property => property.escapedName.toString().includes("proxyMarker"));
  });
}

function hasTransferMarker(type) {
  const candidates = type.isIntersection() ? type.types : [type];
  return candidates.some(candidate =>
    candidate.getProperties().some(property => property.escapedName.toString().includes("workerTransferMarker"))
  );
}

function getCapabilityMarker(type, checker) {
  const candidates = type.isIntersection() ? type.types : [type];
  for (const candidate of candidates) {
    const property = candidate.getProperties().find(item =>
      item.escapedName.toString().includes("workerCapabilityMarker")
    );
    if (!property) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) return undefined;
    const markerType = checker.getTypeOfSymbolAtLocation(property, declaration);
    return getTypeName(markerType, checker).replace(/^"|"$/g, "");
  }
  return undefined;
}

function hasCapabilityMarker(type, checker) {
  return getCapabilityMarker(type, checker) !== undefined;
}

function declarationPath(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  return declaration?.getSourceFile().fileName.replace(/\\/g, "/");
}

function isKnownAtomic(type, checker) {
  const name = getTypeName(type, checker);
  return /^(Date|RegExp|Blob|File|ArrayBuffer|DataView|Error|Uint8Array|Uint8ClampedArray|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array)$/.test(name);
}

function firstReturnViolation({ type, checker, path, depth = 24, seen = new Set(), analysis = { remaining: DEFAULT_ANALYSIS_BUDGET } }) {
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    const resultType = getPromiseResult(member, checker);
    const violation = firstViolation({
      type: resultType,
      checker,
      path,
      depth,
      seen,
      analysis,
    });
    if (violation) return violation;
  }
  return undefined;
}

function proxyTargetViolation({ type, checker, path, depth, seen, analysis }) {
  const targets = type.isIntersection() ? type.types.filter(member => !hasProxyMarker(member)) : [type];
  for (const target of targets) {
    const signatures = target.getCallSignatures();
    if (signatures.length > 0) {
      for (const signature of signatures) {
        const parameters = signature.getParameters();
        for (let index = 0; index < parameters.length; index += 1) {
          const parameter = parameters[index];
          const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
          if (!declaration) continue;
          const parameterType = ts.isParameter(declaration) && declaration.type
            ? checker.getTypeFromTypeNode(declaration.type)
            : checker.getTypeOfSymbolAtLocation(parameter, declaration);
          const violation = firstViolation({
            type: parameterType, checker, path: `${path}.proxy.arg${index}`, depth: depth - 1, seen, analysis, allowProxy: true, allowTransfer: true, allowCapability: true,
          });
          if (violation) return violation;
        }
        const violation = firstReturnViolation({
          type: signature.getReturnType(),
          checker,
          path: `${path}.proxy.return`,
          depth: depth - 1,
          seen,
          analysis,
        });
        if (violation) return violation;
      }
      continue;
    }

    for (const property of checker.getPropertiesOfType(target)) {
      if (property.escapedName.toString().includes("proxyMarker")) continue;
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const propertySignatures = propertyType.getCallSignatures();
      if (propertySignatures.length === 0) {
        const violation = firstViolation({ type: propertyType, checker, path: `${path}.proxy.${property.getName()}.return`, depth: depth - 1, seen, analysis });
        if (violation) return violation;
        continue;
      }
      for (const signature of propertySignatures) {
        const parameters = signature.getParameters();
        for (let index = 0; index < parameters.length; index += 1) {
          const parameter = parameters[index];
          const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
          const parameterType = ts.isParameter(parameterDeclaration) && parameterDeclaration.type
            ? checker.getTypeFromTypeNode(parameterDeclaration.type)
            : checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration);
          const violation = firstViolation({
            type: parameterType, checker, path: `${path}.proxy.${property.getName()}.arg${index}`, depth: depth - 1, seen, analysis, allowProxy: true, allowTransfer: true, allowCapability: true,
          });
          if (violation) return violation;
        }
        const violation = firstReturnViolation({
          type: signature.getReturnType(),
          checker,
          path: `${path}.proxy.${property.getName()}.return`,
          depth: depth - 1,
          seen,
          analysis,
        });
        if (violation) return violation;
      }
    }
  }
  return undefined;
}

function firstViolation({ type, checker, path, depth = 24, seen = new Set(), analysis = { remaining: DEFAULT_ANALYSIS_BUDGET }, allowProxy = false, allowTransfer = false, allowCapability = false, transferScope = false, capabilityScope = new Set() }) {
  if (analysis.remaining <= 0) return { path, reason: "analysis-budget-exceeded" };
  analysis.remaining -= 1;
  if (depth <= 0) return { path, reason: "analysis-depth-exceeded" };
  if (type.flags & ts.TypeFlags.Any) return { path, reason: "any" };
  if (type.flags & ts.TypeFlags.Unknown) return { path, reason: "unknown" };
  if (type.flags & ts.TypeFlags.TypeParameter) return { path, reason: `type-parameter-unreviewed:${getTypeName(type, checker)}` };
  if (type.flags & ts.TypeFlags.Never) return undefined;
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return undefined;
  if (type.flags & ts.TypeFlags.ESSymbolLike) return { path, reason: "symbol" };

  if (hasProxyMarker(type)) {
    if (!allowProxy) return { path, reason: "proxy-must-be-top-level" };
    return proxyTargetViolation({ type, checker, path, depth, seen, analysis });
  }

  if (hasTransferMarker(type)) {
    if (!allowTransfer) return { path, reason: "transfer-must-be-top-level" };
    if (type.isIntersection()) {
      for (const member of type.types) {
        if (hasTransferMarker(member)) continue;
        const violation = firstViolation({
          type: member,
          checker,
          path,
          depth: depth - 1,
          seen,
          analysis,
          transferScope: true,
          capabilityScope,
        });
        if (violation) return violation;
      }
      return undefined;
    }
    transferScope = true;
  }

  const capabilityMarker = getCapabilityMarker(type, checker);
  if (capabilityMarker !== undefined) {
    if (!allowCapability) return { path, reason: "capability-marker-must-be-top-level" };
    if (capabilityMarker !== "file-system-handle-clone") {
      return { path, reason: `unknown-capability:${capabilityMarker}` };
    }
    if (type.isIntersection()) {
      const nextCapabilityScope = new Set(capabilityScope);
      nextCapabilityScope.add(capabilityMarker);
      for (const member of type.types) {
        if (hasCapabilityMarker(member, checker)) continue;
        const violation = firstViolation({
          type: member,
          checker,
          path,
          depth: depth - 1,
          seen,
          analysis,
          transferScope,
          capabilityScope: nextCapabilityScope,
        });
        if (violation) return violation;
      }
      return undefined;
    }
  }

  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      const violation = firstViolation({ type: member, checker, path, depth: depth - 1, seen, analysis, allowProxy, allowTransfer, allowCapability, transferScope, capabilityScope });
      if (violation) return violation;
    }
    return undefined;
  }

  const calls = type.getCallSignatures();
  if (calls.length > 0) {
    return { path, reason: "function-must-be-proxied" };
  }

  if (isKnownAtomic(type, checker)) return undefined;

  const name = getTypeName(type, checker);
  if (name === "MessagePort") {
    return transferScope ? undefined : { path, reason: "transfer-required:MessagePort" };
  }
  if (name === "FileSystemDirectoryHandle" || name === "FileSystemFileHandle" || name === "FileSystemHandle") {
    return capabilityScope.has("file-system-handle-clone")
      ? undefined
      : { path, reason: `capability-sensitive:${name}` };
  }

  if (seen.has(type)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(type);

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type);
    for (const arg of args) {
      const violation = firstViolation({ type: arg, checker, path: `${path}[]`, depth: depth - 1, seen: nextSeen, analysis, transferScope, capabilityScope });
      if (violation) return violation;
    }
    return undefined;
  }

  const collectionName = type.getSymbol()?.getName();
  if (collectionName === "Map" || collectionName === "Set") {
    const args = checker.getTypeArguments(type);
    for (let index = 0; index < args.length; index += 1) {
      const segment = collectionName === "Map" ? (index === 0 ? "<key>" : "<value>") : "<value>";
      const violation = firstViolation({ type: args[index], checker, path: `${path}.${segment}`, depth: depth - 1, seen: nextSeen, analysis, transferScope, capabilityScope });
      if (violation) return violation;
    }
    return undefined;
  }

  const stringIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (stringIndexType) {
    const violation = firstViolation({ type: stringIndexType, checker, path: `${path}[string]`, depth: depth - 1, seen: nextSeen, analysis, transferScope, capabilityScope });
    if (violation) return violation;
  }
  const numberIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (numberIndexType) {
    const violation = firstViolation({ type: numberIndexType, checker, path: `${path}[number]`, depth: depth - 1, seen: nextSeen, analysis, transferScope, capabilityScope });
    if (violation) return violation;
  }
  if ((stringIndexType || numberIndexType) && checker.getPropertiesOfType(type).length === 0) {
    return undefined;
  }

  const source = declarationPath(type);
  const aliasName = type.aliasSymbol?.getName();
  const symbolName = type.getSymbol()?.getName();
  const structuralUtilityAliases = new Set(["Omit", "Pick", "Partial", "Required", "Readonly", "Record"]);
  const isStructuralUtilityAlias = aliasName !== undefined && structuralUtilityAliases.has(aliasName);
  const isAnonymousStructuralType = !aliasName && (!symbolName || symbolName.startsWith("__"));
  if (!isStructuralUtilityAlias && !isAnonymousStructuralType && (source?.includes("/node_modules/") || source?.includes("/typescript/lib/"))) {
    return { path, reason: `external-unreviewed:${name}` };
  }

  const properties = checker.getPropertiesOfType(type);
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const violation = firstViolation({
      type: propertyType,
      checker,
      path: `${path}.${property.getName()}`,
      depth: depth - 1,
      seen: nextSeen,
      analysis,
      transferScope,
      capabilityScope,
    });
    if (violation) return violation;
  }
  return undefined;
}

function getPromiseResult(type, checker) {
  const promised = checker.getPromisedTypeOfPromise(type);
  return promised ?? type;
}

function resolvedCallDeclarationName({ tsCall, checker }) {
  const declaration = checker.getResolvedSignature(tsCall)?.declaration;
  if (!declaration || !("name" in declaration) || declaration.name === undefined) return undefined;
  if (ts.isIdentifier(declaration.name) || ts.isStringLiteral(declaration.name)) {
    return declaration.name.text;
  }
  return undefined;
}

export const rule = {
  meta: {
    type: "problem",
    schema: [{
      type: "object",
      properties: {
        genericBridgeFileSuffixes: { type: "array", items: { type: "string" }, uniqueItems: true },
        legacyUncheckedFileSuffixes: { type: "array", items: { type: "string" }, uniqueItems: true },
        analysisBudget: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    }],
    messages: {
      invalidApi: "Worker API is not wire-safe at {{ path }}: {{ reason }}.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
    const checker = services.program.getTypeChecker();
    const options = context.options[0] ?? {};
    const analysisBudget = options.analysisBudget ?? DEFAULT_ANALYSIS_BUDGET;
    const normalizedFilename = context.filename.replace(/\\/g, "/");
    if (isTestFile(normalizedFilename)) return {};
    const isAllowedGenericBridge = (options.genericBridgeFileSuffixes ?? [])
      .some(suffix => normalizedFilename.endsWith(suffix));
    const isLegacyUncheckedFile = (options.legacyUncheckedFileSuffixes ?? [])
      .some(suffix => normalizedFilename.endsWith(suffix));
    if (isLegacyUncheckedFile) return {};
    return {
      CallExpression(node) {
        const tsCall = services.esTreeNodeToTSNodeMap.get(node);
        if (!ts.isCallExpression(tsCall)) return;
        const resolvedCalleeName = resolvedCallDeclarationName({ tsCall, checker });
        const isProjectWrap = resolvedCalleeName === "wrapWorkerRemote"
          || (node.callee.type === "Identifier" && node.callee.name === "wrapWorkerRemote");
        const isProjectExpose = resolvedCalleeName === "exposeWorkerRemote"
          || (node.callee.type === "Identifier" && node.callee.name === "exposeWorkerRemote");
        const isComlinkMember = node.callee.type === "MemberExpression"
          && !node.callee.computed
          && node.callee.object.type === "Identifier"
          && node.callee.object.name === "Comlink"
          && node.callee.property.type === "Identifier";
        const isComlinkWrap = isComlinkMember && node.callee.property.name === "wrap";
        const isComlinkExpose = isComlinkMember && node.callee.property.name === "expose";
        if (!isProjectWrap && !isProjectExpose && !isComlinkWrap && !isComlinkExpose) return;

        let apiType;
        if (isProjectWrap || isComlinkWrap) {
          if (!tsCall.typeArguments?.[0]) return;
          apiType = checker.getTypeFromTypeNode(tsCall.typeArguments[0]);
        } else if (tsCall.typeArguments?.[0]) {
          apiType = checker.getTypeFromTypeNode(tsCall.typeArguments[0]);
        } else if (tsCall.arguments[0]) {
          apiType = checker.getTypeAtLocation(tsCall.arguments[0]);
        } else {
          return;
        }

        if (apiType.flags & ts.TypeFlags.TypeParameter) {
          if (isAllowedGenericBridge) return;
          context.report({ node, messageId: "invalidApi", data: { path: "<api>", reason: "generic-transport-bridge-not-allowed" } });
          return;
        }

        if (isProjectExpose || isComlinkExpose) {
          const apiSymbol = apiType.aliasSymbol ?? apiType.getSymbol();
          const apiName = apiSymbol?.getName();
          if (!apiName || apiName.startsWith("__")) {
            context.report({ node, messageId: "invalidApi", data: { path: "<api>", reason: "named-worker-api-contract-required" } });
            return;
          }
        }

        let reportCount = 0;
        const reportViolation = (violation) => {
          if (reportCount >= 20) return;
          context.report({ node, messageId: "invalidApi", data: violation });
          reportCount += 1;
        };
        for (const method of checker.getPropertiesOfType(apiType)) {
          const declaration = method.valueDeclaration ?? method.declarations?.[0];
          if (!declaration) continue;
          const methodType = checker.getTypeOfSymbolAtLocation(method, declaration);
          const signatures = methodType.getCallSignatures();
          if (signatures.length === 0) {
            reportViolation({ path: method.getName(), reason: "non-callable-member" });
            continue;
          }
          const reported = new Set();
          for (const signature of signatures) {
            const parameters = signature.getParameters();
            for (let index = 0; index < parameters.length; index += 1) {
              const parameter = parameters[index];
              const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
              const parameterType = ts.isParameter(parameterDeclaration) && parameterDeclaration.type
                ? checker.getTypeFromTypeNode(parameterDeclaration.type)
                : checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration);
              const violation = firstViolation({ type: parameterType, checker, path: `${method.getName()}.arg${index}`, analysis: { remaining: analysisBudget }, allowProxy: true, allowTransfer: true, allowCapability: true });
              if (violation) {
                const key = `${violation.path}:${violation.reason}`;
                if (!reported.has(key)) { reported.add(key); reportViolation(violation); }
              }
            }
            const violation = firstReturnViolation({
              type: signature.getReturnType(),
              checker,
              path: `${method.getName()}.return`,
              analysis: { remaining: analysisBudget },
            });
            if (violation) {
              const key = `${violation.path}:${violation.reason}`;
              if (!reported.has(key)) { reported.add(key); reportViolation(violation); }
            }
          }
        }
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
  plugins: {
    'local-rules-worker-api': {
      rules: {
        'validate-worker-api': rule,
      },
    },
  },
  rules: {
    'local-rules-worker-api/validate-worker-api': ['error', {
      genericBridgeFileSuffixes: [
        '/src/utils/worker-transport.ts',
        '/src/features/file-protocol-standalone/worker/standalone-worker-session.ts',
        '/src/features/file-protocol-standalone/debug/verification/worker-probe.ts',
      ],
      legacyUncheckedFileSuffixes: [],
    }],
  },
};
