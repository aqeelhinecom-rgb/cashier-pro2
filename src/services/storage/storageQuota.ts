import { StorageQuotaInfo } from './types';

/**
 * Checks storage quota, usage, and persistence status using StorageManager API.
 * Provides graceful fallbacks if APIs are unavailable.
 */
export async function checkStorageQuota(): Promise<StorageQuotaInfo> {
  const fallbackInfo: StorageQuotaInfo = {
    supported: false,
    usageBytes: 0,
    quotaBytes: 0,
    percentUsed: 0,
    persisted: false,
  };

  if (typeof navigator === 'undefined' || !navigator.storage) {
    return fallbackInfo;
  }

  try {
    let usageBytes = 0;
    let quotaBytes = 0;

    if (typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage || 0;
      quotaBytes = estimate.quota || 0;
    }

    let persisted = false;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
    }

    const percentUsed = quotaBytes > 0 ? Number(((usageBytes / quotaBytes) * 100).toFixed(2)) : 0;

    return {
      supported: true,
      usageBytes,
      quotaBytes,
      percentUsed,
      persisted,
    };
  } catch (error) {
    console.warn('StorageManager estimate failed:', error);
    return fallbackInfo;
  }
}

/**
 * Requests persistent storage from browser/Android OS.
 * Returns true if granted or already persisted.
 */
export async function requestStoragePersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
    return false;
  }

  try {
    const isAlreadyPersisted = typeof navigator.storage.persisted === 'function'
      ? await navigator.storage.persisted()
      : false;

    if (isAlreadyPersisted) return true;

    return await navigator.storage.persist();
  } catch (error) {
    console.warn('Could not request persistent storage:', error);
    return false;
  }
}

/**
 * Formats bytes into a human-readable Arabic string (MB / GB)
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 ميغابايت';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(1)} ميغابايت`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} جيجابايت`;
}
