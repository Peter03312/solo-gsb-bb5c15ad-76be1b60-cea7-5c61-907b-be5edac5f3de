import { describe, expect, it } from 'vitest';
import {
  analyzeCrossChanges,
  IMPACT_LABEL,
  type CrossImpactEntry,
} from './crossAnalysis';
import { threeWayMerge } from './threeWayMerge';
import { ABSENT, isAbsent, type JsonValue } from './types';

function analyze(base: JsonValue, ours: JsonValue, theirs: JsonValue) {
  return analyzeCrossChanges(base, ours, theirs);
}

/** 按 pointer 取条目（根为 ''） */
function entryOf(entries: CrossImpactEntry[], pointer: string): CrossImpactEntry {
  const e = entries.find((x) => x.pointer === pointer);
  if (!e) throw new Error(`缺少条目 ${pointer}；实际：${entries.map((x) => x.pointer).join(', ')}`);
  return e;
}

/** 交叉分析的冲突根集合应与真实三方合并的冲突指针集合完全一致 */
function expectConflictRootsMatchMerge(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
) {
  const a = analyze(base, ours, theirs);
  const mergePointers = threeWayMerge(base, ours, theirs)
    .conflicts.map((c) => c.pointer)
    .sort();
  expect(a.conflictPointers).toEqual(mergePointers);
  return a;
}

describe('analyzeCrossChanges 单侧与同路径', () => {
  it('仅一侧改动标为可自动合并（ours-only / theirs-only）', () => {
    const a = analyze(
      { a: 1, b: 2 },
      { a: 10, b: 2 },
      { a: 1, b: 20 },
    );
    expect(entryOf(a.entries, '/a').impact).toBe('ours-only');
    expect(entryOf(a.entries, '/b').impact).toBe('theirs-only');
    expect(a.counts.autoMergeable).toBe(2);
    expect(a.counts.conflictRoots).toBe(0);
  });

  it('双方改成相同值（含双方都删除）标为 both-agree', () => {
    const a = analyze(
      { a: 1, b: 2 },
      { a: 9 },
      { a: 9 },
    );
    // /a 双方改成相同值；/b 双方都删除
    expect(entryOf(a.entries, '/a').impact).toBe('both-agree');
    expect(entryOf(a.entries, '/b').impact).toBe('both-agree');
    expect(isAbsent(entryOf(a.entries, '/b').ours!.value)).toBe(true);
    expect(a.counts.conflictRoots).toBe(0);
  });

  it('同一路径双方改成不同标量为 same-path-conflict', () => {
    const a = analyze({ a: 1 }, { a: 2 }, { a: 3 });
    expect(entryOf(a.entries, '/a').impact).toBe('same-path-conflict');
    expect(a.counts.conflictRoots).toBe(1);
    expect(a.conflictPointers).toEqual(['/a']);
  });

  it('一侧删除另一侧修改同一路径为 same-path-conflict', () => {
    const a = analyze({ a: 1, b: 2 }, { b: 2 }, { a: 9, b: 2 });
    expect(entryOf(a.entries, '/a').impact).toBe('same-path-conflict');
    expect(entryOf(a.entries, '/a').ours!.kind).toBe('remove');
    expect(entryOf(a.entries, '/a').theirs!.kind).toBe('replace');
    expect(a.conflictPointers).toEqual(['/a']);
  });

  it('对象内互不相干的键改动分别展开为可自动合并条目', () => {
    const a = analyze(
      { x: 1, y: 2, nested: { p: 1, q: 2 } },
      { x: 10, y: 2, nested: { p: 1, q: 2 } },
      { x: 1, y: 20, nested: { p: 1, q: 22 } },
    );
    expect(entryOf(a.entries, '/x').impact).toBe('ours-only');
    expect(entryOf(a.entries, '/y').impact).toBe('theirs-only');
    expect(entryOf(a.entries, '/nested/q').impact).toBe('theirs-only');
    expect(a.entries.map((e) => e.pointer)).not.toContain('/nested');
    expect(a.entries.map((e) => e.pointer)).not.toContain('/nested/p');
    expect(a.counts.conflictRoots).toBe(0);
  });

  it('同一对象键双方改成不同值仍为同路径冲突，其余键自动合并', () => {
    const a = analyze(
      { a: 1, b: 2 },
      { a: 10, b: 20 },
      { a: 100, b: 20 },
    );
    expect(entryOf(a.entries, '/a').impact).toBe('same-path-conflict');
    expect(entryOf(a.entries, '/b').impact).toBe('both-agree');
    expect(a.conflictPointers).toEqual(['/a']);
  });
});

describe('analyzeCrossChanges 数组与标量整体处理', () => {
  it('数组始终按整体值处理，不展开下标', () => {
    const a = analyze(
      { list: [1, 2] },
      { list: [1, 2, 3] },
      { list: [1, 2] },
    );
    expect(a.entries).toHaveLength(1);
    expect(entryOf(a.entries, '/list').impact).toBe('ours-only');
    expect(entryOf(a.entries, '/list').ours!.kind).toBe('replace');
  });

  it('双方都改同一数组为不同值为同路径冲突', () => {
    const a = analyze({ list: [1, 2] }, { list: [1, 2, 3] }, { list: [1, 5] });
    expect(entryOf(a.entries, '/list').impact).toBe('same-path-conflict');
    expect(a.conflictPointers).toEqual(['/list']);
  });

  it('数组内部对象改动不产生后代路径', () => {
    const a = analyze(
      { items: [{ k: 1 }] },
      { items: [{ k: 2 }] },
      { items: [{ k: 1 }] },
    );
    expect(a.entries.map((e) => e.pointer)).toEqual(['/items']);
  });
});

describe('analyzeCrossChanges 祖先整体替换/删除 × 后代修改', () => {
  it('一侧整体删除对象，另一侧修改其后代：祖先与后代为同一组交叉影响', () => {
    const a = analyze(
      { cfg: { a: 1, b: 2 } },
      {},
      { cfg: { a: 99, b: 2 } },
    );
    const ancestor = entryOf(a.entries, '/cfg');
    expect(ancestor.impact).toBe('cross-ancestor-conflict');
    expect(ancestor.ancestor).toBeUndefined(); // 祖先条目本身是冲突根
    expect(ancestor.ours!.kind).toBe('remove');

    const descendant = entryOf(a.entries, '/cfg/a');
    expect(descendant.impact).toBe('cross-ancestor-conflict');
    expect(descendant.ancestor).toEqual({ pointer: '/cfg', side: 'ours', kind: 'remove' });
    // /cfg/b 两侧一致未变，不出现在矩阵中
    expect(a.entries.map((e) => e.pointer)).not.toContain('/cfg/b');
    expect(a.conflictPointers).toEqual(['/cfg']);
    expect(a.counts.conflictRoots).toBe(1);
  });

  it('一侧把对象整体替换为标量，另一侧在后代路径上增改', () => {
    const a = analyze(
      { cfg: { a: 1 } },
      { cfg: 'disabled' },
      { cfg: { a: 1, b: 5 } },
    );
    const ancestor = entryOf(a.entries, '/cfg');
    expect(ancestor.impact).toBe('cross-ancestor-conflict');
    expect(ancestor.ours!.kind).toBe('replace');

    const descendant = entryOf(a.entries, '/cfg/b');
    expect(descendant.impact).toBe('cross-ancestor-conflict');
    expect(descendant.theirs!.kind).toBe('add');
    expect(descendant.ancestor).toEqual({ pointer: '/cfg', side: 'ours', kind: 'replace' });
    expect(a.conflictPointers).toEqual(['/cfg']);
  });

  it('一侧把对象换成数组（非对象），另一侧修改后代键', () => {
    const a = analyze(
      { cfg: { a: 1 } },
      { cfg: [1, 2] },
      { cfg: { a: 2 } },
    );
    expect(entryOf(a.entries, '/cfg').impact).toBe('cross-ancestor-conflict');
    expect(entryOf(a.entries, '/cfg/a').impact).toBe('cross-ancestor-conflict');
    expect(a.conflictPointers).toEqual(['/cfg']);
  });

  it('祖先整体换成另一个对象（对象→对象）不构成交叉：后代删除冲突在后代路径暴露', () => {
    // ours 用 {x} 整体替换 {a,b}（对象形态，合并引擎仍按键递归）；
    // theirs 修改了被保留的键 b 以外的场景：这里 ours 删 a、theirs 改 a → 冲突在 /cfg/a
    const a = analyze(
      { cfg: { a: 1, b: 2 } },
      { cfg: { x: 7 } },
      { cfg: { a: 9, b: 2 } },
    );
    expect(a.entries.find((e) => e.pointer === '/cfg')).toBeUndefined();
    expect(entryOf(a.entries, '/cfg/a').impact).toBe('same-path-conflict');
    expect(entryOf(a.entries, '/cfg/x').impact).toBe('ours-only');
    expect(a.conflictPointers).toEqual(['/cfg/a']);
  });

  it('在基线不存在处放上非对象值，另一侧在后代路径加键', () => {
    const a = analyze(
      {},
      { cfg: 42 },
      { cfg: { deep: 1 } },
    );
    expect(entryOf(a.entries, '/cfg').impact).toBe('cross-ancestor-conflict');
    expect(entryOf(a.entries, '/cfg/deep').impact).toBe('cross-ancestor-conflict');
    expect(entryOf(a.entries, '/cfg/deep').ancestor).toEqual({
      pointer: '/cfg',
      side: 'ours',
      kind: 'add',
    });
    expect(a.conflictPointers).toEqual(['/cfg']);
  });

  it('两侧在同一不存在路径都放对象时按键递归，不构成交叉', () => {
    const a = analyze(
      {},
      { cfg: { a: 1 } },
      { cfg: { b: 2 } },
    );
    expect(entryOf(a.entries, '/cfg/a').impact).toBe('ours-only');
    expect(entryOf(a.entries, '/cfg/b').impact).toBe('theirs-only');
    expect(a.counts.conflictRoots).toBe(0);
  });

  it('一侧删除根节点，另一侧修改深层后代：冲突根为根', () => {
    const a = analyze(
      { a: { b: { c: 1 } } },
      null,
      { a: { b: { c: 2 } } },
    );
    expect(entryOf(a.entries, '').impact).toBe('cross-ancestor-conflict');
    expect(entryOf(a.entries, '/a/b/c').impact).toBe('cross-ancestor-conflict');
    expect(entryOf(a.entries, '/a/b/c').ancestor?.pointer).toBe('');
    expect(a.conflictPointers).toEqual(['']);
  });
});

describe('analyzeCrossChanges 计数与合并引擎一致性', () => {
  it('复杂混合场景：交叉影响涉及多个后代条目但只计一个冲突根', () => {
    const a = analyze(
      { cfg: { a: 1, b: 2, c: 3 }, ok: true },
      { ok: false },
      { cfg: { a: 10, b: 20, c: 3 }, ok: true },
    );
    expect(a.counts.byImpact['cross-ancestor-conflict']).toBe(3); // /cfg、/cfg/a、/cfg/b
    expect(entryOf(a.entries, '/ok').impact).toBe('ours-only');
    expect(a.counts.conflictRoots).toBe(1);
  });

  it('交叉影响与真实三方合并的冲突指针一致（对象换成对象 + 后代同改）', () => {
    expectConflictRootsMatchMerge(
      { cfg: { a: 1, b: 2 }, keep: 0 },
      { cfg: { x: 7 }, keep: 1 },
      { cfg: { a: 9, b: 22 }, keep: 0 },
    );
  });

  it('交叉影响与真实三方合并的冲突指针一致（祖先删除）', () => {
    expectConflictRootsMatchMerge(
      { cfg: { a: 1, b: { d: 4 } } },
      {},
      { cfg: { a: 1, b: { d: 40 } } },
    );
  });

  it('交叉影响与真实三方合并一致（祖先换成标量）', () => {
    expectConflictRootsMatchMerge(
      { cfg: { a: 1 } },
      { cfg: false },
      { cfg: { a: 2, extra: 3 } },
    );
  });

  it('无任何变更时矩阵为空', () => {
    const a = analyze({ x: 1 }, { x: 1 }, { x: 1 });
    expect(a.entries).toEqual([]);
    expect(a.counts.total).toBe(0);
    expect(a.counts.conflictRoots).toBe(0);
  });

  it('条目按路径（祖先在前、兄弟字典序）排序', () => {
    const a = analyze(
      { a: 1, m: { z: 1, y: 1 } },
      { a: 2, m: { z: 2, y: 2 } },
      { a: 1, m: { z: 1, y: 1 } },
    );
    expect(a.entries.map((e) => e.pointer)).toEqual(['/a', '/m/y', '/m/z']);
  });

  it('三方值与单侧变更形态记录正确（add/replace/remove）', () => {
    const a = analyze(
      { kept: 1, changed: 1 },
      { kept: 1, changed: 2, added: 9 },
      {},
    );
    expect(entryOf(a.entries, '/kept').theirs!.kind).toBe('remove');
    expect(entryOf(a.entries, '/changed').ours!.kind).toBe('replace');
    expect(entryOf(a.entries, '/added').ours!.kind).toBe('add');
    expect(entryOf(a.entries, '/added').base).toBe(ABSENT); // 基线不存在
  });
});

describe('analyzeCrossChanges 徽标文案', () => {
  it('每种影响类型都有中文标签', () => {
    for (const key of [
      'ours-only',
      'theirs-only',
      'both-agree',
      'same-path-conflict',
      'cross-ancestor-conflict',
    ] as const) {
      expect(IMPACT_LABEL[key]).toBeTruthy();
    }
  });
});
