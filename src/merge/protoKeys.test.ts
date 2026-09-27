import { describe, expect, it } from 'vitest';
import { analyzeCrossChanges } from './crossAnalysis';
import { buildDecisionTrace } from './decisionTrace';
import { applyJsonPatch, parseJsonPatch } from './jsonPatch';
import { auditPatch } from './patchAudit';
import { getBySegments } from './pointer';
import { diff } from './rfc6902';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import { ABSENT, hasOwn, type JsonValue } from './types';

/** 用 JSON.parse 构造 / 期望带自有 __proto__ 键的对象（对象字面量会命中原型 setter） */
function parse(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

describe('原型同名键（__proto__ / constructor / toString）', () => {
  it('基线 {}、双方在 __proto__ 下分别新增键时，合并保留整棵子树', () => {
    const base = parse('{}');
    const ours = parse('{"__proto__":{"a":1}}');
    const theirs = parse('{"__proto__":{"b":2}}');
    const r = threeWayMerge(base, ours, theirs);
    expect(r.conflicts).toHaveLength(0);
    const merged = buildMerged(r.root, {}) as Record<string, JsonValue>;

    // 必须是自有可枚举键，且 JSON 序列化不丢子树
    expect(hasOwn(merged, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(merged))).toEqual(parse('{"__proto__":{"a":1,"b":2}}'));
    // 不得污染 Object.prototype
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('__proto__ 两侧改成不同值时产生路径正确的冲突', () => {
    const base = parse('{"__proto__":{"a":1}}');
    const ours = parse('{"__proto__":{"a":2}}');
    const theirs = parse('{"__proto__":{"a":3}}');
    const r = threeWayMerge(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].pointer).toBe('/__proto__/a');
    const res: Resolutions = { [r.conflicts[0].id]: { kind: 'ours' } };
    const merged = buildMerged(r.root, res);
    expect(JSON.parse(JSON.stringify(merged))).toEqual(parse('{"__proto__":{"a":2}}'));
  });

  it('一方删除 __proto__ 子键、另一方修改它时保留冲突裁决结果', () => {
    const base = parse('{"__proto__":{"a":1,"b":2}}');
    const ours = parse('{"__proto__":{"b":2}}');
    const theirs = parse('{"__proto__":{"a":9,"b":2}}');
    const r = threeWayMerge(base, ours, theirs);
    expect(r.conflicts.map((c) => c.pointer)).toEqual(['/__proto__/a']);

    const deleted = buildMerged(r.root, { [r.conflicts[0].id]: { kind: 'ours' } });
    expect(JSON.parse(JSON.stringify(deleted))).toEqual(parse('{"__proto__":{"b":2}}'));

    const kept = buildMerged(r.root, { [r.conflicts[0].id]: { kind: 'theirs' } });
    expect(JSON.parse(JSON.stringify(kept))).toEqual(parse('{"__proto__":{"a":9,"b":2}}'));
  });

  it('双方都删除 __proto__ 键时自动合并为删除', () => {
    const base = parse('{"__proto__":{"a":1},"x":1}');
    const ours = parse('{"x":1}');
    const theirs = parse('{"x":1}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {});
    expect(merged).toEqual({ x: 1 });
    expect(Object.prototype.hasOwnProperty.call(merged!, '__proto__')).toBe(false);
  });

  it('安全写入 constructor / toString 等其它原型同名键', () => {
    const base = parse('{}');
    const ours = parse('{"constructor":{"a":1}}');
    const theirs = parse('{"toString":"s"}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {}) as Record<
      string,
      JsonValue
    >;
    expect(JSON.parse(JSON.stringify(merged))).toEqual({ constructor: { a: 1 }, toString: 's' });
    expect(hasOwn(merged, 'constructor')).toBe(true);
    expect(hasOwn(merged, 'toString')).toBe(true);
    // 原型成员不受影响
    expect(typeof (merged as unknown as { constructor: unknown }).constructor).toBe('object');
    expect({}.toString()).toBe('[object Object]');
  });

  it('__proto__ 下嵌套对象的双方改动仍按键递归合并', () => {
    const base = parse('{"__proto__":{"n":{"a":1,"b":2}}}');
    const ours = parse('{"__proto__":{"n":{"a":10,"b":2}}}');
    const theirs = parse('{"__proto__":{"n":{"a":1,"b":20}}}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {});
    expect(JSON.parse(JSON.stringify(merged))).toEqual(
      parse('{"__proto__":{"n":{"a":10,"b":20}}}'),
    );
  });

  it('嵌套对象内 __proto__ 键（深层路径）同样安全', () => {
    const base = parse('{"o":{}}');
    const ours = parse('{"o":{"__proto__":{"a":1}}}');
    const theirs = parse('{"o":{"__proto__":{"b":2}}}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {}) as Record<
      string,
      JsonValue
    >;
    expect(JSON.parse(JSON.stringify(merged))).toEqual(parse('{"o":{"__proto__":{"a":1,"b":2}}}'));
    const inner = getBySegments(merged, ['o', '__proto__']) as Record<string, JsonValue>;
    expect(hasOwn(inner, 'a')).toBe(true);
    expect(({} as Record<string, unknown>).b).toBeUndefined();
  });

  it('标量 __proto__ 值不被原型 setter 静默丢弃', () => {
    const base = parse('{}');
    const ours = parse('{"__proto__":1}');
    const theirs = parse('{"__proto__":1}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {});
    expect(JSON.parse(JSON.stringify(merged))).toEqual(parse('{"__proto__":1}'));
  });
});

describe('交叉分析对原型同名键的路径与语义', () => {
  it('基线 {} 时 /__proto__/a 与 /__proto__/b 标记为单侧新增（add）', () => {
    const ca = analyzeCrossChanges(
      parse('{}'),
      parse('{"__proto__":{"a":1}}'),
      parse('{"__proto__":{"b":2}}'),
    );
    const byPointer = new Map(ca.entries.map((e) => [e.pointer, e]));
    const a = byPointer.get('/__proto__/a')!;
    const b = byPointer.get('/__proto__/b')!;
    expect(a.impact).toBe('ours-only');
    expect(a.ours?.kind).toBe('add');
    expect(a.base).toBe(ABSENT);
    expect(b.impact).toBe('theirs-only');
    expect(b.theirs?.kind).toBe('add');
    expect(b.base).toBe(ABSENT);
  });

  it('不会把继承来的 constructor 误判为基线已有键', () => {
    const ca = analyzeCrossChanges(parse('{}'), parse('{"constructor":{"x":1}}'), parse('{}'));
    const entry = ca.entries.find((e) => e.pointer === '/constructor/x');
    expect(entry?.impact).toBe('ours-only');
    expect(entry?.ours?.kind).toBe('add');
  });

  it('同一路径两侧改成不同值给出 same-path-conflict', () => {
    const ca = analyzeCrossChanges(
      parse('{"__proto__":{"a":1}}'),
      parse('{"__proto__":{"a":2}}'),
      parse('{"__proto__":{"a":3}}'),
    );
    expect(ca.conflictPointers).toContain('/__proto__/a');
    const entry = ca.entries.find((e) => e.pointer === '/__proto__/a')!;
    expect(entry.impact).toBe('same-path-conflict');
  });
});

describe('决策溯源对原型同名键与合并结果一致', () => {
  it('叶子条目的指针、增改语义与最终值正确', () => {
    const base = parse('{}');
    const ours = parse('{"__proto__":{"a":1}}');
    const theirs = parse('{"__proto__":{"b":2}}');
    const r = threeWayMerge(base, ours, theirs);
    const merged = buildMerged(r.root, {}) as JsonValue;
    const entries = buildDecisionTrace(r, {}, merged);
    const byPointer = new Map(entries.map((e) => [e.pointer, e]));
    const a = byPointer.get('/__proto__/a')!;
    const b = byPointer.get('/__proto__/b')!;
    expect(a.source).toBe('ours-only');
    expect(a.change).toBe('add');
    expect(a.final).toBe(1);
    expect(b.source).toBe('theirs-only');
    expect(b.change).toBe('add');
    expect(b.final).toBe(2);
  });

  it('选择删除子键的冲突时溯源记为 remove', () => {
    // ours 仅删除 /__proto__/a（保留 __proto__ 对象及其它子键），冲突停在子路径
    const base = parse('{"__proto__":{"a":1,"b":2}}');
    const ours = parse('{"__proto__":{"b":2}}');
    const theirs = parse('{"__proto__":{"a":9,"b":2}}');
    const r = threeWayMerge(base, ours, theirs);
    expect(r.conflicts[0].pointer).toBe('/__proto__/a');
    const id = r.conflicts[0].id;
    const resolutions = { [id]: { kind: 'ours' } } as Resolutions;
    const merged = buildMerged(r.root, resolutions) as JsonValue;
    const entries = buildDecisionTrace(r, resolutions, merged);
    const entry = entries.find((e) => e.pointer === '/__proto__/a')!;
    expect(entry.change).toBe('remove');
    expect(entry.source).toBe('conflict-ours');
  });

  it('整棵 __proto__ 子树一侧删除一侧修改时，溯源停在祖先路径', () => {
    const base = parse('{"__proto__":{"a":1}}');
    const ours = parse('{}');
    const theirs = parse('{"__proto__":{"a":9}}');
    const r = threeWayMerge(base, ours, theirs);
    expect(r.conflicts[0].pointer).toBe('/__proto__');
    const id = r.conflicts[0].id;
    const resolutions = { [id]: { kind: 'ours' } } as Resolutions;
    const merged = buildMerged(r.root, resolutions) as JsonValue;
    const entries = buildDecisionTrace(r, resolutions, merged);
    // 父路径整体删除记一条 remove，不重复列出已失效的 /__proto__/a
    expect(entries.map((e) => e.pointer)).toEqual(['/__proto__']);
    expect(entries[0].change).toBe('remove');
    expect(entries[0].source).toBe('conflict-ours');
  });
});

describe('JSON Patch 生成与回放对原型同名键一致', () => {
  it('生成 add /__proto__ 并可回放得到合并结果', () => {
    const base = parse('{}');
    const target = parse('{"__proto__":{"a":1,"b":2}}');
    const ops = diff(base, target);
    expect(JSON.parse(JSON.stringify(ops))).toEqual(
      JSON.parse('[{"op":"add","path":"/__proto__","value":{"a":1,"b":2}}]'),
    );

    const parsed = parseJsonPatch(JSON.stringify(ops));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('补丁解析失败');
    const applied = applyJsonPatch(base, parsed.ops);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.failure.reason);
    expect(JSON.parse(JSON.stringify(applied.document))).toEqual(
      parse('{"__proto__":{"a":1,"b":2}}'),
    );
    // 回放不得污染原型
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('深层层级的 __proto__ 增改删补丁均可安全回放', () => {
    const base = parse('{"o":{"__proto__":{"a":1}}}');
    const target = parse('{"o":{"__proto__":{"b":2}}}');
    const ops = diff(base, target);
    expect(JSON.parse(JSON.stringify(ops))).toEqual(
      JSON.parse(
        '[{"op":"remove","path":"/o/__proto__/a"},{"op":"add","path":"/o/__proto__/b","value":2}]',
      ),
    );
    const parsed = parseJsonPatch(JSON.stringify(ops));
    if (!parsed.ok) throw new Error('补丁解析失败');
    const applied = applyJsonPatch(base, parsed.ops);
    if (!applied.ok) throw new Error(applied.failure.reason);
    expect(JSON.parse(JSON.stringify(applied.document))).toEqual(
      parse('{"o":{"__proto__":{"b":2}}}'),
    );
  });

  it('整个 __proto__ 子树删除的补丁可回放', () => {
    const base = parse('{"__proto__":{"a":1},"x":1}');
    const target = parse('{"x":1}');
    const ops = diff(base, target);
    expect(ops).toEqual([{ op: 'remove', path: '/__proto__' }]);
    const parsed = parseJsonPatch(JSON.stringify(ops));
    if (!parsed.ok) throw new Error('补丁解析失败');
    const applied = applyJsonPatch(base, parsed.ops);
    if (!applied.ok) throw new Error(applied.failure.reason);
    expect(applied.document).toEqual({ x: 1 });
    expect(Object.prototype.hasOwnProperty.call(applied.document, '__proto__')).toBe(false);
  });

  it('test 操作触及 __proto__ 自有键时按自有值断言', () => {
    const doc = parse('{"__proto__":{"a":1}}');
    const parsed = parseJsonPatch(
      JSON.stringify([{ op: 'test', path: '/__proto__', value: { a: 1 } }]),
    );
    if (!parsed.ok) throw new Error('补丁解析失败');
    const applied = applyJsonPatch(doc, parsed.ops);
    expect(applied.ok).toBe(true);
  });

  it('move / copy 触及 __proto__ 路径时按自有键语义执行', () => {
    const base = parse('{"__proto__":{"a":1},"z":2}');
    const ops = [
      { op: 'move', from: '/z', path: '/__proto__/z' },
      { op: 'copy', from: '/__proto__/a', path: '/__proto__/a2' },
    ];
    const parsed = parseJsonPatch(JSON.stringify(ops));
    if (!parsed.ok) throw new Error('补丁解析失败');
    const applied = applyJsonPatch(base, parsed.ops);
    if (!applied.ok) throw new Error(applied.failure.reason);
    expect(JSON.parse(JSON.stringify(applied.document))).toEqual(
      parse('{"__proto__":{"a":1,"z":2,"a2":1}}'),
    );
  });

  it('补丁审计：生成的补丁回放结果与合并文档逐值一致', () => {
    const base = parse('{}');
    const ours = parse('{"__proto__":{"a":1}}');
    const theirs = parse('{"__proto__":{"b":2}}');
    const merged = buildMerged(threeWayMerge(base, ours, theirs).root, {}) as JsonValue;
    const ops = diff(base, merged);
    const result = auditPatch(JSON.stringify(ops), base, merged);
    expect(result.kind).toBe('pass');
  });
});

describe('原型污染防护', () => {
  it('任何合并路径都不会在 Object.prototype 上留下新增属性', () => {
    const cases: Array<[string, string, string]> = [
      ['{}', '{"__proto__":{"polluted":true}}', '{"__proto__":{"x":1}}'],
      ['{}', '{"constructor":{"prototype":{"p":1}}}', '{}'],
      ['{}', '{"toString":{"y":1}}', '{"toString":{"z":2}}'],
    ];
    for (const [b, o, t] of cases) {
      const r = threeWayMerge(parse(b), parse(o), parse(t));
      const res: Resolutions = {};
      r.conflicts.forEach((c, i) => (res[c.id] = i % 2 === 0 ? { kind: 'ours' } : { kind: 'theirs' }));
      buildMerged(r.root, res);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });
});
