import { getBySegments, toPointer, unescapeSegment } from './pointer';
import { isPlainObject, type JsonValue } from './types';

/**
 * 输出阶段的「引用完整性检查」：用户以 JSON 文本配置规则列表，每条规则指定
 * 目标对象数组的 JSON Pointer、顶层身份字段与引用路径（RFC 6901，允许整段 *
 * 逐层展开数组并保留具体下标）。
 *
 * 检查分两步：
 * 1. 按合并结果建立目标索引：目标必须存在且为对象数组；每项必须有顶层身份字段，
 *    身份仅限字符串或数字、按类型区分（数字 1 与字符串 "1" 是不同身份）、不得重复；
 *    目标缺失 / 非对象数组 / 身份缺失 / 类型非法 / 重复均记为规则错误，
 *    目标索引有错的规则不再求值其引用路径。
 * 2. 求值引用路径：引用终点缺失或为 null 时跳过，其余必须为字符串或数字；
 *    中间路径缺失、或 * 段遇到非数组记为规则错误；空数组展开后不产生任何引用。
 *    每个引用值（按类型区分）在目标索引中查不到即记为悬空引用。
 */

/** 引用路径段：字面量键 / 下标，或整段 *（展开数组、保留具体下标） */
export type RefSegment = { type: 'literal'; value: string } | { type: '*' };

/** 一条已解析的引用完整性规则 */
export interface RefRule {
  /** 规则序号（自 1 起，即配置数组下标 + 1） */
  index: number;
  /** 目标对象数组的 JSON Pointer 原文（'' 表示根） */
  target: string;
  /** 目标指针的路径段（已反转义） */
  targetSegments: string[];
  /** 顶层身份字段名 */
  identity: string;
  /** 引用路径原文 */
  ref: string;
  /** 引用路径段（字面量或 * 通配段） */
  refSegments: RefSegment[];
}

/** 配置文本层面的错误（rule 为规则序号；整体错误为 null） */
export interface RefConfigError {
  rule: number | null;
  message: string;
}

/** 规则错误（目标索引或引用路径求值问题） */
export interface RefIssue {
  /** 规则序号（自 1 起） */
  rule: number;
  /** 具体路径（RFC 6901；* 已展开为具体下标，根为 ''） */
  pointer: string;
  message: string;
}

/** 一条悬空引用 */
export interface DanglingRef {
  /** 规则序号（自 1 起） */
  rule: number;
  /** 引用所在的具体路径（* 已展开为具体下标） */
  pointer: string;
  /** 引用值（字符串或数字） */
  value: string | number;
}

export interface RefCheckResult {
  /** 规则错误（目标索引与引用路径求值问题） */
  errors: RefIssue[];
  /** 悬空引用清单 */
  dangling: DanglingRef[];
  /** 本次求值得到的引用终点总数（不含缺失 / null 跳过项） */
  checked: number;
}

/** 空检查结果（未启用或无有效规则时使用） */
export const EMPTY_REF_RESULT: RefCheckResult = { errors: [], dangling: [], checked: 0 };

/**
 * 校验并解析配置中的 JSON Pointer（'' 为根；allowStar 时原始段 * 解析为通配段，
 * 键名本身恰为 * 的节点无法在引用路径中按字面量表达）。
 */
function parseConfigPointer(raw: string, allowStar: boolean): RefSegment[] {
  if (raw === '') return [];
  if (!raw.startsWith('/')) {
    throw new Error('必须是 ""（根）或以 / 开头的 JSON Pointer');
  }
  return raw
    .slice(1)
    .split('/')
    .map((seg): RefSegment => {
      // 严格校验 RFC 6901 转义：~ 后只能跟 0 或 1
      if (/~[^01]/.test(seg) || /~$/.test(seg)) {
        throw new Error(`路径段 "${seg}" 含非法 RFC 6901 转义：~ 后只能为 0 或 1`);
      }
      if (allowStar && seg === '*') return { type: '*' };
      return { type: 'literal', value: unescapeSegment(seg) };
    });
}

/**
 * 解析引用完整性规则配置（JSON 文本）：
 * 空文本视为无规则；整体必须是规则数组，每条规则为
 * {"target": "目标数组指针", "identity": "身份字段", "ref": "引用路径"}。
 * 合法规则进入 rules，非法项进入 errors（含规则序号与原因）；
 * 调用方在 errors 非空时就地提示，且不得更新有效配置。
 */
export function parseRefConfig(text: string): { rules: RefRule[]; errors: RefConfigError[] } {
  const rules: RefRule[] = [];
  const errors: RefConfigError[] = [];
  if (text.trim() === '') return { rules, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors.push({
      rule: null,
      message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return { rules, errors };
  }
  if (!Array.isArray(parsed)) {
    errors.push({
      rule: null,
      message: '配置必须是规则数组：[{"target":"…","identity":"…","ref":"…"}]',
    });
    return { rules, errors };
  }

  parsed.forEach((item, i) => {
    const index = i + 1;
    if (!isPlainObject(item)) {
      errors.push({ rule: index, message: '规则必须是对象：{"target":"…","identity":"…","ref":"…"}' });
      return;
    }
    const { target, identity, ref } = item;
    if (typeof target !== 'string') {
      errors.push({ rule: index, message: 'target 必须是字符串（目标对象数组的 JSON Pointer）' });
      return;
    }
    if (typeof identity !== 'string' || identity === '') {
      errors.push({ rule: index, message: 'identity 必须是非空字符串（顶层身份字段名）' });
      return;
    }
    if (typeof ref !== 'string') {
      errors.push({ rule: index, message: 'ref 必须是字符串（引用路径，允许 * 段展开数组）' });
      return;
    }
    try {
      const targetSegments = parseConfigPointer(target, false).map(
        (s) => (s as { value: string }).value,
      );
      const refSegments = parseConfigPointer(ref, true);
      rules.push({ index, target, targetSegments, identity, ref, refSegments });
    } catch (err) {
      errors.push({ rule: index, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return { rules, errors };
}

/** 身份索引键：字符串与数字按类型区分（数字 1 与字符串 "1" 是不同身份） */
function identityKey(v: string | number): string {
  return typeof v === 'string' ? `s:${v}` : `n:${String(v)}`;
}

/**
 * 按合并结果建立一条规则的目标索引（身份键 → 首次出现下标）。
 * 目标缺失 / 非对象数组 / 身份缺失 / 类型非法 / 重复均记入 errors 并返回 null。
 */
function buildTargetIndex(
  merged: JsonValue,
  rule: RefRule,
  errors: RefIssue[],
): Map<string, number> | null {
  const target = getBySegments(merged, rule.targetSegments);
  if (target === undefined) {
    errors.push({ rule: rule.index, pointer: rule.target, message: '目标对象数组缺失' });
    return null;
  }
  if (!Array.isArray(target)) {
    errors.push({ rule: rule.index, pointer: rule.target, message: '目标不是对象数组' });
    return null;
  }
  const index = new Map<string, number>();
  let ok = true;
  target.forEach((el, i) => {
    const pointer = toPointer([...rule.targetSegments, String(i)]);
    const fail = (message: string) => {
      errors.push({ rule: rule.index, pointer, message });
      ok = false;
    };
    if (!isPlainObject(el)) return fail(`第 ${i + 1} 项不是对象`);
    if (!(rule.identity in el)) {
      return fail(`第 ${i + 1} 项缺少身份字段 ${JSON.stringify(rule.identity)}`);
    }
    const id = el[rule.identity];
    if (typeof id !== 'string' && typeof id !== 'number') {
      return fail(`第 ${i + 1} 项身份字段 ${JSON.stringify(rule.identity)} 必须是字符串或数字`);
    }
    const key = identityKey(id);
    const first = index.get(key);
    if (first !== undefined) {
      return fail(`第 ${i + 1} 项身份 ${JSON.stringify(id)} 与第 ${first + 1} 项重复`);
    }
    index.set(key, i);
    return undefined;
  });
  return ok ? index : null;
}

/**
 * 递归求值引用路径：把每个引用终点（字符串 / 数字）收入 refs，
 * 中间路径缺失、* 段遇到非数组、终点类型非法记入 errors；
 * 终点缺失或为 null 跳过，空数组展开后不产生任何引用。
 */
function collectRefs(
  value: JsonValue | undefined,
  rule: RefRule,
  segs: RefSegment[],
  path: string[],
  refs: Array<{ pointer: string; value: string | number }>,
  errors: RefIssue[],
): void {
  if (segs.length === 0) {
    // 引用终点：缺失或 null 跳过，其余必须为字符串或数字
    if (value === undefined || value === null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      refs.push({ pointer: toPointer(path), value });
    } else {
      errors.push({
        rule: rule.index,
        pointer: toPointer(path),
        message: '引用终点必须是字符串或数字',
      });
    }
    return;
  }
  const [seg, ...rest] = segs;
  const last = segs.length === 1;
  if (seg.type === '*') {
    if (!Array.isArray(value)) {
      errors.push({ rule: rule.index, pointer: toPointer(path), message: '「*」段遇到非数组' });
      return;
    }
    // 逐层展开数组、保留具体下标；空数组无引用
    value.forEach((item, i) => collectRefs(item, rule, rest, [...path, String(i)], refs, errors));
    return;
  }
  // 字面量段：对象为键、数组为下标
  const key = seg.value;
  let next: JsonValue | undefined;
  let found = false;
  if (Array.isArray(value)) {
    const idx = Number(key);
    if (Number.isInteger(idx) && idx >= 0 && idx < value.length) {
      next = value[idx];
      found = true;
    }
  } else if (isPlainObject(value) && key in value) {
    next = value[key];
    found = true;
  }
  if (!found) {
    // 最后一段缺失按「引用终点缺失」跳过；中间段缺失报错
    if (last) return;
    errors.push({
      rule: rule.index,
      pointer: toPointer(path),
      message: `中间路径缺失：键 ${JSON.stringify(key)} 不存在`,
    });
    return;
  }
  collectRefs(next, rule, rest, [...path, key], refs, errors);
}

/**
 * 对合并结果执行全部规则的引用完整性检查：
 * 先为每条规则建立目标索引（有错则跳过该规则的引用求值），
 * 再求值引用路径并与索引比对，汇总规则错误与悬空引用。
 */
export function checkRefIntegrity(merged: JsonValue, rules: RefRule[]): RefCheckResult {
  const errors: RefIssue[] = [];
  const dangling: DanglingRef[] = [];
  let checked = 0;
  for (const rule of rules) {
    const index = buildTargetIndex(merged, rule, errors);
    if (index === null) continue; // 目标索引有错：本规则不再求值引用
    const refs: Array<{ pointer: string; value: string | number }> = [];
    collectRefs(merged, rule, rule.refSegments, [], refs, errors);
    checked += refs.length;
    for (const r of refs) {
      if (!index.has(identityKey(r.value))) {
        dangling.push({ rule: rule.index, pointer: r.pointer, value: r.value });
      }
    }
  }
  return { errors, dangling, checked };
}
