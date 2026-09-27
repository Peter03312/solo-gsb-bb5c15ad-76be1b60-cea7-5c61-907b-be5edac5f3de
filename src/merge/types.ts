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

/**
 * 只按对象的自有键判定键是否存在。
 * 不能用 `key in obj`：对 `{}` 而言 `'__proto__' in {}`、`'constructor' in {}`
 * 均为 true（继承自 Object.prototype），会把合法的同名 JSON 键误判为基线已有键。
 */
export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 读取对象自有键的值；键不是自有键（含仅存在于原型链上）时返回 undefined */
export function getOwn(obj: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
  if (!hasOwn(obj, key)) return undefined;
  // 自有 __proto__ 是 JSON.parse 产生的可枚举数据描述符；统一经描述符取值，
  // 避免经过 __proto__ 访问器读到原型对象的歧义
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc?.value as JsonValue | undefined;
}

/**
 * 安全写入自有键：对 __proto__ / constructor / toString 等与原型属性同名的键
 * 使用 defineProperty 定义为普通数据描述符，避免：
 * - `obj.__proto__ = x` 命中原型 setter（改写对象原型而非写入自有键，非对象值被静默丢弃）；
 * - `obj.constructor = x` / `obj.toString = x` 遮蔽原型成员（虽不报错，但显式定义语义更清晰）。
 */
export function setOwn(obj: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** 删除对象自有键（键不存在或为继承属性时不做任何事） */
export function deleteOwn(obj: { [key: string]: JsonValue }, key: string): void {
  if (hasOwn(obj, key)) delete obj[key];
}
