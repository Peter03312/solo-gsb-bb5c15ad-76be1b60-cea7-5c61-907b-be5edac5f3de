import { deepEqual } from './deepEqual';
import { escapeSegment } from './pointer';
import { isPlainObject, type JsonValue } from './types';

export type PatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue };

/**
 * 生成 base -> target 的 RFC 6902 JSON Patch。
 * 数组按索引对齐比较：公共前缀递归 diff，多余元素从尾部倒序 remove，新增元素依次 add。
 */
export function diff(base: JsonValue, target: JsonValue): PatchOp[] {
  const ops: PatchOp[] = [];
  diffInto(base, target, '', ops);
  return ops;
}

function diffInto(base: JsonValue, target: JsonValue, path: string, ops: PatchOp[]): void {
  if (deepEqual(base, target)) return;

  if (isPlainObject(base) && isPlainObject(target)) {
    for (const k of Object.keys(base)) {
      if (!(k in target)) {
        ops.push({ op: 'remove', path: path + '/' + escapeSegment(k) });
      }
    }
    for (const k of Object.keys(target)) {
      const childPath = path + '/' + escapeSegment(k);
      if (!(k in base)) {
        ops.push({ op: 'add', path: childPath, value: target[k] });
      } else {
        diffInto(base[k], target[k], childPath, ops);
      }
    }
    return;
  }

  if (Array.isArray(base) && Array.isArray(target)) {
    const min = Math.min(base.length, target.length);
    for (let i = 0; i < min; i++) {
      diffInto(base[i], target[i], `${path}/${i}`, ops);
    }
    // 先倒序删除多余元素，避免索引位移
    for (let i = base.length - 1; i >= min; i--) {
      ops.push({ op: 'remove', path: `${path}/${i}` });
    }
    for (let i = min; i < target.length; i++) {
      ops.push({ op: 'add', path: `${path}/${i}`, value: target[i] });
    }
    return;
  }

  ops.push({ op: 'replace', path, value: target });
}
