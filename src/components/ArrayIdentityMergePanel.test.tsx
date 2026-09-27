// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import MergeStage from './MergeStage';
import { threeWayMerge, type Resolutions } from '../merge/threeWayMerge';
import {
  initHistory,
  resolutionHistoryReducer,
  type ResolutionHistoryState,
  type TransactionKind,
} from '../merge/history';
import { buildMerged } from '../merge/threeWayMerge';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = function scrollIntoView() {};

const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

function typeInto(input: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 构造一个含对象数组冲突的合并：
 * - id=1：当前删 name，目标改 name（字段级冲突）
 * - id=2：当前删除整项，目标修改（记录级冲突）
 * - id=3：双方一致删除
 * - id=10：仅当前新增
 * - id=20：仅目标新增
 * - 顺序：目标侧重排，应不采纳
 */
function setup() {
  const base: JsonValue = {
    list: [
      { id: 1, name: 'a', v: 1 },
      { id: 2, name: 'b', v: 2 },
      { id: 3, name: 'c' },
    ],
  };
  const ours: JsonValue = {
    list: [
      { id: 10, name: 'new-ours' },
      { id: 1, v: 1 },
    ],
  };
  const theirs: JsonValue = {
    list: [
      { id: 1, name: 'A', v: 1 },
      { id: 2, name: 'b', v: 20 },
      { id: 20, name: 'new-theirs' },
    ],
  };
  const mergeResult = threeWayMerge(base, ours, theirs);
  expect(mergeResult.conflicts.map((c) => c.pointer)).toEqual(['/list']);

  const container = document.createElement('div');
  document.body.appendChild(container);
  let history: ResolutionHistoryState = initHistory();
  const root = createRoot(container);
  const render = (node: ReactElement) => act(() => root.render(node));
  const rerender = () => {
    render(
      <MergeStage
        mergeResult={mergeResult}
        resolutions={history.present}
        onCommit={(kind: TransactionKind, next: Resolutions) => {
          const before = history.past.length;
          history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
          rerender();
          return history.past.length > before ? history.past[history.past.length - 1] : null;
        }}
        onUndo={() => {
          const tx = history.past[history.past.length - 1] ?? null;
          history = resolutionHistoryReducer(history, { type: 'undo' });
          rerender();
          return tx;
        }}
        onRedo={() => {
          const tx = history.future[0] ?? null;
          history = resolutionHistoryReducer(history, { type: 'redo' });
          rerender();
          return tx;
        }}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        undoTransaction={history.past[history.past.length - 1] ?? null}
        redoTransaction={history.future[0] ?? null}
        onFinish={() => {}}
        onBack={() => {}}
        restoreInfo={null}
      />,
    );
  };
  rerender();
  return { container, getHistory: () => history, mergeResult };
}

describe('ConflictPanel 按身份字段合并', () => {
  it('非对象数组冲突不显示模块', () => {
    const base: JsonValue = { list: [1, 2] };
    const mergeResult = threeWayMerge(base, { list: [1, 3] }, { list: [2, 2] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    let history: ResolutionHistoryState = initHistory();
    const root = createRoot(container);
    act(() => {
      root.render(
        <MergeStage
          mergeResult={mergeResult}
          resolutions={history.present}
          onCommit={(kind: TransactionKind, next: Resolutions) => {
            history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
            return null;
          }}
          onUndo={() => null}
          onRedo={() => null}
          canUndo={false}
          canRedo={false}
          undoTransaction={null}
          redoTransaction={null}
          onFinish={() => {}}
          onBack={() => {}}
          restoreInfo={null}
        />,
      );
    });
    expect(container.querySelector('.idm-panel')).toBeNull();
  });

  it('完整流程：填字段 → 报校验错误（禁止提交）→ 改正 → 逐项裁决 → 一次提交为自定义值，可撤销重做', () => {
    const { container, getHistory, mergeResult } = setup();

    // 对象数组冲突显示模块
    const panel = container.querySelector('.idm-panel') as HTMLElement;
    expect(panel).not.toBeNull();

    // 填写一个缺失的字段名 → 报错指出侧别与项位置，无候选数组、无提交按钮
    act(() => typeInto(panel.querySelector('.idm-field-input') as HTMLInputElement, 'nope'));
    const violations = panel.querySelector('.idm-violations') as HTMLElement;
    expect(violations).not.toBeNull();
    expect(violations.textContent).toContain('基线');
    expect(violations.textContent).toContain('第 1 项');
    expect(violations.textContent).toContain('缺少身份字段 "nope"');
    expect(panel.querySelector('.idm-candidate')).toBeNull();
    expect(btnByText(container, '提交候选数组')).toBeUndefined();

    // 改成正确字段 id → 出现对齐记录：3 条基线 + 2 条新增 = 5 条
    act(() => typeInto(panel.querySelector('.idm-field-input') as HTMLInputElement, 'id'));
    expect(panel.querySelector('.idm-violations')).toBeNull();
    expect(panel.querySelector('.idm-summary')?.textContent).toContain('5 条记录');
    // 2 处冲突：/list/1/name（字段级）、/list/2（记录级）
    expect(panel.querySelectorAll('.idm-conflict')).toHaveLength(2);
    expect(panel.querySelector('.idm-pending-tip')?.textContent).toContain('2');

    // 记录级冲突按钮文案区分删除
    const recordConflict = all(panel, '.idm-conflict').find((el) =>
      el.querySelector('code')?.textContent?.endsWith('/list/2'),
    ) as HTMLElement;
    expect(recordConflict.querySelector('.idm-conflict-reason')?.textContent).toContain('记录级冲突');
    expect(btnByText(recordConflict, '采用当前分支（删除该项）')).toBeDefined();
    expect(btnByText(recordConflict, '采用目标分支')).toBeDefined();

    // 字段级冲突：当前删除 name，目标改为 "A"
    const fieldConflict = all(panel, '.idm-conflict').find((el) =>
      el.querySelector('code')?.textContent?.includes('/list/1/name'),
    ) as HTMLElement;
    expect(btnByText(fieldConflict, '采用当前分支（删除该字段）')).toBeDefined();

    // 裁决字段冲突采用目标（name = "A"）
    act(() => btnByText(fieldConflict, '采用目标分支')!.click());
    expect(panel.querySelector('.idm-pending-tip')?.textContent).toContain('1');

    // 裁决记录冲突采用当前（删除 id=2）
    act(() => btnByText(recordConflict, '采用当前分支（删除该项）')!.click());

    // 候选数组生成：基线原顺序（id=1 在前，不采纳重排），新增按当前再目标追加
    const candidate = panel.querySelector('.idm-candidate pre')?.textContent ?? '';
    const parsed = JSON.parse(candidate) as JsonValue[];
    expect(parsed).toEqual([
      { id: 1, name: 'A', v: 1 },
      { id: 10, name: 'new-ours' },
      { id: 20, name: 'new-theirs' },
    ]);

    // 提交为自定义值：整组一次事务（past 仅 1 条）
    act(() => btnByText(container, '提交候选数组')!.click());
    const historyAfter = getHistory();
    expect(historyAfter.past).toHaveLength(1);
    const resolution = historyAfter.present[mergeResult.conflicts[0].id];
    expect(resolution).toEqual({ kind: 'custom', value: parsed });
    // buildMerged 与自定义值一致（接入最终结果 / 导出链路）
    expect(buildMerged(mergeResult.root, historyAfter.present)).toEqual({ list: parsed });

    // 撤销后冲突恢复未解决，重做后再次提交生效
    act(() => btnByText(container, '↩ 撤销')!.click());
    expect(getHistory().present[mergeResult.conflicts[0].id]).toBeUndefined();
    act(() => btnByText(container, '↪ 重做')!.click());
    expect(getHistory().present[mergeResult.conflicts[0].id]).toEqual({
      kind: 'custom',
      value: parsed,
    });
  });

  it('一侧删项另一侧修改的记录级冲突可选择保留（目标），null 与删除在字段冲突中分开呈现', () => {
    const { container } = setup();
    const panel = container.querySelector('.idm-panel') as HTMLElement;
    act(() => typeInto(panel.querySelector('.idm-field-input') as HTMLInputElement, 'id'));

    const fieldConflict = all(panel, '.idm-conflict').find((el) =>
      el.querySelector('code')?.textContent?.includes('/list/1/name'),
    ) as HTMLElement;
    const recordConflict = all(panel, '.idm-conflict').find((el) =>
      el.querySelector('code')?.textContent?.endsWith('/list/2'),
    ) as HTMLElement;

    act(() => btnByText(fieldConflict, '采用当前分支（删除该字段）')!.click());
    act(() => btnByText(recordConflict, '采用目标分支')!.click());

    const parsed = JSON.parse(panel.querySelector('.idm-candidate pre')?.textContent ?? '') as JsonValue[];
    // id=1 的 name 被删除；id=2 保留目标修改；id=3 双方删除不保留；新身份追加
    expect(parsed).toEqual([
      { id: 1, v: 1 },
      { id: 2, name: 'b', v: 20 },
      { id: 10, name: 'new-ours' },
      { id: 20, name: 'new-theirs' },
    ]);
  });

  it('同侧身份重复（数字 1 与字符串 "1" 分开识别）：指出侧别、项位置并禁止提交', () => {
    const base: JsonValue = { list: [{ id: 1 }, { id: '1' }] };
    const ours: JsonValue = { list: [{ id: '1' }, { id: 1 }, { id: 1 }] };
    const theirs: JsonValue = { list: [{ id: 1 }, { id: '1' }, { id: 9 }] };
    const mergeResult = threeWayMerge(base, ours, theirs);

    const container = document.createElement('div');
    document.body.appendChild(container);
    let history: ResolutionHistoryState = initHistory();
    const root = createRoot(container);
    act(() => {
      root.render(
        <MergeStage
          mergeResult={mergeResult}
          resolutions={history.present}
          onCommit={(kind: TransactionKind, next: Resolutions) => {
            history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
            return null;
          }}
          onUndo={() => null}
          onRedo={() => null}
          canUndo={false}
          canRedo={false}
          undoTransaction={null}
          redoTransaction={null}
          onFinish={() => {}}
          onBack={() => {}}
          restoreInfo={null}
        />,
      );
    });
    const panel = container.querySelector('.idm-panel') as HTMLElement;
    act(() => typeInto(panel.querySelector('.idm-field-input') as HTMLInputElement, 'id'));
    const violations = panel.querySelector('.idm-violations') as HTMLElement;
    expect(violations).not.toBeNull();
    // 仅当前分支第 3 项数字 1 重复（首次出现在第 2 项）；字符串 "1"（第 1 项）不冲突
    expect(violations.textContent).toContain('当前分支');
    expect(violations.textContent).toContain('第 3 项');
    expect(violations.textContent).toContain('首次出现在第 2 项');
    expect(btnByText(container, '提交候选数组')).toBeUndefined();
  });
});
