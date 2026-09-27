import { ABSENT, isPlainObject, type SideValue } from './types';

/** 两个 JSON 值（可含 ABSENT 哨兵）的深度相等比较，对象键序无关 */
export function deepEqual(a: SideValue, b: SideValue): boolean {
  if (a === ABSENT || b === ABSENT) return a === b;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  return false;
}
