import { useEffect, useState } from 'react';
import { isAbsent, type JsonValue, type SideValue } from '../merge/types';
import type { Conflict, Resolution, Resolutions } from '../merge/threeWayMerge';
import { supportsIdentityMerge } from '../merge/arrayIdentity';
import ArrayIdentityMergePanel, {
  emptyIdentityMergeState,
  type IdentityMergeState,
} from './ArrayIdentityMergePanel';

interface Props {
  conflicts: Conflict[];
  resolutions: Resolutions;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onResolve: (id: string, res: Resolution) => void;
}

function SideValueView({ label, value }: { label: string; value: SideValue }) {
  return (
    <div className="side-value">
      <h4>{label}</h4>
      <pre>{isAbsent(value) ? '（此侧已删除）' : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default function ConflictPanel({ conflicts, resolutions, selectedId, onSelect, onResolve }: Props) {
  const index = conflicts.findIndex((c) => c.id === selectedId);
  const conflict = index >= 0 ? conflicts[index] : conflicts[0];
  const current = conflict ? resolutions[conflict.id] : undefined;

  const [customText, setCustomText] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  // 「按身份字段合并」模块的工作状态（按冲突 id 保存，切换冲突不丢失；重新合并时整体清空）
  const [identityStates, setIdentityStates] = useState<Record<string, IdentityMergeState>>({});

  const committed = conflict ? resolutions[conflict.id] : undefined;
  // 当前冲突已提交选择的签名：切换冲突、撤销/重做或批量应用导致选择变化时重新同步输入框
  const committedSignature = committed ? JSON.stringify(committed) : '';

  // 切换冲突，或撤销/重做 / 批量规则改变了当前冲突的已提交选择时，
  // 用当前冲突的“当前分支”值或已有自定义值填充输入框（用户正在输入时不会触发）
  useEffect(() => {
    if (!conflict) return;
    const res = resolutions[conflict.id];
    if (res?.kind === 'custom') {
      setCustomText(JSON.stringify(res.value, null, 2));
    } else {
      setCustomText(isAbsent(conflict.ours) ? '' : JSON.stringify(conflict.ours, null, 2));
    }
    setCustomError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict?.id, committedSignature]);

  // 冲突集合变化（重新合并 / 导入快照）时清空「按身份字段合并」的工作状态
  useEffect(() => {
    setIdentityStates({});
  }, [conflicts]);

  if (!conflict) {
    return <div className="empty-tip">🎉 没有冲突，所有变更已自动合并</div>;
  }

  const goto = (i: number) => {
    const next = conflicts[(i + conflicts.length) % conflicts.length];
    if (next) onSelect(next.id);
  };

  const applyCustom = () => {
    try {
      const value = JSON.parse(customText) as JsonValue;
      onResolve(conflict.id, { kind: 'custom', value });
      setCustomError(null);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  };

  const choiceClass = (kind: Resolution['kind']) =>
    current?.kind === kind ? ' active-choice' : '';

  return (
    <>
      <div className="conflict-nav">
        <button className="small" onClick={() => goto(index - 1)}>← 上一个</button>
        <span className="pos">
          冲突 {index + 1} / {conflicts.length}
        </span>
        <button className="small" onClick={() => goto(index + 1)}>下一个 →</button>
      </div>
      <div className="conflict-detail">
        <div className="pointer">{conflict.pointer || '（根节点）'}</div>
        <div className="reason">⚠ {conflict.reason}</div>
        <div className="side-values">
          <SideValueView label="基线" value={conflict.base} />
          <SideValueView label="当前分支" value={conflict.ours} />
          <SideValueView label="目标分支" value={conflict.theirs} />
        </div>
        {supportsIdentityMerge(conflict.base, conflict.ours, conflict.theirs) && (
          <ArrayIdentityMergePanel
            conflict={conflict}
            state={identityStates[conflict.id] ?? emptyIdentityMergeState}
            onStateChange={(next) =>
              setIdentityStates((prev) => ({ ...prev, [conflict.id]: next }))
            }
            onSubmit={(value) => onResolve(conflict.id, { kind: 'custom', value })}
            currentResolution={current}
          />
        )}
        <div className="resolve-actions">
          <button
            className={`ours-btn${choiceClass('ours')}`}
            onClick={() => onResolve(conflict.id, { kind: 'ours' })}
          >
            采用当前分支
          </button>
          <button
            className={`theirs-btn${choiceClass('theirs')}`}
            onClick={() => onResolve(conflict.id, { kind: 'theirs' })}
          >
            采用目标分支
          </button>
        </div>
        <div className="custom-resolve">
          <textarea
            placeholder='输入自定义 JSON 值，例如 {"key": "value"}'
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            spellCheck={false}
          />
          {customError && <div className="error-text">自定义值不是合法 JSON：{customError}</div>}
          <button className={`small${choiceClass('custom')}`} onClick={applyCustom}>
            使用自定义值
          </button>
        </div>
      </div>
    </>
  );
}
