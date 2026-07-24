// CLAUDE.md §10: request persistent storage so the browser is less likely to
// evict cached PDFs under memory pressure, and expose the real numbers in a
// diagnostic screen. Eviction rules genuinely differ between iOS/Android and
// browser/installed-PWA — this only requests and reports; the actual
// behavior has to be verified on real devices of each type before rollout.

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null; // unsupported (e.g. iOS Safari)
  return navigator.storage.persist();
}

export async function isStoragePersisted(): Promise<boolean | null> {
  if (!navigator.storage?.persisted) return null;
  return navigator.storage.persisted();
}

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
}

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usageBytes: usage ?? null, quotaBytes: quota ?? null };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
