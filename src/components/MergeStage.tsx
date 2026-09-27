import { useEffect, useState } from 'react';
import BatchRulesPanel from './BatchRulesPanel';
import ConflictPanel from './ConflictPanel';
import MergeTree from './MergeTree';
import {
  countConflicts,
  type MergeResult,
  type Resolution,
  type Resolutions,
} from '../merge/threeWayMerge';
import { applyBatchRules, type BatchRule } from '../merge/batchRules';
import type { HistoryTransaction, TransactionKind } from '../merge/history';
import { createSnapshot, type RestoreSummary } from '../merge/snapshot';
import { downloadText } from '../download';

interface Props {
  mergeResult: MergeResult;
  resolutions: Resolutions;
  /** 提交一组新选择：手动决策传 'manual'（单冲突），批量应用传 'batch'（整批一个事务）；
   *  与当前状态无差异时返回 null（不产生事务） */
  onCommit: (kind: TransactionKind, next: Resolutions) => HistoryTransaction | null;
  onUndo: () => HistoryTransaction | null;
  onRedo: () => HistoryTransaction | null;
  canUndo: boolean;
  canRedo: boolean;
  /** 栈顶事务，用于按钮提示 */
  undoTransaction: HistoryTransaction | null;
  redoTransaction: HistoryTransaction | null;
  onFinish: () => void;
  onBack: () => void;
  /** 从快照导入时的恢复汇总（非快照导入时为 null） */
  restoreInfo: RestoreSummary | null;
}

/** 判断元素是否为原生文本编辑控件（聚焦其中时不拦截 Ctrl/Cmd+Z 等编辑快捷键） */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  if (el.tagName === 'INPUT') {
    // 仅文本类输入框需要保留原生撤销；复选框 / 单选框等不拦截
    const textTypes = ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'];
    return textTypes.includes((el as HTMLInputElement).type.toLowerCase());
  }
  return false;
}

export default function MergeStage({
  mergeResult,
  resolutions,
  onCommit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  undoTransaction,
  redoTransaction,
  onFinish,
  onBack,
  restoreInfo,
}: Props) {
  // 初始定位到首个未解决的冲突（快照导入时跳过已恢复的项）
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      mergeResult.conflicts.find((c) => !resolutions[c.id])?.id ??
      mergeResult.conflicts[0]?.id ??
      null,
  );
  const [showUnchanged, setShowUnchanged] = useState(true);
  const [showRestoreInfo, setShowRestoreInfo] = useState(true);

  const { total, resolved } = countConflicts(mergeResult.root, resolutions);
  const allResolved = total === resolved;

  /** 撤销/重做后定位到该事务涉及的首个冲突（仍存在时） */
  const focusFirstChanged = (transaction: HistoryTransaction | null) => {
    const id = transaction?.changes[0]?.id;
    if (id !== undefined && mergeResult.conflicts.some((c) => c.id === id)) {
      setSelectedId(id);
    }
  };

  const handleUndo = () => focusFirstChanged(onUndo());
  const handleRedo = () => focusFirstChanged(onRedo());

  // 快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y 重做；
  // 焦点位于文本输入框 / 文本域 / contenteditable 时不拦截，保留原生编辑行为。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        if (!canUndo) return;
        e.preventDefault();
        handleUndo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        if (!canRedo) return;
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUndo, canRedo, onUndo, onRedo, mergeResult.conflicts]);

  const handleResolve = (id: string, res: Resolution) => {
    const next = { ...resolutions, [id]: res };
    // 手动采用当前/目标或提交自定义值：每次记为一个历史事务
    onCommit('manual', next);
    // 自动跳到下一个未解决的冲突
    const nextUnresolved = mergeResult.conflicts.find((c) => c.id !== id && !next[c.id]);
    if (nextUnresolved) setSelectedId(nextUnresolved.id);
  };

  const handleDownloadSnapshot = () => {
    const snapshot = createSnapshot(mergeResult, resolutions);
    downloadText('merge-session-snapshot.json', JSON.stringify(snapshot, null, 2));
  };

  // 批量决策规则：自上而下首条命中，只处理尚未选择的冲突，绝不覆盖已有选择。
  // 一次应用整体记为一个事务，撤销/重做时同步恢复该批次涉及的全部冲突。
  const handleApplyBatch = (rules: BatchRule[]) => {
    const result = applyBatchRules(rules, mergeResult.conflicts, resolutions);
    if (result.applied.length > 0) {
      onCommit('batch', result.resolutions);
    }
    // 应用后定位到第一个仍未解决的冲突，便于继续逐项处理
    const nextUnresolved = mergeResult.conflicts.find((c) => !result.resolutions[c.id]);
    if (nextUnresolved) setSelectedId(nextUnresolved.id);
    return { applied: result.applied, skippedResolved: result.skippedResolved };
  };

  return (
    <>
      <div className="merge-layout">
        <div className="merge-tree-panel">
          <h3>合并树</h3>
          <div className="tree-toolbar">
            <label>
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(e) => setShowUnchanged(e.target.checked)}
              />{' '}
              显示未变更节点
            </label>
            <span>点击红色冲突行可定位并解决</span>
          </div>
          <MergeTree
            root={mergeResult.root}
            resolutions={resolutions}
            selectedConflictId={selectedId}
            onSelectConflict={setSelectedId}
            showUnchanged={showUnchanged}
          />
        </div>
        <div className="conflict-panel">
          <h3>冲突解决</h3>
          <div className="history-bar">
            <button
              type="button"
              className="small"
              onClick={handleUndo}
              disabled={!canUndo}
              title={undoTransaction ? `撤销：${undoTransaction.label}（Ctrl/⌘+Z）` : '没有可撤销的决策'}
            >
              ↩ 撤销
            </button>
            <button
              type="button"
              className="small"
              onClick={handleRedo}
              disabled={!canRedo}
              title={
                redoTransaction
                  ? `重做：${redoTransaction.label}（Ctrl/⌘+Shift+Z）`
                  : '没有可重做的决策'
              }
            >
              ↪ 重做
            </button>
            <span className="history-hint">Ctrl/⌘+Z 撤销 · Ctrl/⌘+Shift+Z 重做</span>
          </div>
          {restoreInfo && showRestoreInfo && (
            <div className="restore-banner">
              <div className="restore-head">
                <span>
                  📥 快照已导入：恢复 <strong>{restoreInfo.restored}</strong> 项选择，跳过{' '}
                  <strong>{restoreInfo.skipped.length}</strong> 项
                </span>
                <button
                  className="dismiss"
                  onClick={() => setShowRestoreInfo(false)}
                  title="关闭提示"
                >
                  ×
                </button>
              </div>
              {restoreInfo.skipped.length > 0 && (
                <ul>
                  {restoreInfo.skipped.map((s, i) => (
                    <li key={i}>
                      <code>{s.pointer || '（根节点）'}</code>：{s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="progress-line">
            已解决 <strong>{resolved}</strong> / {total} 个冲突
          </div>
          <div className="progress-bar">
            <div style={{ width: total === 0 ? '100%' : `${(resolved / total) * 100}%` }} />
          </div>
          {allResolved && (
            <div className="all-done">✅ 全部冲突已解决，可以生成合并结果。</div>
          )}
          <ConflictPanel
            conflicts={mergeResult.conflicts}
            resolutions={resolutions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onResolve={handleResolve}
          />
        </div>
      </div>
      {mergeResult.conflicts.length > 0 && (
        <BatchRulesPanel
          conflicts={mergeResult.conflicts}
          resolutions={resolutions}
          onApply={handleApplyBatch}
          onLocateConflict={setSelectedId}
        />
      )}
      <div className="merge-footer">
        <button onClick={onBack}>← 返回重新输入</button>
        <button onClick={handleDownloadSnapshot}>下载会话快照</button>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="primary" onClick={onFinish} disabled={!allResolved}>
          生成合并结果 →
        </button>
      </div>
    </>
  );
}
