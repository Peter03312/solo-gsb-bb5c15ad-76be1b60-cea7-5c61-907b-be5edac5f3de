import { deepEqual } from './deepEqual';
import { toPointer } from './pointer';
import { ABSENT, isAbsent, isPlainObject, type JsonValue, type SideValue } from './types';

/** 节点合并状态 */
export type NodeStatus =
  | 'unchanged' // 三份一致
  | 'ours' // 仅当前分支修改，已采用当前分支
  | 'theirs' // 仅目标分支修改，已采用目标分支
  | 'both' // 双方改成相同值（含都删除），采用一次
  | 'object' // 对象容器，已按键递归合并
  | 'conflict'; // 冲突，需人工解决

export interface MergeNode {
  /** 在父对象中的键，根节点为 '' */
  key: string;
  /** 从根到本节点的路径段 */
  segments: string[];
  /** JSON Pointer */
  pointer: string;
  status: NodeStatus;
  base: SideValue;
  ours: SideValue;
  theirs: SideValue;
  /** 非冲突节点的合并结果（ABSENT 表示被删除） */
  merged: SideValue;
  /** 对象容器的子节点；冲突节点无子节点 */
  children: MergeNode[];
  /** 仅冲突节点：冲突 id */
  conflictId?: string;
}

export interface Conflict {
  id: string;
  pointer: string;
  segments: string[];
  base: SideValue;
  ours: SideValue;
  theirs: SideValue;
  reason: string;
}

export interface MergeResult {
  root: MergeNode;
  conflicts: Conflict[];
}

export type Resolution =
  | { kind: 'ours' }
  | { kind: 'theirs' }
  | { kind: 'custom'; value: JsonValue };

export type Resolutions = Record<string, Resolution>;

function conflictReason(ours: SideValue, theirs: SideValue): string {
  if (isAbsent(ours) && !isAbsent(theirs)) return '当前分支已删除，目标分支进行了修改';
  if (isAbsent(theirs) && !isAbsent(ours)) return '目标分支已删除，当前分支进行了修改';
  return '双方修改为不同的值';
}

function mergeValue(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  key: string,
  segments: string[],
  conflicts: Conflict[],
): MergeNode {
  const node: MergeNode = {
    key,
    segments,
    pointer: toPointer(segments),
    status: 'unchanged',
    base,
    ours,
    theirs,
    merged: ABSENT,
    children: [],
  };

  // 双方一致（含双方都删除、双方改成相同值）：采用一次
  if (deepEqual(ours, theirs)) {
    node.merged = ours;
    node.status = deepEqual(base, ours) ? 'unchanged' : 'both';
    return node;
  }
  // 仅目标分支修改（含当前分支删除、目标分支保留/修改）
  if (deepEqual(base, ours)) {
    node.merged = theirs;
    node.status = 'theirs';
    return node;
  }
  // 仅当前分支修改
  if (deepEqual(base, theirs)) {
    node.merged = ours;
    node.status = 'ours';
    return node;
  }

  // 双方都修改且不一致：若两侧都是对象则按键递归合并
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const baseObj = isPlainObject(base) ? base : {};
    const keys: string[] = [];
    const pushKeys = (obj: Record<string, JsonValue>) => {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) keys.push(k);
    };
    pushKeys(baseObj);
    pushKeys(ours);
    pushKeys(theirs);

    node.status = 'object';
    node.children = keys.map((k) =>
      mergeValue(
        k in baseObj ? baseObj[k] : ABSENT,
        k in ours ? ours[k] : ABSENT,
        k in theirs ? theirs[k] : ABSENT,
        k,
        [...segments, k],
        conflicts,
      ),
    );
    // 组装已合并的对象（冲突子节点暂以 undefined 占位，最终以解决方案为准）
    const assembled: Record<string, JsonValue> = {};
    for (const child of node.children) {
      if (child.status !== 'conflict' && !isAbsent(child.merged)) {
        assembled[child.key] = child.merged;
      }
    }
    node.merged = assembled;
    return node;
  }

  // 其余情况：冲突（双方改成不同值，或一方删除另一方修改）
  const conflict: Conflict = {
    id: `c${conflicts.length}`,
    pointer: node.pointer,
    segments,
    base,
    ours,
    theirs,
    reason: conflictReason(ours, theirs),
  };
  conflicts.push(conflict);
  node.status = 'conflict';
  node.conflictId = conflict.id;
  return node;
}

/**
 * 合并任意节点的三方值（任一侧可为 ABSENT，如按身份字段对齐数组记录）。
 * key/segments 用于生成冲突的 JSON Pointer：数组按身份合并时以记录指针为前缀，
 * 内部冲突指针形如「/list」+「/name」。
 */
export function mergeSides(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  key: string,
  segments: string[],
): MergeResult {
  const conflicts: Conflict[] = [];
  const root = mergeValue(base, ours, theirs, key, segments, conflicts);
  return { root, conflicts };
}

/** 执行三方合并：base 为基线，ours 为当前分支，theirs 为目标分支 */
export function threeWayMerge(base: JsonValue, ours: JsonValue, theirs: JsonValue): MergeResult {
  return mergeSides(base, ours, theirs, '', []);
}

/** 根据冲突解决方案计算最终合并结果；存在未解决的冲突时返回 undefined */
export function buildMerged(root: MergeNode, resolutions: Resolutions): SideValue | undefined {
  if (root.status === 'conflict') {
    const res = root.conflictId ? resolutions[root.conflictId] : undefined;
    if (!res) return undefined;
    if (res.kind === 'ours') return root.ours;
    if (res.kind === 'theirs') return root.theirs;
    return res.value;
  }
  if (root.status === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const child of root.children) {
      const v = buildMerged(child, resolutions);
      if (v === undefined) return undefined;
      if (!isAbsent(v)) out[child.key] = v;
    }
    return out;
  }
  return root.merged;
}

/** 统计子树中的冲突数量及已解决数量 */
export function countConflicts(
  node: MergeNode,
  resolutions: Resolutions,
): { total: number; resolved: number } {
  if (node.status === 'conflict') {
    const done = node.conflictId && resolutions[node.conflictId] ? 1 : 0;
    return { total: 1, resolved: done };
  }
  let total = 0;
  let resolved = 0;
  for (const c of node.children) {
    const r = countConflicts(c, resolutions);
    total += r.total;
    resolved += r.resolved;
  }
  return { total, resolved };
}
