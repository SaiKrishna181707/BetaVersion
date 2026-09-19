/** Resolve only recorded references at the API boundary. Stored traces stay immutable. */
export async function presentEvidence<T>(value: T, resolve?: (ref: string) => Promise<string | null>): Promise<T> {
  if (resolve === undefined) return value;
  const cache = new Map<string, Promise<string | null>>();
  async function walk(entry: unknown, key = ''): Promise<unknown> {
    if (typeof entry === 'string' && (key === 'ref' || key.endsWith('_ref'))) {
      if (!cache.has(entry)) cache.set(entry, resolve!(entry));
      return await cache.get(entry) ?? entry;
    }
    if (Array.isArray(entry)) return Promise.all(entry.map(item => walk(item)));
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(await Promise.all(Object.entries(entry).map(async ([name, item]) => [name, await walk(item, name)])));
    }
    return entry;
  }
  return await walk(value) as T;
}
