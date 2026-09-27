import { deepEqual } from './deepEqual';
import { getBySegments, toPointer } from './pointer';
import { isPlainObject, ABSENT, isAbsent, type JsonValue, type SideValue } from './types';
import type { MergeResult, Resolution, Resolutions } from './threeWayMerge';

/**
 * 输出阶段的「决策溯源」：按最终结果相对基线的变更路径生成清单，
 * 逐项归类为仅当前 / 仅目标 / 双方同改 / 冲突解决（采用当前、采用目标、自定义）。
 *
 * 判定顺序与 threeWayMerge.mergeValue 一致；对一侧整体采用的对象子树补做按键展开到叶子，
 * 而父节点整体替换或删除（含冲突裁决、数组 / 标量）停在父路径记一条，
 * 因此不会重复列出随父节点失效的子路径。冲突 id 经「指针 → 冲突」映射核对。
 */

/** 来源大类 */
export type TraceSource =
  | 'ours-only' // 仅当前分支修改
  | 'theirs-only' // 仅目标分支修改
  | 'both' // 双方同改（改成相同值，含双方都删除）
  | 'conflict-ours' // 冲突解决：采用当前分支
  | 'conflict-theirs' // 冲突解决：采用目标分支
  | 'conflict-custom'; // 冲突解决：自定义值

/** 最终值相对基线的变更形态 */
export type ChangeKind = 'add' | 'remove' | 'replace';

/** 溯源清单项 */
export interface TraceEntry {
  /** RFC 6901 JSON Pointer，根为 '' */
  pointer: string;
  /** 从根到本节点的路径段（未转义） */
  segments: string[];
  source: TraceSource;
  change: ChangeKind;
  /** 基线侧值；ABSENT 表示基线中不存在 */
  base: SideValue;
  /** 当前分支侧值；ABSENT 表示该侧缺失（删除 / 从未存在） */
  ours: SideValue;
  /** 目标分支侧值；ABSENT 表示该侧缺失 */
  theirs: SideValue;
  /** 最终合并结果值；ABSENT 表示最终被删除 */
  final: SideValue;
  /** 冲突项才有：冲突 id */
  conflictId?: string;
  /** 冲突项才有：实际采用的解决方案 */
  resolution?: Resolution;
}

export const TRACE_FILTERS: { key: TraceSource; label: string }[] = [
  { key: 'ours-only', label: '仅当前分支' },
  { key: 'theirs-only', label: '仅目标分支' },
  { key: 'both', label: '双方同改' },
  { key: 'conflict-ours', label: '冲突解决 · 采用当前' },
  { key: 'conflict-theirs', label: '冲突解决 · 采用目标' },
  { key: 'conflict-custom', label: '冲突解决 · 自定义' },
];

export const SOURCE_LABEL: Record<TraceSource, string> = {
  'ours-only': '仅当前分支',
  'theirs-only': '仅目标分支',
  both: '双方同改',
  'conflict-ours': '冲突解决（采用当前）',
  'conflict-theirs': '冲突解决（采用目标）',
  'conflict-custom': '冲突解决（自定义）',
};

function classifyChange(base: SideValue, final: SideValue): ChangeKind {
  if (isAbsent(base)) return 'add';
  if (isAbsent(final)) return 'remove';
  return 'replace';
}

/**
 * 生成决策溯源清单。
 *
 * 判定与递归结构完全沿用 threeWayMerge.mergeValue 的顺序，但对一侧整体采用的对象子树
 * 也按键展开到叶子（mergeValue 因短路只给出整体节点）：
 * 1. 双方一致（含都删除、改成相同值）→ 最终值 = ours，相对基线不同则记一条；
 * 2. 当前未改（base == ours）→ 最终值 = theirs：
 *    - 基线与最终值都是对象（如仅目标修改了对象里的某个键）→ 按键展开到叶子；
 *    - 否则（标量 / 数组、整体替换或删除对象）→ 整体记一条；
 * 3. 目标未改（base == theirs）→ 同上，最终值 = ours；
 * 4. 两侧都是对象且都改 → 按键递归；
 * 5. 其余为冲突 → 按实际采用的解决方案整体记一条，不展开子路径。
 *
 * 因此父节点整体替换或删除时停在父路径，不重复列出已失效的子路径；
 * 最终值与基线一致（如冲突处自定义回基线值）时不列条目。
 * @param mergeResult 三方合并结果（冲突指针 → 冲突 id）
 * @param resolutions 已应用的冲突解决方案
 * @param merged 最终合并文档（叶子条目的最终值来源，保证与导出结果一致）
 */
export function buildDecisionTrace(
  mergeResult: MergeResult,
  resolutions: Resolutions,
  merged: JsonValue,
): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const conflictByPointer = new Map(mergeResult.conflicts.map((c) => [c.pointer, c.id]));

  /**
   * 从最终合并文档按路径读取；根为文档本身，读不到（删除 / 越界）为 ABSENT。
   * getBySegments 仅以 undefined 表示缺失；null 是真实存在的 JSON 值，
   * 不能当作缺失（否则新增 / 改成 null 的变更会被漏报或误记为删除）。
   */
  const readFinal = (segments: string[]): SideValue => {
    if (segments.length === 0) return merged;
    const v = getBySegments(merged, segments);
    return v === undefined ? ABSENT : v;
  };

  const classify = (
    base: SideValue,
    ours: SideValue,
    theirs: SideValue,
    segments: string[],
  ): void => {
    const pointer = toPointer(segments);

    // 1. 双方一致：采用一次（含都删除、改成相同值/相同对象）
    if (deepEqual(ours, theirs)) {
      if (expandObject(base, ours, theirs)) {
        // 三方同一对象、内部子键双侧同改：展开到叶子
        recurse(base, ours, theirs, segments);
      } else {
        // 整体新增 / 删除 / 替换（含双方新增相同对象）：父路径记一条
        emit(base, ours, theirs, segments, pointer, 'both');
      }
      return;
    }
    // 2. 当前分支未改：采用目标分支
    if (deepEqual(base, ours)) {
      adopt(base, ours, theirs, segments, 'theirs-only');
      return;
    }
    // 3. 目标分支未改：采用当前分支
    if (deepEqual(base, theirs)) {
      adopt(base, ours, theirs, segments, 'ours-only');
      return;
    }
    // 4. 双方都修改且两侧都是对象：按键递归
    if (isPlainObject(ours) && isPlainObject(theirs)) {
      recurse(base, ours, theirs, segments);
      return;
    }
    // 5. 冲突：按解决方案整体记一条
    const conflictId = conflictByPointer.get(pointer);
    const resolution = conflictId ? resolutions[conflictId] : undefined;
    if (!resolution) return; // 未解决冲突不会进入输出页，防御性跳过
    const source: TraceSource =
      resolution.kind === 'ours'
        ? 'conflict-ours'
        : resolution.kind === 'theirs'
          ? 'conflict-theirs'
          : 'conflict-custom';
    emit(base, ours, theirs, segments, pointer, source, conflictId, resolution);
  };

  /**
   * 是否应按键展开到子路径：三方都是对象（即 mergeValue 的“对象容器”情形）。
   * 一侧缺失（新增 / 删除）或任一侧不是对象（整体替换为数组 / 标量）时不展开。
   */
  const expandObject = (base: SideValue, ours: SideValue, theirs: SideValue): boolean =>
    isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs);

  /**
   * 一侧整体采用（另一侧与基线一致）时是否展开到叶子：
   * - 纯就地修改（采用侧键 ⊆ 基线键，只改值 / 删键）或纯新增键（基线键 ⊆ 采用侧键）→ 同一对象形态，展开；
   * - 既有旧键消失又有新键出现（整个对象被换成另一个对象，旧子路径随之失效）→ 停在父路径记一条。
   */
  const adoptExpands = (base: SideValue, adopted: SideValue): boolean => {
    if (!isPlainObject(base) || !isPlainObject(adopted)) return false;
    const baseKeys = Object.keys(base);
    const adoptedKeys = Object.keys(adopted);
    const removed = baseKeys.some((k) => !(k in adopted));
    const added = adoptedKeys.some((k) => !(k in base));
    return !(removed && added);
  };

  /**
   * 一侧整体采用（另一侧与基线一致）：就地修改的对象按键展开到叶子
   * （mergeValue 在此短路只给整体节点，展开后得到叶子级变更路径）；
   * 一侧删除或把对象整体换成另一个对象 / 数组 / 标量时，父路径整体记一条。
   */
  const adopt = (
    base: SideValue,
    ours: SideValue,
    theirs: SideValue,
    segments: string[],
    source: TraceSource,
  ): void => {
    // source 为 theirs-only 时采用侧是 theirs；ours-only 时采用侧是 ours
    const adopted = source === 'theirs-only' ? theirs : ours;
    if (adoptExpands(base, adopted)) {
      recurse(base, ours, theirs, segments);
      return;
    }
    emit(base, ours, theirs, segments, toPointer(segments), source);
  };

  /** 对三方对象按并集键递归；某侧缺键以 ABSENT 表示 */
  const recurse = (
    base: SideValue,
    ours: SideValue,
    theirs: SideValue,
    segments: string[],
  ): void => {
    const baseObj = isPlainObject(base) ? base : {};
    const oursObj = isPlainObject(ours) ? ours : {};
    const theirsObj = isPlainObject(theirs) ? theirs : {};
    const keys: string[] = [];
    const pushKeys = (obj: Record<string, JsonValue>) => {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) keys.push(k);
    };
    pushKeys(baseObj);
    pushKeys(oursObj);
    pushKeys(theirsObj);
    for (const k of keys) {
      classify(
        k in baseObj ? baseObj[k] : ABSENT,
        k in oursObj ? oursObj[k] : ABSENT,
        k in theirsObj ? theirsObj[k] : ABSENT,
        [...segments, k],
      );
    }
  };

  /** 记录一条变更；最终值从最终合并文档按路径读取，与基线一致（如冲突处自定义回基线值）时不列条目 */
  const emit = (
    base: SideValue,
    ours: SideValue,
    theirs: SideValue,
    segments: string[],
    pointer: string,
    source: TraceSource,
    conflictId?: string,
    resolution?: Resolution,
  ): void => {
    const final = readFinal(segments);
    if (deepEqual(base, final)) return;
    const entry: TraceEntry = {
      pointer,
      segments,
      source,
      change: classifyChange(base, final),
      base,
      ours,
      theirs,
      final,
    };
    if (conflictId !== undefined) entry.conflictId = conflictId;
    if (resolution) entry.resolution = resolution;
    entries.push(entry);
  };

  classify(mergeResult.root.base, mergeResult.root.ours, mergeResult.root.theirs, []);
  return entries;
}

export interface TraceCounts {
  total: number;
  add: number;
  remove: number;
  replace: number;
  bySource: Record<TraceSource, number>;
}

export function countTraceEntries(entries: TraceEntry[]): TraceCounts {
  const bySource = {
    'ours-only': 0,
    'theirs-only': 0,
    both: 0,
    'conflict-ours': 0,
    'conflict-theirs': 0,
    'conflict-custom': 0,
  } as Record<TraceSource, number>;
  const counts = { total: entries.length, add: 0, remove: 0, replace: 0, bySource };
  for (const e of entries) {
    counts[e.change]++;
    counts.bySource[e.source]++;
  }
  return counts;
}

/** 报告中的单侧值：present=false 明确标注缺失（删除 / 从未存在） */
interface ReportValue {
  present: boolean;
  value?: JsonValue;
}

function toReportValue(v: SideValue): ReportValue {
  return isAbsent(v) ? { present: false } : { present: true, value: v };
}

export interface DecisionTraceReport {
  format: 'json-three-way-merge/decision-trace';
  version: 1;
  generatedAt: string;
  summary: {
    total: number;
    add: number;
    remove: number;
    replace: number;
    bySource: Record<TraceSource, number>;
  };
  entries: {
    pointer: string;
    source: TraceSource;
    sourceLabel: string;
    change: ChangeKind;
    base: ReportValue;
    ours: ReportValue;
    theirs: ReportValue;
    final: ReportValue;
    conflictId?: string;
    resolution?: Resolution;
  }[];
}

/** 生成可下载的决策溯源 JSON 报告（缺失值以 {present:false} 明确标注） */
export function buildTraceReport(entries: TraceEntry[], now: Date = new Date()): DecisionTraceReport {
  const counts = countTraceEntries(entries);
  return {
    format: 'json-three-way-merge/decision-trace',
    version: 1,
    generatedAt: now.toISOString(),
    summary: {
      total: counts.total,
      add: counts.add,
      remove: counts.remove,
      replace: counts.replace,
      bySource: counts.bySource,
    },
    entries: entries.map((e) => {
      const item: DecisionTraceReport['entries'][number] = {
        pointer: e.pointer,
        source: e.source,
        sourceLabel: SOURCE_LABEL[e.source],
        change: e.change,
        base: toReportValue(e.base),
        ours: toReportValue(e.ours),
        theirs: toReportValue(e.theirs),
        final: toReportValue(e.final),
      };
      if (e.conflictId !== undefined) item.conflictId = e.conflictId;
      if (e.resolution) item.resolution = e.resolution;
      return item;
    }),
  };
}
