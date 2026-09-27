import { deepEqual } from './deepEqual';
import { applyJsonPatch, parseJsonPatch, type PatchFailure } from './jsonPatch';
import { escapeSegment, getBySegments, parsePointer } from './pointer';
import { isPlainObject, type JsonValue } from './types';

/**
 * 输出阶段的“补丁审计”：把用户编辑后的 RFC 6902 补丁按顺序应用到基线的一份独立副本上，
 * 再与当前合并结果逐值比对。整个过程只读基线与合并结果，绝不修改二者。
 */

/** 补丁文本非法（JSON 语法错误 / 结构不合法），无法开始回放 */
export interface AuditPatchError {
  kind: 'invalid';
  failure: PatchFailure;
}

/** 回放过程中某个操作应用失败（序号从 1 开始） */
export interface AuditApplyFailure {
  kind: 'apply-failed';
  failure: PatchFailure;
}

/** 回放完成但结果与当前合并结果不同：首个差异的定位与双方值 */
export interface AuditMismatch {
  kind: 'mismatch';
  /** 首个差异的 JSON Pointer（根为 ""） */
  pointer: string;
  /** 期望（当前合并结果）在该指针处的值；不存在（键缺失 / 索引越界）为 undefined */
  expected: JsonValue | undefined;
  /** 实际（补丁回放结果）在该指针处的值；不存在为 undefined */
  actual: JsonValue | undefined;
}

/** 回放完成且与当前合并结果逐值一致 */
export interface AuditPass {
  kind: 'pass';
}

export type AuditResult = AuditPatchError | AuditApplyFailure | AuditMismatch | AuditPass;

/**
 * 解析补丁文本 → 按序应用到基线独立副本 → 与合并结果比对。
 * 返回判别联合，UI 据此渲染失败序号 / 首个差异 / 通过。
 */
export function auditPatch(baseText: string, base: JsonValue, expected: JsonValue): AuditResult {
  const parsed = parseJsonPatch(baseText);
  if (!parsed.ok) return { kind: 'invalid', failure: parsed.failure };

  const applied = applyJsonPatch(base, parsed.ops);
  if (!applied.ok) return { kind: 'apply-failed', failure: applied.failure };

  const diff = firstDifference(expected, applied.document);
  return diff ? { kind: 'mismatch', ...diff } : { kind: 'pass' };
}

/**
 * 深度优先按确定顺序（对象按 Object.keys：基准文档键优先、实际文档新键随后；数组按下标）
 * 找出两个 JSON 文档的首个差异，返回 JSON Pointer 与双方在该处的值。
 * 键缺失 / 数组索引越界用 undefined 表示。
 */
export function firstDifference(
  expected: JsonValue,
  actual: JsonValue,
): { pointer: string; expected: JsonValue | undefined; actual: JsonValue | undefined } | null {
  return walk(expected, actual, []);
}

function walk(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  segments: string[],
): { pointer: string; expected: JsonValue | undefined; actual: JsonValue | undefined } | null {
  if (isJsonEqual(expected, actual)) return null;

  const expectedIsObj = isPlainObject(expected);
  const actualIsObj = isPlainObject(actual);
  if (expectedIsObj || actualIsObj) {
    // 父级均为对象时才逐键比较；一侧不是对象（如对象 vs 标量）已在前面判为不相等
    if (!expectedIsObj || !actualIsObj) return at(segments, expected, actual);
    const keys: string[] = [...Object.keys(expected)];
    for (const k of Object.keys(actual)) if (!(k in expected)) keys.push(k);
    for (const k of keys) {
      const hit = walk(expected[k], actual[k], [...segments, escapeSegment(k)]);
      if (hit) return hit;
    }
    return null;
  }

  const expectedIsArr = Array.isArray(expected);
  const actualIsArr = Array.isArray(actual);
  if (expectedIsArr || actualIsArr) {
    if (!expectedIsArr || !actualIsArr) return at(segments, expected, actual);
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      const hit = walk(expected[i], actual[i], [...segments, String(i)]);
      if (hit) return hit;
    }
    return null;
  }

  return at(segments, expected, actual);
}

function at(segments: string[], expected: JsonValue | undefined, actual: JsonValue | undefined) {
  return { pointer: toPointerFromSegments(segments), expected, actual };
}

/** 与 deepEqual 等价，但允许两侧为 undefined（缺失） */
function isJsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return deepEqual(a, b);
}

/** pointer.toPointer 的本地版本：入参已是转义后的路径段（无需二次转义） */
function toPointerFromSegments(escapedSegments: string[]): string {
  return escapedSegments.length === 0 ? '' : '/' + escapedSegments.join('/');
}

/** 供 UI 展示差异值：undefined 显示为「（不存在）」 */
export function formatAuditValue(v: JsonValue | undefined): string {
  return v === undefined ? '（不存在）' : JSON.stringify(v, null, 2);
}

/** 供 UI 展示差异指针：根指针显示为「（根）」 */
export function formatAuditPointer(pointer: string): string {
  // 校验并规范化：非法指针不应出现（指针由内部生成），这里做防御性处理
  try {
    parsePointer(pointer);
  } catch {
    return pointer;
  }
  return pointer === '' ? '（根）' : pointer;
}

/** 读取文档在某指针处的值（缺失返回 undefined），供测试 / 调试复用 */
export function readAtPointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  return getBySegments(doc, parsePointer(pointer));
}
