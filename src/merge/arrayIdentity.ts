import { buildMerged, mergeSides } from './threeWayMerge';
import type { MergeResult, Resolution } from './threeWayMerge';
import { toPointer } from './pointer';
import {
  ABSENT,
  isAbsent,
  isPlainObject,
  type JsonValue,
  type SideValue,
} from './types';

/** 对象数组中的一项记录 */
type JsonObject = { [key: string]: JsonValue };

/** 三方中存在的一侧 */
type SideName = '基线' | '当前分支' | '目标分支';

/** 身份字段必须为字符串或数字（数字 1 与字符串 "1" 区分识别） */
export type IdentityValue = string | number;

/** 身份字段校验问题：指出侧别与项位置（从 1 开始的项序号） */
export interface IdentityViolation {
  side: SideName;
  /** 项位置，从 1 开始（第 N 项） */
  index: number;
  message: string;
}

/** 一条对齐后的记录（按身份字段对齐三方数组） */
export interface AlignedRecord {
  /** 身份字段的原始值（字符串 / 数字，严格区分类型） */
  identity: IdentityValue;
  base: SideValue;
  ours: SideValue;
  theirs: SideValue;
  /** 在基线数组中的下标（-1 表示基线无此身份） */
  baseIndex: number;
  /** 基线存活项首次出现时标记 */
  fromBase: boolean;
  /** 新增身份的来源：仅当前 / 仅目标 / 双方 */
  addedFrom?: 'ours' | 'theirs' | 'both';
}

/** 记录内部的一个字段级冲突 */
export interface RecordConflict {
  /** 组件内部使用的冲突键：记录下标#字段指针 */
  key: string;
  /** 该记录在对齐记录列表中的下标 */
  recordIndex: number;
  /** 字段相对数组本身的 JSON Pointer 片段（如 /name；记录级删除冲突为 ''） */
  fieldPointer: string;
  /** 完整冲突信息（pointer 为「数组指针 + 字段指针」） */
  conflict: {
    pointer: string;
    base: SideValue;
    ours: SideValue;
    theirs: SideValue;
    reason: string;
  };
}

/** 一次按身份字段对齐的分析结果 */
export interface IdentityAlignment {
  field: string;
  records: AlignedRecord[];
  violations: IdentityViolation[];
  /** 各记录的三方合并结果（与 records 一一对应） */
  merges: MergeResult[];
  /** 展平后的全部字段级冲突 */
  conflicts: RecordConflict[];
}

/** 判断一个 SideValue 是否为「对象数组」（全部元素均为对象的数组；空数组算） */
export function isObjectArray(v: SideValue): v is JsonObject[] {
  if (isAbsent(v)) return false;
  return Array.isArray(v) && v.every((item) => isPlainObject(item));
}

/**
 * 判断三方值是否符合「按身份字段合并」的适用条件：
 * 仅当三方均为对象数组（全部由对象构成的数组，空数组也算）时适用；
 * 一侧整体删除数组（该侧不存在）或任一侧含非对象元素时均不适用，仍走普通数组整体冲突。
 */
export function supportsIdentityMerge(base: SideValue, ours: SideValue, theirs: SideValue): boolean {
  return isObjectArray(base) && isObjectArray(ours) && isObjectArray(theirs);
}

/** 判断身份字段值是否为合法身份（字符串或数字，布尔 / null / 对象 / 数组均不合格） */
export function isIdentityValue(v: unknown): v is IdentityValue {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** 身份值在错误提示中的展示：字符串加引号、数字不加（NaN/Infinity 已在入口拒绝） */
export function formatIdentity(v: IdentityValue): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** 校验一侧数组的身份字段：缺字段 / 类型不合格 / 同侧重复（数字 1 与 "1" 视为不同身份） */
function validateSide(
  arr: SideValue,
  side: SideName,
  field: string,
): { violations: IdentityViolation[]; items: { value: JsonObject; identity: IdentityValue }[] } {
  const violations: IdentityViolation[] = [];
  const items: { value: JsonObject; identity: IdentityValue }[] = [];
  if (isAbsent(arr) || !Array.isArray(arr)) return { violations, items };
  const seen = new Map<IdentityValue, number>();
  arr.forEach((raw, i) => {
    const index = i + 1;
    if (!isPlainObject(raw)) {
      violations.push({ side, index, message: `第 ${index} 项不是对象` });
      return;
    }
    if (!(field in raw)) {
      violations.push({
        side,
        index,
        message: `第 ${index} 项缺少身份字段 "${field}"`,
      });
      return;
    }
    const id = raw[field];
    if (!isIdentityValue(id)) {
      violations.push({
        side,
        index,
        message: `第 ${index} 项的身份字段 "${field}" 不是字符串或数字（实际为 ${describeType(id)}）`,
      });
      return;
    }
    if (seen.has(id)) {
      violations.push({
        side,
        index,
        message: `第 ${index} 项的身份 ${formatIdentity(id)} 在${side}重复（首次出现在第 ${seen.get(
          id,
        )} 项）；数字 1 与字符串 "1" 为不同身份`,
      });
    } else {
      seen.set(id, index);
    }
    items.push({ value: raw, identity: id });
  });
  return { violations, items };
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}

interface SideItems {
  side: SideName;
  arr: SideValue;
}

/**
 * 按身份字段对齐三方对象数组并对每条记录执行对象三方合并。
 *
 * 顺序规则：存活的基线项保留基线原顺序（不采纳任何一侧的重排）；
 * 新身份按「当前侧首次出现 → 目标侧首次出现」的顺序追加。
 * 嵌套数组仍按整体值参与三方合并（见 threeWayMerge）。
 */
export function alignByIdentity(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  field: string,
  arraySegments: string[],
): IdentityAlignment {
  const sides: SideItems[] = [
    { side: '基线', arr: base },
    { side: '当前分支', arr: ours },
    { side: '目标分支', arr: theirs },
  ];
  const violations: IdentityViolation[] = [];
  const validated = sides.map(({ side, arr }) => {
    const r = validateSide(arr, side, field);
    violations.push(...r.violations);
    return r.items;
  });
  const [baseItems, oursItems, theirsItems] = validated;

  const records: AlignedRecord[] = [];
  const order: IdentityValue[] = [];
  const recordMap = new Map<IdentityValue, AlignedRecord>();

  const ensureRecord = (identity: IdentityValue): AlignedRecord => {
    const existing = recordMap.get(identity);
    if (existing) return existing;
    const rec: AlignedRecord = {
      identity,
      base: ABSENT,
      ours: ABSENT,
      theirs: ABSENT,
      baseIndex: -1,
      fromBase: false,
    };
    recordMap.set(identity, rec);
    records.push(rec);
    order.push(identity);
    return rec;
  };

  baseItems.forEach((it, i) => {
    const rec = ensureRecord(it.identity);
    rec.base = it.value;
    rec.baseIndex = i;
    rec.fromBase = true;
  });
  oursItems.forEach((it) => {
    const rec = ensureRecord(it.identity);
    rec.ours = it.value;
    if (!rec.fromBase && rec.addedFrom === undefined) rec.addedFrom = 'ours';
    else if (!rec.fromBase && rec.addedFrom === 'theirs') rec.addedFrom = 'both';
  });
  theirsItems.forEach((it) => {
    const rec = ensureRecord(it.identity);
    rec.theirs = it.value;
    if (!rec.fromBase && rec.addedFrom === undefined) rec.addedFrom = 'theirs';
    else if (!rec.fromBase && rec.addedFrom === 'ours') rec.addedFrom = 'both';
  });

  // 稳定排序：存活的基线项按基线下标，其余按首次出现顺序（当前侧先于目标侧）
  records.sort((a, b) => {
    if (a.fromBase && b.fromBase) return a.baseIndex - b.baseIndex;
    if (a.fromBase) return -1;
    if (b.fromBase) return 1;
    return order.indexOf(a.identity) - order.indexOf(b.identity);
  });

  const merges: MergeResult[] = [];
  const conflicts: RecordConflict[] = [];

  records.forEach((rec, recordIndex) => {
    // 记录以「身份值」作为路径段（RFC 6901 转义），使字段级冲突指针形如 /list/123/name；
    // 记录整体删除冲突的指针形如 /list/123
    const recordSegments = [...arraySegments, String(rec.identity)];
    const merge = mergeSides(rec.base, rec.ours, rec.theirs, '', recordSegments);
    merges.push(merge);
    for (const c of merge.conflicts) {
      const relative = c.segments.slice(recordSegments.length);
      const escapedRelative = relative.map(encodeSeg);
      const suffix = escapedRelative.length === 0 ? '' : '/' + escapedRelative.join('/');
      conflicts.push({
        key: `${recordIndex}#${escapedRelative.join('/')}`,
        recordIndex,
        fieldPointer: suffix,
        conflict: {
          pointer: toPointer([...recordSegments, ...relative]),
          base: c.base,
          ours: c.ours,
          theirs: c.theirs,
          reason: c.reason,
        },
      });
    }
  });

  return { field, records, violations, merges, conflicts };
}

/** RFC 6901 转义路径段（与 pointer.ts 保持一致） */
function encodeSeg(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 记录级（整条记录被一侧删除）冲突的字段指针为空串 */
export function isRecordLevelConflict(rc: RecordConflict): boolean {
  return rc.fieldPointer === '';
}

/** 统计尚未裁决的字段级冲突数 */
export function countPending(
  alignment: IdentityAlignment,
  decisions: Record<string, Resolution>,
): number {
  return alignment.conflicts.filter((c) => !decisions[c.key]).length;
}

/** 是否存在未裁决的字段级冲突 */
export function hasPending(
  alignment: IdentityAlignment,
  decisions: Record<string, Resolution>,
): boolean {
  return alignment.conflicts.some((c) => !decisions[c.key]);
}

/**
 * 根据逐项裁决组装最终数组：
 * - 记录级冲突未裁决 / 字段级冲突未裁决时返回 undefined；
 * - 记录最终为 ABSENT（双方删除或裁决删除）时不保留该项；
 * - null 是存活项（删除与 null 有别）。
 */
export function buildIdentityArray(
  alignment: IdentityAlignment,
  decisions: Record<string, Resolution>,
): JsonObject[] | undefined {
  const out: JsonObject[] = [];
  for (let i = 0; i < alignment.records.length; i++) {
    const v = buildMerged(alignment.merges[i].root, remapResolutions(alignment, i, decisions));
    if (v === undefined) return undefined;
    if (!isAbsent(v)) {
      if (!isPlainObject(v)) return undefined;
      out.push(v);
    }
  }
  return out;
}

/** 把「记录下标#字段指针」形式的内部裁决重映射为该次记录合并所需的冲突 id（c0、c1…） */
function remapResolutions(
  alignment: IdentityAlignment,
  recordIndex: number,
  decisions: Record<string, Resolution>,
): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  const recordConflicts = alignment.merges[recordIndex].conflicts;
  alignment.conflicts
    .filter((c) => c.recordIndex === recordIndex)
    .forEach((c, i) => {
      const res = decisions[c.key];
      if (res) out[recordConflicts[i].id] = res;
    });
  return out;
}
