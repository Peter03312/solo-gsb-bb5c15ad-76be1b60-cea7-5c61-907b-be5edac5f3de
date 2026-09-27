import { deepEqual } from './deepEqual';
import type { Resolution, Resolutions } from './threeWayMerge';

/** 历史事务的来源：手动决策（采用当前/目标、自定义值）或一次批量规则应用 */
export type TransactionKind = 'manual' | 'batch';

/** 一个冲突在事务前后的选择（undefined 表示该冲突未选择） */
export interface ResolutionChange {
  id: string;
  before: Resolution | undefined;
  after: Resolution | undefined;
}

/**
 * 一次不可分割的历史事务：
 * - 手动采用当前/目标或提交自定义值 → 恰好包含一个冲突的变更；
 * - 一次批量规则应用 → 包含该批次涉及的**全部**冲突变更，撤销/重做整体生效。
 */
export interface HistoryTransaction {
  kind: TransactionKind;
  /** 简明描述，用于按钮提示 */
  label: string;
  changes: ResolutionChange[];
}

/** 决策历史状态：past 为可撤销栈，future 为重做栈，present 为当前选择 */
export interface ResolutionHistoryState {
  past: HistoryTransaction[];
  present: Resolutions;
  future: HistoryTransaction[];
}

export type ResolutionHistoryAction =
  | { type: 'reset'; present: Resolutions }
  | { type: 'commit'; kind: TransactionKind; next: Resolutions; label?: string }
  | { type: 'undo' }
  | { type: 'redo' };

/** 以一组选择作为**不可撤销的初始状态**建立历史（空 past / future） */
export function initHistory(present: Resolutions = {}): ResolutionHistoryState {
  return { past: [], present, future: [] };
}

function resolutionEqual(a: Resolution | undefined, b: Resolution | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return deepEqual(a, b);
}

/** 计算两个 resolutions 状态之间发生变化的冲突（保持键的先后顺序，便于定位首个受影响项） */
export function diffResolutions(before: Resolutions, after: Resolutions): ResolutionChange[] {
  const ids = Object.keys(before);
  for (const id of Object.keys(after)) if (!ids.includes(id)) ids.push(id);
  const changes: ResolutionChange[] = [];
  for (const id of ids) {
    if (!resolutionEqual(before[id], after[id])) {
      changes.push({ id, before: before[id], after: after[id] });
    }
  }
  return changes;
}

/** 单个冲突变更的简明描述 */
export function describeResolution(resolution: Resolution | undefined): string {
  const kind = resolution?.kind;
  if (kind === 'ours') return '采用当前分支';
  if (kind === 'theirs') return '采用目标分支';
  if (kind === 'custom') return '提交自定义值';
  return '清除选择';
}

function describeTransaction(kind: TransactionKind, changes: ResolutionChange[]): string {
  if (kind === 'batch') return `批量应用规则（${changes.length} 项冲突）`;
  return describeResolution(changes[0].after);
}

/** 把一组变更按方向（undo 取 before / redo 取 after）应用到当前选择上 */
function applyChanges(
  current: Resolutions,
  changes: ResolutionChange[],
  direction: 'undo' | 'redo',
): Resolutions {
  const next = { ...current };
  for (const change of changes) {
    const value = direction === 'undo' ? change.before : change.after;
    if (value === undefined) delete next[change.id];
    else next[change.id] = value;
  }
  return next;
}

/**
 * 决策历史 reducer：
 * - reset：以快照恢复结果等作为不可撤销的初始状态，清空两个历史栈；
 * - commit：记入一个事务并**清空重做分支**；与当前状态完全相同的提交为空操作（保留重做分支）；
 * - undo / redo：整体恢复事务涉及的全部冲突，无可用记录时状态不变。
 */
export function resolutionHistoryReducer(
  state: ResolutionHistoryState,
  action: ResolutionHistoryAction,
): ResolutionHistoryState {
  switch (action.type) {
    case 'reset':
      return initHistory(action.present);

    case 'commit': {
      const changes = diffResolutions(state.present, action.next);
      if (changes.length === 0) return state;
      const transaction: HistoryTransaction = {
        kind: action.kind,
        label: action.label ?? describeTransaction(action.kind, changes),
        changes,
      };
      return {
        past: [...state.past, transaction],
        present: action.next,
        future: [],
      };
    }

    case 'undo': {
      if (state.past.length === 0) return state;
      const transaction = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: applyChanges(state.present, transaction.changes, 'undo'),
        future: [transaction, ...state.future],
      };
    }

    case 'redo': {
      if (state.future.length === 0) return state;
      const transaction = state.future[0];
      return {
        past: [...state.past, transaction],
        present: applyChanges(state.present, transaction.changes, 'redo'),
        future: state.future.slice(1),
      };
    }
  }
}
