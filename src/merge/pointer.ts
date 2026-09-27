import type { JsonValue } from './types';

/** RFC 6901：转义路径段（~ -> ~0，/ -> ~1） */
export function escapeSegment(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** RFC 6901：反转义路径段 */
export function unescapeSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 由路径段数组生成 JSON Pointer 字符串，根为 "" */
export function toPointer(segments: string[]): string {
  if (segments.length === 0) return '';
  return '/' + segments.map(escapeSegment).join('/');
}

/** 解析 JSON Pointer 为路径段数组 */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`非法 JSON Pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeSegment);
}

/** 按路径段读取 JSON 文档中的值；不存在返回 undefined */
export function getBySegments(doc: JsonValue, segments: string[]): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const seg of segments) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, JsonValue>)[seg];
    }
  }
  return cur;
}
