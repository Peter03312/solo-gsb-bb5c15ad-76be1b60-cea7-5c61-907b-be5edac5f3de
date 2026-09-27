import { unescapeSegment } from './pointer';
import type { Conflict, Resolution } from './threeWayMerge';

/** 批量决策规则的采用侧：ours = 采用当前分支，theirs = 采用目标分支 */
export type BatchChoice = 'ours' | 'theirs';

/** 一条批量决策规则 */
export interface BatchRule {
  /** JSON Pointer 模式（以 / 开头，支持 * 与 ** 段通配） */
  pattern: string;
  choice: BatchChoice;
}

/** 非法模式时抛出 */
export class BatchRulePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRulePatternError';
  }
}

/** 模式路径段：字面量段或通配段 */
export type PatternSegment =
  | { type: 'literal'; value: string }
  | { type: '*' }
  | { type: '**' };

/**
 * 校验并解析一条 JSON Pointer 模式。
 *
 * 规则：
 * - 必须以 `/` 开头（根指针 `""` 无法直接写出，但 `/**` 以零段方式命中根冲突）；
 * - 各路径段遵循 RFC 6901 转义（`~0` / `~1`，`~` 后只能跟 `0` 或 `1`）；
 * - 反转义后的整段恰为 `*` 时匹配恰好一个完整路径段；
 * - 反转义后的整段恰为 `**` 时匹配零个或多个完整路径段；
 * - 段内出现的 `*`（如 `a*`）按普通字面量处理；键本身恰好为 `*` / `**` 的节点无法用模式区分。
 */
export function compilePattern(pattern: string): PatternSegment[] {
  if (typeof pattern !== 'string' || pattern === '' || !pattern.startsWith('/')) {
    throw new BatchRulePatternError('模式必须以 / 开头（JSON Pointer，根节点冲突可用 /** 命中）');
  }
  const rawSegments = pattern.slice(1).split('/');
  const segments: PatternSegment[] = [];
  for (const raw of rawSegments) {
    // 严格校验 RFC 6901 转义：unescapeSegment 不报错，这里显式检查 ~ 后的字符
    if (/~[^01]/.test(raw) || /~$/.test(raw)) {
      throw new BatchRulePatternError(
        `路径段 "${raw}" 含非法 RFC 6901 转义：~ 后只能为 0 或 1`,
      );
    }
    // 通配只在原始段（转义形式）恰为 * / ** 时成立；~0* 等是包含星号的字面量
    if (raw === '*') {
      segments.push({ type: '*' });
    } else if (raw === '**') {
      segments.push({ type: '**' });
    } else {
      segments.push({ type: 'literal', value: unescapeSegment(raw) });
    }
  }
  return segments;
}

/** 判断模式段序列是否与实际冲突路径段序列匹配 */
export function matchSegments(pattern: PatternSegment[], target: string[]): boolean {
  // 动态规划：dp[i][j] = 模式前 i 段是否匹配目标前 j 段
  const pi = pattern.length;
  const ti = target.length;
  const dp: boolean[][] = Array.from({ length: pi + 1 }, () =>
    new Array<boolean>(ti + 1).fill(false),
  );
  dp[0][0] = true;
  for (let i = 1; i <= pi; i++) {
    const seg = pattern[i - 1];
    for (let j = 0; j <= ti; j++) {
      if (seg.type === '**') {
        // ** 匹配零段（沿用 dp[i-1][j]）或至少一段（沿用 dp[i][j-1]）
        dp[i][j] = dp[i - 1][j] || (j > 0 && dp[i][j - 1]);
      } else if (j > 0) {
        const matchOne = seg.type === '*' || seg.value === target[j - 1];
        dp[i][j] = dp[i - 1][j - 1] && matchOne;
      }
    }
  }
  return dp[pi][ti];
}

/** 判断模式字符串是否命中某个冲突路径；非法模式返回 false（错误由编译处另行报告） */
export function patternMatches(pattern: string, targetSegments: string[]): boolean {
  try {
    return matchSegments(compilePattern(pattern), targetSegments);
  } catch {
    return false;
  }
}

/** 一条规则对单个冲突的命中信息（用于预览） */
export interface RuleHit {
  conflictId: string;
  pointer: string;
  /** 命中时该冲突是否尚无选择（本次应用会处理的对象） */
  pending: boolean;
}

/** 单条规则的预览统计 */
export interface RulePreview {
  rule: BatchRule;
  hits: RuleHit[];
  /** 命中的冲突总数 */
  total: number;
  /** 其中尚未选择的冲突数 */
  pending: number;
}

/** 同时命中多条规则的冲突 */
export interface OverlappingConflict {
  conflictId: string;
  pointer: string;
  /** 命中的规则序号（自 0 起，自上而下） */
  ruleIndexes: number[];
  pending: boolean;
}

export interface BatchPreview {
  /** 与输入规则一一对应的预览（仅对编译成功的规则计算命中） */
  rules: RulePreview[];
  /** 同时命中两条及以上规则的冲突 */
  overlapping: OverlappingConflict[];
  /** 按自上而下首条命中、且尚未选择的冲突，本次应用将会处理的数量 */
  willApply: number;
}

/**
 * 依据规则列表对冲突做预览分析：每条规则命中数量、多规则重叠冲突、本次应用数量。
 * rules 应为编译可通过的规则（非法模式请先在编辑区报错并阻止应用）。
 */
export function previewBatchRules(
  rules: BatchRule[],
  conflicts: Conflict[],
  resolutions: Record<string, Resolution>,
): BatchPreview {
  const compiled = rules.map((r) => compilePattern(r.pattern));
  const previews: RulePreview[] = rules.map((rule) => ({ rule, hits: [], total: 0, pending: 0 }));
  /** conflictId -> 命中的规则序号 */
  const hitMap = new Map<string, { pointer: string; ruleIndexes: number[] }>();

  conflicts.forEach((conflict) => {
    compiled.forEach((segments, ruleIdx) => {
      if (!matchSegments(segments, conflict.segments)) return;
      const pending = !resolutions[conflict.id];
      previews[ruleIdx].hits.push({ conflictId: conflict.id, pointer: conflict.pointer, pending });
      previews[ruleIdx].total++;
      if (pending) previews[ruleIdx].pending++;
      const entry = hitMap.get(conflict.id) ?? { pointer: conflict.pointer, ruleIndexes: [] };
      entry.ruleIndexes.push(ruleIdx);
      hitMap.set(conflict.id, entry);
    });
  });

  const overlapping: OverlappingConflict[] = [];
  let willApply = 0;
  for (const conflict of conflicts) {
    const entry = hitMap.get(conflict.id);
    if (!entry) continue;
    if (entry.ruleIndexes.length >= 2) {
      overlapping.push({
        conflictId: conflict.id,
        pointer: entry.pointer,
        ruleIndexes: entry.ruleIndexes,
        pending: !resolutions[conflict.id],
      });
    }
    // 首条命中规则的选择与现有选择不同也不计入：已有选择绝不覆盖
    if (!resolutions[conflict.id]) willApply++;
  }

  return { rules: previews, overlapping, willApply };
}

export interface ApplyBatchResult {
  /** 应用后的完整 resolutions（新对象，不修改入参） */
  resolutions: Record<string, Resolution>;
  /** 本次新写入选择的冲突 id（按冲突列表顺序） */
  applied: string[];
  /** 已有手动 / 快照恢复选择而跳过的冲突 id */
  skippedResolved: string[];
}

/**
 * 按规则自上而下为尚未选择的冲突写入选择：
 * - 每个冲突只取**首条命中**的规则；
 * - 已存在选择（手动选择、自定义值或快照恢复）的冲突一律跳过，绝不覆盖；
 * - 应用结果只是普通选择，之后仍可在冲突面板逐项改选。
 */
export function applyBatchRules(
  rules: BatchRule[],
  conflicts: Conflict[],
  resolutions: Record<string, Resolution>,
): ApplyBatchResult {
  const compiled = rules.map((r) => compilePattern(r.pattern));
  const next: Record<string, Resolution> = { ...resolutions };
  const applied: string[] = [];
  const skippedResolved: string[] = [];

  for (const conflict of conflicts) {
    if (resolutions[conflict.id]) {
      // 仍记录是否被规则命中过，便于界面说明“为什么这项没被批量改动”
      if (compiled.some((segments) => matchSegments(segments, conflict.segments))) {
        skippedResolved.push(conflict.id);
      }
      continue;
    }
    const idx = compiled.findIndex((segments) => matchSegments(segments, conflict.segments));
    if (idx < 0) continue;
    const choice = rules[idx].choice;
    next[conflict.id] = { kind: choice };
    applied.push(conflict.id);
  }

  return { resolutions: next, applied, skippedResolved };
}
