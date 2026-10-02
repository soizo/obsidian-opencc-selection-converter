export function ok(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>;
  const bb = b as Record<string, unknown>;
  const keys = Object.keys(aa);
  return keys.length === Object.keys(bb).length && keys.every(key => Object.hasOwn(bb, key) && same(aa[key], bb[key]));
}

export function equal(actual: unknown, expected: unknown): void {
  if (!same(actual, expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)?.slice(0, 400)}; received ${JSON.stringify(actual)?.slice(0, 400)}`);
  }
}

export async function rejectsCode(action: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    if (typeof action === 'function') await action();
    else await action;
  } catch (error) {
    equal((error as {code?: string}).code, code);
    return;
  }
  throw new Error(`Expected rejection ${code}`);
}
