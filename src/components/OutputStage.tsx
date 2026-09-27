import { useEffect, useMemo, useRef, useState } from 'react';
import type { PatchOp } from '../merge/rfc6902';
import type { JsonValue } from '../merge/types';
import type { CompiledSchema } from '../merge/schema';
import { validateMerged } from '../merge/schema';
import type { MergeResult, Resolutions } from '../merge/threeWayMerge';
import { buildDecisionTrace } from '../merge/decisionTrace';
import { computeProtectedHits, parseProtectedRules } from '../merge/protectedPaths';
import { checkRefIntegrity, parseRefConfig, EMPTY_REF_RESULT } from '../merge/refIntegrity';
import { buildPointerLines, resolveLine } from '../merge/jsonLineMap';
import { downloadText } from '../download';
import SchemaPanel from './SchemaPanel';
import ValidationIssues from './ValidationIssues';
import PatchAuditPanel from './PatchAuditPanel';
import DecisionTracePanel from './DecisionTracePanel';
import ProtectedPathsPanel from './ProtectedPathsPanel';
import RefIntegrityPanel from './RefIntegrityPanel';

interface Props {
  base: JsonValue;
  merged: JsonValue;
  patch: PatchOp[];
  /** 合并树与冲突解决结果：决策溯源据此还原每一路径的基线 / 两侧值与来源类别 */
  mergeResult: MergeResult;
  resolutions: Resolutions;
  schemaEnabled: boolean;
  schema: CompiledSchema | null;
  onSchemaEnabledChange: (v: boolean) => void;
  onSchemaChange: (s: CompiledSchema | null) => void;
  /** 受保护路径规则配置（逐行一条模式；由 App 保存，返回调整重新生成后仍保留） */
  protectedConfig: string;
  onProtectedConfigChange: (text: string) => void;
  /** 引用完整性检查开关与规则配置（JSON 文本；由 App 保存，返回调整保留、重新开始清空） */
  refCheckEnabled: boolean;
  refCheckConfig: string;
  onRefCheckEnabledChange: (v: boolean) => void;
  onRefCheckConfigChange: (text: string) => void;
  onBack: () => void;
  onRestart: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 带行号的 JSON 结果视图，支持按行高亮并滚动定位 */
function JsonResultView({
  text,
  highlightLine,
  lineRef,
}: {
  text: string;
  highlightLine: number | null;
  lineRef: React.MutableRefObject<(HTMLDivElement | null)[]>;
}) {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="json-lines">
      {lines.map((line, i) => (
        <div
          key={i}
          ref={(el) => {
            lineRef.current[i] = el;
          }}
          className={`json-line${i === highlightLine ? ' hit' : ''}`}
        >
          <span className="ln">{i + 1}</span>
          <span className="code">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export default function OutputStage({
  base,
  merged,
  patch,
  mergeResult,
  resolutions,
  schemaEnabled,
  schema,
  onSchemaEnabledChange,
  onSchemaChange,
  protectedConfig,
  onProtectedConfigChange,
  refCheckEnabled,
  refCheckConfig,
  onRefCheckEnabledChange,
  onRefCheckConfigChange,
  onBack,
  onRestart,
}: Props) {
  const [toast, setToast] = useState<string | null>(null);
  const [hitLine, setHitLine] = useState<number | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  // 受保护路径命中项的逐项确认（变更路径集合）；返回调整重新生成后本组件重挂载即清空
  const [confirmedProtected, setConfirmedProtected] = useState<ReadonlySet<string>>(new Set());

  const mergedText = JSON.stringify(merged, null, 2);
  const patchText = JSON.stringify(patch, null, 2);

  const groups = useMemo(
    () => (schemaEnabled && schema ? validateMerged(schema, merged) : []),
    [schemaEnabled, schema, merged],
  );
  const errorCount = groups.reduce((n, g) => n + g.issues.length, 0);

  // 受保护路径检查：以决策溯源的最终变更为输入，按有效规则计算命中（按变更路径合并）
  const traceEntries = useMemo(
    () => buildDecisionTrace(mergeResult, resolutions, merged),
    [mergeResult, resolutions, merged],
  );
  const protectedRules = useMemo(
    () => parseProtectedRules(protectedConfig).rules,
    [protectedConfig],
  );
  const protectedHits = useMemo(
    () => computeProtectedHits(traceEntries, protectedRules),
    [traceEntries, protectedRules],
  );
  // 存在未确认的命中项时禁用 merged.json / patch.json 下载
  const protectedBlocked = protectedHits.some((h) => !confirmedProtected.has(h.entry.pointer));

  // 引用完整性检查：以合并结果 + 已生效规则计算（规则修改或重新生成结果后自动重检）
  const refApplied = useMemo(() => {
    const { rules, errors } = parseRefConfig(refCheckConfig);
    return { rules, errors, ruleCount: rules.length };
  }, [refCheckConfig]);
  const refResult = useMemo(
    () =>
      refCheckEnabled && refApplied.errors.length === 0
        ? checkRefIntegrity(merged, refApplied.rules)
        : EMPTY_REF_RESULT,
    [refCheckEnabled, refApplied, merged],
  );
  // 启用且存在配置错误 / 规则错误 / 悬空引用时禁用 merged.json / patch.json 下载
  const refBlocked =
    refCheckEnabled &&
    (refApplied.errors.length > 0 ||
      refResult.errors.length > 0 ||
      refResult.dangling.length > 0);

  const downloadBlocked = protectedBlocked || refBlocked;
  const downloadBlockTitle = protectedBlocked
    ? '受保护路径命中项未全部确认，暂不可下载'
    : refBlocked
      ? '引用完整性检查存在错误，暂不可下载'
      : undefined;

  // JSON Pointer → 渲染行号
  const pointerLines = useMemo(() => buildPointerLines(mergedText), [mergedText]);

  // Schema 变化或重新生成结果后清除旧高亮
  useEffect(() => {
    setHitLine(null);
  }, [schema, merged]);

  // 保护规则变化后旧确认不再有效，需按新命中清单重新逐项确认
  useEffect(() => {
    setConfirmedProtected(new Set());
  }, [protectedConfig]);

  const toggleProtectedConfirm = (pointer: string) => {
    setConfirmedProtected((prev) => {
      const next = new Set(prev);
      if (next.has(pointer)) next.delete(pointer);
      else next.add(pointer);
      return next;
    });
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const handleCopy = async (text: string, label: string) => {
    showToast((await copyText(text)) ? `${label}已复制到剪贴板` : '复制失败，请手动选择复制');
  };

  const handleLocate = (instancePath: string) => {
    const ln = resolveLine(pointerLines, instancePath);
    if (ln === null) return;
    setHitLine(ln);
    lineRefs.current[ln]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };

  const showValidation = schemaEnabled && schema !== null;

  return (
    <>
      <SchemaPanel
        enabled={schemaEnabled}
        schema={schema}
        onEnabledChange={onSchemaEnabledChange}
        onSchemaChange={onSchemaChange}
      />
      {showValidation && <ValidationIssues groups={groups} onLocate={handleLocate} />}
      <ProtectedPathsPanel
        configText={protectedConfig}
        onConfigChange={onProtectedConfigChange}
        hits={protectedHits}
        confirmed={confirmedProtected}
        onToggleConfirm={toggleProtectedConfirm}
      />
      <RefIntegrityPanel
        enabled={refCheckEnabled}
        onEnabledChange={onRefCheckEnabledChange}
        configText={refCheckConfig}
        onConfigChange={onRefCheckConfigChange}
        applied={refApplied}
        result={refResult}
        onLocate={handleLocate}
      />
      <div className="output-grid">
        <div className="output-panel">
          <h3>合并结果 JSON</h3>
          <JsonResultView text={mergedText} highlightLine={hitLine} lineRef={lineRefs} />
          <div className="panel-actions">
            <button className="small" onClick={() => void handleCopy(mergedText, '合并结果 ')}>
              复制
            </button>
            <button
              className="small"
              disabled={downloadBlocked}
              title={downloadBlockTitle}
              onClick={() => downloadText('merged.json', mergedText)}
            >
              下载 merged.json
            </button>
            {protectedBlocked && (
              <span
                className="download-warn"
                title="在「受保护路径检查」中逐项确认全部命中变更后恢复下载"
              >
                ⚠ 受保护命中未确认
              </span>
            )}
            {refBlocked && (
              <span
                className="download-warn"
                title="在「引用完整性检查」中修复规则错误或悬空引用后恢复下载"
              >
                ⚠ 引用完整性检查未通过
              </span>
            )}
            {showValidation && errorCount > 0 && (
              <span
                className="download-warn"
                title="合并结果未通过 Schema 校验，仍可下载；点击错误路径可定位"
              >
                ⚠ {errorCount} 个校验错误
              </span>
            )}
          </div>
        </div>
        <div className="output-panel">
          <h3>RFC 6902 补丁（基线 → 合并结果）</h3>
          <pre>{patchText}</pre>
          <div className="panel-actions">
            <button className="small" onClick={() => void handleCopy(patchText, '补丁 ')}>
              复制
            </button>
            <button
              className="small"
              disabled={downloadBlocked}
              title={downloadBlockTitle}
              onClick={() => downloadText('patch.json', patchText)}
            >
              下载 patch.json
            </button>
            {protectedBlocked && (
              <span
                className="download-warn"
                title="在「受保护路径检查」中逐项确认全部命中变更后恢复下载"
              >
                ⚠ 受保护命中未确认
              </span>
            )}
            {refBlocked && (
              <span
                className="download-warn"
                title="在「引用完整性检查」中修复规则错误或悬空引用后恢复下载"
              >
                ⚠ 引用完整性检查未通过
              </span>
            )}
          </div>
        </div>
      </div>
      <PatchAuditPanel base={base} merged={merged} autoPatch={patch} onCopy={handleCopy} />
      <DecisionTracePanel mergeResult={mergeResult} resolutions={resolutions} merged={merged} />
      <div className="output-actions">
        <button onClick={onBack}>← 返回继续调整</button>
        <button onClick={onRestart}>重新开始</button>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
