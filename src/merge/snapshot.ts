import { deepEqual } from './deepEqual';
import { parsePointer } from './pointer';
import type { MergeResult, Resolution, Resolutions } from './threeWayMerge';
import { isAbsent, isPlainObject, type JsonValue, type SideValue } from './types';

/** 快照格式标识 */
export const SNAPSHOT_FORMAT = 'json-three-way-merge/session';
/** 当前支持的快照格式版本 */
export const SNAPSHOT_VERSION = 1;

/** 某一侧的值：present=false 表示该侧不存在此节点（已删除或从未存在） */
export type SnapshotSideValue = { present: true; value: JsonValue } | { present: false };

/** 快照中记录的一条冲突解决方案 */
export interface SnapshotResolution {
  /** 冲突的 JSON Pointer */
  pointer: string;
  /** 冲突三方值，导入时用于确认仍是同一个冲突 */
  base: SnapshotSideValue;
  ours: SnapshotSideValue;
  theirs: SnapshotSideValue;
  /** 已选择的解决方案 */
  resolution: Resolution;
}

/** 会话快照：格式版本 + 三份源 JSON + 已选解决方案 */
export interface SessionSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
  resolutions: SnapshotResolution[];
}

/** 快照结构或字段非法时抛出 */
export class SnapshotParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotParseError';
  }
}

function fail(message: string): never {
  throw new SnapshotParseError(message);
}

function encodeSide(v: SideValue): SnapshotSideValue {
  return isAbsent(v) ? { present: false } : { present: true, value: v };
}

/** 由当前合并状态生成会话快照（仅记录已做出选择的冲突） */
export function createSnapshot(mergeResult: MergeResult, resolutions: Resolutions): SessionSnapshot {
  const entries: SnapshotResolution[] = [];
  for (const c of mergeResult.conflicts) {
    const resolution = resolutions[c.id];
    if (!resolution) continue;
    entries.push({
      pointer: c.pointer,
      base: encodeSide(c.base),
      ours: encodeSide(c.ours),
      theirs: encodeSide(c.theirs),
      resolution,
    });
  }
  const { root } = mergeResult;
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    // 根节点的三侧即输入的三份完整文档，不会是 ABSENT
    base: isAbsent(root.base) ? null : root.base,
    ours: isAbsent(root.ours) ? null : root.ours,
    theirs: isAbsent(root.theirs) ? null : root.theirs,
    resolutions: entries,
  };
}

function parseSide(raw: unknown, path: string): SnapshotSideValue {
  if (!isPlainObject(raw)) fail(`${path} 必须是对象（{ "present": boolean, "value"?: ... }）`);
  if (typeof raw.present !== 'boolean') fail(`${path}.present 必须是布尔值`);
  if (raw.present) {
    if (!('value' in raw)) fail(`${path}.value 缺失（present 为 true 时必须提供）`);
    return { present: true, value: raw.value };
  }
  return { present: false };
}

function parseResolution(raw: unknown, path: string): Resolution {
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`);
  if (raw.kind === 'ours' || raw.kind === 'theirs') return { kind: raw.kind };
  if (raw.kind === 'custom') {
    if (!('value' in raw)) fail(`${path}.value 缺失（自定义解决方案必须提供 value）`);
    return { kind: 'custom', value: raw.value };
  }
  fail(`${path}.kind 必须是 "ours" | "theirs" | "custom"`);
}

function parseEntry(raw: unknown, index: number): SnapshotResolution {
  const path = `resolutions[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} 必须是对象`);
  if (typeof raw.pointer !== 'string') fail(`${path}.pointer 必须是字符串`);
  try {
    parsePointer(raw.pointer);
  } catch {
    fail(`${path}.pointer 不是合法 JSON Pointer：${raw.pointer}`);
  }
  return {
    pointer: raw.pointer,
    base: parseSide(raw.base, `${path}.base`),
    ours: parseSide(raw.ours, `${path}.ours`),
    theirs: parseSide(raw.theirs, `${path}.theirs`),
    resolution: parseResolution(raw.resolution, `${path}.resolution`),
  };
}

/** 解析并校验会话快照文本；结构或字段非法时抛出 SnapshotParseError */
export function parseSnapshot(text: string): SessionSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SnapshotParseError(
      `快照不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(raw)) fail('快照必须是 JSON 对象');
  if (raw.format !== SNAPSHOT_FORMAT) {
    fail(`格式标识不正确：期望 format 为 "${SNAPSHOT_FORMAT}"`);
  }
  if (raw.version !== SNAPSHOT_VERSION) {
    const got = raw.version === undefined ? '缺失' : JSON.stringify(raw.version);
    fail(`不支持的快照版本：${got}（当前支持版本 ${SNAPSHOT_VERSION}）`);
  }
  for (const key of ['base', 'ours', 'theirs'] as const) {
    if (!(key in raw)) fail(`缺少源 JSON 字段：${key}`);
  }
  if (!Array.isArray(raw.resolutions)) fail('resolutions 必须是数组');
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    base: raw.base,
    ours: raw.ours,
    theirs: raw.theirs,
    resolutions: raw.resolutions.map((entry, i) => parseEntry(entry, i)),
  };
}

/** 被跳过的快照条目及原因 */
export interface SkippedResolution {
  pointer: string;
  reason: string;
}

/** 导入结果的汇总信息（用于界面展示） */
export interface RestoreSummary {
  restored: number;
  skipped: SkippedResolution[];
}

export interface RestoreResult extends RestoreSummary {
  resolutions: Resolutions;
}

function sideMatches(snapshotSide: SnapshotSideValue, side: SideValue): boolean {
  if (!snapshotSide.present) return isAbsent(side);
  return !isAbsent(side) && deepEqual(snapshotSide.value, side);
}

/**
 * 将快照中的解决方案应用到一次**重新执行的**三方合并结果上。
 * 按 JSON Pointer 定位冲突，且仅当 base/ours/theirs 三方值均与快照一致时才恢复选择；
 * 其余条目跳过并记录原因（绝不按快照条目顺序或旧冲突序号直接套用）。
 */
export function restoreResolutions(
  snapshot: SessionSnapshot,
  mergeResult: MergeResult,
): RestoreResult {
  const resolutions: Resolutions = {};
  const skipped: SkippedResolution[] = [];
  let restored = 0;
  for (const entry of snapshot.resolutions) {
    const conflict = mergeResult.conflicts.find((c) => c.pointer === entry.pointer);
    if (!conflict) {
      skipped.push({ pointer: entry.pointer, reason: '重新合并后不存在该 JSON Pointer 的冲突' });
      continue;
    }
    if (
      !sideMatches(entry.base, conflict.base) ||
      !sideMatches(entry.ours, conflict.ours) ||
      !sideMatches(entry.theirs, conflict.theirs)
    ) {
      skipped.push({
        pointer: entry.pointer,
        reason: '冲突的 base/ours/theirs 三方值与快照不一致',
      });
      continue;
    }
    resolutions[conflict.id] = entry.resolution;
    restored++;
  }
  return { resolutions, restored, skipped };
}
