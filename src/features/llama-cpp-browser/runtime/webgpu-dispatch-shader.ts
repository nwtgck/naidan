/**
 * Adapt compute-entry builtins, not a model or a numerical kernel. Splitting a
 * dispatch must preserve the *logical* workgroup/global IDs and grid dimensions.
 * Ordinary dispatches continue using the original shader and pipeline.
 */
const prefix = 'naidan_dispatch_';
const axes = ['x', 'y', 'z'] as const;

// Mask comments without moving offsets. WGSL permits nested block comments.
function maskComments({ source }: { source: string }): string | undefined {
  const text = source.split('');
  let block = 0; let line = false;
  for (let i = 0; i < source.length; i++) {
    const pair = source.slice(i, i + 2);
    if (!line && pair === '/*') {
      block++; text[i] = ' '; text[++i] = ' ';
    } else if (block && pair === '*/') {
      block--; text[i] = ' '; text[++i] = ' ';
    } else if (!block && !line && pair === '//') {
      line = true; text[i] = ' '; text[++i] = ' ';
    } else if (block || line) {
      if (source[i] === '\n') line = false;
      else text[i] = ' ';
    }
  }
  return block ? undefined : text.join('');
}

export type DispatchShader = { code: string, gridDependent: boolean, offsetDependent: boolean, bindingGroups: readonly number[] };

/** Deliberately bounded grammar: one void compute entry with direct builtin
 * parameters. Unknown syntax is rejected before issuing any split dispatch,
 * rather than guessed at or falling back to CPU / a lower image resolution. */
export function adaptDispatchShader({ source, entryPoint }: { source: string, entryPoint: string | undefined }): DispatchShader | undefined {
  const masked = maskComments({ source });
  if (masked === undefined || masked.includes(prefix) || /#|@(?:vertex|fragment)\b/.test(masked)) return;
  if ([...masked.matchAll(/@compute\b/g)].length !== 1) return;
  // Current ggml shaders use scalar literals/identifiers for each workgroup axis.
  // Keep this a whitelist, not a regex that accepts arbitrary WGSL expressions.
  const scalar = '(?:0[xX][0-9a-fA-F]+[uUiI]?|[0-9]+[uUiI]?|[A-Za-z_][A-Za-z_0-9]*)';
  const header = new RegExp(`@compute\\s+@workgroup_size\\s*\\(\\s*(${scalar}(?:\\s*,\\s*${scalar}){0,2})\\s*\\)\\s*fn\\s+([A-Za-z_][A-Za-z_0-9]*)\\s*\\(`).exec(masked);
  if (!header || (entryPoint !== undefined && entryPoint !== header[2])) return;
  const sizes = header[1]!.split(',').map(part => part.trim());
  while (sizes.length < 3) sizes.push('1u');
  const start = header.index + header[0].length;
  let position = start;
  const parameter = /\s*@builtin\s*\(\s*([a-z_]+)\s*\)\s*([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(vec3\s*<\s*u32\s*>|vec3u|u32)\s*/y;
  const parameters: { builtin: string, name: string, type: string }[] = [];
  const builtins = new Set<string>(); const names = new Set<string>();
  while (masked[position] !== ')') {
    parameter.lastIndex = position;
    const match = parameter.exec(masked);
    if (!match) return;
    const builtin = match[1]!; const name = match[2]!; const type = match[3]!;
    if (builtins.has(builtin) || names.has(name)) return;
    builtins.add(builtin); names.add(name); parameters.push({ builtin, name, type });
    position = parameter.lastIndex;
    if (masked[position] === ',') {
      position++; while (/\s/.test(masked[position] ?? 'X')) position++;
    } else if (masked[position] !== ')') return;
  }
  const body = /^\)\s*\{/.exec(masked.slice(position));
  if (!body || [...masked.matchAll(/@builtin\b/g)].length !== parameters.length) return;
  const bodyStart = position + body[0].length;
  const declarations: string[] = [];
  const aliases: string[] = [];
  let gridDependent = false;
  let offsetDependent = false;
  let adapted = false;
  const signature: string[] = [];
  for (const { builtin, name, type } of parameters) {
    let expression: string | undefined;
    const vector = type !== 'u32';
    switch (builtin) {
    case 'workgroup_id':
      if (!vector) return;
      offsetDependent = true;
      expression = `${prefix}${name} + vec3<u32>(${axes.map(axis => `${prefix}offset_${axis}`).join(', ')})`;
      break;
    case 'global_invocation_id':
      if (!vector) return;
      offsetDependent = true;
      expression = `${prefix}${name} + vec3<u32>(${axes.map(axis => `${prefix}offset_${axis}`).join(', ')}) * vec3<u32>(${sizes.map(size => `u32(${size})`).join(', ')})`;
      break;
    case 'num_workgroups':
      if (!vector) return;
      gridDependent = true;
      expression = `vec3<u32>(${axes.map(axis => `${prefix}grid_${axis}`).join(', ')})`;
      break;
    case 'local_invocation_id': if (!vector) return; break;
    case 'local_invocation_index': case 'subgroup_id': case 'subgroup_invocation_id': case 'subgroup_size': case 'num_subgroups':
      if (vector) return;
      break;
    default: return;
    }
    if (expression !== undefined) {
      signature.push(`@builtin(${builtin}) ${prefix}${name}: ${type}`);
      aliases.push(`let ${name} = ${expression};`);
      adapted = true;
    } else signature.push(`@builtin(${builtin}) ${name}: ${type}`);
  }
  if (!adapted) return;
  // Appending declarations preserves enable/requires/diagnostic directives at
  // the beginning. Pipeline overrides are uniform across every workgroup.
  if (offsetDependent) for (const axis of axes) declarations.push(`override ${prefix}offset_${axis}: u32 = 0u;`);
  if (gridDependent) for (const axis of axes) declarations.push(`override ${prefix}grid_${axis}: u32 = 1u;`);
  // Native ggml uses literal group indices. Reject unknown resource-address
  // grammar, and never rebuild a stale binding from a previous pipeline at an
  // index outside this shader's interface. No resource declarations are edited.
  const groupMatches = [...masked.matchAll(/@group\s*\(\s*([0-9]+)u?\s*\)/g)];
  if (groupMatches.length !== [...masked.matchAll(/@group\b/g)].length) return;
  const bindingGroups = [...new Set(groupMatches.map(match => Number(match[1])))];
  return {
    code: source.slice(0, start) + signature.join(', ') + ') {\n' + aliases.join('\n') + '\n'
      + source.slice(bodyStart) + '\n' + declarations.join('\n') + '\n',
    gridDependent, offsetDependent, bindingGroups,
  };
}
export const TEST_ONLY = {
  maskComments,
};
