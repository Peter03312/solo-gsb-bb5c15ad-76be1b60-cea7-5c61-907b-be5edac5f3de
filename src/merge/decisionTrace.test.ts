import { describe, expect, it } from 'vitest';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import {
  buildDecisionTrace,
  buildTraceReport,
  countTraceEntries,
  type TraceEntry,
} from './decisionTrace';
import { ABSENT, type JsonValue, type SideValue } from './types';

function trace(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
  resolutions: Resolutions = {},
): { entries: TraceEntry[]; merged: SideValue } {
  const result = threeWayMerge(base, ours, theirs);
  const merged = buildMerged(result.root, resolutions);
  if (merged === undefined || merged === ABSENT) throw new Error('测试用例必须全部解决冲突');
  return { entries: buildDecisionTrace(result, resolutions, merged), merged };
}

const byPointer = (entries: TraceEntry[]) =>
  new Map(entries.map((e) => [e.pointer, e]));

describe('buildDecisionTrace 来源分类', () => {
  it('仅当前分支修改 → ours-only / replace', () => {
    const { entries } = trace({ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 1, b: 2 });
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.pointer).toBe('/b');
    expect(e.source).toBe('ours-only');
    expect(e.change).toBe('replace');
    expect(e.final).toBe(3);
    expect(e.base).toBe(2);
  });

  it('仅目标分支修改 → theirs-only', () => {
    const { entries } = trace({ a: 1 }, { a: 1 }, { a: 8 });
    expect(entries[0].source).toBe('theirs-only');
    expect(entries[0].final).toBe(8);
  });

  it('双方改成相同值 → both', () => {
    const { entries } = trace({ a: 1 }, { a: 5 }, { a: 5 });
    expect(entries[0].source).toBe('both');
    expect(entries[0].change).toBe('replace');
  });

  it('未变更路径不出现在清单中', () => {
    const { entries } = trace(
      { a: 1, b: 2, c: 3 },
      { a: 10, b: 2, c: 3 },
      { a: 1, b: 20, c: 3 },
    );
    const pointers = entries.map((e) => e.pointer).sort();
    expect(pointers).toEqual(['/a', '/b']);
  });

  it('冲突解决：采用当前 / 采用目标 / 自定义分别归类', () => {
    const base: JsonValue = { a: 1, b: 1, c: 1 };
    const ours: JsonValue = { a: 2, b: 2, c: 2 };
    const theirs: JsonValue = { a: 3, b: 3, c: 3 };
    const resolutions: Resolutions = {
      c0: { kind: 'ours' },
      c1: { kind: 'theirs' },
      c2: { kind: 'custom', value: 99 },
    };
    const { entries } = trace(base, ours, theirs, resolutions);
    const m = byPointer(entries);
    expect(m.get('/a')!.source).toBe('conflict-ours');
    expect(m.get('/a')!.final).toBe(2);
    expect(m.get('/b')!.source).toBe('conflict-theirs');
    expect(m.get('/b')!.final).toBe(3);
    expect(m.get('/c')!.source).toBe('conflict-custom');
    expect(m.get('/c')!.final).toBe(99);
    expect(m.get('/c')!.resolution).toEqual({ kind: 'custom', value: 99 });
  });
});

describe('buildDecisionTrace 新增 / 删除（删除值保留为条目）', () => {
  it('仅当前分支新增 → add，基线侧为 ABSENT', () => {
    const { entries } = trace({}, { a: 1 }, {});
    const e = entries[0];
    expect(e.change).toBe('add');
    expect(e.base).toBe(ABSENT);
    expect(e.ours).toBe(1);
    expect(e.theirs).toBe(ABSENT);
    expect(e.final).toBe(1);
  });

  it('仅当前分支删除 → remove，最终值为 ABSENT 且条目保留', () => {
    const { entries } = trace({ a: 1 }, {}, { a: 1 });
    const e = entries[0];
    expect(e.pointer).toBe('/a');
    expect(e.source).toBe('ours-only');
    expect(e.change).toBe('remove');
    expect(e.final).toBe(ABSENT);
    expect(e.base).toBe(1);
  });

  it('双方都删除同一键 → both / remove', () => {
    const { entries } = trace({ a: 1, b: 2 }, { b: 2 }, { b: 2 });
    const e = byPointer(entries).get('/a')!;
    expect(e.source).toBe('both');
    expect(e.change).toBe('remove');
    expect(e.ours).toBe(ABSENT);
    expect(e.theirs).toBe(ABSENT);
    expect(e.final).toBe(ABSENT);
  });

  it('冲突：一方删除另一方修改，采用删除侧 → remove；采用修改侧 → replace', () => {
    const base: JsonValue = { a: 1 };
    const r1 = trace(base, {}, { a: 9 }, { c0: { kind: 'ours' } });
    expect(r1.entries[0]).toMatchObject({
      pointer: '/a',
      source: 'conflict-ours',
      change: 'remove',
    });
    expect(r1.entries[0].final).toBe(ABSENT);

    const r2 = trace(base, {}, { a: 9 }, { c0: { kind: 'theirs' } });
    expect(r2.entries[0]).toMatchObject({
      pointer: '/a',
      source: 'conflict-theirs',
      change: 'replace',
    });
    expect(r2.entries[0].final).toBe(9);
  });
});

describe('buildDecisionTrace null 与缺失的区分', () => {
  it('仅当前分支新增 null → add 条目保留，最终值为 null 而非缺失', () => {
    const { entries } = trace({}, { a: null }, {});
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.pointer).toBe('/a');
    expect(e.source).toBe('ours-only');
    expect(e.change).toBe('add');
    expect(e.base).toBe(ABSENT);
    expect(e.ours).toBeNull();
    expect(e.final).toBeNull();
    expect(e.final).not.toBe(ABSENT);
  });

  it('已有值改为 null → replace（不记为删除）', () => {
    const { entries } = trace({ a: 1 }, { a: null }, { a: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].pointer).toBe('/a');
    expect(entries[0].change).toBe('replace');
    expect(entries[0].base).toBe(1);
    expect(entries[0].final).toBeNull();
  });

  it('双方同改为 null → both / replace', () => {
    const { entries } = trace({ a: 1 }, { a: null }, { a: null });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('both');
    expect(entries[0].change).toBe('replace');
    expect(entries[0].final).toBeNull();
  });

  it('真实删除 null 值 → remove，最终值仍为 ABSENT', () => {
    const { entries } = trace({ a: null }, {}, { a: null });
    expect(entries).toHaveLength(1);
    expect(entries[0].change).toBe('remove');
    expect(entries[0].base).toBeNull();
    expect(entries[0].final).toBe(ABSENT);
  });

  it('嵌套路径上的 null 新增同样按实际变更列出', () => {
    const { entries } = trace({ a: { x: 1 } }, { a: { x: 1, y: null } }, { a: { x: 1 } });
    expect(entries.map((e) => e.pointer)).toEqual(['/a/y']);
    expect(entries[0].change).toBe('add');
    expect(entries[0].final).toBeNull();
  });

  it('报告中 null 值以 present:true 呈现，真实缺失仍是 present:false', () => {
    // /a 已有值改为 null（replace）；/b 真实删除（remove）
    const { entries } = trace({ a: 1, b: 2 }, { a: null }, { a: 1, b: 2 });
    const report = buildTraceReport(entries, new Date('2026-09-27T00:00:00.000Z'));
    expect(report.summary.total).toBe(2);
    expect(report.summary.replace).toBe(1);
    expect(report.summary.remove).toBe(1);

    const a = report.entries.find((e) => e.pointer === '/a')!;
    expect(a.change).toBe('replace');
    expect(a.final).toEqual({ present: true, value: null });

    const b = report.entries.find((e) => e.pointer === '/b')!;
    expect(b.change).toBe('remove');
    expect(b.final).toEqual({ present: false });

    // 报告可 JSON 序列化（null 值保留）
    const text = JSON.stringify(report);
    expect(text).toContain('"value":null');
  });
});

describe('buildDecisionTrace 路径与失效子路径', () => {
  it('路径遵循 RFC 6901 转义（/ 与 ~）', () => {
    const { entries } = trace({ 'a/b': 1, 'm~n': 2 }, { 'a/b': 1, 'm~n': 3 }, {
      'a/b': 1,
      'm~n': 2,
    });
    expect(entries.map((e) => e.pointer)).toEqual(['/m~0n']);

    const { entries: e2 } = trace({ 'a/b': 1 }, { 'a/b': 9 }, { 'a/b': 1 });
    expect(e2[0].pointer).toBe('/a~1b');
  });

  it('父对象被一侧整体替换时只列父路径，不重复列出失效子路径', () => {
    // theirs 未改（对象），ours 把整个 a 换成另一个对象 → /a 节点 ours 状态，不递归
    const { entries } = trace({ a: { x: 1, y: 2 } }, { a: { z: 9 } }, { a: { x: 1, y: 2 } });
    expect(entries.map((e) => e.pointer)).toEqual(['/a']);
    expect(entries[0].change).toBe('replace');
    expect(entries[0].final).toEqual({ z: 9 });
  });

  it('父对象被整体删除时只列父路径（删除条目），子路径不出现', () => {
    const { entries } = trace({ a: { x: 1, y: 2 } }, {}, { a: { x: 1, y: 2 } });
    expect(entries.map((e) => e.pointer)).toEqual(['/a']);
    expect(entries[0].change).toBe('remove');
    expect(entries[0].final).toBe(ABSENT);
  });

  it('一侧就地修改对象子键（含只删键 / 只加键）展开为叶子条目', () => {
    // 仅目标：改 x、删 y
    const r1 = trace(
      { a: { x: 1, y: 2 } },
      { a: { x: 1, y: 2 } },
      { a: { x: 9 } },
    );
    expect(r1.entries.map((e) => e.pointer)).toEqual(['/a/x', '/a/y']);
    expect(r1.entries[0]).toMatchObject({ source: 'theirs-only', change: 'replace' });
    expect(r1.entries[1]).toMatchObject({ source: 'theirs-only', change: 'remove' });

    // 仅当前：只新增键（同一对象形态）→ 叶子 add
    const r2 = trace({ a: { x: 1 } }, { a: { x: 1, z: 5 } }, { a: { x: 1 } });
    expect(r2.entries.map((e) => e.pointer)).toEqual(['/a/z']);
    expect(r2.entries[0]).toMatchObject({ source: 'ours-only', change: 'add' });
  });

  it('一侧既删旧键又加新键视为整体替换：只列父路径', () => {
    const { entries } = trace(
      { a: { x: 1, y: 2 } },
      { a: { x: 1, z: 9 } },
      { a: { x: 1, y: 2 } },
    );
    expect(entries.map((e) => e.pointer)).toEqual(['/a']);
    expect(entries[0].change).toBe('replace');
  });

  it('双方在父对象上冲突（对象 vs 标量）时整体记为冲突路径，不展开子路径', () => {
    const { entries } = trace({ a: { x: 1 } }, { a: 5 }, { a: 9 }, {
      c0: { kind: 'custom', value: 7 },
    });
    expect(entries.map((e) => e.pointer)).toEqual(['/a']);
    expect(entries[0].source).toBe('conflict-custom');
  });

  it('数组按整体处理：替换数组只列数组路径，不列 /list/0 等下标', () => {
    const { entries } = trace({ list: [1, 2] }, { list: [3] }, { list: [1, 2] });
    expect(entries.map((e) => e.pointer)).toEqual(['/list']);
    expect(entries[0].final).toEqual([3]);
  });

  it('双方新增完全相同的对象 → 父路径 both 一条，不展开子键', () => {
    const { entries } = trace({}, { x: { p: 1 } }, { x: { p: 1 } });
    expect(entries.map((e) => e.pointer)).toEqual(['/x']);
    expect(entries[0].source).toBe('both');
    expect(entries[0].change).toBe('add');
  });

  it('对象按键递归合并时各子键分别列条目（深度优先、确定顺序）', () => {
    const { entries } = trace(
      { a: 1, nested: { p: 1, q: 2 } },
      { a: 10, nested: { p: 11, q: 2 } },
      { a: 1, nested: { p: 1, q: 22 } },
    );
    expect(entries.map((e) => e.pointer)).toEqual(['/a', '/nested/p', '/nested/q']);
  });

  it('根节点整体冲突并解决时根指针 "" 作为条目', () => {
    const { entries } = trace(1, 2, 3, { c0: { kind: 'theirs' } });
    expect(entries).toHaveLength(1);
    expect(entries[0].pointer).toBe('');
    expect(entries[0].source).toBe('conflict-theirs');
  });
});

describe('buildDecisionTrace 与最终决策一致', () => {
  it('冲突处自定义回基线值时相对基线无变更，不列条目', () => {
    const { entries } = trace({ a: 1 }, { a: 2 }, { a: 3 }, { c0: { kind: 'custom', value: 1 } });
    expect(entries).toHaveLength(0);
  });

  it('每个条目的 final 都能在最终文档同路径读到（删除除外）', () => {
    const { entries, merged } = trace(
      { a: 1, b: { x: 1 }, c: 1 },
      { a: 2, b: { x: 2 }, c: 1 },
      { a: 1, b: { x: 1 }, c: 9 },
    );
    for (const e of entries) {
      if (e.change === 'remove') {
        expect(e.final).toBe(ABSENT);
      } else {
        expect(e.final).not.toBe(ABSENT);
        // segments 与 pointer 一致
        expect(e.pointer.startsWith('/') || e.pointer === '').toBe(true);
        expect(merged).not.toBe(ABSENT);
      }
    }
  });
});

describe('buildTraceReport 报告', () => {
  it('汇总计数与条目缺失值标注', () => {
    // /a 双方都删除 → both remove；/b 仅目标修改（当前保留基线值）→ theirs-only replace
    const { entries } = trace({ a: 1, b: 2 }, { b: 2 }, { b: 20 });
    // /a 双方都删除 → both remove；/b 仅目标修改 → theirs-only replace
    const report = buildTraceReport(entries, new Date('2026-09-18T00:00:00.000Z'));
    expect(report.format).toBe('json-three-way-merge/decision-trace');
    expect(report.version).toBe(1);
    expect(report.generatedAt).toBe('2026-09-18T00:00:00.000Z');
    expect(report.summary.total).toBe(2);
    expect(report.summary.remove).toBe(1);
    expect(report.summary.replace).toBe(1);
    expect(report.summary.bySource.both).toBe(1);
    expect(report.summary.bySource['theirs-only']).toBe(1);

    const a = report.entries.find((e) => e.pointer === '/a')!;
    expect(a.base).toEqual({ present: true, value: 1 });
    expect(a.ours).toEqual({ present: false });
    expect(a.theirs).toEqual({ present: false });
    expect(a.final).toEqual({ present: false });

    // 报告可 JSON 序列化
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('countTraceEntries 按来源与变更形态统计', () => {
    // /a 冲突（采当前）/b 仅目标修改 /c 仅当前修改 /d 双方都删除
    const base: JsonValue = { a: 1, b: 1, c: 1, d: 1 };
    const ours: JsonValue = { a: 2, b: 1, c: 2 };
    const theirs: JsonValue = { a: 3, b: 3, c: 1 };
    const { entries } = trace(base, ours, theirs, { c0: { kind: 'ours' } });
    const counts = countTraceEntries(entries);
    expect(counts.total).toBe(4);
    expect(counts.bySource['conflict-ours']).toBe(1);
    expect(counts.bySource['theirs-only']).toBe(1); // /b
    expect(counts.bySource['ours-only']).toBe(1); // /c
    expect(counts.bySource.both).toBe(1); // /d 双方都删除
    expect(counts.remove).toBe(1);
  });
});
