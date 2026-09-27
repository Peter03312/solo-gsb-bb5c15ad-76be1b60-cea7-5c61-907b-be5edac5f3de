import { compilePattern, matchSegments, type PatternSegment } from './batchRules';
import type { TraceEntry } from './decisionTrace';

/**
 * 输出阶段的「受保护路径检查」：用户逐行配置 RFC 6901 路径模式（支持整段 * 与 **，
 * 语法与批量决策规则一致），以决策溯源的最终变更为输入计算命中；
 * 命中的变更必须逐项确认后才允许下载 merged.json / patch.json。
 *
 * 命中语义（变更路径 P，规则模式 R）：
 * - R 匹配 P 本身或 P 的任一祖先路径（子路径变更命中受保护的父路径）；
 * - P 为整体替换 / 删除时，R 匹配 P 的任一真后代路径
 *   （父路径整体替换或删除会波及其下所有受保护的后代路径；新增不波及，
 *   因为基线中该子树本不存在）。
 * 同一变更路径命中多条规则时按变更路径合并为一条命中项。
 */

/** 一条受保护路径规则（配置文本中的一个非空行） */
export interface ProtectedRule {
  /** 在配置文本中的行号（自 1 起） */
  line: number;
  /** 模式原文（已去除首尾空白） */
  pattern: string;
  /** 编译后的模式段 */
  segments: PatternSegment[];
}

/** 配置文本中某一行的解析错误 */
export interface ProtectedRuleError {
  /** 行号（自 1 起） */
  line: number;
  /** 该行原文（已去除首尾空白） */
  pattern: string;
  message: string;
}

/**
 * 逐行解析受保护路径配置：空行忽略；每行必须是一条合法的 JSON Pointer 模式
 * （以 / 开头、遵循 RFC 6901 转义、整段 * / ** 通配）。
 * 合法行进入 rules，非法行进入 errors（含行号与原因）；
 * 调用方在 errors 非空时就地提示，且不得更新有效规则。
 */
export function parseProtectedRules(text: string): {
  rules: ProtectedRule[];
  errors: ProtectedRuleError[];
} {
  const rules: ProtectedRule[] = [];
  const errors: ProtectedRuleError[] = [];
  text.split('\n').forEach((rawLine, i) => {
    const pattern = rawLine.trim();
    if (pattern === '') return;
    const line = i + 1;
    try {
      rules.push({ line, pattern, segments: compilePattern(pattern) });
    } catch (err) {
      errors.push({
        line,
        pattern,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { rules, errors };
}

/** 规则是否命中路径 P 本身或 P 的某个祖先：子路径变更命中受保护的父路径 */
export function matchesAncestorOrSelf(segments: PatternSegment[], target: string[]): boolean {
  for (let j = 0; j <= target.length; j++) {
    if (matchSegments(segments, target.slice(0, j))) return true;
  }
  return false;
}

/**
 * 规则是否命中路径 P 的某个真后代（P 是真前缀）。
 *
 * 用 NFA 模拟模式对 P 的匹配：状态为「已消费的模式段数」，** 段既可吸收当前段
 * 也可在此结束（ε 闭包沿连续的 ** 段传播）。消费完 P 后若仍可达某个未走完模式的
 * 状态 i（i < 段数），则剩余模式段总能再匹配至少一段（字面量 / * 占一段，
 * ** 至少可吸收一段），即存在一条以 P 为真前缀且被规则命中的后代路径。
 */
export function matchesProperDescendant(segments: PatternSegment[], target: string[]): boolean {
  const n = segments.length;
  if (n === 0) return false;
  const close = (states: Set<number>): Set<number> => {
    for (let i = 0; i < n; i++) {
      if (states.has(i) && segments[i].type === '**') states.add(i + 1);
    }
    return states;
  };
  let states = close(new Set([0]));
  for (const seg of target) {
    const next = new Set<number>();
    for (const i of states) {
      if (i >= n) continue;
      const r = segments[i];
      if (r.type === '**') {
        next.add(i); // ** 继续吸收后续段
        next.add(i + 1); // ** 止于本段
      } else if (r.type === '*' || r.value === seg) {
        next.add(i + 1);
      }
    }
    if (next.size === 0) return false;
    states = close(next);
  }
  for (const i of states) if (i < n) return true;
  return false;
}

/** 一条规则是否命中一个变更条目 */
export function ruleHitsEntry(segments: PatternSegment[], entry: TraceEntry): boolean {
  if (matchesAncestorOrSelf(segments, entry.segments)) return true;
  // 父路径整体替换 / 删除会波及其下全部受保护后代；新增不波及（基线中本不存在）
  if (entry.change === 'replace' || entry.change === 'remove') {
    return matchesProperDescendant(segments, entry.segments);
  }
  return false;
}

/** 一条命中项：同一变更路径命中的全部规则合并展示 */
export interface ProtectedHit {
  /** 命中的变更（决策溯源条目，变更路径在清单中唯一） */
  entry: TraceEntry;
  /** 命中该变更的规则（按配置行号升序） */
  rules: ProtectedRule[];
}

/**
 * 以决策溯源的最终变更为输入计算命中清单：
 * 每个变更路径至多产生一条命中项，命中多条规则时合并到同一项。
 */
export function computeProtectedHits(
  entries: TraceEntry[],
  rules: ProtectedRule[],
): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const entry of entries) {
    const matched = rules.filter((rule) => ruleHitsEntry(rule.segments, entry));
    if (matched.length > 0) hits.push({ entry, rules: matched });
  }
  return hits;
}
