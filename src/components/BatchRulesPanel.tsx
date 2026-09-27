import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BatchRulePatternError,
  compilePattern,
  previewBatchRules,
  type BatchChoice,
  type BatchRule,
} from '../merge/batchRules';
import type { Conflict, Resolutions } from '../merge/threeWayMerge';

interface Props {
  conflicts: Conflict[];
  resolutions: Resolutions;
  /** 应用规则到尚未选择的冲突（MergeStage 负责写入全局 resolutions） */
  onApply: (rules: BatchRule[]) => { applied: string[]; skippedResolved: string[] };
  /** 点击预览中的冲突路径时定位到该冲突 */
  onLocateConflict: (id: string) => void;
}

interface RuleRow {
  id: number;
  pattern: string;
  choice: BatchChoice;
}

interface RowState {
  empty: boolean;
  error: string | null;
}

export default function BatchRulesPanel({ conflicts, resolutions, onApply, onLocateConflict }: Props) {
  const [rows, setRows] = useState<RuleRow[]>([{ id: 1, pattern: '', choice: 'ours' }]);
  const rowIdRef = useRef(1);
  const [collapsed, setCollapsed] = useState(false);
  const [resultMsg, setResultMsg] = useState<{ applied: number; skipped: number; ids: string[] } | null>(null);

  // 撤销批量应用后，相关冲突恢复为未选择：清除“已应用 N 项”的结果提示
  useEffect(() => {
    if (!resultMsg) return;
    if (resultMsg.ids.some((id) => !resolutions[id])) setResultMsg(null);
  }, [resolutions, resultMsg]);

  const addRow = () => {
    rowIdRef.current += 1;
    setRows((rs) => [...rs, { id: rowIdRef.current, pattern: '', choice: 'ours' }]);
    setResultMsg(null);
  };

  /** 每行的模式校验结果（空串 = 尚未填写，不参与校验与应用），及有效规则 → 行号映射 */
  const analysis = useMemo(() => {
    const states: RowState[] = rows.map((row) => {
      const pattern = row.pattern.trim();
      if (pattern === '') return { empty: true, error: null };
      try {
        compilePattern(pattern);
        return { empty: false, error: null };
      } catch (err) {
        const message =
          err instanceof BatchRulePatternError ? err.message : `非法模式：${String(err)}`;
        return { empty: false, error: message };
      }
    });

    const rules: BatchRule[] = [];
    /** 预览中的规则序号 → 编辑器行号 */
    const rowByPreview: number[] = [];
    rows.forEach((row, i) => {
      const state = states[i];
      if (!state.empty && !state.error) {
        rowByPreview.push(i);
        rules.push({ pattern: row.pattern.trim(), choice: row.choice });
      }
    });

    const preview = previewBatchRules(rules, conflicts, resolutions);
    return { states, rules, rowByPreview, preview };
  }, [rows, conflicts, resolutions]);

  const { states, rules, rowByPreview, preview } = analysis;
  const hasError = states.some((s) => s.error !== null);
  /** 行号 → 预览序号 */
  const previewByRow = useMemo(() => {
    const map = new Map<number, number>();
    rowByPreview.forEach((rowIdx, previewIdx) => map.set(rowIdx, previewIdx));
    return map;
  }, [rowByPreview]);

  const updateRow = (id: number, patch: Partial<Omit<RuleRow, 'id'>>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setResultMsg(null);
  };

  const removeRow = (id: number) => {
    setRows((rs) => {
      const next = rs.filter((r) => r.id !== id);
      return next.length === 0
        ? [{ id: (rowIdRef.current += 1), pattern: '', choice: 'ours' }]
        : next;
    });
    setResultMsg(null);
  };

  const moveRow = (index: number, delta: -1 | 1) => {
    setRows((rs) => {
      const target = index + delta;
      if (target < 0 || target >= rs.length) return rs;
      const next = [...rs];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setResultMsg(null);
  };

  const handleApply = () => {
    if (hasError || rules.length === 0) return;
    const { applied, skippedResolved } = onApply(rules);
    if (applied.length === 0) {
      setResultMsg(null);
      return;
    }
    setResultMsg({ applied: applied.length, skipped: skippedResolved.length, ids: applied });
  };

  const pointerText = (pointer: string) => pointer || '（根节点）';

  return (
    <section className="batch-panel">
      <div className="batch-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="batch-toggle">{collapsed ? '▸' : '▾'}</span>
        <h3>批量决策规则</h3>
        <span className="batch-hint">
          按 JSON Pointer 模式自上而下匹配，仅处理尚未选择的冲突，已有手动 / 快照恢复的选择不会被覆盖
        </span>
      </div>

      {!collapsed && (
        <div className="batch-body">
          <div className="batch-syntax-hint">
            模式以 <code>/</code> 开头并遵循 RFC 6901 转义（<code>~0</code> 表示 <code>~</code>，
            <code>~1</code> 表示 <code>/</code>）；<code>*</code> 匹配一个完整路径段，
            <code>**</code> 匹配零个或多个完整路径段。应用后仍可逐项改选。
          </div>

          <div className="batch-rule-list">
            {rows.map((row, i) => {
              const state = states[i];
              const pi = previewByRow.get(i);
              const rulePreview = pi !== undefined ? preview.rules[pi] : undefined;
              return (
                <div key={row.id} className={`batch-rule-row${state.error ? ' invalid' : ''}`}>
                  <div className="batch-rule-order">
                    <button
                      type="button"
                      className="icon-btn"
                      title="上移（规则自上而下取首条命中）"
                      onClick={() => moveRow(i, -1)}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <span className="order-no">{i + 1}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      title="下移"
                      onClick={() => moveRow(i, 1)}
                      disabled={i === rows.length - 1}
                    >
                      ↓
                    </button>
                  </div>
                  <input
                    className="batch-pattern-input"
                    placeholder="/services/*/name"
                    value={row.pattern}
                    spellCheck={false}
                    onChange={(e) => updateRow(row.id, { pattern: e.target.value })}
                  />
                  <select
                    className="batch-choice-select"
                    value={row.choice}
                    onChange={(e) => updateRow(row.id, { choice: e.target.value as BatchChoice })}
                  >
                    <option value="ours">采用当前分支</option>
                    <option value="theirs">采用目标分支</option>
                  </select>
                  {rulePreview && (
                    <span
                      className="batch-hit-badge"
                      title={`命中 ${rulePreview.total} 个冲突，其中 ${rulePreview.pending} 个尚未选择`}
                    >
                      命中 {rulePreview.total}
                      {rulePreview.pending !== rulePreview.total && (
                        <em>（待处理 {rulePreview.pending}）</em>
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    className="icon-btn remove"
                    title="删除此规则"
                    onClick={() => removeRow(row.id)}
                  >
                    ×
                  </button>
                  {state.error && <div className="batch-row-error">⚠ {state.error}</div>}
                  {rulePreview && rulePreview.hits.length > 0 && (
                    <div className="batch-hit-pointers">
                      {rulePreview.hits.map((hit) => (
                        <button
                          key={hit.conflictId}
                          type="button"
                          className={`hit-pointer${hit.pending ? '' : ' resolved'}`}
                          title={
                            hit.pending
                              ? '定位冲突（尚未选择）'
                              : '定位冲突（已有选择，应用时不会覆盖）'
                          }
                          onClick={() => onLocateConflict(hit.conflictId)}
                        >
                          {pointerText(hit.pointer)}
                          {hit.pending ? '' : ' ✓'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="batch-actions">
            <button type="button" className="small" onClick={addRow}>
              ＋ 添加规则
            </button>
            <div className="spacer" style={{ flex: 1 }} />
            {hasError && <span className="batch-blocked">存在非法模式，请修正后再应用</span>}
            {!hasError && rules.length > 0 && (
              <span className="batch-will-apply">
                本次将处理 <strong>{preview.willApply}</strong> 个尚未选择的冲突
              </span>
            )}
            <button
              type="button"
              className="primary"
              onClick={handleApply}
              disabled={hasError || rules.length === 0}
            >
              应用规则
            </button>
          </div>

          {resultMsg && (
            <div className="batch-result">
              ✅ 已按首条命中规则处理 <strong>{resultMsg.applied}</strong> 个冲突
              {resultMsg.skipped > 0 && (
                <>
                  ；<strong>{resultMsg.skipped}</strong> 个已有选择（手动 / 快照恢复），未覆盖
                </>
              )}
              ，可在上方逐项改选。
            </div>
          )}

          {preview.overlapping.length > 0 && (
            <div className="batch-overlap">
              <div className="overlap-title">
                ⚠ 同时命中多条规则的冲突（{preview.overlapping.length}）—— 应用时取最上方首条命中规则
              </div>
              <ul>
                {preview.overlapping.map((o) => (
                  <li key={o.conflictId}>
                    <button
                      type="button"
                      className={`hit-pointer${o.pending ? '' : ' resolved'}`}
                      onClick={() => onLocateConflict(o.conflictId)}
                    >
                      {pointerText(o.pointer)}
                    </button>
                    <span className="overlap-rules">
                      命中规则{' '}
                      {o.ruleIndexes.map((previewIdx) => (
                        <span key={previewIdx} className="rule-no">
                          #{rowByPreview[previewIdx] + 1}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
