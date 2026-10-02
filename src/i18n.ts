import { getLanguage } from 'obsidian';
import { enGB, enGBErrors, type MessageKey } from './locales/en-GB';
import { zhHans, zhHansErrors } from './locales/zh-Hans';

export type Locale = 'en-GB' | 'zh-Hans';

export function localeFor(language: string): Locale {
  return language.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en-GB';
}

function currentLocale(): Locale {
  return localeFor(getLanguage());
}

export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return (currentLocale() === 'zh-Hans' ? zhHans[key] : enGB[key]).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}

export function errorText(code: string, fallback: string): string {
  return (currentLocale() === 'zh-Hans' ? zhHansErrors : enGBErrors)[code] ?? fallback;
}
