import { describe, expect, it } from 'vitest';
import {
  diffResolutions,
  initHistory,
  resolutionHistoryReducer,
  type ResolutionHistoryState,
} from './history';
import type { Resolutions } from './threeWayMerge';

function commit(
  state: ResolutionHistoryState,
  next: Resolutions,
  kind: 'manual' | 'batch' = 'manual',
  label?: string,
): ResolutionHistoryState {
  return resolutionHistoryReducer(state, { type: 'commit', kind, next, label });
}

const undo = (state: ResolutionHistoryState) =>
  resolutionHistoryReducer(state, { type: 'undo' });
const redo = (state: ResolutionHistoryState) =>
  resolutionHistoryReducer(state, { type: 'redo' });

describe('diffResolutions', () => {
  it('记录新增、修改与删除', () => {
    const before: Resolutions = { c0: { kind: 'ours' }, c1: { kind: 'custom', value: 1 } };
    const after: Resolutions = { c0: { kind: 'theirs' }, c2: { kind: 'theirs' } };
    expect(diffResolutions(before, after)).toEqual([
      { id: 'c0', before: { kind: 'ours' }, after: { kind: 'theirs' } },
      { id: 'c1', before: { kind: 'custom', value: 1 }, after: undefined },
      { id: 'c2', before: undefined, after: { kind: 'theirs' } },
    ]);
  });

  it('深比较自定义值：值相同则无变化，键序无关', () => {
    const before: Resolutions = { c0: { kind: 'custom', value: { a: 1, b: 2 } } };
    const after: Resolutions = { c0: { kind: 'custom', value: { b: 2, a: 1 } } };
    expect(diffResolutions(before, after)).toEqual([]);
  });
});

describe('resolutionHistoryReducer 手动事务', () => {
  it('每次手动决策记为一个事务，可逐级撤销与重做', () => {
    let s = initHistory();
    s = commit(s, { c0: { kind: 'ours' } });
    s = commit(s, { c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    s = commit(s, { c0: { kind: 'custom', value: 1 }, c1: { kind: 'theirs' } });

    expect(s.past).toHaveLength(3);
    expect(s.past.map((t) => t.label)).toEqual(['采用当前分支', '采用目标分支', '提交自定义值']);

    s = undo(s);
    expect(s.present).toEqual({ c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    s = undo(s);
    expect(s.present).toEqual({ c0: { kind: 'ours' } });
    s = undo(s);
    expect(s.present).toEqual({});
    // 已到初始状态，继续撤销为空操作
    const atStart = s;
    expect(undo(s)).toBe(atStart);

    s = redo(s);
    expect(s.present).toEqual({ c0: { kind: 'ours' } });
    s = redo(s);
    expect(s.present).toEqual({ c0: { kind: 'ours' }, c1: { kind: 'theirs' } });
    s = redo(s);
    expect(s.present).toEqual({ c0: { kind: 'custom', value: 1 }, c1: { kind: 'theirs' } });
    // 已到最新状态，继续重做为空操作
    const atEnd = s;
    expect(redo(s)).toBe(atEnd);
  });

  it('撤销后再做新决策会清空重做分支', () => {
    let s = initHistory();
    s = commit(s, { c0: { kind: 'ours' } });
    s = commit(s, { c0: { kind: 'theirs' } });
    s = undo(s);
    expect(s.future).toHaveLength(1);

    s = commit(s, { c0: { kind: 'custom', value: 'x' } });
    expect(s.future).toEqual([]);
    expect(s.present).toEqual({ c0: { kind: 'custom', value: 'x' } });
    // 被清空的重做分支无法再恢复到旧值
    expect(redo(s)).toBe(s);
  });

  it('提交与当前状态相同的选择不产生事务，也不清空重做分支', () => {
    let s = initHistory({ c0: { kind: 'ours' } });
    s = commit(s, { c0: { kind: 'theirs' } });
    s = undo(s);
    expect(s.future).toHaveLength(1);

    const next = commit(s, { c0: { kind: 'ours' } });
    expect(next).toBe(s);
    expect(next.future).toHaveLength(1);
  });

  it('撤销恢复出的“未选择”状态（删除键）可再次重做', () => {
    let s = initHistory();
    s = commit(s, { c0: { kind: 'ours' } });
    expect(undo(s).present).toEqual({});
    expect('c0' in undo(s).present).toBe(false);
    expect(redo(undo(s)).present).toEqual({ c0: { kind: 'ours' } });
  });
});

describe('resolutionHistoryReducer 批量事务', () => {
  it('一次批量应用整体记为一个事务，撤销时同步恢复批次涉及的全部冲突', () => {
    let s = initHistory({ c0: { kind: 'theirs' } });
    // 批量只处理未选择冲突：c0 保留，c1、c2 写入
    s = commit(
      s,
      { c0: { kind: 'theirs' }, c1: { kind: 'ours' }, c2: { kind: 'theirs' } },
      'batch',
    );

    expect(s.past).toHaveLength(1);
    const tx = s.past[0];
    expect(tx.kind).toBe('batch');
    expect(tx.label).toBe('批量应用规则（2 项冲突）');
    expect(tx.changes.map((c) => c.id)).toEqual(['c1', 'c2']);

    const undone = undo(s);
    // 批次涉及的全部冲突一起回到未选择，批次外的 c0 不受影响
    expect(undone.present).toEqual({ c0: { kind: 'theirs' } });

    const redone = redo(undone);
    expect(redone.present).toEqual({
      c0: { kind: 'theirs' },
      c1: { kind: 'ours' },
      c2: { kind: 'theirs' },
    });
  });

  it('没有实际改动的批量应用不产生事务', () => {
    const s = initHistory({ c0: { kind: 'ours' } });
    const next = commit(s, { c0: { kind: 'ours' } }, 'batch');
    expect(next).toBe(s);
  });

  it('批量撤销后手动修改会清空重做分支', () => {
    let s = initHistory();
    s = commit(s, { c0: { kind: 'ours' }, c1: { kind: 'theirs' } }, 'batch');
    s = undo(s);
    expect(s.future).toHaveLength(1);
    s = commit(s, { c0: { kind: 'ours' }, c1: { kind: 'ours' } });
    expect(s.future).toEqual([]);
    expect(s.past).toHaveLength(1);
  });
});

describe('resolutionHistoryReducer reset', () => {
  it('快照恢复结果作为不可撤销的初始状态', () => {
    let s = initHistory();
    s = commit(s, { c0: { kind: 'ours' } });
    s = commit(s, { c0: { kind: 'theirs' } });

    s = resolutionHistoryReducer(s, {
      type: 'reset',
      present: { c0: { kind: 'custom', value: 9 } },
    });
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.present).toEqual({ c0: { kind: 'custom', value: 9 } });
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});
