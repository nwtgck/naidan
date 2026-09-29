import { describe, expect, it } from 'vitest';
import { adaptDispatchShader, TEST_ONLY } from './webgpu-dispatch-shader';

const row = `\
struct Params { ne0: u32, ne1: u32, ne2: u32, eps: f32 };
@group(0) @binding(0) var<uniform> params: Params;
var<workgroup> scratch: array<f32, 64u>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>) {
    var i = wid.x;
    let i3 = i / (params.ne2 * params.ne1);
    i = i % (params.ne2 * params.ne1);
    scratch[lid.x] = f32(i3);
    workgroupBarrier();
}
`;
describe('dispatch builtin adaptation', () => {
  it('leaves the complete numerical body intact and only aliases the logical workgroup id', () => {
    const adapted = adaptDispatchShader({ source: row, entryPoint: 'main' });
    expect(adapted).toBeDefined();
    expect(adapted!.gridDependent).toBe(false);
    expect(adapted!.code).toContain('let wid = naidan_dispatch_wid + vec3<u32>(naidan_dispatch_offset_x, naidan_dispatch_offset_y, naidan_dispatch_offset_z);');
    expect(adapted!.code).toContain(row.slice(row.indexOf('    var i = wid.x;')));
    expect(adapted!.code).toContain('@builtin(local_invocation_id) lid: vec3<u32>');
    expect(adapted!.code).not.toContain('naidan_dispatch_grid_x');
    expect(adapted!.code.match(/@group\(/g)).toHaveLength(1);
  });
  it('preserves logical global ids and the original grid, including multi-axis workgroup sizes', () => {
    const source = `\
enable f16;
override work_x: u32 = 4;
@compute @workgroup_size(work_x, 2, 3u)
fn compute(@builtin(global_invocation_id) gid: vec3u,
           @builtin(num_workgroups) grid: vec3<u32>,
           @builtin(local_invocation_index) index: u32,
           @builtin(subgroup_size) subgroup: u32,) {
    let value = gid.x + grid.y + index + subgroup;
}
`;
    const adapted = adaptDispatchShader({ source, entryPoint: undefined });
    expect(adapted!.code.startsWith('enable f16;')).toBe(true);
    expect(adapted!.gridDependent).toBe(true);
    expect(adapted!.code).toContain('* vec3<u32>(u32(work_x), u32(2), u32(3u))');
    expect(adapted!.code).toContain('let grid = vec3<u32>(naidan_dispatch_grid_x, naidan_dispatch_grid_y, naidan_dispatch_grid_z);');
    expect(adapted!.code).toContain('@builtin(subgroup_size) subgroup: u32');
    expect(adapted!.code).toContain('let value = gid.x + grid.y + index + subgroup;');
  });
  it('does not manufacture unused offset overrides for a grid-only shader', () => {
    const source = '@compute @workgroup_size(1) fn main(@builtin(num_workgroups) n: vec3u) { let value = n.x; }';
    const shader = adaptDispatchShader({ source, entryPoint: 'main' })!;
    expect(shader.offsetDependent).toBe(false);
    expect(shader.gridDependent).toBe(true);
    expect(shader.code).not.toContain('naidan_dispatch_offset_');
    expect(shader.bindingGroups).toEqual([]);
  });
  it('records literal resource groups without modifying their declarations', () => {
    const source = row.replace('@group(0)', '@group(2u)');
    expect(adaptDispatchShader({ source, entryPoint: 'main' })!.bindingGroups).toEqual([2]);
  });
  it('does not mistake comments for entry points or reserved identifiers', () => {
    const source = `\
/* @compute /* @builtin(workgroup_id) */ naidan_dispatch_reserved */
// @compute @workgroup_size(99) fn bad() {}
${row}`;
    expect(adaptDispatchShader({ source, entryPoint: 'main' })).toBeDefined();
    expect(TEST_ONLY.maskComments({ source })!.length).toBe(source.length);
  });
  it.each([
    { name: 'unclosed block comment', source: row + '/*', entryPoint: 'main' },
    { name: 'reserved identifier', source: row + 'const naidan_dispatch_grid_x = 2;', entryPoint: 'main' },
    { name: 'wrong entry point', source: row, entryPoint: 'other' },
    { name: 'multiple entry points', source: row + '@compute @workgroup_size(1) fn other() {}', entryPoint: 'main' },
    { name: 'structure parameter', source: row.replace('@builtin(workgroup_id) wid: vec3<u32>', 'wid: Input'), entryPoint: 'main' },
    { name: 'unsupported builtin', source: row.replace('local_invocation_id', 'future_builtin'), entryPoint: 'main' },
    { name: 'builtin type mismatch', source: row.replace('wid: vec3<u32>', 'wid: u32'), entryPoint: 'main' },
    { name: 'duplicate builtin', source: row.replace('local_invocation_id', 'workgroup_id'), entryPoint: 'main' },
    { name: 'duplicate name', source: row.replace('lid:', 'wid:'), entryPoint: 'main' },
    { name: 'unprocessed macro', source: '#define X 1\n' + row, entryPoint: 'main' },
    { name: 'unsupported workgroup expression', source: row.replace('workgroup_size(64)', 'workgroup_size(32 * 2)'), entryPoint: 'main' },
    { name: 'vertex entry', source: row.replace('@compute', '@vertex'), entryPoint: 'main' },
    { name: 'unknown resource address', source: row.replace('@group(0)', '@group(1+1)'), entryPoint: 'main' },
    { name: 'return value', source: row.replace('lid: vec3<u32>) {', 'lid: vec3<u32>) -> u32 {'), entryPoint: 'main' },
  ])('rejects $name instead of guessing', ({ source, entryPoint }) => {
    expect(adaptDispatchShader({ source, entryPoint })).toBeUndefined();
  });
  it('supports every local and subgroup scalar input used by the native compute shaders', () => {
    const source = `\
@compute @workgroup_size(128u)
fn main(@builtin(workgroup_id) wid: vec3<u32>,
        @builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(subgroup_id) sg: u32,
        @builtin(subgroup_invocation_id) lane: u32,
        @builtin(subgroup_size) size: u32,
        @builtin(num_subgroups) count: u32) { let i = wid.x; }
`;
    expect(adaptDispatchShader({ source, entryPoint: 'main' })).toBeDefined();
  });
});
