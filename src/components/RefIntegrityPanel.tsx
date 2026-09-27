import { useState } from 'react';
import {
  parseRefConfig,
  type RefCheckResult,
  type RefConfigError,
} from '../merge/refIntegrity';

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** 已生效的规则配置（JSON 文本；由 App 保存，返回调整重新生成后仍保留） */
  configText: string;
  /** 应用合法配置时更新有效规则；非法配置不会触发本回调（就地提示，沿用旧规则） */
  onConfigChange: (text: string) => void;
  /** 已生效配置的解析结果（规则数与配置级错误；正常无错误，防御性展示） */
  applied: { ruleCount: number; errors: RefConfigError[] };
  /** 以合并结果 + 有效规则算出的检查结果 */
  result: RefCheckResult;
  /** 点击具体路径在合并结果视图中定位 */
  onLocate: (pointer: string) => void;
}

const PLACEHOLDER = `[
  {
    "target": "/servers",
    "identity": "id",
    "ref": "/apps/*/serverId"
  }
]`;

const displayPointer = (p: string) => (p === '' ? '（根）' : p);

/**
 * 输出阶段的「引用完整性检查」面板：以 JSON 文本配置规则列表
 * （目标对象数组指针 + 顶层身份字段 + 引用路径，引用路径允许 * 段逐层展开数组），
 * 列出规则错误与悬空引用（含规则序号与具体路径）；启用且存在错误时禁止下载导出文件。
 */
export default function RefIntegrityPanel({
  enabled,
  onEnabledChange,
  configText,
  onConfigChange,
  applied,
  result,
  onLocate,
}: Props) {
  const [text, setText] = useState(configText);
  const [configErrors, setConfigErrors] = useState<RefConfigError[]>([]);

  const dirty = text !== configText;

  const apply = () => {
    const { errors } = parseRefConfig(text);
    if (errors.length > 0) {
      // 配置非法：就地提示，不更新有效规则（检查仍按上一份有效规则计算）
      setConfigErrors(errors);
      return;
    }
    setConfigErrors([]);
    onConfigChange(text);
  };

  const clear = () => {
    setText('');
    setConfigErrors([]);
    onConfigChange('');
  };

  const issueCount = result.errors.length + result.dangling.length;
  const hasIssues = applied.errors.length > 0 || issueCount > 0;

  return (
    <section className="refcheck-panel">
      <div className="refcheck-header">
        <label className="refcheck-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          <strong>引用完整性检查</strong>
          <span className="hint">
            （按规则核对合并结果中的引用能否解析到目标身份；启用且有错误时禁止下载）
          </span>
        </label>
        {enabled && !hasIssues && applied.ruleCount > 0 && (
          <span className="refcheck-status ok">● 检查通过</span>
        )}
        {enabled && hasIssues && (
          <span className="refcheck-status bad">● 存在错误，已禁止下载</span>
        )}
      </div>
      {enabled && (
        <>
          <textarea
            className={`refcheck-input${configErrors.length > 0 ? ' invalid' : ''}`}
            placeholder={PLACEHOLDER}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {configErrors.length > 0 && (
            <div className="error-text">
              {configErrors.map((e, i) => (
                <div key={i}>
                  {e.rule === null ? e.message : `规则 #${e.rule}：${e.message}`}
                </div>
              ))}
            </div>
          )}
          <div className="panel-actions">
            <button
              className="small primary"
              onClick={apply}
              disabled={!dirty && configErrors.length === 0}
              title={dirty ? '应用当前规则并重新检查' : '规则已是最新'}
            >
              应用规则
            </button>
            <button className="small" onClick={clear} disabled={text === '' && configText === ''}>
              清空
            </button>
            {configErrors.length > 0 && (
              <span className="refcheck-status bad">● 配置非法，沿用上一份有效规则</span>
            )}
            {configErrors.length === 0 && dirty && (
              <span className="refcheck-status dirty">● 规则已修改，应用后重新检查</span>
            )}
          </div>
          {applied.errors.length > 0 && (
            <div className="refcheck-summary bad">
              ⚠ 已生效配置异常：
              {applied.errors.map((e, i) => (
                <div key={i}>{e.rule === null ? e.message : `规则 #${e.rule}：${e.message}`}</div>
              ))}
            </div>
          )}
          {applied.ruleCount === 0 && applied.errors.length === 0 && (
            <div className="refcheck-summary none">未配置引用规则，下载不受限制</div>
          )}
          {applied.ruleCount > 0 && issueCount === 0 && applied.errors.length === 0 && (
            <div className="refcheck-summary ok">
              ✅ {applied.ruleCount} 条规则、{result.checked} 个引用全部命中目标索引
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="refcheck-issues">
              <div className="refcheck-summary bad">⚠ {result.errors.length} 个规则错误</div>
              <div className="refcheck-issue-list">
                {result.errors.map((e, i) => (
                  <div key={i} className="refcheck-issue-row">
                    <span className="refcheck-rule-chip">规则 #{e.rule}</span>
                    <button
                      className="issue-pointer"
                      title="在合并结果中定位"
                      onClick={() => onLocate(e.pointer)}
                    >
                      {displayPointer(e.pointer)}
                    </button>
                    <span className="refcheck-message">{e.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.dangling.length > 0 && (
            <div className="refcheck-issues">
              <div className="refcheck-summary bad">⚠ {result.dangling.length} 个悬空引用</div>
              <div className="refcheck-issue-list">
                {result.dangling.map((d, i) => (
                  <div key={i} className="refcheck-issue-row">
                    <span className="refcheck-rule-chip">规则 #{d.rule}</span>
                    <button
                      className="issue-pointer"
                      title="在合并结果中定位"
                      onClick={() => onLocate(d.pointer)}
                    >
                      {displayPointer(d.pointer)}
                    </button>
                    <span className="refcheck-message">
                      引用 {JSON.stringify(d.value)} 在目标索引中不存在
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
