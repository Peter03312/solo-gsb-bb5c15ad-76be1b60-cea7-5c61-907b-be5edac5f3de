import { useMemo, useState } from 'react';
import type { PatchOp } from '../merge/rfc6902';
import type { JsonValue } from '../merge/types';
import {
  auditPatch,
  formatAuditPointer,
  formatAuditValue,
  type AuditResult,
} from '../merge/patchAudit';
import { downloadText } from '../download';

interface Props {
  /** 基线文档：补丁始终回放到它的独立副本上 */
  base: JsonValue;
  /** 当前合并结果：审计只与之比对，编辑补丁绝不会修改它 */
  merged: JsonValue;
  /** 自动生成的基线 → 合并结果补丁（“重置”恢复到它） */
  autoPatch: PatchOp[];
  onCopy: (text: string, label: string) => void;
}

/** 输出阶段的可编辑“补丁审计”面板 */
export default function PatchAuditPanel({ base, merged, autoPatch, onCopy }: Props) {
  const autoText = useMemo(() => JSON.stringify(autoPatch, null, 2), [autoPatch]);
  const [text, setText] = useState(autoText);
  // null = 尚未审计；编辑后也回到 null（旧结论不再有效）
  const [result, setResult] = useState<AuditResult | null>(null);

  const dirty = text !== autoText;

  const runAudit = () => setResult(auditPatch(text, base, merged));

  const reset = () => {
    setText(autoText);
    setResult(null);
  };

  return (
    <div className="patch-audit-panel">
      <div className="audit-header">
        <h3>补丁审计（可编辑）</h3>
        <span className="hint">
          修改 JSON Patch 后按顺序在基线的独立副本上逐操作回放，并与当前合并结果比对；编辑不会改变合并结果
        </span>
      </div>
      <textarea
        className="audit-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        spellCheck={false}
      />
      <div className="panel-actions">
        <button className="small primary" onClick={runAudit}>
          审计补丁
        </button>
        <button className="small" onClick={reset} disabled={!dirty && result === null} title="恢复自动生成的补丁">
          重置为自动补丁
        </button>
        <button className="small" onClick={() => onCopy(text, '审计补丁 ')}>
          复制
        </button>
        <button className="small" onClick={() => downloadText('audit-patch.json', text)}>
          下载 audit-patch.json
        </button>
        {dirty && <span className="audit-dirty">● 已修改（未重置前不影响合并结果与上方补丁）</span>}
      </div>
      {result && <AuditResultView result={result} />}
    </div>
  );
}

function AuditResultView({ result }: { result: AuditResult }) {
  if (result.kind === 'pass') {
    return (
      <div className="audit-result pass">
        <strong>✓ 审计通过</strong>
        <span>补丁按序回放成功，回放结果与当前合并结果完全一致。</span>
      </div>
    );
  }

  if (result.kind === 'invalid') {
    const { failure } = result;
    return (
      <div className="audit-result fail">
        <strong>✗ 补丁格式非法，无法回放</strong>
        {failure.opIndex !== null && <span>操作序号：{failure.opIndex}</span>}
        <span className="reason">原因：{failure.reason}</span>
      </div>
    );
  }

  if (result.kind === 'apply-failed') {
    const { failure } = result;
    return (
      <div className="audit-result fail">
        <strong>✗ 回放失败</strong>
        <span>
          失败操作序号：<strong className="op-index">{failure.opIndex ?? '—'}</strong>
        </span>
        <span className="reason">原因：{failure.reason}</span>
      </div>
    );
  }

  // mismatch：回放完成但与合并结果不同
  return (
    <div className="audit-result mismatch">
      <strong>✗ 回放结果与当前合并结果不一致</strong>
      <span>
        首个差异 JSON Pointer：<code>{formatAuditPointer(result.pointer)}</code>
      </span>
      <div className="audit-diff-grid">
        <div>
          <h4>期望值（当前合并结果）</h4>
          <pre>{formatAuditValue(result.expected)}</pre>
        </div>
        <div>
          <h4>实际值（补丁回放结果）</h4>
          <pre>{formatAuditValue(result.actual)}</pre>
        </div>
      </div>
    </div>
  );
}
