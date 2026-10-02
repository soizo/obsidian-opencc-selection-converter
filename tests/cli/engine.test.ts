import type { TestPlugin } from './fixtures';
import { equal, ok, rejectsCode } from './assert';
import type { Snapshot } from '../../src/schemes/model';
import type { EngineClient } from '../../src/engine/client';
import { ENGINE_ID } from '../../src/engine/types';
import ocd from '../fixtures/opencc/formats.ocd';
import ocd2 from '../fixtures/opencc/formats.ocd2';
import s2twp from '../fixtures/opencc/s2twp/config.json';
import compatibility from '../fixtures/opencc/s2twp/CJK_Compatibility_Ideographs.ocd2';
import stCharacters from '../fixtures/opencc/s2twp/STCharacters.ocd2';
import stPhrases from '../fixtures/opencc/s2twp/STPhrases.ocd2';
import generatedPhrases from '../fixtures/opencc/s2twp/STPhrases_GeneratedFromRegionalPhrases.ocd2';
import twPhrases from '../fixtures/opencc/s2twp/TWPhrases.ocd2';
import twVariants from '../fixtures/opencc/s2twp/TWVariants.ocd2';
import twVariantPhrases from '../fixtures/opencc/s2twp/TWVariantsPhrases.ocd2';

export async function snapshot(config: unknown, files: Record<string, string> = {}): Promise<Snapshot> {
  const text = JSON.stringify(config);
  const resources = await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const bytes = new TextEncoder().encode(content);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
      source: { kind: 'vault' as const, location: `fixtures/${file}` },
      originalRef: file, virtualPath: file, configPaths: [], dictType: 'text' as const,
      bytes, sha256: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''),
    };
  }));
  return {
    id: crypto.randomUUID(), schemeId: 'engine-fixture', sourceKey: 'test-only',
    engineId: ENGINE_ID, configText: text, virtualConfigText: text,
    resources, createdAt: Date.now(),
  };
}

export async function officialSnapshot(): Promise<Snapshot> {
  const prepared = await snapshot(s2twp);
  for (const [file, bytes] of [
    ['CJK_Compatibility_Ideographs.ocd2', compatibility],
    ['STCharacters.ocd2', stCharacters],
    ['STPhrases.ocd2', stPhrases],
    ['STPhrases_GeneratedFromRegionalPhrases.ocd2', generatedPhrases],
    ['TWPhrases.ocd2', twPhrases],
    ['TWVariants.ocd2', twVariants],
    ['TWVariantsPhrases.ocd2', twVariantPhrases],
  ] as const) prepared.resources.push({
    source: { kind: 'vault', location: `fixtures/s2twp/${file}` }, originalRef: file,
    virtualPath: file, configPaths: [], dictType: 'ocd2', bytes: bytes.slice(), sha256: 'verified-fixture',
  });
  return prepared;
}

type EngineEndpoint = Pick<EngineClient, 'validate' | 'convertPlain' | 'convert' | 'checkLengths'>;

export function engine(plugin: TestPlugin): EngineEndpoint {
  const endpoint = (plugin as TestPlugin & {engine?: EngineEndpoint}).engine;
  ok(endpoint, 'Native engine endpoint not implemented');
  return endpoint;
}

const chain = {
  conversion_chain: [
    { dict: { type: 'inline', entries: { 软件: '軟件' } } },
    { dict: { type: 'inline', entries: { 軟件: '軟體' } } },
  ],
};

export function engineTests(plugin: TestPlugin) {
  return [
    { name: 'engine/offline-formats', run: async () => {
      const client = engine(plugin);
      const signal = new AbortController().signal;
      equal(await client.convertPlain(await snapshot(chain), '软件', signal), '軟體');
      const config = { conversion_chain: [{ dict: { type: 'text', file: 'dict/words.txt' } }] };
      const prepared = await snapshot(config, { 'dict/words.txt': '软件\t軟體\n服务器\t伺服器\n' });
      await client.validate(prepared, signal);
      equal(await client.convertPlain(prepared, '服务器软件', signal), '伺服器軟體');
      equal(await client.convertPlain(prepared, '软件', signal), '軟體');
      ok(prepared.resources[0]!.bytes.byteLength > 0, 'Worker detached the cached resource buffer');
      const segmented = await snapshot({
        segmentation: { type: 'mmseg', dict: { type: 'text', file: 'dict/words.txt' } },
        conversion_chain: [{ dict: { type: 'text', file: 'dict/words.txt' } }],
      }, { 'dict/words.txt': '软件\t軟體\n服务器\t伺服器\n' });
      equal(await client.convertPlain(segmented, '服务器软件', signal), '伺服器軟體');
      for (const [type, bytes] of [['ocd', ocd], ['ocd2', ocd2]] as const) {
        const file = `formats.${type}`;
        const binary = await snapshot({ conversion_chain: [{ dict: { type, file } }] });
        binary.resources.push({
          source: { kind: 'vault', location: `fixtures/${file}` }, originalRef: file,
          virtualPath: file, configPaths: [], dictType: type, bytes: bytes.slice(), sha256: 'verified-fixture',
        });
        equal(await client.convertPlain(binary, '服务器软件', signal), '伺服器軟體');
      }
    } },
    { name: 'engine/official-s2twp', run: async () => {
      const prepared = await officialSnapshot();
      equal(await engine(plugin).convertPlain(prepared, '服务器软件', new AbortController().signal), '伺服器軟體');
    } },
    { name: 'engine/long-input', run: async () => {
      const client = engine(plugin);
      equal(await client.convertPlain(await snapshot(chain), '软件'.repeat(25000), new AbortController().signal), '軟體'.repeat(25000));
    } },
    { name: 'engine/invalid-encoding', run: async () => {
      const client = engine(plugin);
      const prepared = await snapshot(chain);
      const signal = new AbortController().signal;
      for (const input of ['甲\u0000乙', '\ud800', '\udc00']) {
        await rejectsCode(client.convertPlain(prepared, input, signal), 'INVALID_TEXT');
      }
      equal(await client.convertPlain(prepared, '软件', signal), '軟體');
    } },
    { name: 'engine/dictionary-encoding', run: async () => {
      const client = engine(plugin);
      for (const bytes of [new Uint8Array([0xe7, 0x94, 0xb2, 9, 0xff, 10]), new TextEncoder().encode('甲\t乙\u0000丙\n')]) {
        const prepared = await snapshot({ conversion_chain: [{ dict: { type: 'text', file: 'bad.txt' } }] }, { 'bad.txt': '' });
        prepared.resources[0]!.bytes = bytes;
        await rejectsCode(client.validate(prepared, new AbortController().signal), 'INVALID_DICT_ENCODING');
      }
    } },
    { name: 'engine/resource-paths', run: async () => {
      for (const path of ['dir\\name.txt', 'bad\u0000.txt', '../escape.txt', '/outside.txt']) {
        const prepared = await snapshot(chain, { 'valid.txt': '甲\t乙\n' });
        prepared.resources[0]!.virtualPath = path;
        await rejectsCode(engine(plugin).validate(prepared, new AbortController().signal), 'INVALID_RESOURCE_PATH');
      }
    } },
    { name: 'engine/configuration-budget', run: async () => {
      const prepared = await snapshot(chain);
      prepared.configText = JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), ...chain });
      await rejectsCode(engine(plugin).validate(prepared, new AbortController().signal), 'CONFIG_LIMIT');
    } },
    { name: 'engine/complete-snapshot-budget', run: async () => {
      const prepared = await snapshot(chain);
      prepared.resources = ['a.ocd2', 'b.ocd2'].map(file => ({
        source: { kind: 'vault', location: `fixtures/${file}` }, originalRef: file,
        virtualPath: file, configPaths: [], dictType: 'ocd2', bytes: new Uint8Array(64 * 1024 * 1024), sha256: 'fixture',
      }));
      await rejectsCode(engine(plugin).validate(prepared, new AbortController().signal), 'RESOURCE_LIMIT');
    } },
    { name: 'engine/normalization-group-candidates', run: async () => {
      const client = engine(plugin);
      const signal = new AbortController().signal;
      const normalized = await snapshot({
        normalization: [{ dict: { type: 'inline', entries: { 'Ａ': '甲' } } }],
        conversion_chain: [{ dict: { type: 'text', file: 'candidates.txt' } }],
      }, { 'candidates.txt': '甲\t乙 丙\n' });
      equal(await client.convertPlain(normalized, 'Ａ', signal), '乙');
      for (const [policy, expected] of [['short_circuit', '丙乙'], ['union', '丁']]) {
        const grouped = await snapshot({ conversion_chain: [{ dict: {
          type: 'group', match_policy: policy,
          dicts: [{ type: 'inline', entries: { 甲: '丙' } }, { type: 'inline', entries: { 甲乙: '丁' } }],
        } }] });
        equal(await client.convertPlain(grouped, '甲乙', signal), expected);
      }
    } },
    { name: 'engine/mixed-newlines-and-unicode', run: async () => {
      const client = engine(plugin);
      equal(await client.convertPlain(await snapshot(chain), '软件\r\n软件\n𠀀软件\r', new AbortController().signal), '軟體\r\n軟體\n𠀀軟體\r');
    } },
    { name: 'engine/reject-segmentation-plugin', run: async () => {
      const client = engine(plugin);
      const prepared = await snapshot({ ...chain, segmentation: { type: 'jieba' } });
      await rejectsCode(client.validate(prepared, new AbortController().signal), 'UNSUPPORTED_SEGMENTATION');
    } },
    { name: 'engine/cancel-and-recover', run: async () => {
      const client = engine(plugin);
      const before = new AbortController();
      before.abort();
      await rejectsCode(client.convertPlain(await snapshot(chain), '软件', before.signal), 'CANCELLED');
      const active = new AbortController();
      const pending = client.convertPlain(await snapshot(chain), '软件'.repeat(100000), active.signal);
      active.abort();
      await rejectsCode(pending, 'CANCELLED');
      equal(await client.convertPlain(await snapshot(chain), '软件', new AbortController().signal), '軟體');
    } },
    { name: 'engine/limits', run: async () => {
      const client = engine(plugin);
      const signal = new AbortController().signal;
      await rejectsCode(client.convertPlain(await snapshot(chain), '甲'.repeat(200001), signal), 'INPUT_LIMIT');
      const expansive = await snapshot({ conversion_chain: [{ dict: { type: 'inline', entries: { 甲: 'x'.repeat(50) } } }] });
      await rejectsCode(client.convertPlain(expansive, '甲'.repeat(180000), signal), 'OUTPUT_LIMIT');
      const resources = await snapshot(chain);
      resources.resources = Array.from({ length: 257 }, (_, index) => ({
        source: { kind: 'vault' as const, location: `fixtures/${index}` }, originalRef: String(index),
        virtualPath: String(index), configPaths: [], dictType: 'text' as const,
        bytes: new Uint8Array(), sha256: 'fixture',
      }));
      await rejectsCode(client.validate(resources, signal), 'RESOURCE_LIMIT');
      equal(await client.convertPlain(await snapshot(chain), '软件', signal), '軟體');
    } },
    { name: 'engine/serial-jobs', run: async () => {
      const client = engine(plugin);
      const prepared = await snapshot(chain);
      const signal = new AbortController().signal;
      equal(await Promise.all([
        client.convertPlain(prepared, '软件', signal),
        client.convertPlain(prepared, '软件软件', signal),
      ]), ['軟體', '軟體軟體']);
    } },
    { name: 'engine/broken-dictionary-recovery', run: async () => {
      const client = engine(plugin);
      const broken = await snapshot({ conversion_chain: [{ dict: { type: 'ocd2', file: 'broken.ocd2' } }] });
      broken.resources.push({
        source: { kind: 'vault', location: 'fixtures/broken.ocd2' }, originalRef: 'broken.ocd2',
        virtualPath: 'broken.ocd2', configPaths: [], dictType: 'ocd2', bytes: new Uint8Array([1, 2, 3]), sha256: 'fixture',
      });
      await rejectsCode(client.validate(broken, new AbortController().signal), 'ENGINE_ERROR');
      equal(await client.convertPlain(await snapshot(chain), '软件', new AbortController().signal), '軟體');
    } },
  ];
}
