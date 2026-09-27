/** 任意 JSON 值 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 标记“该侧不存在此节点”（被删除或从未存在） */
export const ABSENT: unique symbol = Symbol('absent');
export type Absent = typeof ABSENT;

/** 合并某一侧的值：JSON 值或“不存在” */
export type SideValue = JsonValue | Absent;

export function isAbsent(v: SideValue): v is Absent {
  return v === ABSENT;
}

export function isPlainObject(v: unknown): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
