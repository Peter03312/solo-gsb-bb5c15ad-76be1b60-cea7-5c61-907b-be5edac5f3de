import { applyOperation, deepClone, validate, JsonPatchError } from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import type { JsonValue } from './types';

/**
 * RFC 6902 补丁模式：解析并应用 JSON Patch。
 * 指针与数组语义（含 `-` 追加、索引越界、test 断言等）全部委托给 fast-json-patch。
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
 * 将补丁按顺序应用到基线的一份独立副本上，返回新文档；基线本身不被修改。
 * 任一操作失败即中止，并报告失败操作序号（从 1 开始）与原因。
 * 注：逐个应用而非 applyPatch 一次跑完，是因为 fast-json-patch 在路径不可解析时
 * 会把操作序号错误地上报为 0，这里用循环下标保证序号始终准确。
 */
export function applyJsonPatch(base: JsonValue, ops: Operation[]): PatchApplyResult {
  let document = deepClone(base) as JsonValue;
  for (let i = 0; i < ops.length; i++) {
    try {
      // validateOperation=true：应用前校验；在自有副本上原地修改（mutateDocument=true）
      document = applyOperation(document, ops[i], true, true, true, i).newDocument as JsonValue;
    } catch (err) {
      return { ok: false, failure: { opIndex: i + 1, reason: errorReason(err) } };
    }
  }
  return { ok: true, document };
}
