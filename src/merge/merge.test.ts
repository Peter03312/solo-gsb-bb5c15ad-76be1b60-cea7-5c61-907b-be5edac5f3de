import { describe, expect, it } from 'vitest';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import { diff } from './rfc6902';
import { ABSENT, type JsonValue } from './types';

function merge(base: JsonValue, ours: JsonValue, theirs: JsonValue, res: Resolutions = {}) {
  const r = threeWayMerge(base, ours, theirs);
  return { result: buildMerged(r.root, res), conflicts: r.conflicts };
}

describe('threeWayMerge', () => {
  it('仅一侧修改时采用该侧', () => {
    const { result, conflicts } = merge({ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 1, b: 2 });
    expect(result).toEqual({ a: 1, b: 3 });
    expect(conflicts).toHaveLength(0);
  });

  it('双方改成相同值时采用一次', () => {
    const { result, conflicts } = merge({ a: 1 }, { a: 2 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
    expect(conflicts).toHaveLength(0);
  });

  it('双方改成不同值时产生冲突，可选任一侧', () => {
    const r = threeWayMerge({ a: 1 }, { a: 2 }, { a: 3 });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pointer).toBe('/a');
    expect(buildMerged(r.root, { c0: { kind: 'ours' } })).toEqual({ a: 2 });
    expect(buildMerged(r.root, { c0: { kind: 'theirs' } })).toEqual({ a: 3 });
    expect(buildMerged(r.root, { c0: { kind: 'custom', value: 9 } })).toEqual({ a: 9 });
  });

  it('一侧删除另一侧修改时产生冲突', () => {
    const r = threeWayMerge({ a: 1, b: 2 }, { b: 2 }, { a: 9, b: 2 });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pointer).toBe('/a');
    expect(r.conflicts[0].ours).toBe(ABSENT);
    expect(buildMerged(r.root, { c0: { kind: 'ours' } })).toEqual({ b: 2 });
    expect(buildMerged(r.root, { c0: { kind: 'theirs' } })).toEqual({ a: 9, b: 2 });
  });

  it('双方都删除同一键时不冲突', () => {
    const { result, conflicts } = merge({ a: 1, b: 2 }, { b: 2 }, { b: 2 });
    expect(result).toEqual({ b: 2 });
    expect(conflicts).toHaveLength(0);
  });

  it('数组按单个值处理：双方都改数组则冲突', () => {
    const r = threeWayMerge({ list: [1, 2] }, { list: [1, 2, 3] }, { list: [1, 5] });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pointer).toBe('/list');
    expect(buildMerged(r.root, { c0: { kind: 'ours' } })).toEqual({ list: [1, 2, 3] });
  });

  it('数组仅一侧修改时采用该侧', () => {
    const { result, conflicts } = merge({ list: [1, 2] }, { list: [3] }, { list: [1, 2] });
    expect(result).toEqual({ list: [3] });
    expect(conflicts).toHaveLength(0);
  });

  it('对象递归合并：双方改不同键可自动合并', () => {
    const { result, conflicts } = merge(
      { a: 1, b: 2 },
      { a: 10, b: 2 },
      { a: 1, b: 20 },
    );
    expect(result).toEqual({ a: 10, b: 20 });
    expect(conflicts).toHaveLength(0);
  });

  it('双方新增不同对象时按键合并', () => {
    const { result, conflicts } = merge({}, { x: { p: 1 } }, { x: { q: 2 } });
    expect(result).toEqual({ x: { p: 1, q: 2 } });
    expect(conflicts).toHaveLength(0);
  });

  it('类型变化（对象 vs 标量）按冲突处理', () => {
    const r = threeWayMerge({ a: { x: 1 } }, { a: { x: 2 } }, { a: 5 });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pointer).toBe('/a');
  });

  it('未解决全部冲突时 buildMerged 返回 undefined', () => {
    const r = threeWayMerge({ a: 1 }, { a: 2 }, { a: 3 });
    expect(buildMerged(r.root, {})).toBeUndefined();
  });

  it('嵌套冲突的 JSON Pointer 定位正确', () => {
    const r = threeWayMerge(
      { outer: { inner: 1 } },
      { outer: { inner: 2 } },
      { outer: { inner: 3 } },
    );
    expect(r.conflicts[0].pointer).toBe('/outer/inner');
  });
});

describe('rfc6902 diff', () => {
  it('无变化时为空补丁', () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('标量替换', () => {
    expect(diff({ a: 1 }, { a: 2 })).toEqual([{ op: 'replace', path: '/a', value: 2 }]);
  });

  it('新增与删除键', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c', value: 3 },
    ]);
  });

  it('根整体替换', () => {
    expect(diff({ a: 1 }, [1, 2] as unknown as JsonValue)).toEqual([
      { op: 'replace', path: '', value: [1, 2] },
    ]);
  });

  it('数组元素替换、尾部删除与追加', () => {
    expect(diff([1, 2, 3], [1, 5])).toEqual([
      { op: 'replace', path: '/1', value: 5 },
      { op: 'remove', path: '/2' },
    ]);
    expect(diff([1], [1, 2, 3])).toEqual([
      { op: 'add', path: '/1', value: 2 },
      { op: 'add', path: '/2', value: 3 },
    ]);
  });

  it('键名含特殊字符时按 RFC 6901 转义', () => {
    expect(diff({ 'a/b': 1 }, { 'a/b': 2 })).toEqual([
      { op: 'replace', path: '/a~1b', value: 2 },
    ]);
    expect(diff({ 'x~y': 1 }, { 'x~y': 2 })).toEqual([
      { op: 'replace', path: '/x~0y', value: 2 },
    ]);
  });

  it('嵌套对象递归 diff', () => {
    expect(diff({ o: { x: 1, y: 2 } }, { o: { x: 1, y: 3 } })).toEqual([
      { op: 'replace', path: '/o/y', value: 3 },
    ]);
  });
});
