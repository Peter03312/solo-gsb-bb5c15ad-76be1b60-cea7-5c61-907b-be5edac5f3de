import { describe, expect, it } from 'vitest';
import {
  alignByIdentity,
  buildIdentityArray,
  countPending,
  formatIdentity,
  isIdentityValue,
  supportsIdentityMerge,
} from './arrayIdentity';
import { ABSENT, type JsonValue } from './types';
import type { Resolution } from './threeWayMerge';

const base = (v: JsonValue) => v;

describe('supportsIdentityMerge', () => {
  it('三方均为对象数组（含空数组）时适用', () => {
    expect(supportsIdentityMerge([], [], [])).toBe(true);
    expect(
      supportsIdentityMerge(
        [{ id: 1 }],
        [{ id: 1 }, { id: 2 }],
        [{ id: 3 }],
      ),
    ).toBe(true);
  });

  it('任一侧含非对象元素时不适用', () => {
    expect(supportsIdentityMerge([1], [1], [1])).toBe(false);
    expect(supportsIdentityMerge(['x'], ['x'], ['x'])).toBe(false);
    expect(supportsIdentityMerge([null], [null], [null])).toBe(false);
    expect(
      supportsIdentityMerge([{ a: 1 }], [{ a: 1 }, 2 as unknown as JsonValue], [{ a: 1 }]),
    ).toBe(false);
  });

  it('一侧整体删除数组时不适用', () => {
    expect(supportsIdentityMerge([{ id: 1 }], ABSENT, [{ id: 1 }])).toBe(false);
  });

  it('isIdentityValue 仅接受有限数字与字符串', () => {
    expect(isIdentityValue('1')).toBe(true);
    expect(isIdentityValue(1)).toBe(true);
    expect(isIdentityValue(null)).toBe(false);
    expect(isIdentityValue(true)).toBe(false);
    expect(isIdentityValue(NaN)).toBe(false);
    expect(isIdentityValue({})).toBe(false);
    expect(isIdentityValue([])).toBe(false);
  });

  it('formatIdentity 字符串加引号数字不加', () => {
    expect(formatIdentity('1')).toBe('"1"');
    expect(formatIdentity(1)).toBe('1');
  });
});

describe('alignByIdentity 校验', () => {
  it('缺少身份字段：指出侧别与项位置', () => {
    const a = alignByIdentity(
      [{ id: 1, v: 0 }],
      [{ v: 1 }],
      [{ id: 1, v: 2 }],
      'id',
      ['list'],
    );
    expect(a.violations).toEqual([
      {
        side: '当前分支',
        index: 1,
        message: '第 1 项缺少身份字段 "id"',
      },
    ]);
  });

  it('身份字段类型不合格时指出实际类型', () => {
    const a = alignByIdentity(
      [{ id: null, v: 0 }],
      [{ id: true, v: 0 }],
      [{ id: [1], v: 0 }],
      'id',
      [],
    );
    expect(a.violations.map((v) => v.side)).toEqual(['基线', '当前分支', '目标分支']);
    expect(a.violations[0].message).toContain('实际为 null');
    expect(a.violations[1].message).toContain('实际为 boolean');
    expect(a.violations[2].message).toContain('实际为 数组');
  });

  it('同侧身份重复时报错并指出首次出现位置', () => {
    const a = alignByIdentity(
      [{ id: 1 }, { id: 1 }],
      [{ id: '1' }, { id: '1' }, { id: 1 }],
      [],
      'id',
      [],
    );
    // 基线第 2 项与第 1 项重复
    expect(a.violations[0]).toMatchObject({ side: '基线', index: 2 });
    expect(a.violations[0].message).toContain('首次出现在第 1 项');
    // 当前分支："1" 重复（第 2 项），数字 1 与字符串 "1" 分开识别（第 3 项不算重复）
    expect(a.violations).toHaveLength(2);
    expect(a.violations[1]).toMatchObject({ side: '当前分支', index: 2 });
  });
});

describe('alignByIdentity 对齐与顺序', () => {
  it('存活基线项保留基线原顺序，重排不采纳', () => {
    const a = alignByIdentity(
      base([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }]),
      [{ id: 3, v: 'c' }, { id: 1, v: 'a' }, { id: 2, v: 'b' }],
      [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }],
      'id',
      ['list'],
    );
    expect(a.records.map((r) => r.identity)).toEqual([1, 2, 3]);
    expect(buildIdentityArray(a, {})).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
      { id: 3, v: 'c' },
    ]);
  });

  it('新身份按当前侧再目标侧首次出现顺序追加', () => {
    const a = alignByIdentity(
      [{ id: 1 }],
      [{ id: 1 }, { id: 2 }, { id: 4 }],
      [{ id: 3 }, { id: 1 }, { id: 5 }],
      'id',
      [],
    );
    expect(a.records.map((r) => r.identity)).toEqual([1, 2, 4, 3, 5]);
    expect(a.records.map((r) => r.addedFrom)).toEqual([
      undefined,
      'ours',
      'ours',
      'theirs',
      'theirs',
    ]);
  });

  it('仅一侧增删改自动合并；双方都删同一项则删除', () => {
    const a = alignByIdentity(
      base([
        { id: 1, v: 1 },
        { id: 2, v: 2 },
        { id: 3, v: 3 },
      ]),
      [{ id: 1, v: 1 }, { id: 3, v: 30 }], // 删 2，改 3
      [{ id: 1, v: 10 }, { id: 2, v: 2 }, { id: 3, v: 3 }], // 改 1
      'id',
      [],
    );
    expect(a.conflicts).toHaveLength(0);
    expect(buildIdentityArray(a, {})).toEqual([
      { id: 1, v: 10 },
      { id: 3, v: 30 },
    ]);
  });

  it('嵌套数组仍按整体值处理：双方各改内部数组产生字段级冲突', () => {
    const a = alignByIdentity(
      base([{ id: 1, tags: ['x'] }]),
      [{ id: 1, tags: ['x', 'y'] }],
      [{ id: 1, tags: ['z'] }],
      'id',
      ['list'],
    );
    expect(a.conflicts).toHaveLength(1);
    expect(a.conflicts[0].fieldPointer).toBe('/tags');
    expect(a.conflicts[0].conflict.pointer).toBe('/list/1/tags');
    expect(countPending(a, {})).toBe(1);
    const dec: Record<string, Resolution> = {
      [a.conflicts[0].key]: { kind: 'ours' },
    };
    expect(countPending(a, dec)).toBe(0);
    expect(buildIdentityArray(a, dec)).toEqual([{ id: 1, tags: ['x', 'y'] }]);
  });

  it('一侧删项另一侧修改：记录级冲突，逐项选择当前（删除）或目标（保留修改）', () => {
    const a = alignByIdentity(
      base([{ id: 1, v: 1 }]),
      [], // 当前侧删除
      [{ id: 1, v: 9 }], // 目标侧修改
      'id',
      ['list'],
    );
    expect(a.conflicts).toHaveLength(1);
    expect(a.conflicts[0].fieldPointer).toBe('');
    expect(a.conflicts[0].conflict.pointer).toBe('/list/1');
    expect(a.conflicts[0].conflict.ours).toBe(ABSENT);
    expect(buildIdentityArray(a, {})).toBeUndefined();
    expect(buildIdentityArray(a, { [a.conflicts[0].key]: { kind: 'ours' } })).toEqual([]);
    expect(
      buildIdentityArray(a, { [a.conflicts[0].key]: { kind: 'theirs' } }),
    ).toEqual([{ id: 1, v: 9 }]);
  });

  it('双方同字段异改：逐项选择当前或目标值；删除字段与设为 null 有别', () => {
    const a = alignByIdentity(
      base([{ id: 1, name: 'a', note: 'x' }]),
      [{ id: 1, name: 'b', note: null }],
      [{ id: 1, name: 'c' }], // 目标侧删除 note
      'id',
      ['list'],
    );
    // name 双方异改；note：一侧改 null 另一侧删除 → 冲突
    expect(a.conflicts.map((c) => c.fieldPointer).sort()).toEqual(['/name', '/note']);
    const note = a.conflicts.find((c) => c.fieldPointer === '/note')!;
    // ours = null（存活），theirs = ABSENT（删除）
    expect(note.conflict.ours).toBeNull();
    expect(note.conflict.theirs).toBe(ABSENT);
    const dec: Record<string, Resolution> = {
      [a.conflicts.find((c) => c.fieldPointer === '/name')!.key]: { kind: 'ours' },
      [note.key]: { kind: 'theirs' }, // 采用删除
    };
    expect(buildIdentityArray(a, dec)).toEqual([{ id: 1, name: 'b' }]);
    // 改为采用 ours：null 保留为存活字段
    const dec2: Record<string, Resolution> = { ...dec, [note.key]: { kind: 'ours' } };
    expect(buildIdentityArray(a, dec2)).toEqual([{ id: 1, name: 'b', note: null }]);
  });

  it('自定义裁决值生效', () => {
    const a = alignByIdentity(
      base([{ id: 1, v: 1 }]),
      [{ id: 1, v: 2 }],
      [{ id: 1, v: 3 }],
      'id',
      [],
    );
    const dec = { [a.conflicts[0].key]: { kind: 'custom' as const, value: 42 } };
    expect(buildIdentityArray(a, dec)).toEqual([{ id: 1, v: 42 }]);
  });

  it('一条记录内多个字段冲突需全部裁决后方可组装', () => {
    const a = alignByIdentity(
      base([{ id: 1, x: 1, y: 1 }]),
      [{ id: 1, x: 2, y: 2 }],
      [{ id: 1, x: 3, y: 3 }],
      'id',
      [],
    );
    expect(a.conflicts).toHaveLength(2);
    expect(countPending(a, { [a.conflicts[0].key]: { kind: 'ours' } })).toBe(1);
    expect(buildIdentityArray(a, { [a.conflicts[0].key]: { kind: 'ours' } })).toBeUndefined();
    const dec: Record<string, Resolution> = {
      [a.conflicts[0].key]: { kind: 'ours' },
      [a.conflicts[1].key]: { kind: 'theirs' },
    };
    expect(buildIdentityArray(a, dec)).toEqual([{ id: 1, x: 2, y: 3 }]);
  });

  it('数字 1 与字符串 "1" 作为不同身份分别对齐', () => {
    const a = alignByIdentity(
      base([{ id: 1, v: 'num' }, { id: '1', v: 'str' }]),
      [{ id: 1, v: 'num' }, { id: '1', v: 'str2' }],
      [{ id: 1, v: 'num' }, { id: '1', v: 'str' }],
      'id',
      [],
    );
    expect(a.violations).toHaveLength(0);
    expect(a.records.map((r) => r.identity)).toEqual([1, '1']);
    expect(buildIdentityArray(a, {})).toEqual([
      { id: 1, v: 'num' },
      { id: '1', v: 'str2' },
    ]);
  });

  it('双方新增同一身份但内容不同：按键合并，冲突按字段暴露', () => {
    const a = alignByIdentity(
      [],
      [{ id: 9, a: 1, b: 2 }],
      [{ id: 9, a: 10, c: 3 }],
      'id',
      ['list'],
    );
    expect(a.conflicts).toHaveLength(1);
    expect(a.conflicts[0].fieldPointer).toBe('/a');
    const dec = { [a.conflicts[0].key]: { kind: 'ours' as const } };
    expect(buildIdentityArray(a, dec)).toEqual([{ id: 9, a: 1, b: 2, c: 3 }]);
  });

  it('存在校验问题时 buildIdentityArray 仍可在无冲突时返回结果（由 UI 负责禁止提交）', () => {
    // 重复身份在对齐阶段最后一次出现覆盖，但 UI 因 violations 非空禁止提交；核心函数不崩溃
    const a = alignByIdentity(
      [{ id: 1, v: 1 }, { id: 1, v: 2 }],
      [{ id: 1, v: 1 }],
      [{ id: 1, v: 1 }],
      'id',
      [],
    );
    expect(a.violations.length).toBeGreaterThan(0);
    expect(buildIdentityArray(a, {})).toBeDefined();
  });
});
