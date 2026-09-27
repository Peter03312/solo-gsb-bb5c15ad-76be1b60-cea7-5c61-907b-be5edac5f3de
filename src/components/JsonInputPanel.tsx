import { useRef } from 'react';

interface Props {
  title: string;
  hint: string;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  /** 错误文案前缀，默认「JSON 解析失败：」；传空串则原样展示 error */
  errorPrefix?: string;
}

/** 单个 JSON 输入面板：支持粘贴与文件导入 */
export default function JsonInputPanel({ title, hint, value, error, onChange, errorPrefix }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    onChange(await file.text());
  };

  const handleFormat = () => {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* 由校验提示错误 */
    }
  };

  return (
    <div className="input-panel">
      <h3>{title}</h3>
      <div className="hint">{hint}</div>
      <textarea
        placeholder={`粘贴${title} JSON，或点击下方按钮导入文件`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {error && <div className="error-text">{errorPrefix ?? 'JSON 解析失败：'}{error}</div>}
      <div className="panel-actions">
        <button className="small" onClick={() => fileRef.current?.click()}>
          导入文件
        </button>
        <button className="small" onClick={handleFormat} disabled={!value.trim()}>
          格式化
        </button>
        <button className="small" onClick={() => onChange('')} disabled={!value}>
          清空
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
