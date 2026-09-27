import { describe, expect, it } from 'vitest';
import {
  applyBatchRules,
  BatchRulePatternError,
  compilePattern,
  matchSegments,
  patternMatches,
  previewBatchRules,
  type BatchRule,
} from './batchRules';
import { threeWayMerge, type Conflict, type Resolutions } from './threeWayMerge';
import { ABSENT, type JsonValue } from './types';

function compile(pattern: string) {
  return compilePattern(pattern);
}

/** 构造一批位于指定路径的冲突（base 两侧都不同即可） */
function conflictsAt(pointers: string[]): Conflict[] {
  return pointers.map((pointer, i) => ({
    id: `c${i}`,
    pointer,
    segments: pointer === '' ? [] : pointer.slice(1).split('/'),
    base: ABSENT,
    ours: ABSENT,
    theirs: ABSENT,
    reason: '测试冲突',
  }));
}

describe('compilePattern', () => {
  it('必须以 / 开头', () => {
    expect(() => compile('')).toThrow(BatchRulePatternError);
    expect(() => compile('a/b')).toThrow(/必须以 \/ 开头/);
  });

  it('解析普通段与 RFC 6901 转义段', () => {
    expect(compile('/a/b')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'literal', value: 'b' },
    ]);
    expect(compile('/a~1b/~0c')).toEqual([
      { type: 'literal', value: 'a/b' },
      { type: 'literal', value: '~c' },
    ]);
    // 末尾 / 表示空字符串键
    expect(compile('/a/')).toEqual([
      { type: 'literal', value: 'a' },
      { type: 'literal', value: '' },
    ]);
  });

  it('拒绝非法 RFC 6901 转义', () => {
    expect(() => compile('/a~2b')).toThrow(/非法 RFC 6901 转义/);
    expect(() => compile('/a~')).toThrow(/非法 RFC 6901 转义/);
    expect(() => compile('/a~/b')).toThrow(/非法 RFC 6901 转义/);
  });

  it('整段恰为 * / ** 才是通配；段内星号按字面量处理', () => {
    expect(compile('/*')).toEqual([{ type: '*' }]);
    expect(compile('/**')).toEqual([{ type: '**' }]);
    expect(compile('/a*')).toEqual([{ type: 'literal', value: 'a*' }]);
    expect(compile('/a**/b')).toEqual([
      { type: 'literal', value: 'a**' },
      { type: 'literal', value: 'b' },
    ]);
    // 转义后的 ~ 与星号相邻仍是普通字面量段
    expect(compile('/a~0*')).toEqual([{ type: 'literal', value: 'a~*' }]);
  });
});

describe('matchSegments', () => {
  it('字面量段精确匹配', () => {
    expect(patternMatches('/a/b', ['a', 'b'])).toBe(true);
    expect(patternMatches('/a/b', ['a', 'c'])).toBe(false);
    expect(patternMatches('/a/b', ['a'])).toBe(false);
    expect(patternMatches('/a', ['a', 'b'])).toBe(false);
  });

  it('* 匹配恰好一个完整路径段，不跨 / 、不匹配零段', () => {
    expect(patternMatches('/*', ['a'])).toBe(true);
    expect(patternMatches('/*', ['a', 'b'])).toBe(false);
    expect(patternMatches('/*', [])).toBe(false);
    expect(patternMatches('/*/b', ['a', 'b'])).toBe(true);
    expect(patternMatches('/*/b', ['x', 'b'])).toBe(true);
    expect(patternMatches('/*/b', ['a', 'x'])).toBe(false);
    expect(patternMatches('/a/*/c', ['a', 'b', 'c'])).toBe(true);
    // 段内的 / 经转义后是键的一部分，* 不能越过它
    expect(patternMatches('/*', ['a/b'])).toBe(true);
    expect(patternMatches('/*', ['a', 'b'])).toBe(false);
  });

  it('** 匹配零个或多个完整路径段（零段时亦可命中根指针）', () => {
    expect(patternMatches('/**', [])).toBe(true);
    expect(patternMatches('/**', ['a'])).toBe(true);
    expect(patternMatches('/**', ['a', 'b', 'c'])).toBe(true);
    expect(patternMatches('/a/**/b', ['a', 'b'])).toBe(true);
    expect(patternMatches('/a/**/b', ['a', 'x', 'y', 'b'])).toBe(true);
    expect(patternMatches('/a/**/b', ['a', 'b', 'c'])).toBe(false);
    expect(patternMatches('/**/c', ['a', 'b', 'c'])).toBe(true);
    expect(patternMatches('/**/c', ['c'])).toBe(true);
  });

  it('RFC 6901 转义后的段按反转义值匹配', () => {
    expect(patternMatches('/a~1b', ['a/b'])).toBe(true);
    expect(patternMatches('/~0x', ['~x'])).toBe(true);
  });

  it('非法模式返回 false 而不抛出', () => {
    expect(patternMatches('bad', ['a'])).toBe(false);
    expect(patternMatches('/a~2', ['a'])).toBe(false);
  });

  it('重复 ** 段独立工作', () => {
    const p = compile('/a/**/b/**/c');
    expect(matchSegments(p, ['a', 'b', 'c'])).toBe(true);
    expect(matchSegments(p, ['a', 'x', 'b', 'y', 'z', 'c'])).toBe(true);
    expect(matchSegments(p, ['a', 'x', 'c'])).toBe(false);
  });
});

describe('previewBatchRules', () => {
  const rules: BatchRule[] = [
    { pattern: '/services/*/name', choice: 'ours' },
    { pattern: '/services/**', choice: 'theirs' },
    { pattern: '/meta', choice: 'ours' },
  ];

  it('按规则统计命中数量（含已解决 / 未解决拆分）', () => {
    const conflicts = conflictsAt([
      '/services/api/name',
      '/services/web/name',
      '/services/api/port',
      '/meta',
      '/other',
    ]);
    const resolutions: Resolutions = { c1: { kind: 'theirs' } };
    const preview = previewBatchRules(rules, conflicts, resolutions);

    expect(preview.rules.map((r) => r.total)).toEqual([2, 3, 1]);
    // c1（/services/web/name）已有选择，规则 0 待处理 1 条；规则 1 中 c1 也已解决
    expect(preview.rules.map((r) => r.pending)).toEqual([1, 2, 1]);
    // 将被处理的待处理冲突：c0、c2、c3（c1 已选择，c4 无命中）
    expect(preview.willApply).toBe(3);
  });

  it('单列同时命中多条规则的冲突', () => {
    const conflicts = conflictsAt([
      '/services/api/name', // 命中规则 0、1
      '/services/api/port', // 仅命中规则 1
    ]);
    const preview = previewBatchRules(rules, conflicts, {});
    expect(preview.overlapping).toEqual([
      {
        conflictId: 'c0',
        pointer: '/services/api/name',
        ruleIndexes: [0, 1],
        pending: true,
      },
    ]);
  });

  it('已有选择的重叠冲突标记为非待处理', () => {
    const conflicts = conflictsAt(['/services/api/name']);
    const resolutions: Resolutions = { c0: { kind: 'custom', value: 1 } };
    const preview = previewBatchRules(rules, conflicts, resolutions);
    expect(preview.overlapping[0].pending).toBe(false);
    expect(preview.willApply).toBe(0);
  });

  it('非法模式在预览阶段抛出，由编辑区就地报错', () => {
    const conflicts = conflictsAt(['/a']);
    expect(() =>
      previewBatchRules([{ pattern: 'no-slash', choice: 'ours' }], conflicts, {}),
    ).toThrow(BatchRulePatternError);
  });
});

describe('applyBatchRules', () => {
  const rules: BatchRule[] = [
    { pattern: '/services/*/name', choice: 'ours' },
    { pattern: '/services/**', choice: 'theirs' },
  ];

  it('自上而下取首条命中规则', () => {
    const conflicts = conflictsAt(['/services/api/name', '/services/api/port']);
    const { resolutions, applied } = applyBatchRules(rules, conflicts, {});
    expect(applied).toEqual(['c0', 'c1']);
    expect(resolutions.c0).toEqual({ kind: 'ours' }); // 首条规则
    expect(resolutions.c1).toEqual({ kind: 'theirs' });
  });

  it('不覆盖已有手动或快照恢复的选择，并记录跳过', () => {
    const conflicts = conflictsAt(['/services/api/name', '/services/api/port']);
    const existing: Resolutions = {
      c0: { kind: 'theirs' }, // 手动 / 快照恢复的选择
    };
    const result = applyBatchRules(rules, conflicts, existing);
    expect(result.resolutions.c0).toEqual({ kind: 'theirs' });
    expect(result.resolutions.c1).toEqual({ kind: 'theirs' });
    expect(result.applied).toEqual(['c1']);
    expect(result.skippedResolved).toEqual(['c0']);
    // 入参不被修改
    expect(existing.c1).toBeUndefined();
  });

  it('无命中的冲突保持未选择；再次应用是幂等的', () => {
    const conflicts = conflictsAt(['/other']);
    const first = applyBatchRules(rules, conflicts, {});
    expect(first.applied).toEqual([]);
    expect(first.resolutions.c0).toBeUndefined();
    const second = applyBatchRules(rules, conflicts, first.resolutions);
    expect(second.applied).toEqual([]);
  });

  it('自定义值选择同样不会被批量规则覆盖', () => {
    const conflicts = conflictsAt(['/services/api/name']);
    const existing: Resolutions = { c0: { kind: 'custom', value: 42 } };
    const result = applyBatchRules(rules, conflicts, existing);
    expect(result.resolutions.c0).toEqual({ kind: 'custom', value: 42 });
    expect(result.applied).toEqual([]);
  });

  it('与真实三方合并结果集成：按冲突 segments 命中', () => {
    const base: JsonValue = { services: { api: { name: 'a', port: 80 } } };
    const ours: JsonValue = { services: { api: { name: 'ours-name', port: 81 } } };
    const theirs: JsonValue = { services: { api: { name: 'theirs-name', port: 82 } } };
    const merge = threeWayMerge(base, ours, theirs);
    expect(merge.conflicts).toHaveLength(2);

    const batchRules: BatchRule[] = [{ pattern: '/services/*/name', choice: 'ours' }];
    const { resolutions, applied } = applyBatchRules(batchRules, merge.conflicts, {});
    expect(applied).toHaveLength(1);
    const nameConflict = merge.conflicts.find((c) => c.pointer === '/services/api/name')!;
    expect(resolutions[nameConflict.id]).toEqual({ kind: 'ours' });
  });
});
