import { deepEqual } from './deepEqual';
import { toPointer } from './pointer';
import { ABSENT, isAbsent, isPlainObject, type JsonValue, type SideValue } from './types';

/**
 * 输入阶段的「变更交叉分析」：基于 Base / Ours / Theirs，分别计算两侧相对基线的
 * 结构化变更，再按 JSON Pointer 汇总为影响矩阵。
 *
 * 结构化变更的遍历口径与 threeWayMerge 保持一致：
 * - 只要某一侧的值是对象就按键递归（基线非对象时以空对象对待，对应合并引擎对
 *   「双方新增对象」「标量整体换成对象」的按键递归），因此对象内互不相干的键改动
 *   会展开为各自独立的路径，标记为可自动合并；
 * - 数组与标量始终按整体值处理（add / remove / replace），不展开内部下标。
 *
 * 影响分类：
 * - ours-only / theirs-only：仅一侧改动且与另一侧无交叉，可自动合并；
 * - both-agree：两侧在同一路径改成相同值（含双方都删除），可自动合并；
 * - same-path-conflict：两侧在同一路径改成不同值（含一侧删除另一侧修改）；
 * - cross-ancestor-conflict：一侧在祖先路径整体删除 / 整体替换为非对象值
 *   （或在基线不存在处放上非对象值），另一侧在其后代路径上改动——祖先条目与
 *   受影响的后代条目标为同一组交叉影响，真正需要裁决的冲突节点位于祖先路径。
 */

export type SideName = 'ours' | 'theirs';

/** 单侧相对基线的变更形态 */
export type SideChangeKind = 'add' | 'remove' | 'replace';

export interface SideChange {
  kind: SideChangeKind;
  /** 变更后的值；remove 时为 ABSENT */
  value: SideValue;
}

export type ImpactType =
  | 'ours-only' // 仅当前分支改动（互不相干，可自动合并）
  | 'theirs-only' // 仅目标分支改动（互不相干，可自动合并）
  | 'both-agree' // 同一路径双方改成相同值（可自动合并）
  | 'same-path-conflict' // 同一路径双方改成不同值
  | 'cross-ancestor-conflict'; // 祖先整体替换/删除 × 后代修改

/** 交叉影响的祖先信息（后代条目指向对侧造成影响的祖先变更） */
export interface CrossAncestorRef {
  /** 祖先路径的 JSON Pointer */
  pointer: string;
  /** 在哪一侧发生了祖先整体变更 */
  side: SideName;
  /** 祖先变更形态（remove / replace / add-nonobject 统一用单侧变更形态表示） */
  kind: SideChangeKind;
}

export interface CrossImpactEntry {
  /** RFC 6901 JSON Pointer，根为 '' */
  pointer: string;
  /** 从根到本节点的路径段（未转义） */
  segments: string[];
  impact: ImpactType;
  /** 该路径的基线值；ABSENT 表示基线中不存在 */
  base: SideValue;
  /** 当前分支侧变更；该侧未改动为 null */
  ours: SideChange | null;
  /** 目标分支侧变更；该侧未改动为 null */
  theirs: SideChange | null;
  /**
   * 后代条目才有：指向对侧造成交叉影响的祖先变更。
   * 祖先条目本身不含此字段（它就是冲突节点），但其 impact 同样是
   * cross-ancestor-conflict，可经 affected 反查到受影响的后代。
   */
  ancestor?: CrossAncestorRef;
}

export interface CrossAnalysisCounts {
  total: number;
  byImpact: Record<ImpactType, number>;
  /** 可自动合并的条目数（ours-only / theirs-only / both-agree） */
  autoMergeable: number;
  /** 实际需要人工裁决的冲突节点数（同路径冲突 + 交叉影响去重后的祖先节点） */
  conflictRoots: number;
}

export interface CrossAnalysis {
  entries: CrossImpactEntry[];
  counts: CrossAnalysisCounts;
  /** 需要人工裁决的冲突节点 JSON Pointer（同路径冲突 + 交叉影响祖先），已排序 */
  conflictPointers: string[];
}

export const IMPACT_ORDER: ImpactType[] = [
  'same-path-conflict',
  'cross-ancestor-conflict',
  'both-agree',
  'ours-only',
  'theirs-only',
];

export const IMPACT_LABEL: Record<ImpactType, string> = {
  'ours-only': '仅当前分支',
  'theirs-only': '仅目标分支',
  'both-agree': '双方同改一致',
  'same-path-conflict': '同一路径冲突',
  'cross-ancestor-conflict': '祖先×后代交叉',
};

export const IMPACT_DESCRIPTION: Record<ImpactType, string> = {
  'ours-only': '只有当前分支相对基线改动，与目标分支互不相干，可自动合并',
  'theirs-only': '只有目标分支相对基线改动，与当前分支互不相干，可自动合并',
  'both-agree': '两侧在同一路径改成了相同的值（含双方都删除），可自动合并',
  'same-path-conflict': '两侧在同一路径改成不同的值（含一侧删除、另一侧修改），需人工裁决',
  'cross-ancestor-conflict':
    '一侧在祖先路径整体删除 / 整体替换（或放上非对象值），另一侧改动了其后代路径，需在祖先路径人工裁决',
};

export const SIDE_CHANGE_LABEL: Record<SideChangeKind, string> = {
  add: '新增',
  remove: '删除',
  replace: '整体修改',
};

interface ChangeRecord extends SideChange {
  segments: string[];
  pointer: string;
  base: SideValue;
}

/** 分类单侧相对基线的变更：对象按键递归，数组 / 标量 / 缺失按整体值记一条 */
function collectSideChanges(
  base: SideValue,
  side: SideValue,
  segments: string[],
  out: Map<string, ChangeRecord>,
): void {
  if (deepEqual(base, side)) return;
  if (isPlainObject(side)) {
    const baseObj = isPlainObject(base) ? base : {};
    const keys: string[] = [];
    const pushKeys = (obj: Record<string, JsonValue>) => {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) keys.push(k);
    };
    pushKeys(baseObj);
    pushKeys(side);
    for (const k of keys) {
      collectSideChanges(
        k in baseObj ? baseObj[k] : ABSENT,
        k in side ? side[k] : ABSENT,
        [...segments, k],
        out,
      );
    }
    return;
  }
  // 数组与标量（含 side 为 ABSENT）按整体值处理
  const kind: SideChangeKind = isAbsent(side) ? 'remove' : isAbsent(base) ? 'add' : 'replace';
  out.set(toPointer(segments), { kind, value: side, segments, pointer: toPointer(segments), base });
}

/** 路径段数组的确定性排序（祖先排在后代之前，兄弟按键名字典序） */
function compareSegments(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function isProperAncestor(ancestor: string[], descendant: string[]): boolean {
  return ancestor.length < descendant.length && ancestor.every((seg, i) => seg === descendant[i]);
}

/** 在一侧变更表中查找离 target 最近的祖先变更（对象侧不会留下祖先条目，故命中即交叉） */
function findAncestorChange(
  map: Map<string, ChangeRecord>,
  target: string[],
): ChangeRecord | null {
  let best: ChangeRecord | null = null;
  for (const rec of map.values()) {
    if (!isProperAncestor(rec.segments, target)) continue;
    if (!best || rec.segments.length > best.segments.length) best = rec;
  }
  return best;
}

/** 一侧变更表中是否存在 target 的后代变更 */
function hasDescendantChange(map: Map<string, ChangeRecord>, target: string[]): boolean {
  for (const rec of map.values()) {
    if (isProperAncestor(target, rec.segments)) return true;
  }
  return false;
}

/**
 * 计算变更交叉分析影响矩阵。
 * @param base 基线文档
 * @param ours 当前分支文档
 * @param theirs 目标分支文档
 */
export function analyzeCrossChanges(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
): CrossAnalysis {
  const oursMap = new Map<string, ChangeRecord>();
  const theirsMap = new Map<string, ChangeRecord>();
  collectSideChanges(base, ours, [], oursMap);
  collectSideChanges(base, theirs, [], theirsMap);

  const pointers = new Set<string>([...oursMap.keys(), ...theirsMap.keys()]);
  const entries: CrossImpactEntry[] = [];

  for (const pointer of pointers) {
    const o = oursMap.get(pointer) ?? null;
    const t = theirsMap.get(pointer) ?? null;
    const segments = (o ?? t)!.segments;
    const baseValue = o ? o.base : t!.base;

    const entry: CrossImpactEntry = {
      pointer,
      segments,
      impact: 'ours-only',
      base: baseValue,
      ours: o ? { kind: o.kind, value: o.value } : null,
      theirs: t ? { kind: t.kind, value: t.value } : null,
    };

    if (o && t) {
      // 同一路径双方都改：值一致可自动合并，否则为同路径冲突
      entry.impact = deepEqual(o.value, t.value) ? 'both-agree' : 'same-path-conflict';
    } else if (o) {
      const ancestor = findAncestorChange(theirsMap, segments);
      if (ancestor) {
        entry.impact = 'cross-ancestor-conflict';
        entry.ancestor = { pointer: ancestor.pointer, side: 'theirs', kind: ancestor.kind };
      } else if (hasDescendantChange(theirsMap, segments)) {
        // 本条即祖先整体变更，对侧在后代路径上有改动
        entry.impact = 'cross-ancestor-conflict';
      } else {
        entry.impact = 'ours-only';
      }
    } else {
      const ancestor = findAncestorChange(oursMap, segments);
      if (ancestor) {
        entry.impact = 'cross-ancestor-conflict';
        entry.ancestor = { pointer: ancestor.pointer, side: 'ours', kind: ancestor.kind };
      } else if (hasDescendantChange(oursMap, segments)) {
        entry.impact = 'cross-ancestor-conflict';
      } else {
        entry.impact = 'theirs-only';
      }
    }

    entries.push(entry);
  }

  entries.sort((a, b) => compareSegments(a.segments, b.segments));

  const byImpact: Record<ImpactType, number> = {
    'ours-only': 0,
    'theirs-only': 0,
    'both-agree': 0,
    'same-path-conflict': 0,
    'cross-ancestor-conflict': 0,
  };
  const conflictRoots = new Set<string>();
  for (const e of entries) {
    byImpact[e.impact]++;
    if (e.impact === 'same-path-conflict') conflictRoots.add(e.pointer);
    if (e.impact === 'cross-ancestor-conflict') {
      conflictRoots.add(e.ancestor ? e.ancestor.pointer : e.pointer);
    }
  }
  const conflictPointers = [...conflictRoots].sort();

  return {
    entries,
    conflictPointers,
    counts: {
      total: entries.length,
      byImpact,
      autoMergeable: byImpact['ours-only'] + byImpact['theirs-only'] + byImpact['both-agree'],
      conflictRoots: conflictPointers.length,
    },
  };
}
