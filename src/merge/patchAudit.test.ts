import { describe, expect, it } from 'vitest';
import {
  auditPatch,
  firstDifference,
  formatAuditPointer,
  formatAuditValue,
} from './patchAudit';
import { diff } from './rfc6902';
import { buildMerged, threeWayMerge, type Resolutions } from './threeWayMerge';
import type { JsonValue } from './types';

const BASE: JsonValue = {
  app: 'demo-service',
  version: '1.2.0',
  features: { auth: true, cache: false, logging: { level: 'info' } },
  tags: ['web', 'api'],
  nested: { list: [{ id: 1 }, { id: 2 }] },
  'a/b~c': 1,
};

const MERGED: JsonValue = {
  app: 'demo-service',
  version: '2.0.0',
  features: { auth: true, cache: true, logging: { level: 'debug' } },
  tags: ['web', 'api', 'admin'],
  nested: { list: [{ id: 1 }, { id: 3 }] },
  owner: 'team-a',
  'a/b~c': 1,
};

/** 自动生成补丁文本（基线 → 合并结果） */
function autoPatchText(base: JsonValue = BASE, merged: JsonValue = MERGED): string {
  return JSON.stringify(diff(base, merged));
}

describe('auditPatch：自动生成补丁恒通过', () => {
  it('diff(base, merged) 生成的补丁审计必须通过', () => {
    const r = auditPatch(autoPatchText(), BASE, MERGED);
    expect(r.kind).toBe('pass');
  });

  it('空补丁：基线即结果时通过', () => {
    const r = auditPatch('[]', BASE, BASE);
    expect(r.kind).toBe('pass');
  });

  it('合并结果为数组/标量时根级替换补丁通过', () => {
    expect(auditPatch('[{"op":"replace","path":"","value":[1,2,3]}]', BASE, [1, 2, 3]).kind).toBe('pass');
    expect(auditPatch('[{"op":"replace","path":"","value":42}]', 1, 42).kind).toBe('pass');
  });

  it('含 move/copy/test 的等价补丁也通过（支持六种操作）', () => {
    const text = JSON.stringify([
      { op: 'test', path: '/version', value: '1.2.0' },
      { op: 'move', from: '/features/logging', path: '/logging' },
      { op: 'copy', from: '/app', path: '/appCopy' },
      { op: 'replace', path: '/version', value: '1.2.0' },
    ]);
    const expected = JSON.parse(JSON.stringify(BASE)) as Record<string, JsonValue>;
    delete (expected.features as Record<string, JsonValue>).logging;
    expected.logging = { level: 'info' };
    expected.appCopy = 'demo-service';
    const r = auditPatch(text, BASE, expected as JsonValue);
    expect(r.kind).toBe('pass');
  });
});

describe('auditPatch：应用失败', () => {
  it('第 2 个操作路径不存在：报告从 1 开始的序号与原因', () => {
    const text = JSON.stringify([
      { op: 'replace', path: '/version', value: '9.9.9' },
      { op: 'remove', path: '/features/nope' },
    ]);
    const r = auditPatch(text, BASE, MERGED);
    expect(r.kind).toBe('apply-failed');
    if (r.kind === 'apply-failed') {
      expect(r.failure.opIndex).toBe(2);
      expect(r.failure.reason).toContain('路径不存在');
    }
  });

  it('第 1 个操作数组索引越界：序号为 1', () => {
    const r = auditPatch('[{"op":"add","path":"/tags/9","value":"x"}]', BASE, MERGED);
    expect(r.kind).toBe('apply-failed');
    if (r.kind === 'apply-failed') expect(r.failure.opIndex).toBe(1);
  });

  it('test 断言失败：报告该操作序号', () => {
    const r = auditPatch(
      JSON.stringify([
        { op: 'replace', path: '/version', value: 'x' },
        { op: 'test', path: '/version', value: '1.2.0' },
      ]),
      BASE,
      MERGED,
    );
    expect(r.kind).toBe('apply-failed');
    if (r.kind === 'apply-failed') {
      expect(r.failure.opIndex).toBe(2);
      expect(r.failure.reason).toContain('test');
    }
  });

  it('失败回放不修改基线：同一基线再次审计仍可通过', () => {
    const bad = JSON.stringify([{ op: 'remove', path: '/app' }, { op: 'remove', path: '/nope' }]);
    expect(auditPatch(bad, BASE, MERGED).kind).toBe('apply-failed');
    expect(BASE.app).toBe('demo-service');
    expect(auditPatch(autoPatchText(), BASE, MERGED).kind).toBe('pass');
  });
});

describe('auditPatch：补丁文本非法', () => {
  it('JSON 语法错误：kind=invalid 且无操作序号', () => {
    const r = auditPatch('[{bad', BASE, MERGED);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.failure.opIndex).toBeNull();
      expect(r.failure.reason).toContain('JSON 解析失败');
    }
  });

  it('非法 op：标明操作序号', () => {
    const r = auditPatch(
      JSON.stringify([
        { op: 'add', path: '/x', value: 1 },
        { op: 'delete', path: '/y' },
      ]),
      BASE,
      MERGED,
    );
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.failure.opIndex).toBe(2);
  });
});

describe('auditPatch：回放完成但与合并结果不同（首个差异）', () => {
  it('标量值不同：报告该指针、期望值与实际值', () => {
    // 自动补丁基础上把 version 改成错误值
    const text = JSON.stringify([...diff(BASE, MERGED), { op: 'replace', path: '/version', value: '9.9.9' }]);
    const r = auditPatch(text, BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/version');
      expect(r.expected).toBe('2.0.0');
      expect(r.actual).toBe('9.9.9');
    }
  });

  it('缺少一个新键：实际值为 undefined，指针指向缺失键', () => {
    // 自动补丁去掉 /owner 的 add
    const ops = diff(BASE, MERGED).filter((op) => op.path !== '/owner');
    const r = auditPatch(JSON.stringify(ops), BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/owner');
      expect(r.expected).toBe('team-a');
      expect(r.actual).toBeUndefined();
    }
  });

  it('多出一个键：期望值为 undefined', () => {
    const ops = [...diff(BASE, MERGED), { op: 'add', path: '/extra', value: 1 }];
    const r = auditPatch(JSON.stringify(ops), BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/extra');
      expect(r.expected).toBeUndefined();
      expect(r.actual).toBe(1);
    }
  });

  it('深层嵌套差异：报告最具体的指针', () => {
    const ops = diff(BASE, MERGED).map((op) =>
      op.path === '/nested/list/1/id' ? { ...op, value: 99 } : op,
    );
    const r = auditPatch(JSON.stringify(ops), BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/nested/list/1/id');
      expect(r.expected).toBe(3);
      expect(r.actual).toBe(99);
    }
  });

  it('数组长度不同：报告首个越界下标', () => {
    const ops = diff(BASE, MERGED).filter((op) => op.path !== '/tags/2');
    const r = auditPatch(JSON.stringify(ops), BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/tags/2');
      expect(r.expected).toBe('admin');
      expect(r.actual).toBeUndefined();
    }
  });

  it('RFC 6901 转义键的差异指针正确转义', () => {
    // 空补丁回放结果仍是 BASE（该键为 1），合并结果中为 2
    const mergedEsc = { ...(BASE as Record<string, JsonValue>), 'a/b~c': 2 };
    const r = auditPatch('[]', BASE, mergedEsc as JsonValue);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      expect(r.pointer).toBe('/a~1b~0c');
      expect(r.expected).toBe(2);
      expect(r.actual).toBe(1);
    }
  });

  it('根级整体不同：指针为根 ""', () => {
    const r = auditPatch('[]', BASE, MERGED);
    expect(r.kind).toBe('mismatch');
    if (r.kind === 'mismatch') {
      // 根对象类型相同，首个差异按键序报告（app 相同、version 不同）；根不同仅在类型不同的场景
      expect(['', '/version']).toContain(r.pointer);
    }
    const rootType = auditPatch('[{"op":"replace","path":"","value":[1]}]', BASE, MERGED);
    expect(rootType.kind).toBe('mismatch');
    if (rootType.kind === 'mismatch') expect(rootType.pointer).toBe('');
  });

  it('首个差异按键序确定性报告：修复首个差异后报告下一个', () => {
    // 同时篡改两个值
    let ops = diff(BASE, MERGED).map((op) =>
      op.path === '/version' ? { ...op, value: 'bad-version' } : op,
    );
    ops = ops.map((op) => (op.path === '/features/cache' ? { ...op, value: 'cache-bad' } : op));
    const r1 = auditPatch(JSON.stringify(ops), BASE, MERGED);
    if (r1.kind !== 'mismatch') throw new Error('should mismatch');
    expect(r1.pointer).toBe('/version'); // /version 键序先于 /features
    expect(r1.actual).toBe('bad-version');

    // 修好第一个后再审计，报告 /features/cache
    ops = ops.map((op) => (op.path === '/version' ? { ...op, value: '2.0.0' } : op));
    const r2 = auditPatch(JSON.stringify(ops), BASE, MERGED);
    if (r2.kind !== 'mismatch') throw new Error('should mismatch');
    expect(r2.pointer).toBe('/features/cache');
  });
});

describe('真实合并管线端到端：自动补丁审计必须通过', () => {
  it('无冲突自动合并 + 全部冲突解决后生成的补丁均可从基线回放得到合并结果', () => {
    // 无冲突：双方改不同键
    {
      const base: JsonValue = { a: 1, b: 2, arr: [1, 2] };
      const ours: JsonValue = { a: 9, b: 2, arr: [1, 2, 3] };
      const theirs: JsonValue = { a: 1, b: 8, arr: [1, 2] };
      const result = threeWayMerge(base, ours, theirs);
      expect(result.conflicts).toHaveLength(0);
      const mergedDoc = buildMerged(result.root, {}) as JsonValue;
      expect(auditPatch(JSON.stringify(diff(base, mergedDoc)), base, mergedDoc).kind).toBe('pass');
    }

    // 有冲突：逐个采用一侧（ours / theirs 混合），含数组整体冲突
    {
      const base: JsonValue = { x: 1, arr: [1, 2], nested: { keep: 1, v: 'b' } };
      const ours: JsonValue = { x: 2, arr: [9], nested: { keep: 1, v: 'o' } };
      const theirs: JsonValue = { x: 3, arr: [8, 7], nested: { keep: 1, v: 't' } };
      const result = threeWayMerge(base, ours, theirs);
      expect(result.conflicts.length).toBeGreaterThan(0);
      const resolutions: Resolutions = {};
      result.conflicts.forEach((c, i) => {
        resolutions[c.id] = i % 2 === 0 ? { kind: 'ours' } : { kind: 'theirs' };
      });
      const mergedDoc = buildMerged(result.root, resolutions) as JsonValue;
      expect(auditPatch(JSON.stringify(diff(base, mergedDoc)), base, mergedDoc).kind).toBe('pass');
    }

    // 根级数组冲突 + 自定义值
    {
      const result = threeWayMerge([1], [2], [3]);
      expect(result.conflicts).toHaveLength(1);
      const resolutions: Resolutions = { [result.conflicts[0].id]: { kind: 'custom', value: [2, 3] } };
      const mergedDoc = buildMerged(result.root, resolutions) as JsonValue;
      expect(auditPatch(JSON.stringify(diff([1], mergedDoc)), [1], mergedDoc).kind).toBe('pass');
    }
  });
});

describe('firstDifference 直接覆盖边界', () => {
  it('相等时返回 null（键序无关）', () => {
    expect(firstDifference({ a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
    expect(firstDifference([1, { x: 2 }], [1, { x: 2 }])).toBeNull();
  });

  it('对象 vs 标量在当前段报告', () => {
    const d = firstDifference({ a: { b: 1 } }, { a: 5 });
    expect(d).toEqual({ pointer: '/a', expected: { b: 1 }, actual: 5 });
  });

  it('null 与缺失可区分', () => {
    const d = firstDifference({ a: null }, {});
    expect(d).toEqual({ pointer: '/a', expected: null, actual: undefined });
  });
});

describe('审计展示格式化', () => {
  it('formatAuditValue：undefined 显示（不存在），其余为 JSON', () => {
    expect(formatAuditValue(undefined)).toBe('（不存在）');
    expect(formatAuditValue(null)).toBe('null');
    expect(formatAuditValue(1)).toBe('1');
  });

  it('formatAuditPointer：根显示（根），非法指针原样返回', () => {
    expect(formatAuditPointer('')).toBe('（根）');
    expect(formatAuditPointer('/a/b')).toBe('/a/b');
    expect(formatAuditPointer('no-leading-slash')).toBe('no-leading-slash');
  });
});
