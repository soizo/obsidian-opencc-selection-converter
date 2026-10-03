import type { MessageKey } from '../locales/en-GB';
import type { SchemeDefinition, SingleSchemeDefinition } from './model';

const OPENCC_CONFIG = 'https://cdn.jsdelivr.net/npm/opencc@1.4.2/data/config';
const OPENCC_DICTIONARIES = 'https://cdn.jsdelivr.net/npm/opencc@1.4.2/prebuilds/assets/';
const GOV_ROOT = 'https://cdn.jsdelivr.net/gh/TerryTian-tech/OpenCC-Traditional-Chinese-characters-according-to-Chinese-government-standards@67f2c7293e9ce226fcc1ee15cdb60b9b9dfd5c60/t2gov';

export const PRESETS = [
  ['s2t', 'official.s2t', 'opencc'], ['t2s', 'official.t2s', 'opencc'], ['s2tw', 'official.s2tw', 'opencc'], ['tw2s', 'official.tw2s', 'opencc'],
  ['s2hk', 'official.s2hk', 'opencc'], ['hk2s', 'official.hk2s', 'opencc'], ['s2twp', 'official.s2twp', 'opencc'], ['tw2sp', 'official.tw2sp', 'opencc'],
  ['t2tw', 'official.t2tw', 'opencc'], ['tw2t', 'official.tw2t', 'opencc'], ['t2hk', 'official.t2hk', 'opencc'], ['hk2t', 'official.hk2t', 'opencc'],
  ['t2gov', 'official.t2gov', 'terrytian'], ['s2gov', 'official.s2gov', 'terrytian'],
] as const satisfies readonly (readonly [string, MessageKey, 'opencc' | 'terrytian'])[];

export type PresetId = (typeof PRESETS)[number][0];
export type Preset = (typeof PRESETS)[number];

function opencc(id: string, name: string): SingleSchemeDefinition {
  return { id: crypto.randomUUID(), name, source: { kind: 'url', location: `${OPENCC_CONFIG}/${id}.json` }, dependencyBase: OPENCC_DICTIONARIES };
}
function t2gov(name: string): SingleSchemeDefinition {
  return { id: crypto.randomUUID(), name, source: { kind: 'url', location: `${GOV_ROOT}/t2gov.json` } };
}

export function presetDefinition(id: PresetId, name: string): SchemeDefinition {
  if (id === 't2gov') return t2gov(name);
  if (id === 's2gov') {
    return {
      id: crypto.randomUUID(), name,
      source: { kind: 'chain', steps: [opencc('s2t', 'Simplified → Traditional'), t2gov('Traditional → Mainland Traditional')] },
    };
  }
  return opencc(id, name);
}
