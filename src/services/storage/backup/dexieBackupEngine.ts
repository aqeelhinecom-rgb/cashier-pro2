import { CashierDatabase, cashierStorageDb } from '../schema';
import { StorageBackupRecord } from '../types';
import { storageCacheAdapter } from '../cacheAdapter';
import { generateUUID } from '../uuid';

export interface CompleteDexieBackupFile {
  format: 'CashierProCompleteDexieBackup';
  version: '2.0.0-dexie';
  createdAt: string;
  checksum: string;
  storeName: string;
  currency: string;
  totalRecords: number;
  tableCounts: Record<string, number>;
  data: {
    products: any[];
    parties: any[];
    invoices: any[];
    invoice_items: any[];
    payments: any[];
    expenses: any[];
    held_invoices: any[];
    categories: any[];
    settings: any[];
    product_images: any[];
    change_journal: any[];
    migration_state: any[];
  };
}

export interface BackupValidationResult {
  valid: boolean;
  error?: string;
  manifest?: {
    storeName: string;
    createdAt: string;
    totalRecords: number;
    tableCounts: Record<string, number>;
    checksum: string;
  };
}

/**
 * Computes standard deterministic SHA-256 checksum (64 hex characters)
 */
export function computeBackupChecksum(data: CompleteDexieBackupFile['data']): string {
  // Sort keys and serialize deterministically
  const canonical = JSON.stringify({
    products: data.products,
    parties: data.parties,
    invoices: data.invoices,
    invoice_items: data.invoice_items,
    payments: data.payments,
    expenses: data.expenses,
    held_invoices: data.held_invoices,
    categories: data.categories,
    settings: data.settings,
    product_images: data.product_images,
    change_journal: data.change_journal,
    migration_state: data.migration_state,
  });

  return calculateSha256(canonical);
}

function calculateSha256(ascii: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const maxWord = Math.pow(2, 32);
  let i: number, j: number;
  let result = '';

  const words: number[] = [];

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  // UTF-8 encoding
  const utf8Bytes: number[] = [];
  for (i = 0; i < ascii.length; i++) {
    let c = ascii.charCodeAt(i);
    if (c < 128) {
      utf8Bytes.push(c);
    } else if (c < 2048) {
      utf8Bytes.push((c >> 6) | 192);
      utf8Bytes.push((c & 63) | 128);
    } else if ((c & 0xfc00) === 0xd800 && i + 1 < ascii.length && (ascii.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // surrogate pair
      c = 0x10000 + ((c & 0x03ff) << 10) + (ascii.charCodeAt(++i) & 0x03ff);
      utf8Bytes.push((c >> 18) | 240);
      utf8Bytes.push(((c >> 12) & 63) | 128);
      utf8Bytes.push(((c >> 6) & 63) | 128);
      utf8Bytes.push((c & 63) | 128);
    } else {
      utf8Bytes.push((c >> 12) | 224);
      utf8Bytes.push(((c >> 6) & 63) | 128);
      utf8Bytes.push((c & 63) | 128);
    }
  }

  const bitLength = utf8Bytes.length * 8;
  utf8Bytes.push(0x80);
  while ((utf8Bytes.length * 8) % 512 !== 448) {
    utf8Bytes.push(0);
  }

  for (i = 0; i < utf8Bytes.length; i += 4) {
    words.push(
      (utf8Bytes[i] << 24) |
      (utf8Bytes[i + 1] << 16) |
      (utf8Bytes[i + 2] << 8) |
      utf8Bytes[i + 3]
    );
  }
  words.push(Math.floor(bitLength / maxWord));
  words.push(bitLength >>> 0);

  // Process blocks
  const w = new Array(64);
  for (i = 0; i < words.length; i += 16) {
    let [a, b, c, d, e, f, g, h] = hash;
    for (j = 0; j < 64; j++) {
      if (j < 16) {
        w[j] = words[i + j];
      } else {
        const gamma0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        const gamma1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + gamma0 + w[j - 7] + gamma1) | 0;
      }
      const ch = (e & f) ^ (~e & g);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const t1 = (h + sigma1 + ch + k[j] + w[j]) | 0;
      const t2 = (sigma0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j >= 0; j--) {
      const b = (hash[i] >> (8 * j)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

/**
 * Checks available storage quota and warns if full
 */
export async function checkStorageSpaceAvailable(): Promise<{ hasSpace: boolean; message?: string }> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota && estimate.usage) {
        const remainingBytes = estimate.quota - estimate.usage;
        // Require at least 20MB free space
        if (remainingBytes < 20 * 1024 * 1024) {
          return {
            hasSpace: false,
            message: 'المساحة التخزينية المتاحة في المتصفح منخفضة جداً (أقل من 20 ميجابايت).',
          };
        }
      }
    } catch {
      // Quota API estimation failed, proceed
    }
  }
  return { hasSpace: true };
}

/**
 * Generates a full, verified backup package of the entire Dexie database
 */
export async function createFullDexieBackup(
  dbOrType: CashierDatabase | 'manual' | 'daily_auto' | 'pre_restore_safety' = cashierStorageDb,
  typeOrLabel?: 'manual' | 'daily_auto' | 'pre_restore_safety' | string,
  maybeLabel?: string
): Promise<{
  backupRecord: StorageBackupRecord;
  backupFile: CompleteDexieBackupFile;
  jsonString: string;
  blob: Blob;
  fileName: string;
}> {
  let db: CashierDatabase;
  let type: 'manual' | 'daily_auto' | 'pre_restore_safety' = 'manual';
  let customLabel: string | undefined;

  if (typeof dbOrType === 'string') {
    db = cashierStorageDb;
    type = dbOrType as any;
    customLabel = typeof typeOrLabel === 'string' ? typeOrLabel : undefined;
  } else {
    db = dbOrType || cashierStorageDb;
    type = (typeOrLabel as any) || 'manual';
    customLabel = maybeLabel;
  }

  // 1. Quota check
  const space = await checkStorageSpaceAvailable();
  if (!space.hasSpace) {
    throw new Error(`تعذر إنشاء النسخة الاحتياطية: ${space.message}`);
  }

  await db.open();

  // 2. Fetch all tables from Dexie
  const [
    products,
    parties,
    invoices,
    invoice_items,
    payments,
    expenses,
    held_invoices,
    categories,
    settings,
    product_images,
    change_journal,
    migration_state,
  ] = await Promise.all([
    db.products.toArray(),
    db.parties.toArray(),
    db.invoices.toArray(),
    db.invoice_items.toArray(),
    db.payments.toArray(),
    db.expenses.toArray(),
    db.held_invoices.toArray(),
    db.categories.toArray(),
    db.settings.toArray(),
    db.product_images.toArray(),
    db.change_journal.toArray(),
    db.migration_state.toArray(),
  ]);

  const tableCounts: Record<string, number> = {
    products: products.length,
    parties: parties.length,
    invoices: invoices.length,
    invoice_items: invoice_items.length,
    payments: payments.length,
    expenses: expenses.length,
    held_invoices: held_invoices.length,
    categories: categories.length,
    settings: settings.length,
    product_images: product_images.length,
    change_journal: change_journal.length,
    migration_state: migration_state.length,
  };

  const totalRecords = Object.values(tableCounts).reduce((a, b) => a + b, 0);

  const data = {
    products,
    parties,
    invoices,
    invoice_items,
    payments,
    expenses,
    held_invoices,
    categories,
    settings,
    product_images,
    change_journal,
    migration_state,
  };

  const checksum = computeBackupChecksum(data);
  const now = new Date();
  const isoDate = now.toISOString();

  // Extract store name & currency from settings
  const storeNameSetting = settings.find((s) => s.key === 'storeName');
  const currencySetting = settings.find((s) => s.key === 'currency');
  const storeName = storeNameSetting?.value || 'Cashier Pro';
  const currency = currencySetting?.value || 'د.ع';

  const backupFile: CompleteDexieBackupFile = {
    format: 'CashierProCompleteDexieBackup',
    version: '2.0.0-dexie',
    createdAt: isoDate,
    checksum,
    storeName,
    currency,
    totalRecords,
    tableCounts,
    data,
  };

  const jsonString = JSON.stringify(backupFile, null, 2);
  const sizeBytes = new Blob([jsonString]).size;

  // File naming: Cashier_Backup_YYYY-MM-DD_HH-mm.json
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateFormatted = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const typeTag = type === 'daily_auto' ? 'DailyAuto' : (type === 'pre_restore_safety' ? 'Safety' : 'Manual');
  const fileName = `Cashier_${typeTag}_${dateFormatted}.json`;

  const label =
    customLabel ||
    (type === 'daily_auto'
      ? 'نسخة يومية تلقائية'
      : type === 'pre_restore_safety'
      ? 'نسخة أمان قبل الاستعادة'
      : 'نسخة احتياطية يدوية كاملة');

  const backupRecord: StorageBackupRecord = {
    id: `bkp_${now.getTime()}_${generateUUID().substring(0, 6)}`,
    createdAt: isoDate,
    type,
    label,
    fileName,
    checksum,
    totalRecords,
    tableCounts,
    sizeBytes,
    payloadJson: jsonString,
  };

  // 3. Save into local backup_history table with historical rotation (keep up to 10 backups)
  try {
    if (db.backup_history) {
      await db.backup_history.put(backupRecord);

      // Rotate: retain newest 10 backups
      const allHist = await db.backup_history.toArray();
      if (allHist.length > 10) {
        allHist.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const toDelete = allHist.slice(0, allHist.length - 10);
        for (const item of toDelete) {
          await db.backup_history.delete(item.id);
        }
      }
    }
  } catch (err: any) {
    if (err.name === 'QuotaExceededError') {
      throw new Error('امتلاء مساحة التخزين في الجهاز. يرجى مسح بعض الملفات المؤقتة لإتمام النسخ.');
    }
    console.warn('Could not save to backup_history:', err);
  }

  const blob = new Blob([jsonString], { type: 'application/json' });
  return { backupRecord, backupFile, jsonString, blob, fileName };
}

/**
 * Validates any backup file in an isolated sandbox database before allowing restore
 */
export async function validateBackupInSandbox(
  fileContent: string | object
): Promise<BackupValidationResult> {
  let parsed: any;
  if (typeof fileContent === 'string') {
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      return { valid: false, error: 'الملف تالف: لا يمكن قراءة بنية JSON.' };
    }
  } else {
    parsed = fileContent;
  }

  // 1. Verify format & required headers
  if (
    !parsed ||
    parsed.format !== 'CashierProCompleteDexieBackup' ||
    !parsed.checksum ||
    !parsed.data
  ) {
    // If legacy format, reject or convert
    return {
      valid: false,
      error: 'تنسيق النسخة الاحتياطية غير متوافق. تأكد من أن الملف هو نسخة معتمدة لقاعدة Dexie.',
    };
  }

  // 2. Recompute and verify deterministic checksum
  const recomputedChecksum = computeBackupChecksum(parsed.data);
  if (recomputedChecksum !== parsed.checksum) {
    return {
      valid: false,
      error: `فشل التحقق من سلامة النسخة الاحتياطية: البصمة الرقمية غير متطابقة (الملف تم تعديله أو تعرض للتلف).`,
    };
  }

  // 3. Sandbox restoration test on isolated database
  const sandboxDbName = `Cashier_Sandbox_Verify_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const sandboxDb = new CashierDatabase(sandboxDbName);

  try {
    await sandboxDb.open();
    const data = parsed.data;

    await sandboxDb.transaction(
      'rw',
      [
        sandboxDb.products,
        sandboxDb.parties,
        sandboxDb.invoices,
        sandboxDb.invoice_items,
        sandboxDb.payments,
        sandboxDb.expenses,
        sandboxDb.held_invoices,
        sandboxDb.categories,
        sandboxDb.settings,
        sandboxDb.product_images,
        sandboxDb.change_journal,
        sandboxDb.migration_state,
      ],
      async () => {
        if (data.products?.length) await sandboxDb.products.bulkPut(data.products);
        if (data.parties?.length) await sandboxDb.parties.bulkPut(data.parties);
        if (data.invoices?.length) await sandboxDb.invoices.bulkPut(data.invoices);
        if (data.invoice_items?.length) await sandboxDb.invoice_items.bulkPut(data.invoice_items);
        if (data.payments?.length) await sandboxDb.payments.bulkPut(data.payments);
        if (data.expenses?.length) await sandboxDb.expenses.bulkPut(data.expenses);
        if (data.held_invoices?.length) await sandboxDb.held_invoices.bulkPut(data.held_invoices);
        if (data.categories?.length) await sandboxDb.categories.bulkPut(data.categories);
        if (data.settings?.length) await sandboxDb.settings.bulkPut(data.settings);
        if (data.product_images?.length) await sandboxDb.product_images.bulkPut(data.product_images);
        if (data.change_journal?.length) await sandboxDb.change_journal.bulkPut(data.change_journal);
        if (data.migration_state?.length) await sandboxDb.migration_state.bulkPut(data.migration_state);
      }
    );

    // Verify record counts match across ALL 12 Dexie tables
    const actualCounts: Record<string, number> = {
      products: await sandboxDb.products.count(),
      parties: await sandboxDb.parties.count(),
      invoices: await sandboxDb.invoices.count(),
      invoice_items: await sandboxDb.invoice_items.count(),
      payments: await sandboxDb.payments.count(),
      expenses: await sandboxDb.expenses.count(),
      held_invoices: await sandboxDb.held_invoices.count(),
      categories: await sandboxDb.categories.count(),
      settings: await sandboxDb.settings.count(),
      product_images: await sandboxDb.product_images.count(),
      change_journal: await sandboxDb.change_journal.count(),
      migration_state: await sandboxDb.migration_state.count(),
    };

    for (const [tableName, actualCount] of Object.entries(actualCounts)) {
      const expectedCount = parsed.tableCounts?.[tableName] ?? data[tableName]?.length ?? 0;
      if (actualCount !== expectedCount) {
        throw new Error(
          `عدم تطابق عدد السجلات في الجدول (${tableName}) داخل البيئة التجريبية: ${actualCount} مقابل ${expectedCount}`
        );
      }
    }

    const totalSandboxCount = Object.values(actualCounts).reduce((a, b) => a + b, 0);

    return {
      valid: true,
      manifest: {
        storeName: parsed.storeName || 'Cashier',
        createdAt: parsed.createdAt,
        totalRecords: parsed.totalRecords || totalSandboxCount,
        tableCounts: parsed.tableCounts || actualCounts,
        checksum: parsed.checksum,
      },
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `فشل التحقق التجريبي في البيئة المعزولة: ${err.message || String(err)}`,
    };
  } finally {
    try {
      await sandboxDb.close();
      await sandboxDb.delete();
    } catch {
      // ignore
    }
  }
}

/**
 * Restores a validated backup into the live production Dexie database with atomic transaction
 * and pre-restore safety snapshot.
 */
export async function restoreDexieBackupSafely(
  fileContent: string | object,
  db: CashierDatabase = cashierStorageDb
): Promise<{ success: boolean; message: string; preSafetyBackupId?: string }> {
  // 1. Validate in Sandbox FIRST
  const validation = await validateBackupInSandbox(fileContent);
  if (!validation.valid || !validation.manifest) {
    throw new Error(validation.error || 'فشل التحقق من سلامة ملف النسخة الاحتياطية.');
  }

  let parsed: CompleteDexieBackupFile =
    typeof fileContent === 'string' ? JSON.parse(fileContent) : fileContent;

  await db.open();

  // 2. Take immediate Pre-Restore Safety Snapshot into backup_history
  let safetyBackupId: string | undefined;
  try {
    const safety = await createFullDexieBackup(db, 'pre_restore_safety', 'نسخة أمان قبل الاستعادة');
    safetyBackupId = safety.backupRecord.id;
  } catch (e) {
    console.warn('Could not take safety snapshot prior to restore:', e);
  }

  // 3. Atomically overwrite live database tables
  const data = parsed.data;
  await db.transaction(
    'rw',
    [
      db.products,
      db.parties,
      db.invoices,
      db.invoice_items,
      db.payments,
      db.expenses,
      db.held_invoices,
      db.categories,
      db.settings,
      db.product_images,
      db.change_journal,
      db.migration_state,
    ],
    async () => {
      // Clear existing records
      await Promise.all([
        db.products.clear(),
        db.parties.clear(),
        db.invoices.clear(),
        db.invoice_items.clear(),
        db.payments.clear(),
        db.expenses.clear(),
        db.held_invoices.clear(),
        db.categories.clear(),
        db.settings.clear(),
        db.product_images.clear(),
        db.change_journal.clear(),
        db.migration_state.clear(),
      ]);

      // Bulk populate new data
      if (data.products?.length) await db.products.bulkPut(data.products);
      if (data.parties?.length) await db.parties.bulkPut(data.parties);
      if (data.invoices?.length) await db.invoices.bulkPut(data.invoices);
      if (data.invoice_items?.length) await db.invoice_items.bulkPut(data.invoice_items);
      if (data.payments?.length) await db.payments.bulkPut(data.payments);
      if (data.expenses?.length) await db.expenses.bulkPut(data.expenses);
      if (data.held_invoices?.length) await db.held_invoices.bulkPut(data.held_invoices);
      if (data.categories?.length) await db.categories.bulkPut(data.categories);
      if (data.settings?.length) await db.settings.bulkPut(data.settings);
      if (data.product_images?.length) await db.product_images.bulkPut(data.product_images);
      if (data.change_journal?.length) await db.change_journal.bulkPut(data.change_journal);
      if (data.migration_state?.length) await db.migration_state.bulkPut(data.migration_state);

      // Recalibrate invoice sequence keys safely without renumbering any existing invoice
      const restoredInvoices = data.invoices || [];
      const maxAnyId = restoredInvoices.reduce((m: number, inv: any) => Math.max(m, Number(inv.id) || 0), 0);
      const parseSeqSuffix = (num?: string): number => {
        if (!num) return 0;
        const m = String(num).match(/(\d+)$/);
        return m ? parseInt(m[1], 10) || 0 : 0;
      };
      const seqKeys: Array<'sale' | 'purchase' | 'sale_return' | 'quote'> = [
        'sale',
        'purchase',
        'sale_return',
        'quote',
      ];
      for (const invType of seqKeys) {
        const key = `seq_${invType}`;
        const existingRec = await db.settings.get(key);
        const existingVal = typeof existingRec?.value === 'number' ? existingRec.value : 0;
        const typeMax = restoredInvoices
          .filter((inv: any) => inv.type === invType)
          .reduce((m: number, inv: any) => Math.max(m, Number(inv.id) || 0, parseSeqSuffix(inv.invoice_number)), 0);
        const safeSeq = Math.max(existingVal, maxAnyId, typeMax);
        await db.settings.put({ key, value: safeSeq });
      }
      const existingGlobalSeq = await db.settings.get('seq_invoices');
      const safeGlobalSeq = Math.max(
        typeof existingGlobalSeq?.value === 'number' ? existingGlobalSeq.value : 0,
        maxAnyId
      );
      await db.settings.put({ key: 'seq_invoices', value: safeGlobalSeq });
    }
  );

  // 4. Reload storageCacheAdapter ONLY when restoring the active runtime database
  const activeAdapterDb =
    typeof (storageCacheAdapter as any).getDatabase === 'function'
      ? (storageCacheAdapter as any).getDatabase()
      : cashierStorageDb;
  if (db === cashierStorageDb || db === activeAdapterDb) {
    await storageCacheAdapter.refreshCacheFromDb();
    storageCacheAdapter.notifyListeners();
  }

  return {
    success: true,
    message: `تم استعادة النسخة الاحتياطية بنجاح (${validation.manifest.totalRecords} سجل).`,
    preSafetyBackupId: safetyBackupId,
  };
}

/**
 * Lists all historical backups saved in the local Dexie database
 */
export async function listHistoricalBackups(
  db: CashierDatabase = cashierStorageDb
): Promise<StorageBackupRecord[]> {
  await db.open();
  if (!db.backup_history) return [];
  const list = await db.backup_history.toArray();
  return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Deletes a historical backup record
 */
export async function deleteHistoricalBackup(
  id: string,
  db: CashierDatabase = cashierStorageDb
): Promise<void> {
  await db.open();
  if (db.backup_history) {
    await db.backup_history.delete(id);
  }
}

/**
 * Automatic Daily Backup Checker
 * If more than 24h passed since last daily_auto backup, creates one quietly in the background.
 */
export async function checkAndRunDailyAutoBackup(
  db: CashierDatabase = cashierStorageDb
): Promise<StorageBackupRecord | null> {
  await db.open();
  if (!db.backup_history) return null;

  const autoBackups = await db.backup_history.where('type').equals('daily_auto').toArray();
  autoBackups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const now = Date.now();
  const lastAuto = autoBackups[0];
  const twentyFourHours = 24 * 60 * 60 * 1000;

  if (!lastAuto || now - new Date(lastAuto.createdAt).getTime() >= twentyFourHours) {
    try {
      const res = await createFullDexieBackup(db, 'daily_auto', 'نسخة يومية تلقائية');
      return res.backupRecord;
    } catch (err) {
      console.warn('Daily auto backup error:', err);
      return null;
    }
  }

  return null;
}
