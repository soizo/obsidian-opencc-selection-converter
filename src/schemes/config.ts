import { createScanner, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { PluginError } from '../errors';
import { LIMITS } from '../limits';
import type { ParsedConfig, SingleResourcePlan, SingleSchemeDefinition } from './model';

type Path = (string | number)[];
type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue };
const jsonPath = (path: Path): string => '$' + path.map(key => typeof key === 'number' ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('');
function invalid(message: string, path: Path, code = 'INVALID_CONFIG'): never {
  throw new PluginError(code, message, { configPath: jsonPath(path) });
}
function validText(text: string, path: Path): void {
  for (const character of text) {
    const scalar = character.codePointAt(0)!;
    if (scalar === 0 || (scalar >= 0xd800 && scalar <= 0xdfff)) invalid('配置包含 NUL 或孤立代理项。', path, 'INVALID_TEXT');
  }
}
function object(value: unknown, path: Path): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('此处必须是对象。', path);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], path: Path): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid('不支持的配置字段。', [...path, key]);
}
function string(value: unknown, path: Path, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && !value.length)) invalid('此处必须是有效字符串。', path);
  return value;
}

export function parseConfig(text: string): ParsedConfig {
  if (text.length > LIMITS.configBytes || new TextEncoder().encode(text).byteLength > LIMITS.configBytes) {
    invalid('配置超过大小上限。', [], 'CONFIG_LIMIT');
  }
  validText(text, []);
  // Bound recursion before the parser allocates its tree; ignore braces in strings/comments.
  const scanner = createScanner(text, true);
  let nesting = 0;
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const token = text[scanner.getTokenOffset()];
    if (token === '{' || token === '[') {
      if (++nesting > LIMITS.configDepth + 1) invalid('配置嵌套超过上限。', [], 'CONFIG_LIMIT');
    } else if (token === '}' || token === ']') nesting = Math.max(0, nesting - 1);
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length) invalid('配置不是有效的 JSON/JSONC。', []);
  function decode(node: Node, path: Path, depth: number): ConfigValue {
    if (depth > LIMITS.configDepth) invalid('配置嵌套超过上限。', path, 'CONFIG_LIMIT');
    if (node.type === 'object') {
      const result = Object.create(null) as Record<string, ConfigValue>;
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        if (!keyNode || !valueNode || typeof keyNode.value !== 'string') invalid('配置对象无效。', path);
        const key = keyNode.value;
        validText(key, [...path, key]);
        if (Object.hasOwn(result, key)) invalid('配置字段重复。', [...path, key]);
        result[key] = decode(valueNode, [...path, key], depth + 1);
      }
      return result;
    }
    if (node.type === 'array') return (node.children ?? []).map((item, index) => decode(item, [...path, index], depth + 1));
    if (node.type === 'string') { validText(node.value as string, path); return node.value as string; }
    if (node.type === 'number' && Number.isFinite(node.value)) return node.value as number;
    if (node.type === 'boolean') return node.value as boolean;
    if (node.type === 'null') return null;
    invalid('配置值无效。', path);
  }
  const data = object(decode(tree, [], 0), []);
  fields(data, ['name', 'normalization', 'segmentation', 'conversion_chain'], []);
  if (Object.hasOwn(data, 'name')) string(data.name, ['name'], false);
  const references: ParsedConfig['references'] = [];
  const warnings: string[] = [];
  function dictionary(value: unknown, path: Path): void {
    const dict = object(value, path);
    const type = string(dict.type, [...path, 'type']);
    if (type === 'inline') {
      fields(dict, ['type', 'entries'], path);
      const entries = object(dict.entries, [...path, 'entries']);
      for (const [key, target] of Object.entries(entries)) {
        if (!key) invalid('词典键不能为空。', [...path, 'entries', key]);
        string(target, [...path, 'entries', key]);
      }
      return;
    }
    if (!['group', 'text', 'ocd', 'ocd2'].includes(type)) invalid('不支持的词典类型。', [...path, 'type']);
    fields(dict, type === 'group' ? ['type', 'dicts', 'match_policy', 'may_output_tofu'] : ['type', 'file', 'may_output_tofu'], path);
    if (Object.hasOwn(dict, 'may_output_tofu')) {
      if (typeof dict.may_output_tofu !== 'boolean') invalid('may_output_tofu 必须是布尔值。', [...path, 'may_output_tofu']);
      if (dict.may_output_tofu) warnings.push(`${jsonPath(path)}: 包含可能缺字的词典，按原生默认策略保留。`);
    }
    if (type === 'group') {
      if (Object.hasOwn(dict, 'match_policy') && !['short_circuit', 'union'].includes(dict.match_policy as string)) invalid('无效的 group 匹配策略。', [...path, 'match_policy']);
      if (!Array.isArray(dict.dicts)) invalid('dicts 必须是数组。', [...path, 'dicts']);
      dict.dicts.forEach((child, index) => dictionary(child, [...path, 'dicts', index]));
    } else {
      const filePath = [...path, 'file'];
      references.push({ originalRef: string(dict.file, filePath), dictType: type as 'text' | 'ocd' | 'ocd2', configPath: jsonPath(filePath), path: filePath });
    }
  }
  function chain(value: unknown, path: Path): void {
    if (!Array.isArray(value)) invalid('转换链必须是数组。', path);
    value.forEach((item, index) => {
      const stagePath = [...path, index];
      const stage = object(item, stagePath);
      fields(stage, ['dict'], stagePath);
      dictionary(stage.dict, [...stagePath, 'dict']);
    });
  }
  if (Object.hasOwn(data, 'normalization')) chain(data.normalization, ['normalization']);
  if (Object.hasOwn(data, 'segmentation')) {
    const segmentation = object(data.segmentation, ['segmentation']);
    if (segmentation.type !== 'mmseg') invalid('首版仅支持 mmseg 分词。', ['segmentation', 'type'], 'UNSUPPORTED_SEGMENTATION');
    fields(segmentation, ['type', 'dict'], ['segmentation']);
    dictionary(segmentation.dict, ['segmentation', 'dict']);
  }
  chain(data.conversion_chain, ['conversion_chain']);
  return { text, data, references, warnings };
}

function urlLocation(value: string, path: Path, base?: string): string {
  validText(value, path);
  if (value !== value.trim() || value.includes('\\') || Array.from(value).some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) invalid('资源 URL 无效。', path, 'INVALID_RESOURCE_PATH');
  let url: URL;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch { invalid('资源 URL 无效。', path, 'INVALID_RESOURCE_PATH'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('不支持的 URL 协议或凭据。', path, 'INVALID_RESOURCE_PATH');
  url.hash = '';
  return url.href;
}
function vaultLocation(value: string, directory: string[], path: Path): string {
  validText(value, path);
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    invalid('词典必须使用 vault 内相对路径。', path, 'INVALID_RESOURCE_PATH');
  }
  const parts = [...directory];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) invalid('路径越过 vault 根目录。', path, 'PATH_OUTSIDE_VAULT');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) invalid('资源路径不能指向 vault 根目录。', path, 'INVALID_RESOURCE_PATH');
  return parts.join('/');
}

export function resolveDependencies(config: ParsedConfig, definition: SingleSchemeDefinition): SingleResourcePlan {
  const source = definition.source;
  if (!source || !['url', 'vault'].includes(source.kind) || typeof source.location !== 'string') invalid('方案来源无效。', ['source'], 'INVALID_RESOURCE_PATH');
  const location = source.kind === 'url' ? urlLocation(source.location, ['source']) : vaultLocation(source.location, [], ['source']);
  let base = location;
  if (definition.dependencyBase !== undefined) {
    if (source.kind !== 'url' || typeof definition.dependencyBase !== 'string') invalid('依赖基址只适用于 URL 方案。', ['dependencyBase'], 'INVALID_RESOURCE_PATH');
    base = urlLocation(definition.dependencyBase, ['dependencyBase']);
  }
  const overrides = definition.overrides ?? {};
  for (const [ref, target] of Object.entries(object(overrides, ['overrides']))) {
    string(target, ['overrides', ref]);
    urlLocation(target as string, ['overrides', ref]);
  }
  const resources: SingleResourcePlan['resources'] = [];
  const bySource = new Map<string, SingleResourcePlan['resources'][number]>();
  const httpUrls = new Set<string>();
  if (source.kind === 'url' && location.startsWith('http:')) httpUrls.add(location);
  const data = structuredClone(config.data);
  for (const reference of config.references) {
    const overridden = Object.hasOwn(overrides, reference.originalRef);
    const kind = overridden ? 'url' : source.kind;
    const resolved = overridden ? urlLocation(overrides[reference.originalRef]!, reference.path)
      : kind === 'url' ? urlLocation(reference.originalRef, reference.path, base)
      : vaultLocation(reference.originalRef, location.split('/').slice(0, -1), reference.path);
    if (kind === 'url' && resolved.startsWith('http:')) httpUrls.add(resolved);
    const identity = `${kind}:${resolved}`;
    let resource = bySource.get(identity);
    if (resource && resource.dictType !== reference.dictType) invalid('同一资源被声明为不同词典类型。', reference.path);
    if (!resource) {
      if (resources.length >= LIMITS.resources) invalid('依赖资源数量超过上限。', reference.path, 'RESOURCE_LIMIT');
      resource = {
        source: { kind, location: resolved }, originalRef: reference.originalRef,
        virtualPath: `dict/${resources.length}.${reference.dictType}`, configPaths: [], dictType: reference.dictType,
      };
      resources.push(resource);
      bySource.set(identity, resource);
    }
    resource.configPaths.push(reference.configPath);
    let parent: unknown = data;
    for (const key of reference.path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
    (parent as Record<string | number, unknown>)[reference.path.at(-1)!] = resource.virtualPath;
  }
  return { definition, configSource: { kind: source.kind, location }, config, resources, virtualConfigText: JSON.stringify(data), warnings: [...config.warnings], httpUrls: [...httpUrls], requiresHttpConfirmation: httpUrls.size > 0 };
}
