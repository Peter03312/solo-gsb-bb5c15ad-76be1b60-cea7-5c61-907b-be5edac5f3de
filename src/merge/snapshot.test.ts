import { describe, expect, it } from 'vitest';
import {
  createSnapshot,
  parseSnapshot,
  restoreResolutions,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  SnapshotParseError,
  type SessionSnapshot,
} from './snapshot';
import { threeWayMerge, type Resolutions } from './threeWayMerge';
import type { JsonValue } from './types';

const BASE: JsonValue = { a: 1, b: 1 };
const OURS: JsonValue = { a: 2, b: 2 };
const THEIRS: JsonValue = { a: 3, b: 3 };

/** 生成一份带两个冲突（/a、/b）的快照 */
function makeSnapshot(resolutions: Resolutions): SessionSnapshot {
  return createSnapshot(threeWayMerge(BASE, OURS, THEIRS), resolutions);
}

describe('createSnapshot / parseSnapshot', () => {
  it('快照包含格式版本、三份源 JSON 与已选解决方案，可序列化后再解析', () => {
    const merge = threeWayMerge(BASE, OURS, THEIRS);
    expect(merge.conflicts.map((c) => `${c.id}:${c.pointer}`)).toEqual(['c0:/a', 'c1:/b']);

    const snapshot = createSnapshot(merge, {
      c0: { kind: 'ours' },
      c1: { kind: 'custom', value: { x: [1, null] } },
    });
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.base).toEqual(BASE);
    expect(snapshot.ours).toEqual(OURS);
    expect(snapshot.theirs).toEqual(THEIRS);
    expect(snapshot.resolutions).toHaveLength(2);

    const parsed = parseSnapshot(JSON.stringify(snapshot, null, 2));
    expect(parsed).toEqual(snapshot);
    expect(parsed.resolutions[1].resolution).toEqual({ kind: 'custom', value: { x: [1, null] } });
  });

  it('仅记录已做出选择的冲突', () => {
    const snapshot = makeSnapshot({ c1: { kind: 'theirs' } });
    expect(snapshot.resolutions).toHaveLength(1);
    expect(snapshot.resolutions[0].pointer).toBe('/b');
    expect(snapshot.resolutions[0].resolution).toEqual({ kind: 'theirs' });
  });

  it('某侧已删除的冲突以 present:false 记录，重新合并后可完整恢复', () => {
    const merge = threeWayMerge({ a: 1, keep: 1 }, { keep: 1 }, { a: 9, keep: 1 });
    expect(merge.conflicts).toHaveLength(1);
    const text = JSON.stringify(createSnapshot(merge, { c0: { kind: 'theirs' } }));

    const raw = JSON.parse(text);
    expect(raw.resolutions[0].base).toEqual({ present: true, value: 1 });
    expect(raw.resolutions[0].ours).toEqual({ present: false });
    expect(raw.resolutions[0].theirs).toEqual({ present: true, value: 9 });

    const remerge = threeWayMerge({ a: 1, keep: 1 }, { keep: 1 }, { a: 9, keep: 1 });
    const result = restoreResolutions(parseSnapshot(text), remerge);
    expect(result.restored).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.resolutions).toEqual({ c0: { kind: 'theirs' } });
  });
});

describe('parseSnapshot 校验', () => {
  const validText = () => JSON.stringify(makeSnapshot({ c0: { kind: 'ours' } }));
  const mutate = (fn: (raw: Record<string, unknown>) => void): string => {
    const raw = JSON.parse(validText()) as Record<string, unknown>;
    fn(raw);
    return JSON.stringify(raw);
  };

  it('非法 JSON / 非对象时报错', () => {
    expect(() => parseSnapshot('not json')).toThrow(SnapshotParseError);
    expect(() => parseSnapshot('not json')).toThrow('不是合法 JSON');
    expect(() => parseSnapshot('[1,2]')).toThrow('快照必须是 JSON 对象');
  });

  it('格式标识或版本不正确时报错', () => {
    expect(() => parseSnapshot(mutate((r) => (r.format = 'other')))).toThrow('格式标识不正确');
    expect(() => parseSnapshot(mutate((r) => delete r.format))).toThrow('格式标识不正确');
    expect(() => parseSnapshot(mutate((r) => (r.version = 99)))).toThrow('不支持的快照版本');
    expect(() => parseSnapshot(mutate((r) => delete r.version))).toThrow('不支持的快照版本');
  });

  it('缺少源 JSON 或 resolutions 非法时报错', () => {
    expect(() => parseSnapshot(mutate((r) => delete r.ours))).toThrow('缺少源 JSON 字段：ours');
    expect(() => parseSnapshot(mutate((r) => (r.resolutions = {})))).toThrow(
      'resolutions 必须是数组',
    );
  });

  it('解决方案条目字段非法时报错', () => {
    const mutateEntry = (patch: Record<string, unknown>): string =>
      mutate((r) => Object.assign((r.resolutions as unknown[])[0] as object, patch));

    expect(() => parseSnapshot(mutateEntry({ pointer: 1 }))).toThrow('pointer 必须是字符串');
    expect(() => parseSnapshot(mutateEntry({ pointer: 'a/b' }))).toThrow('不是合法 JSON Pointer');
    expect(() => parseSnapshot(mutateEntry({ base: { present: 'yes' } }))).toThrow(
      'present 必须是布尔值',
    );
    expect(() => parseSnapshot(mutateEntry({ base: { present: true } }))).toThrow('value 缺失');
    expect(() => parseSnapshot(mutateEntry({ resolution: { kind: 'nope' } }))).toThrow('kind');
    expect(() => parseSnapshot(mutateEntry({ resolution: { kind: 'custom' } }))).toThrow(
      'value 缺失',
    );
    expect(() => parseSnapshot(mutate((r) => (r.resolutions = ['x'])))).toThrow(
      'resolutions[0] 必须是对象',
    );
  });

  it('根指针空字符串是合法 JSON Pointer', () => {
    const text = mutate((r) => ((r.resolutions as { pointer: string }[])[0].pointer = ''));
    expect(() => parseSnapshot(text)).not.toThrow();
  });
});

describe('restoreResolutions', () => {
  it('相同输入重新合并时全部恢复', () => {
    const snapshot = makeSnapshot({ c0: { kind: 'ours' }, c1: { kind: 'custom', value: 42 } });
    const result = restoreResolutions(snapshot, threeWayMerge(BASE, OURS, THEIRS));
    expect(result.restored).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.resolutions).toEqual({
      c0: { kind: 'ours' },
      c1: { kind: 'custom', value: 42 },
    });
  });

  it('按 JSON Pointer + 三方值匹配恢复，而不是按快照顺序或旧冲突序号套用', () => {
    // 旧会话：冲突顺序为 /a(c0)、/b(c1)
    const snapshot = makeSnapshot({ c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    // 新会话：键顺序不同，冲突 id 与指针的对应关系互换（/b 是 c0，/a 是 c1）
    const remerge = threeWayMerge({ b: 1, a: 1 }, { b: 2, a: 2 }, { b: 3, a: 3 });
    expect(remerge.conflicts.map((c) => `${c.id}:${c.pointer}`)).toEqual(['c0:/b', 'c1:/a']);

    const result = restoreResolutions(snapshot, remerge);
    expect(result.restored).toBe(2);
    expect(result.skipped).toEqual([]);
    // /a 的解决方案必须落到新合并中 /a 对应的冲突 id（c1）上，而非沿用旧序号 c0
    expect(result.resolutions).toEqual({ c1: { kind: 'ours' }, c0: { kind: 'theirs' } });
  });

  it('重新合并后不存在该指针的冲突时跳过并汇总原因', () => {
    const snapshot = makeSnapshot({ c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    // 新输入中 /b 双方改成相同值（自动合并），只剩 /a 冲突
    const remerge = threeWayMerge({ a: 1, b: 1 }, { a: 2, b: 5 }, { a: 3, b: 5 });
    expect(remerge.conflicts.map((c) => c.pointer)).toEqual(['/a']);

    const result = restoreResolutions(snapshot, remerge);
    expect(result.restored).toBe(1);
    expect(result.skipped).toEqual([
      { pointer: '/b', reason: '重新合并后不存在该 JSON Pointer 的冲突' },
    ]);
    expect(result.resolutions).toEqual({ c0: { kind: 'ours' } });
  });

  it('三方值与快照不一致时跳过，绝不套用', () => {
    const snapshot = makeSnapshot({ c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    // /a 的 ours 由 2 变为 22；/b 与快照一致
    const remerge = threeWayMerge({ a: 1, b: 1 }, { a: 22, b: 2 }, { a: 3, b: 3 });

    const result = restoreResolutions(snapshot, remerge);
    expect(result.restored).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].pointer).toBe('/a');
    expect(result.skipped[0].reason).toContain('三方值');
    // /b 落在新合并的 c1 上；/a 不得出现在结果中
    expect(result.resolutions).toEqual({ c1: { kind: 'theirs' } });
  });

  it('空解决方案列表是合法快照', () => {
    const result = restoreResolutions(makeSnapshot({}), threeWayMerge(BASE, OURS, THEIRS));
    expect(result.restored).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.resolutions).toEqual({});
  });
});
