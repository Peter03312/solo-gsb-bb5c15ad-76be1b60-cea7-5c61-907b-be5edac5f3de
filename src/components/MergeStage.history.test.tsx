// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import MergeStage from './MergeStage';
import { threeWayMerge, type Resolutions } from '../merge/threeWayMerge';
import {
  initHistory,
  resolutionHistoryReducer,
  type ResolutionHistoryState,
  type TransactionKind,
} from '../merge/history';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 未实现 scrollIntoView（合并树定位冲突时会调用）
Element.prototype.scrollIntoView = function scrollIntoView() {};

const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const undoBtn = (container: HTMLElement) => btnByText(container, '撤销')!;
const redoBtn = (container: HTMLElement) => btnByText(container, '重做')!;

/** React 受控组件需要用原生 setter 赋值后再派发事件 */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto =
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function mergeWithServiceConflicts() {
  const base: JsonValue = { services: { api: { name: 'n', port: 80 } }, meta: 1 };
  const ours: JsonValue = { services: { api: { name: 'ours-name', port: 81 } }, meta: 2 };
  const theirs: JsonValue = { services: { api: { name: 'theirs-name', port: 82 } }, meta: 3 };
  return threeWayMerge(base, ours, theirs);
}

interface Harness {
  container: HTMLElement;
  getResolutions: () => Resolutions;
  ids: { name: string; port: string; meta: string };
}

function setup(initial: Resolutions = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mergeResult = mergeWithServiceConflicts();
  const idOf = (pointer: string) => mergeResult.conflicts.find((c) => c.pointer === pointer)!.id;
  const ids = {
    name: idOf('/services/api/name'),
    port: idOf('/services/api/port'),
    meta: idOf('/meta'),
  };

  let history: ResolutionHistoryState = initHistory(initial);
  const root = createRoot(container);
  mountedRoots.push(root);
  const render = (node: ReactElement) => act(() => root.render(node));
  const rerender = () => {
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;
    render(
      <MergeStage
        mergeResult={mergeResult}
        resolutions={history.present}
        onCommit={(kind: TransactionKind, next: Resolutions) => {
          const prevLength = history.past.length;
          history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
          rerender();
          return history.past.length > prevLength ? history.past[history.past.length - 1] : null;
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
        canUndo={canUndo}
        canRedo={canRedo}
        undoTransaction={canUndo ? history.past[history.past.length - 1] : null}
        redoTransaction={canRedo ? history.future[0] : null}
        onFinish={() => {}}
        onBack={() => {}}
        restoreInfo={null}
      />,
    );
  };
  rerender();
  return { container, getResolutions: () => history.present, ids };
}

/** 在指定目标上派发 Ctrl+Z（shift=true 即 Ctrl+Shift+Z），返回事件 */
function fireUndoShortcut(target: EventTarget = window, shift = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

// 每个用例后卸载组件，避免 window 上的快捷键监听器串到下一个用例
const mountedRoots: Root[] = [];
afterEach(() => {
  act(() => mountedRoots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
});

describe('MergeStage 撤销 / 重做', () => {
  it('初始或快照恢复的状态下两个按钮均禁用', () => {
    const { container } = setup();
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);

    // 预置选择（模拟快照恢复的不可撤销初始状态）同样无可撤销项
    const restored = setup((() => {
      const r = mergeWithServiceConflicts();
      return { [r.conflicts[0].id]: { kind: 'theirs' as const } };
    })());
    expect(undoBtn(restored.container).disabled).toBe(true);
    expect(redoBtn(restored.container).disabled).toBe(true);
  });

  it('手动决策逐级撤销、重做，按钮禁用状态随之更新', () => {
    const { container, getResolutions, ids } = setup();

    act(() => btnByText(container, '采用当前分支')!.click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });
    expect(undoBtn(container).disabled).toBe(false);
    expect(redoBtn(container).disabled).toBe(true);

    // 自动跳到下一个未解决冲突（port），选目标分支
    act(() => btnByText(container, '采用目标分支')!.click());
    expect(getResolutions()[ids.port]).toEqual({ kind: 'theirs' });

    act(() => undoBtn(container).click());
    expect(getResolutions()[ids.port]).toBeUndefined();
    expect(redoBtn(container).disabled).toBe(false);
    act(() => undoBtn(container).click());
    expect(getResolutions()).toEqual({});
    expect(undoBtn(container).disabled).toBe(true);

    act(() => redoBtn(container).click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });
    act(() => redoBtn(container).click());
    expect(getResolutions()[ids.port]).toEqual({ kind: 'theirs' });
    expect(redoBtn(container).disabled).toBe(true);
  });

  it('撤销后产生新决策清空重做分支', () => {
    const { container, getResolutions, ids } = setup();
    act(() => btnByText(container, '采用当前分支')!.click());
    act(() => undoBtn(container).click());
    expect(redoBtn(container).disabled).toBe(false);

    act(() => btnByText(container, '采用目标分支')!.click());
    expect(redoBtn(container).disabled).toBe(true);
    expect(getResolutions()[ids.name]).toEqual({ kind: 'theirs' });
  });

  it('自定义值提交可撤销，撤销后输入框同步为该冲突当前分支的值', () => {
    const { container, getResolutions, ids } = setup();
    const textarea = container.querySelector('textarea')!;
    act(() => typeInto(textarea, '{"x":1}'));
    act(() => btnByText(container, '使用自定义值')!.click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'custom', value: { x: 1 } });

    act(() => undoBtn(container).click());
    expect(getResolutions()[ids.name]).toBeUndefined();
    expect(container.querySelector('textarea')!.value).toContain('ours-name');
  });

  it('一次批量规则应用整体记为一个事务，撤销/重做同步恢复批次全部冲突', () => {
    const { container, getResolutions, ids } = setup();

    const input = container.querySelector('.batch-pattern-input') as HTMLInputElement;
    act(() => typeInto(input, '/**'));
    act(() => btnByText(container, '应用规则')!.click());

    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });
    expect(getResolutions()[ids.port]).toEqual({ kind: 'ours' });
    expect(getResolutions()[ids.meta]).toEqual({ kind: 'ours' });

    // 整批只是一个事务：撤销一次恢复全部三项
    act(() => undoBtn(container).click());
    expect(getResolutions()).toEqual({});

    act(() => redoBtn(container).click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });
    expect(getResolutions()[ids.port]).toEqual({ kind: 'ours' });
    expect(getResolutions()[ids.meta]).toEqual({ kind: 'ours' });
  });

  it('批量撤销不影响批次外的已有选择，且应用结果提示随之消失', () => {
    // name 冲突已手动选择 theirs（作为批次外的预置选择，模拟快照恢复或早先手动决策）
    const preset = mergeWithServiceConflicts();
    const nameId = preset.conflicts.find((c) => c.pointer === '/services/api/name')!.id;
    const { container, getResolutions, ids } = setup({ [nameId]: { kind: 'theirs' } });
    // 规则 /** ours 只新写入 port、meta，不覆盖 name
    const input = container.querySelector('.batch-pattern-input') as HTMLInputElement;
    act(() => typeInto(input, '/**'));
    act(() => btnByText(container, '应用规则')!.click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'theirs' });
    expect(getResolutions()[ids.port]).toEqual({ kind: 'ours' });
    expect(getResolutions()[ids.meta]).toEqual({ kind: 'ours' });
    expect(container.querySelector('.batch-result')?.textContent).toContain('2');

    act(() => undoBtn(container).click());
    // 批次内两项一起恢复未选择；批次外的手动选择保留
    expect(getResolutions()).toEqual({ [ids.name]: { kind: 'theirs' } });
    expect(container.querySelector('.batch-result')).toBeNull();
  });

  it('Ctrl/Cmd+Z 与 Ctrl/Cmd+Shift+Z 快捷键生效；无可用记录时不响应', () => {
    const { container, getResolutions, ids } = setup();
    // 无历史时不拦截、不改变状态
    expect(fireUndoShortcut().defaultPrevented).toBe(false);
    expect(getResolutions()).toEqual({});

    act(() => btnByText(container, '采用当前分支')!.click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });

    act(() => {
      expect(fireUndoShortcut().defaultPrevented).toBe(true);
    });
    expect(getResolutions()).toEqual({});

    act(() => {
      expect(fireUndoShortcut(window, true).defaultPrevented).toBe(true);
    });
    expect(getResolutions()[ids.name]).toEqual({ kind: 'ours' });
  });

  it('输入框 / 文本域聚焦时不拦截原生 Ctrl+Z / Ctrl+Shift+Z', () => {
    const { container, getResolutions, ids } = setup();
    act(() => btnByText(container, '采用目标分支')!.click());
    expect(getResolutions()[ids.name]).toEqual({ kind: 'theirs' });

    const textarea = container.querySelector('textarea')!;
    act(() => textarea.focus());

    act(() => {
      expect(fireUndoShortcut(textarea).defaultPrevented).toBe(false);
    });
    // 决策未被撤销
    expect(getResolutions()[ids.name]).toEqual({ kind: 'theirs' });

    act(() => {
      expect(fireUndoShortcut(textarea, true).defaultPrevented).toBe(false);
    });
    expect(getResolutions()[ids.name]).toEqual({ kind: 'theirs' });
  });
});
