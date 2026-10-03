import { parseConfig, resolveDependencies } from '../../src/schemes/config';
import { combineSnapshots, schemeSourceKey, splitChainSnapshot } from '../../src/schemes/resources';
import type { ChainSchemeDefinition, SchemeDefinition, SingleSchemeDefinition, SingleSnapshot } from '../../src/schemes/model';
import { PluginError } from '../../src/errors';
import { equal, ok, rejectsCode } from './assert';
import type { TestPlugin } from './fixtures';
import { engine, officialSnapshot, snapshot } from './engine.test';

const vault: SingleSchemeDefinition = { id: 'config-test', name: 'test', source: { kind: 'vault', location: '配置/main.json' } };
const remote: SingleSchemeDefinition = { ...vault, source: { kind: 'url', location: 'https://example.com/config/main.json' } };
const config = (file: string, type = 'text') => JSON.stringify({ conversion_chain: [{ dict: { type, file } }] });

export function configTests(plugin: TestPlugin) {
  return [
    { name: 'config/chain-source-identity', run: async () => {
      const first = { id: 'first', name: 'First', source: { kind: 'vault', location: 'a.json' } };
      const second = { id: 'second', name: 'Second', source: { kind: 'url', location: 'https://example.com/b.json' }, dependencyBase: 'https://cdn.example.com/', overrides: { 'b.txt': 'https://cdn.example.com/b.txt' }, approvedHttpUrls: ['http://ignored.example.com/'] };
      const chain = { id: 'chain', name: 'Chain', source: { kind: 'chain', steps: [first, second] } } as unknown as SchemeDefinition;
      equal(await schemeSourceKey(chain), await schemeSourceKey({ ...chain, name: 'Renamed' }));
      ok(await schemeSourceKey(chain) !== await schemeSourceKey({ ...chain, source: { kind: 'chain', steps: [second, first] } } as unknown as SchemeDefinition));
      ok(await schemeSourceKey(chain) !== await schemeSourceKey({ ...chain, source: { kind: 'chain', steps: [first, { ...second, dependencyBase: 'https://other.example.com/' }] } } as unknown as SchemeDefinition));
      ok(await schemeSourceKey(chain) !== await schemeSourceKey({ ...chain, source: { kind: 'chain', steps: [first, { ...second, overrides: { 'b.txt': 'https://other.example.com/b.txt' } }] } } as unknown as SchemeDefinition));
      equal(await schemeSourceKey(second as SchemeDefinition), await schemeSourceKey({ ...second, name: 'Renamed', approvedHttpUrls: [] } as SchemeDefinition));
    } },
    { name: 'config/chain-snapshot-composition', run: async () => {
      const first: SingleSchemeDefinition = { id: 'first', name: 'First', source: { kind: 'vault', location: 'first.json' } };
      const second: SingleSchemeDefinition = { id: 'second', name: 'Second', source: { kind: 'vault', location: 'second.json' } };
      const chain: ChainSchemeDefinition = { id: 'chain', name: 'Chain', source: { kind: 'chain', steps: [first, second] } };
      const firstSnapshot = await snapshot({ conversion_chain: [{ dict: { type: 'text', file: 'same.txt' } }] }, { 'same.txt': '甲\t乙\n' });
      const secondSnapshot = await snapshot({ conversion_chain: [{ dict: { type: 'text', file: 'same.txt' } }] }, { 'same.txt': '乙\t丙\n' });
      Object.assign(firstSnapshot, { schemeId: first.id, sourceKey: await schemeSourceKey(first) });
      Object.assign(secondSnapshot, { schemeId: second.id, sourceKey: await schemeSourceKey(second) });
      const originals = structuredClone([firstSnapshot, secondSnapshot]);
      const combined = await combineSnapshots(chain, [firstSnapshot, secondSnapshot]);
      equal(combined.steps.length, 2);
      equal(combined.resources.map(resource => resource.virtualPath), ['step/0/same.txt', 'step/1/same.txt']);
      equal([firstSnapshot, secondSnapshot], originals);
      const restored = await splitChainSnapshot(chain, combined);
      equal(restored.map(step => step.virtualConfigText), [firstSnapshot.virtualConfigText, secondSnapshot.virtualConfigText]);
      equal(restored.map(step => new TextDecoder().decode(step.resources[0]!.bytes)), ['甲\t乙\n', '乙\t丙\n']);
      await rejectsCode(combineSnapshots({ ...chain, source: { kind: 'chain', steps: [first] } }, [firstSnapshot]), 'INVALID_CONFIG');
      await rejectsCode(combineSnapshots({ ...chain, source: { kind: 'chain', steps: Array.from({ length: 17 }, () => first) } }, Array.from({ length: 17 }, () => firstSnapshot)), 'INVALID_CONFIG');
      const sixteen = { ...chain, source: { kind: 'chain' as const, steps: Array.from({ length: 16 }, () => first) } };
      equal((await combineSnapshots(sixteen, Array.from({ length: 16 }, () => firstSnapshot))).steps.length, 16);
      const nested = { ...chain, source: { kind: 'chain', steps: [first, chain] } } as unknown as ChainSchemeDefinition;
      await rejectsCode(combineSnapshots(nested, [firstSnapshot, secondSnapshot]), 'INVALID_CONFIG');
      await rejectsCode(splitChainSnapshot({ ...chain, source: { kind: 'chain', steps: [second, first] } }, combined), 'SNAPSHOT_IDENTITY');
    } },
    { name: 'config/strict-known-fields', run: async () => {
      try {
        parseConfig('{"conversion_chain":[{"dict":{"type":"inline","entries":{"甲":"乙"},"extra":true}}]}');
        throw new Error('Unknown field accepted');
      } catch (error) {
        ok(error instanceof PluginError);
        equal(error.code, 'INVALID_CONFIG');
        equal(error.configPath, '$.conversion_chain[0].dict.extra');
      }
      await rejectsCode(() => parseConfig('{"name":"a","na\\u006de":"b","conversion_chain":[]}'), 'INVALID_CONFIG');
      await rejectsCode(() => parseConfig('{"conversion_chain":[],"__proto__":{}}'), 'INVALID_CONFIG');
      await rejectsCode(() => parseConfig('{"segmentation":{"type":"jieba"},"conversion_chain":[]}'), 'UNSUPPORTED_SEGMENTATION');
      await rejectsCode(() => parseConfig('{"conversion_chain":[{"dict":{"type":"inline","entries":{"甲":""}}}]}'), 'INVALID_CONFIG');
    } },
    { name: 'config/all-stages', run: async () => {
      const parsed = parseConfig(`{ // JSONC
        "normalization":[{"dict":{"type":"text","file":"normalization/字典.txt"}}],
        "segmentation":{"type":"mmseg","dict":{"type":"ocd2","file":"seg/词典.ocd2"}},
        "conversion_chain":[{"dict":{"type":"group","dicts":[
          {"type":"inline","entries":{"甲":"乙"}},
          {"type":"ocd","file":"../字典.txt","may_output_tofu":true},
        ]}}],
      }`);
      equal(parsed.references.map(item => item.originalRef), ['normalization/字典.txt', 'seg/词典.ocd2', '../字典.txt']);
      equal(parsed.references.map(item => item.dictType), ['text', 'ocd2', 'ocd']);
      ok(parsed.warnings.length > 0);
      equal(parseConfig('{"conversion_chain":[]}').references, []);
    } },
    { name: 'config/paths', run: async () => {
      const parsed = parseConfig(config('../词典/繁体.txt'));
      const plan = resolveDependencies(parsed, vault);
      equal(plan.resources[0]!.source, { kind: 'vault', location: '词典/繁体.txt' });
      equal(parsed.data, JSON.parse(config('../词典/繁体.txt')));
      ok(plan.virtualConfigText.includes(plan.resources[0]!.virtualPath));
      await rejectsCode(() => resolveDependencies(parseConfig(config('../../escape.txt')), vault), 'PATH_OUTSIDE_VAULT');
      for (const path of ['/tmp/private.txt', 'C:\\private.txt', 'https://example.com/implicit.txt']) {
        await rejectsCode(() => resolveDependencies(parseConfig(config(path)), vault), 'INVALID_RESOURCE_PATH');
      }
      equal(resolveDependencies(parseConfig(config('%2e%2e/字典.txt')), vault).resources[0]!.source.location, '配置/%2e%2e/字典.txt');
    } },
    { name: 'config/url-bases-and-overrides', run: async () => {
      equal(resolveDependencies(parseConfig(config('../字典.txt')), remote).resources[0]!.source.location, 'https://example.com/%E5%AD%97%E5%85%B8.txt');
      equal(resolveDependencies(parseConfig(config('words.bin', 'text')), { ...remote, dependencyBase: 'https://cdn.example.com/dicts/' }).resources[0]!.source.location, 'https://cdn.example.com/dicts/words.bin');
      const overridden = resolveDependencies(parseConfig(config('words.txt')), { ...vault, overrides: { 'words.txt': 'https://cdn.example.com/custom.txt' } });
      equal(overridden.resources[0]!.source.kind, 'url');
      equal(resolveDependencies(parseConfig(config('http://example.com/a.txt')), remote).requiresHttpConfirmation, true);
      for (const path of ['file:///tmp/a', 'data:text/plain,x', 'javascript:x', 'https://user:password@example.com/a']) {
        await rejectsCode(() => resolveDependencies(parseConfig(config(path)), remote), 'INVALID_RESOURCE_PATH');
      }
    } },
    { name: 'config/deduplication', run: async () => {
      const parsed = parseConfig(JSON.stringify({ conversion_chain: [
        { dict: { type: 'text', file: 'a/words.bin' } },
        { dict: { type: 'ocd2', file: 'b/words.bin' } },
        { dict: { type: 'text', file: './a/words.bin' } },
      ] }));
      const plan = resolveDependencies(parsed, vault);
      equal(plan.resources.length, 2);
      equal(plan.resources[0]!.configPaths.length, 2);
      ok(plan.resources[0]!.virtualPath !== plan.resources[1]!.virtualPath);
      equal(plan.resources.map(item => item.dictType), ['text', 'ocd2']);
    } },
    { name: 'config/native-roundtrip', run: async () => {
      const original: SingleSnapshot = await officialSnapshot();
      const plan = resolveDependencies(parseConfig(original.configText), vault);
      const resources = plan.resources.map(resource => {
        const fixture = original.resources.find(item => item.originalRef === resource.originalRef);
        ok(fixture, 'Missing official fixture');
        return { ...resource, bytes: fixture.bytes.slice(), sha256: fixture.sha256 };
      });
      const rewritten = { ...original, virtualConfigText: plan.virtualConfigText, resources };
      equal(await engine(plugin).convertPlain(rewritten, '服务器软件', new AbortController().signal), '伺服器軟體');
      equal(plan.resources.length, 7);
    } },
    { name: 'config/preparse-depth-limit', run: async () => {
      await rejectsCode(() => parseConfig('['.repeat(10000) + '0' + ']'.repeat(10000)), 'CONFIG_LIMIT');
      equal(parseConfig('{/* [[[ */"name":"{{{","conversion_chain":[]}').data.name, '{{{');
    } },
    { name: 'config/limits-and-unicode', run: async () => {
      await rejectsCode(() => parseConfig(' '.repeat(2 * 1024 * 1024 + 1)), 'CONFIG_LIMIT');
      await rejectsCode(() => parseConfig('{"name":"\\ud800","conversion_chain":[]}'), 'INVALID_TEXT');
      await rejectsCode(() => parseConfig('{"name":"\\u0000","conversion_chain":[]}'), 'INVALID_TEXT');
      let dict: unknown = { type: 'inline', entries: { 甲: '乙' } };
      for (let index = 0; index < 33; index++) dict = { type: 'group', dicts: [dict] };
      await rejectsCode(() => parseConfig(JSON.stringify({ conversion_chain: [{ dict }] })), 'CONFIG_LIMIT');
      const many = parseConfig(JSON.stringify({ conversion_chain: Array.from({ length: 257 }, (_, index) => ({ dict: { type: 'text', file: `${index}.txt` } })) }));
      await rejectsCode(() => resolveDependencies(many, vault), 'RESOURCE_LIMIT');
    } },
  ];
}
