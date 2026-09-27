import { applyOperation, validate, JsonPatchError } from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import { deepEqual } from './deepEqual';
import { parsePointer } from './pointer';
import { deleteOwn, getOwn, hasOwn, isPlainObject, setOwn, type JsonValue } from './types';

/**
 * RFC 6902 补丁模式：解析并应用 JSON Patch。
 * 指针与数组语义（含 `-` 追加、索引越界、test 断言等）全部委托给 fast-json-patch；
 * 仅对 fast-json-patch 出于原型污染防护而拒绝的 __proto__ 等键，
 * 使用自有键安全读写（defineProperty / hasOwnProperty）自行应用，
 * 因此包含这些合法 JSON 键的补丁既能应用也不会污染 Object.prototype。
 */

/** 补丁失败信息：失败操作序号（从 1 开始；补丁整体格式错误时为 null）与原因 */
export interface PatchFailure {
  opIndex: number | null;
  reason: string;
}

export type PatchParseResult = { ok: true; ops: Operation[] } | { ok: false; failure: PatchFailure };

export type PatchApplyResult =
  | { ok: true; document: JsonValue }
  | { ok: false; failure: PatchFailure };

/** fast-json-patch 错误名 → 中文原因（未知名称回退到原始 message） */
const ERROR_REASONS: Record<string, string> = {
  SEQUENCE_NOT_AN_ARRAY: '补丁必须是 JSON Patch 操作数组',
  OPERATION_NOT_AN_OBJECT: '操作必须是对象',
  OPERATION_OP_INVALID: 'op 必须是 add / remove / replace / move / copy / test 之一',
  OPERATION_PATH_INVALID: 'path 必须是以 "/" 开头的 JSON Pointer 字符串（根为 ""）',
  OPERATION_FROM_REQUIRED: 'move / copy 操作缺少 from 属性',
  OPERATION_FROM_UNRESOLVABLE: 'from 指向的路径不存在',
  OPERATION_VALUE_REQUIRED: 'add / replace / test 操作缺少 value 属性',
  OPERATION_VALUE_CANNOT_CONTAIN_UNDEFINED: 'value 不能为 undefined',
  OPERATION_PATH_UNRESOLVABLE: '目标路径不存在',
  OPERATION_PATH_CANNOT_ADD: '无法在目标路径执行 add（父级路径不存在）',
  OPERATION_PATH_ILLEGAL_ARRAY_INDEX: '数组索引非法（应为非负整数或 "-"）',
  OPERATION_VALUE_OUT_OF_BOUNDS: '数组索引越界',
  TEST_OPERATION_FAILED: 'test 断言失败（目标值与 value 不相等）',
};

function errorReason(err: unknown): string {
  if (err instanceof JsonPatchError) return ERROR_REASONS[err.name] ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

function errorToFailure(err: unknown): PatchFailure {
  if (err instanceof JsonPatchError) {
    return { opIndex: typeof err.index === 'number' ? err.index + 1 : null, reason: errorReason(err) };
  }
  return { opIndex: null, reason: errorReason(err) };
}

/** 解析补丁文本并做结构校验（不触碰文档） */
export function parseJsonPatch(text: string): PatchParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      failure: { opIndex: null, reason: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` },
    };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, failure: { opIndex: null, reason: ERROR_REASONS.SEQUENCE_NOT_AN_ARRAY } };
  }
  const invalid = validate(raw as Operation[]);
  if (invalid) return { ok: false, failure: errorToFailure(invalid) };
  return { ok: true, ops: raw as Operation[] };
}

/**
 * 深拷贝基线。fast-json-patch 的 deepClone 内部用普通赋值拷贝键值，
 * 自有 __proto__ 会命中原型 setter；JSON 往返可保留 __proto__ 为自有数据描述符
 * （JSON.parse 对 __proto__ 走 defineProperty 语义），且输入本身就是 JSON 文档。
 */
function safeClone(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** fast-json-patch 出于原型污染防护会拒绝的路径段（见其 core.js） */
function isBannedSegment(seg: string, prev: string | undefined): boolean {
  return seg === '__proto__' || (seg === 'prototype' && prev === 'constructor');
}

/** 操作路径（或 from）是否含 fast-json-patch 拒绝的原型键段 */
function touchesBannedPath(pointer: string): boolean {
  const segs = parsePointer(pointer);
  return segs.some((seg, i) => isBannedSegment(seg, i > 0 ? segs[i - 1] : undefined));
}

/** 数组下标段解析：非负整数返回数字，"-" 追加返回 -1，非法返回 null */
function parseArrayIndex(seg: string, length: number, allowDash: boolean): number | null {
  if (allowDash && seg === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(seg)) return null;
  const idx = Number(seg);
  return idx <= length ? idx : null;
}

/** 沿父路径定位容器；路径不存在 / 类型不符返回 null */
function locateParent(
  doc: JsonValue,
  segments: string[],
): { parent: JsonValue; key: string } | null {
  let cur: JsonValue = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(seg)) return null;
      const idx = Number(seg);
      if (idx >= cur.length) return null;
      cur = cur[idx];
    } else if (isPlainObject(cur) && hasOwn(cur, seg)) {
      cur = getOwn(cur, seg)!;
    } else {
      return null;
    }
  }
  return { parent: cur, key: segments[segments.length - 1] };
}

/** 按 RFC 6901 从文档读取自有键路径；不存在返回 undefined（与 getBySegments 同义） */
function readPointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  let cur: JsonValue = doc;
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(seg)) return undefined;
      const idx = Number(seg);
      if (idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isPlainObject(cur) && hasOwn(cur, seg)) {
      cur = getOwn(cur, seg)!;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** fast-json-patch 错误名（其 d.ts 未从主入口导出该联合类型，这里按错误码字面量约束） */
type PatchErrorName =
  | 'OPERATION_VALUE_REQUIRED'
  | 'OPERATION_PATH_UNRESOLVABLE'
  | 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX'
  | 'OPERATION_VALUE_OUT_OF_BOUNDS'
  | 'OPERATION_FROM_REQUIRED'
  | 'OPERATION_FROM_UNRESOLVABLE'
  | 'TEST_OPERATION_FAILED'
  | 'OPERATION_OP_INVALID';

/** 抛出与 fast-json-patch 同构的错误（index 由外层循环负责，这里占位 0） */
function patchFail(op: Operation, message: string, name: PatchErrorName): never {
  throw new JsonPatchError(message, name, 0, op);
}

/**
 * 安全应用单个触及原型键的操作（fast-json-patch 拒绝、但对合法 JSON 键必须支持）。
 * 语义对齐 RFC 6902 / fast-json-patch；路径不可解析时抛出 JsonPatchError 风格错误，
 * 由上层统一转成中文失败原因。
 */
function applyBannedOperation(doc: JsonValue, op: Operation): JsonValue {
  const value: JsonValue | undefined = (op as { value?: JsonValue }).value;
  const from: string | undefined = (op as { from?: string }).from;

  switch (op.op) {
    case 'add':
    case 'replace': {
      if (value === undefined) {
        return patchFail(op, '缺少 value', 'OPERATION_VALUE_REQUIRED');
      }
      if (op.path === '') return value;
      const segs = parsePointer(op.path);
      const loc = locateParent(doc, segs);
      if (!loc) return patchFail(op, '无法解析路径', 'OPERATION_PATH_UNRESOLVABLE');
      const { parent, key } = loc;
      if (Array.isArray(parent)) {
        const idx = parseArrayIndex(key, parent.length, op.op === 'add');
        if (idx === null) {
          return patchFail(op, '数组索引非法或越界', 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX');
        }
        if (op.op === 'add') {
          parent.splice(idx, 0, value);
        } else if (idx >= parent.length) {
          return patchFail(op, '数组索引越界', 'OPERATION_VALUE_OUT_OF_BOUNDS');
        } else {
          parent[idx] = value;
        }
      } else if (isPlainObject(parent)) {
        if (op.op === 'replace' && !hasOwn(parent, key)) {
          return patchFail(op, '目标路径不存在', 'OPERATION_PATH_UNRESOLVABLE');
        }
        setOwn(parent, key, value);
      } else {
        return patchFail(op, '无法解析路径', 'OPERATION_PATH_UNRESOLVABLE');
      }
      return doc;
    }
    case 'remove': {
      if (op.path === '') return null;
      const segs = parsePointer(op.path);
      const loc = locateParent(doc, segs);
      if (!loc) return patchFail(op, '目标路径不存在', 'OPERATION_PATH_UNRESOLVABLE');
      const { parent, key } = loc;
      if (Array.isArray(parent)) {
        const idx = parseArrayIndex(key, parent.length - 1, false);
        if (idx === null || idx >= parent.length) {
          return patchFail(op, '数组索引非法或越界', 'OPERATION_PATH_ILLEGAL_ARRAY_INDEX');
        }
        parent.splice(idx, 1);
      } else if (isPlainObject(parent) && hasOwn(parent, key)) {
        deleteOwn(parent, key);
      } else {
        return patchFail(op, '目标路径不存在', 'OPERATION_PATH_UNRESOLVABLE');
      }
      return doc;
    }
    case 'move': {
      if (!from) return patchFail(op, '缺少 from', 'OPERATION_FROM_REQUIRED');
      const fromValue = readPointer(doc, from);
      if (fromValue === undefined) {
        return patchFail(op, 'from 路径不存在', 'OPERATION_FROM_UNRESOLVABLE');
      }
      // from 一定存在：先按 remove 删除，再按 add 写入（值先取出，remove 不改 JSON 值本身）
      return applyBannedOperation(
        applyBannedOperation(doc, { op: 'remove', path: from }),
        { op: 'add', path: op.path, value: fromValue },
      );
    }
    case 'copy': {
      if (!from) return patchFail(op, '缺少 from', 'OPERATION_FROM_REQUIRED');
      const fromValue = readPointer(doc, from);
      if (fromValue === undefined) {
        return patchFail(op, 'from 路径不存在', 'OPERATION_FROM_UNRESOLVABLE');
      }
      return applyBannedOperation(doc, { op: 'add', path: op.path, value: fromValue });
    }
    case 'test': {
      if (value === undefined) {
        return patchFail(op, '缺少 value', 'OPERATION_VALUE_REQUIRED');
      }
      const actual = op.path === '' ? doc : readPointer(doc, op.path);
      if (actual === undefined || !deepEqual(actual, value)) {
        return patchFail(op, 'test 断言失败（目标值与 value 不相等）', 'TEST_OPERATION_FAILED');
      }
      return doc;
    }
    default:
      return patchFail(op, 'op 必须是 add / remove / replace / move / copy / test 之一', 'OPERATION_OP_INVALID');
  }
}

/** 操作是否需要走自有键安全应用（路径或 from 含被 fast-json-patch 拒绝的原型键段） */
function needsSafeApply(op: Operation): boolean {
  const from = (op as { from?: unknown }).from;
  return touchesBannedPath(op.path) || (typeof from === 'string' && touchesBannedPath(from));
}

/**
 * 将补丁按顺序应用到基线的一份独立副本上，返回新文档；基线本身不被修改。
 * 任一操作失败即中止，并报告失败操作序号（从 1 开始）与原因。
 * 注：逐个应用而非 applyPatch 一次跑完，是因为 fast-json-patch 在路径不可解析时
 * 会把操作序号错误地上报为 0，这里用循环下标保证序号始终准确。
 */
export function applyJsonPatch(base: JsonValue, ops: Operation[]): PatchApplyResult {
  let document = safeClone(base);
  for (let i = 0; i < ops.length; i++) {
    try {
      const op = ops[i];
      if (needsSafeApply(op)) {
        document = applyBannedOperation(document, op);
      } else {
        // validateOperation=true：应用前校验；在自有副本上原地修改（mutateDocument=true）
        document = applyOperation(document, op, true, true, true, i).newDocument as JsonValue;
      }
    } catch (err) {
      return { ok: false, failure: { opIndex: i + 1, reason: errorReason(err) } };
    }
  }
  return { ok: true, document };
}
