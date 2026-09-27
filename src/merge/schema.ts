import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/** 已编译的 Draft 2020-12 Schema */
export interface CompiledSchema {
  /** 归一化后的 Schema 文本（成功解析的内容） */
  text: string;
  validate: ValidateFunction;
}

export class SchemaParseError extends Error {}

export class SchemaCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaCompileError';
  }
}

/** 解析并编译 Draft 2020-12 Schema；无法解析 JSON 或本地 $ref 解析失败时抛错 */
export function compileSchema(text: string): CompiledSchema {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    throw new SchemaParseError(err instanceof Error ? err.message : String(err));
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  try {
    const validate = ajv.compile(schema as object);
    return { text: JSON.stringify(schema, null, 2), validate };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // 本地 $ref 无法解析是最常见的编译错误，给出更明确的提示
    const ref = /reference\s+(\S+)/.exec(raw)?.[1];
    const msg = /can't resolve reference/i.test(raw)
      ? `Schema 包含无法解析的本地 $ref${ref ? `：${ref}` : ''}（请确认引用路径存在，或改为可解析的远程引用）`
      : `Schema 编译失败：${raw}`;
    throw new SchemaCompileError(msg);
  }
}

export interface ValidationIssue {
  /** 出错值的 JSON Pointer */
  instancePath: string;
  /** 触发的校验关键字 */
  keyword: string;
  /** Ajv 错误消息 */
  message: string;
  /** 关键字参数（如 required 的 missingProperty、enum 的 allowedValues 等） */
  params: Record<string, unknown>;
  /** Schema 所在位置（用于排查 Schema 本身） */
  schemaPath: string;
}

/** 按 instancePath 分组的校验结果（保持 Ajv 返回顺序） */
export interface IssueGroup {
  instancePath: string;
  issues: ValidationIssue[];
}

function toIssue(err: ErrorObject): ValidationIssue {
  return {
    instancePath: err.instancePath,
    keyword: err.keyword,
    message: err.message ?? '校验失败',
    params: (err.params ?? {}) as Record<string, unknown>,
    schemaPath: err.schemaPath,
  };
}

/** 对合并结果执行 Schema 校验，返回按 instancePath 分组的错误 */
export function validateMerged(schema: CompiledSchema, data: unknown): IssueGroup[] {
  const ok = schema.validate(data);
  if (ok) return [];
  const groups = new Map<string, IssueGroup>();
  for (const err of schema.validate.errors ?? []) {
    const issue = toIssue(err);
    const g = groups.get(issue.instancePath);
    if (g) g.issues.push(issue);
    else groups.set(issue.instancePath, { instancePath: issue.instancePath, issues: [issue] });
  }
  return [...groups.values()];
}

/** 校验错误总数 */
export function countIssues(groups: IssueGroup[]): number {
  return groups.reduce((n, g) => n + g.issues.length, 0);
}
