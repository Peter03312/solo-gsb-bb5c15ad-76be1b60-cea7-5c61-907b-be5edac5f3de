import { useRef, useState } from 'react';
import {
  compileSchema,
  SchemaCompileError,
  SchemaParseError,
  type CompiledSchema,
} from '../merge/schema';

interface Props {
  enabled: boolean;
  schema: CompiledSchema | null;
  onEnabledChange: (v: boolean) => void;
  onSchemaChange: (s: CompiledSchema | null) => void;
}

/** 输出阶段的 JSON Schema（Draft 2020-12）输入面板 */
export default function SchemaPanel({ enabled, schema, onEnabledChange, onSchemaChange }: Props) {
  const [text, setText] = useState(schema?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = schema === null ? text.trim() !== '' : text !== schema.text;

  const apply = () => {
    if (!text.trim()) {
      onSchemaChange(null);
      setError(null);
      return;
    }
    try {
      const compiled = compileSchema(text);
      onSchemaChange(compiled);
      setText(compiled.text);
      setError(null);
    } catch (err) {
      // 解析 / 编译失败：保留错误提示，不覆盖上一次有效的 Schema
      if (err instanceof SchemaParseError) setError(`Schema JSON 解析失败：${err.message}`);
      else if (err instanceof SchemaCompileError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setError(null);
  };

  return (
    <div className="schema-panel">
      <div className="schema-header">
        <label className="schema-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          <strong>JSON Schema 约束校验</strong>
          <span className="hint">（Draft 2020-12，对合并结果校验）</span>
        </label>
        {enabled && schema && !error && (
          <span className="schema-status ok">● 已应用有效 Schema</span>
        )}
        {enabled && error && <span className="schema-status bad">● Schema 无效，沿用上一份</span>}
      </div>
      {enabled && (
        <>
          <textarea
            className="schema-input"
            placeholder='粘贴 Draft 2020-12 Schema（如 {"type":"object","required":["id"]}），或点击「导入文件」'
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          {error && <div className="error-text">{error}</div>}
          <div className="panel-actions">
            <button className="small" onClick={() => fileRef.current?.click()}>
              导入文件
            </button>
            <button
              className="small primary"
              onClick={apply}
              disabled={!dirty && !error}
              title={dirty ? '应用当前 Schema 并重新校验' : 'Schema 已是最新'}
            >
              应用 Schema
            </button>
            <button
              className="small"
              onClick={() => {
                setText('');
                setError(null);
                onSchemaChange(null);
              }}
              disabled={!text}
            >
              清空
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
