import { describe, expect, it } from 'vitest';
import { compilePattern } from './batchRules';
import { buildDecisionTrace, type TraceEntry } from './decisionTrace';
import { parsePointer } from './pointer';
import {
  computeProtectedHits,
  matchesProperDescendant,
  parseProtectedRules,
  ruleHitsEntry,
} from './protectedPaths';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import { ABSENT, type JsonValue } from './types';

/** 构造一个最小变更条目（仅匹配相关字段有意义；路径段按 RFC 6901 反转义，与真实溯源条目一致） */
function entry(pointer: string, change: TraceEntry['change']): TraceEntry {
  return {
    pointer,
    segments: parsePointer(pointer),
    source: 'ours-only',
    change,
    base: ABSENT,
    ours: ABSENT,
    theirs: ABSENT,
    final: ABSENT,
  };
}

const hits = (pattern: string, e: TraceEntry) => ruleHitsEntry(compilePattern(pattern), e);

const mp = (pattern: string, pointer: string) =>
  matchesProperDescendant(compilePattern(pattern), parsePointer(pointer));

/** 用真实三方合并生成决策溯源条目（测试用例必须无未解决冲突） */
function trace(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
  resolutions: Resolutions = {},
): TraceEntry[] {
  const result = threeWayMerge(base, ours, theirs);
  const merged = buildMerged(result.root, resolutions);
  if (merged === undefined || merged === ABSENT) throw new Error('测试用例必须全部解决冲突');
  return buildDecisionTrace(result, resolutions, merged);
}

describe('parseProtectedRules 逐行解析', () => {
  it('空行忽略，行号按原始文本计，首尾空白去除', () => {
    const { rules, errors } = parseProtectedRules('\n/a/b\n\n  /c/*  \n');
    expect(errors).toEqual([]);
    expect(rules.map((r) => [r.line, r.pattern])).toEqual([
      [2, '/a/b'],
      [4, '/c/*'],
    ]);
  });

  it('非法行进入 errors（含行号与原因），合法行仍编译为规则', () => {
    const { rules, errors } = parseProtectedRules('/ok\nnot-a-pointer\n/a~2b\n');
    expect(rules.map((r) => r.pattern)).toEqual(['/ok']);
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2);
    expect(errors[0].pattern).toBe('not-a-pointer');
    expect(errors[0].message).toContain('必须以 / 开头');
    expect(errors[1].line).toBe(3);
    expect(errors[1].message).toContain('非法 RFC 6901 转义');
  });

  it('空配置 → 无规则无错误', () => {
    const { rules, errors } = parseProtectedRules('  \n\n');
    expect(rules).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('ruleHitsEntry 命中语义', () => {
  it('精确命中变更路径本身', () => {
    expect(hits('/a/b', entry('/a/b', 'replace'))).toBe(true);
    expect(hits('/a/b', entry('/a/c', 'replace'))).toBe(false);
  });

  it('子路径变更命中受保护的父路径（任意变更类型）', () => {
    expect(hits('/a', entry('/a/b', 'replace'))).toBe(true);
    expect(hits('/a', entry('/a/b', 'add'))).toBe(true);
    expect(hits('/a', entry('/a/b/c', 'remove'))).toBe(true);
    // 兄弟路径不命中
    expect(hits('/a', entry('/b', 'replace'))).toBe(false);
  });

  it('父路径整体替换 / 删除命中任一后代保护规则', () => {
    expect(hits('/a/b', entry('/a', 'replace'))).toBe(true);
    expect(hits('/a/b/c', entry('/a', 'remove'))).toBe(true);
    // 深层祖先的替换同样命中
    expect(hits('/a/b/c', entry('', 'replace'))).toBe(true);
  });

  it('父路径新增不命中后代保护规则（基线中该子树本不存在）', () => {
    expect(hits('/a/b', entry('/a', 'add'))).toBe(false);
    expect(hits('/a/b/c', entry('/a', 'add'))).toBe(false);
  });

  it('整段 * 与 ** 通配参与两个方向的匹配', () => {
    expect(hits('/*', entry('/a', 'replace'))).toBe(true);
    // 子路径 /a/b 的祖先 /a 命中 /*
    expect(hits('/*', entry('/a/b', 'replace'))).toBe(true);
    expect(hits('/a/*/c', entry('/a/b/c', 'replace'))).toBe(true);
    expect(hits('/a/**', entry('/a/b/c', 'add'))).toBe(true);
    // 父路径替换命中带通配的后代规则
    expect(hits('/a/*/c', entry('/a', 'remove'))).toBe(true);
    expect(hits('/**/c', entry('/a', 'replace'))).toBe(true);
    expect(hits('/a/**', entry('/a/b', 'replace'))).toBe(true);
  });

  it('/** 命中根节点变更；/a/** 不命中无关子树', () => {
    expect(hits('/**', entry('', 'replace'))).toBe(true);
    expect(hits('/a/**', entry('/b', 'replace'))).toBe(false);
  });

  it('RFC 6901 转义段按字面量匹配', () => {
    expect(hits('/a~1b', entry('/a~1b', 'replace'))).toBe(true);
    expect(hits('/a~1b', entry('/a/b', 'replace'))).toBe(false);
    expect(hits('/a~0c', entry('/a~0c', 'remove'))).toBe(true);
  });
});

describe('matchesProperDescendant 真后代匹配', () => {
  it('字面量后代：P 必须是规则路径的真前缀', () => {
    expect(mp('/a/b', '/a')).toBe(true);
    expect(mp('/a/b', '/a/b')).toBe(false); // 自身不是真后代
    expect(mp('/a', '/a')).toBe(false);
    expect(mp('/a/b', '/x')).toBe(false);
    expect(mp('/a/b', '/a/b/c')).toBe(false); // P 比规则路径更深
  });

  it('** 结尾的规则命中任意深度后代', () => {
    expect(mp('/a/**', '/a')).toBe(true);
    expect(mp('/a/**', '/a/b')).toBe(true);
    expect(mp('/**', '')).toBe(true);
  });

  it('根路径的真后代是全部非根路径', () => {
    expect(mp('/a', '')).toBe(true);
    expect(mp('/*', '')).toBe(true);
    expect(mp('/a/b', '')).toBe(true);
  });

  it('* 段在后代匹配中占恰好一段', () => {
    expect(mp('/a/*', '/a')).toBe(true);
    expect(mp('/a/*/c', '/a/b')).toBe(true);
    expect(mp('/a/*', '/a/b')).toBe(false); // 规则深度已用尽，/a/b 之后无剩余段可匹配
  });
});

describe('computeProtectedHits 以决策溯源为输入', () => {
  it('重复命中按变更路径合并：同一变更命中多条规则时合并为一项', () => {
    // /a 被整体替换（对象 → 标量），/c 新增
    const entries = trace({ a: { b: 1 }, d: 1 }, { a: 9, c: 1, d: 1 }, { a: { b: 1 }, d: 1 });
    const { rules, errors } = parseProtectedRules('/a/b\n/c\n/a\n');
    expect(errors).toEqual([]);
    const hits = computeProtectedHits(entries, rules);
    expect(hits.map((h) => h.entry.pointer)).toEqual(['/a', '/c']);
    // /a（replace）命中 /a/b（后代规则）与 /a（自身），合并展示
    expect(hits[0].rules.map((r) => r.pattern)).toEqual(['/a/b', '/a']);
    expect(hits[0].entry.change).toBe('replace');
    // /c（add）仅命中 /c；新增不波及 /a/b 之类的后代规则
    expect(hits[1].rules.map((r) => r.pattern)).toEqual(['/c']);
    expect(hits[1].entry.change).toBe('add');
  });

  it('父路径整体删除命中后代保护规则，并保留来源分类', () => {
    const entries = trace({ a: { b: 1 } }, {}, { a: { b: 1 } });
    const { rules } = parseProtectedRules('/a/b\n');
    const hits = computeProtectedHits(entries, rules);
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.pointer).toBe('/a');
    expect(hits[0].entry.change).toBe('remove');
    expect(hits[0].entry.source).toBe('ours-only');
  });

  it('冲突解决后的最终变更同样参与命中', () => {
    const entries = trace({ a: 1 }, { a: 2 }, { a: 3 }, { c0: { kind: 'theirs' } });
    const { rules } = parseProtectedRules('/a\n');
    const hits = computeProtectedHits(entries, rules);
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.source).toBe('conflict-theirs');
    expect(hits[0].entry.final).toBe(3);
  });

  it('未变更路径与未命中规则不产生命中项；空规则 → 无命中', () => {
    const entries = trace({ a: 1, b: 2 }, { a: 9, b: 2 }, { a: 1, b: 2 });
    const { rules } = parseProtectedRules('/b\n/c\n');
    expect(computeProtectedHits(entries, rules)).toEqual([]);
    expect(computeProtectedHits(entries, [])).toEqual([]);
  });

  it('新增 null 的变更进入溯源清单并命中保护规则（不被当作缺失漏报）', () => {
    const entries = trace({}, { a: null }, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].change).toBe('add');
    expect(entries[0].final).toBeNull();
    const { rules } = parseProtectedRules('/a\n');
    const hits = computeProtectedHits(entries, rules);
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.pointer).toBe('/a');
    expect(hits[0].entry.change).toBe('add');
  });

  it('已有值改为 null 记为替换：命中自身与后代保护规则', () => {
    const entries = trace({ a: 1 }, { a: null }, { a: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].change).toBe('replace');
    const { rules } = parseProtectedRules('/a\n/a/b\n');
    const hits = computeProtectedHits(entries, rules);
    expect(hits).toHaveLength(1);
    // 变更形态为 replace：命中自身规则 /a，且整体替换波及后代规则 /a/b
    expect(hits[0].rules.map((r) => r.pattern)).toEqual(['/a', '/a/b']);
  });
});
