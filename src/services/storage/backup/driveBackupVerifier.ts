import type { Database } from 'sql.js';
import type { DriveBackupVerificationResult, DriveFileKind } from '../../cloud/types';
import { computeBytesSha256, computeUtf8Sha256 } from '../../cloud/sha256';
import { getSqlJs } from '../../dbFormat';
import { CashierDatabase } from '../schema';
import { generateUUID } from '../uuid';
import { validateBackupInSandbox } from './dexieBackupEngine';

const EXPECTED_SQLITE_TABLES = [
  'settings',
  'products',
  'parties',
  'invoices',
  'invoice_items',
  'payments',
  'expenses',
  'metadata',
] as const;

function hasSqliteHeader(uint8: Uint8Array): boolean {
  return (
    uint8.length >= 16 &&
    uint8[0] === 0x53 && // S
    uint8[1] === 0x51 && // Q
    uint8[2] === 0x4c && // L
    uint8[3] === 0x69 && // i
    uint8[4] === 0x74 && // t
    uint8[5] === 0x65 && // e
    uint8[6] === 0x20 && // space
    uint8[7] === 0x66 // f
  );
}

async function testSnapshotInIsolatedSandbox(snapshot: {
  settings?: Record<string, any>;
  products?: any[];
  parties?: any[];
  invoices?: any[];
  invoice_items?: any[];
  payments?: any[];
  expenses?: any[];
}): Promise<{ ok: boolean; counts: Record<string, number>; error?: string }> {
  const sandboxName = `Cashier_Drive_Sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sandboxDb = new CashierDatabase(sandboxName);
  const now = new Date().toISOString();

  try {
    await sandboxDb.open();

    const products = (snapshot.products || []).map((p, idx) => ({
      id: Number(p.id) || idx + 1,
      uuid: p.uuid || generateUUID(),
      name: String(p.name || `منتج ${idx + 1}`),
      barcode: p.barcode ? String(p.barcode) : '',
      category: p.category ? String(p.category) : 'عام',
      description: p.description ? String(p.description) : '',
      buy_price: Number(p.buy_price) || 0,
      sell_price: Number(p.sell_price) || 0,
      qty: Number(p.qty) || 0,
      currency: p.currency || snapshot.settings?.currency || 'د.ع',
      version: Number(p.version) || 1,
      updatedAt: p.updatedAt || now,
      isDeleted: Boolean(p.isDeleted),
    }));

    const parties = (snapshot.parties || []).map((pt, idx) => ({
      id: Number(pt.id) || idx + 1,
      uuid: pt.uuid || generateUUID(),
      name: String(pt.name || `جهة ${idx + 1}`),
      phone: pt.phone ? String(pt.phone) : '',
      type: (pt.type === 'supplier' ? 'supplier' : 'customer') as 'customer' | 'supplier',
      balance: Number(pt.balance) || 0,
      version: Number(pt.version) || 1,
      updatedAt: pt.updatedAt || now,
      isDeleted: Boolean(pt.isDeleted),
    }));

    const invoices = (snapshot.invoices || []).map((inv, idx) => ({
      id: Number(inv.id) || idx + 1,
      uuid: inv.uuid || generateUUID(),
      invoice_number: inv.invoice_number || undefined,
      type: inv.type || 'sale',
      party_id: inv.party_id ?? null,
      party_name: inv.party_name || '',
      date: inv.date || now,
      discount: Number(inv.discount) || 0,
      total: Number(inv.total) || 0,
      paid: Number(inv.paid) || 0,
      currency: inv.currency || snapshot.settings?.currency || 'د.ع',
      version: Number(inv.version) || 1,
      updatedAt: inv.updatedAt || now,
      isDeleted: Boolean(inv.isDeleted),
    }));

    const invoiceItems = (snapshot.invoice_items || []).map((it, idx) => ({
      id: Number(it.id) || idx + 1,
      uuid: it.uuid || generateUUID(),
      invoice_id: Number(it.invoice_id) || 0,
      product_id: Number(it.product_id) || 0,
      name: String(it.name || `بند ${idx + 1}`),
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
      cost: Number(it.cost) || 0,
      updatedAt: it.updatedAt || now,
    }));

    const payments = (snapshot.payments || []).map((pay, idx) => ({
      id: Number(pay.id) || idx + 1,
      uuid: pay.uuid || generateUUID(),
      party_id: Number(pay.party_id) || 0,
      party_name: pay.party_name || undefined,
      amount: Number(pay.amount) || 0,
      date: pay.date || now,
      notes: pay.notes || undefined,
      currency: pay.currency || snapshot.settings?.currency || 'د.ع',
      updatedAt: pay.updatedAt || now,
      isDeleted: Boolean(pay.isDeleted),
    }));

    const expenses = (snapshot.expenses || []).map((exp, idx) => ({
      id: Number(exp.id) || idx + 1,
      uuid: exp.uuid || generateUUID(),
      recipient: String(exp.recipient || 'مصروف'),
      amount: Number(exp.amount) || 0,
      date: exp.date || now,
      notes: exp.notes || undefined,
      currency: exp.currency || snapshot.settings?.currency || 'د.ع',
      updatedAt: exp.updatedAt || now,
      isDeleted: Boolean(exp.isDeleted),
    }));

    const settingRows = snapshot.settings
      ? Object.entries(snapshot.settings).map(([key, value]) => ({ key, value }))
      : [];

    await sandboxDb.transaction(
      'rw',
      [
        sandboxDb.products,
        sandboxDb.parties,
        sandboxDb.invoices,
        sandboxDb.invoice_items,
        sandboxDb.payments,
        sandboxDb.expenses,
        sandboxDb.settings,
      ],
      async () => {
        if (products.length) await sandboxDb.products.bulkPut(products);
        if (parties.length) await sandboxDb.parties.bulkPut(parties);
        if (invoices.length) await sandboxDb.invoices.bulkPut(invoices);
        if (invoiceItems.length) await sandboxDb.invoice_items.bulkPut(invoiceItems);
        if (payments.length) await sandboxDb.payments.bulkPut(payments);
        if (expenses.length) await sandboxDb.expenses.bulkPut(expenses);
        if (settingRows.length) await sandboxDb.settings.bulkPut(settingRows);
      }
    );

    const counts: Record<string, number> = {
      products: await sandboxDb.products.count(),
      parties: await sandboxDb.parties.count(),
      invoices: await sandboxDb.invoices.count(),
      invoice_items: await sandboxDb.invoice_items.count(),
      payments: await sandboxDb.payments.count(),
      expenses: await sandboxDb.expenses.count(),
      settings: await sandboxDb.settings.count(),
    };

    if (
      counts.products !== products.length ||
      counts.parties !== parties.length ||
      counts.invoices !== invoices.length ||
      counts.invoice_items !== invoiceItems.length ||
      counts.payments !== payments.length ||
      counts.expenses !== expenses.length
    ) {
      return {
        ok: false,
        counts,
        error: 'تفاوت عدد السجلات داخل البيئة المعزولة عن محتوى النسخة.',
      };
    }

    return { ok: true, counts };
  } catch (err: any) {
    return {
      ok: false,
      counts: {},
      error: err?.message || String(err),
    };
  } finally {
    try {
      await sandboxDb.close();
      await sandboxDb.delete();
    } catch {
      // ignore sandbox cleanup errors
    }
  }
}

/**
 * Strictly Read-Only Google Drive Backup Verifier & Sandbox Tester.
 * NEVER modifies CashierPro_DB, NEVER calls DB.restoreDataAsync or universalRestore,
 * and NEVER leaves persistent state behind.
 */
export async function verifyDriveBackupInSandbox(
  buffer: ArrayBuffer,
  meta: {
    fileId: string;
    fileName: string;
    mimeType?: string;
    parents?: string[];
    driveFileKind?: DriveFileKind;
    downloadMethod?: 'alt_media' | 'files_export' | 'rejected';
    reportedSize?: string;
    md5Checksum?: string;
    appProperties?: Record<string, string>;
  }
): Promise<DriveBackupVerificationResult> {
  const verifiedAt = new Date().toISOString();
  const uint8 = new Uint8Array(buffer);
  const sizeBytes = uint8.byteLength;
  const reportedSizeBytes = meta.reportedSize ? Number(meta.reportedSize) || undefined : undefined;
  const warnings: string[] = [];

  if (sizeBytes === 0) {
    return {
      fileId: meta.fileId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      parents: meta.parents,
      driveFileKind: meta.driveFileKind,
      downloadMethod: meta.downloadMethod,
      verifiedAt,
      sizeBytes: 0,
      reportedSizeBytes,
      format: 'unknown',
      structureValid: false,
      sandboxTested: false,
      sandboxRestorable: false,
      computedSha256: '',
      storedSha256: meta.appProperties?.cashierSha256,
      sha256Status: meta.appProperties?.cashierSha256 ? 'mismatch' : 'no_reference',
      sha256Note: 'حجم الملف المنزّل يساوي 0 بايت (ملف فارغ أو تالف).',
      md5Checksum: meta.md5Checksum,
      tables: [],
      totalRecords: 0,
      warnings,
      error: 'حجم الملف المنزّل يساوي 0 بايت ولا يمكن قراءته.',
    };
  }

  if (reportedSizeBytes && reportedSizeBytes !== sizeBytes) {
    warnings.push(`الحجم الفعلي (${sizeBytes} بايت) يختلف عن الحجم المسجل في Drive (${reportedSizeBytes} بايت).`);
  }

  const computedSha256 = await computeBytesSha256(uint8);
  const storedSha256 = meta.appProperties?.cashierSha256?.trim() || undefined;

  let sha256Status: DriveBackupVerificationResult['sha256Status'] = 'no_reference';
  let sha256Note =
    'تم حساب بصمة SHA-256 للنسخة الحالية بنجاح، ولا توجد بصمة مرجعية محفوظة مسبقاً عند الرفع للمقارنة.';

  if (storedSha256) {
    if (storedSha256.toLowerCase() === computedSha256.toLowerCase()) {
      sha256Status = 'matched';
      sha256Note = 'تطابقت بصمة SHA-256 المحسوبة مع البصمة المرجعية المحفوظة عند الرفع.';
    } else {
      sha256Status = 'mismatch';
      sha256Note = 'تحذير: بصمة SHA-256 المحسوبة لا تطابق البصمة المرجعية المحفوظة في Google Drive!';
      warnings.push(sha256Note);
    }
  }

  // Case 1: Binary SQLite 3 database (.db)
  if (hasSqliteHeader(uint8)) {
    let sqlDb: Database | null = null;
    try {
      const SQL = await getSqlJs();
      const activeSqlDb: Database = new SQL.Database(uint8);
      sqlDb = activeSqlDb;

      const tablesRes = activeSqlDb.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tableNames: string[] = tablesRes[0]
        ? tablesRes[0].values.map((row) => String(row[0]))
        : [];

      const tables: Array<{ name: string; rows: number }> = [];
      let totalRecords = 0;

      for (const tbl of tableNames) {
        try {
          const safeTbl = tbl.replace(/"/g, '""');
          const countRes = activeSqlDb.exec(`SELECT COUNT(*) FROM "${safeTbl}"`);
          const rows = countRes[0]?.values?.[0]?.[0] ? Number(countRes[0].values[0][0]) : 0;
          tables.push({ name: tbl, rows });
          if (tbl !== 'metadata' && tbl !== 'settings') {
            totalRecords += rows;
          }
        } catch {
          tables.push({ name: tbl, rows: -1 });
        }
      }

      const lowerNames = new Set(tableNames.map((t) => t.toLowerCase()));
      const missingCore = EXPECTED_SQLITE_TABLES.filter(
        (t) => t !== 'metadata' && !lowerNames.has(t)
      );
      if (missingCore.length > 0) {
        warnings.push(`بعض الجداول القياسية غير موجودة في SQLite: ${missingCore.join(', ')}`);
      }

      // Inspect metadata table if available
      let jsonBackupStr: string | undefined;
      let storedJsonPayloadSha256: string | undefined;
      let jsonPayloadSha256: string | undefined;
      let exportedAt: string | undefined;

      if (lowerNames.has('metadata')) {
        try {
          const metaRows = activeSqlDb.exec('SELECT key, value FROM metadata');
          for (const row of metaRows[0]?.values || []) {
            const k = String(row[0] || '');
            const v = row[1] !== null && row[1] !== undefined ? String(row[1]) : '';
            if (k === 'json_backup') jsonBackupStr = v;
            if (k === 'json_backup_sha256' || k === 'sha256') storedJsonPayloadSha256 = v;
            if (k === 'exported_at') exportedAt = v;
          }
        } catch {
          // ignore metadata read errors
        }
      }

      let storeName: string | undefined;
      if (lowerNames.has('settings')) {
        try {
          const storeRes = activeSqlDb.exec("SELECT value FROM settings WHERE key = 'storeName' LIMIT 1");
          const rawVal = storeRes[0]?.values?.[0]?.[0];
          if (typeof rawVal === 'string') {
            try {
              storeName = String(JSON.parse(rawVal));
            } catch {
              storeName = rawVal;
            }
          }
        } catch {
          // ignore
        }
      }

      let sandboxTested = false;
      let sandboxRestorable = false;
      let sandboxTableCounts: Record<string, number> | undefined;
      let sandboxError: string | undefined;

      if (jsonBackupStr && jsonBackupStr.trim()) {
        jsonPayloadSha256 = await computeUtf8Sha256(jsonBackupStr);
        if (storedJsonPayloadSha256) {
          if (storedJsonPayloadSha256.toLowerCase() !== jsonPayloadSha256.toLowerCase()) {
            warnings.push('تحذير: بصمة SHA-256 لمحتوى json_backup الداخلي غير متطابقة!');
          } else if (sha256Status === 'no_reference') {
            sha256Note =
              'تم التحقق من تطابق بصمة json_backup الداخلية (SHA-256)، أما بصمة ملف .db الكامل فلم تكن محفوظة مسبقاً في خصائص Drive.';
          }
        }

        const parsedJson = JSON.parse(jsonBackupStr);
        if (parsedJson?.format === 'CashierProCompleteDexieBackup' && parsedJson?.data) {
          const v = await validateBackupInSandbox(parsedJson);
          sandboxTested = true;
          sandboxRestorable = v.valid;
          sandboxTableCounts = v.manifest?.tableCounts;
          if (!v.valid) sandboxError = v.error;
          if (v.manifest?.storeName) storeName = v.manifest.storeName;
        } else if (parsedJson && Array.isArray(parsedJson.products)) {
          if (parsedJson.settings?.storeName) storeName = String(parsedJson.settings.storeName);
          if (parsedJson.timestamp && !exportedAt) exportedAt = String(parsedJson.timestamp);

          const sbx = await testSnapshotInIsolatedSandbox(parsedJson);
          sandboxTested = true;
          sandboxRestorable = sbx.ok;
          sandboxTableCounts = sbx.counts;
          if (!sbx.ok) sandboxError = sbx.error;

          // Cross-check SQLite table row counts vs json_backup counts
          const prodRow = tables.find((t) => t.name.toLowerCase() === 'products')?.rows;
          const invRow = tables.find((t) => t.name.toLowerCase() === 'invoices')?.rows;
          if (typeof prodRow === 'number' && prodRow !== parsedJson.products.length) {
            warnings.push(
              `تفاوت عدد الأصناف بين جدول SQLite (${prodRow}) وjson_backup (${parsedJson.products.length}).`
            );
          }
          if (
            typeof invRow === 'number' &&
            Array.isArray(parsedJson.invoices) &&
            invRow !== parsedJson.invoices.length
          ) {
            warnings.push(
              `تفاوت عدد الفواتير بين جدول SQLite (${invRow}) وjson_backup (${parsedJson.invoices.length}).`
            );
          }
        } else {
          sandboxError = 'بيانات json_backup داخل SQLite لا تحتوي على بنية Cashier صالحة.';
        }
      } else {
        // Generic SQLite without json_backup: extract table rows and test in Sandbox
        const readRows = (candidates: string[]): any[] => {
          for (const cand of candidates) {
            const match = tableNames.find((t) => t.toLowerCase() === cand.toLowerCase());
            if (!match || !sqlDb) continue;
            const res = sqlDb.exec(`SELECT * FROM "${match.replace(/"/g, '""')}"`);
            if (!res?.[0]) return [];
            const cols = res[0].columns;
            return res[0].values.map((r) => {
              const obj: Record<string, any> = {};
              cols.forEach((c, idx) => {
                obj[c.toLowerCase()] = r[idx];
              });
              return obj;
            });
          }
          return [];
        };

        const extractedSnapshot = {
          products: readRows(['products', 'items', 'tbl_products']),
          parties: readRows(['parties', 'customers', 'tbl_customers']),
          invoices: readRows(['invoices', 'sales', 'tbl_invoices']),
          invoice_items: readRows(['invoice_items', 'sale_details', 'order_items']),
          payments: readRows(['payments', 'receipts']),
          expenses: readRows(['expenses', 'costs']),
        };

        if (
          extractedSnapshot.products.length > 0 ||
          extractedSnapshot.invoices.length > 0 ||
          extractedSnapshot.parties.length > 0
        ) {
          const sbx = await testSnapshotInIsolatedSandbox(extractedSnapshot);
          sandboxTested = true;
          sandboxRestorable = sbx.ok;
          sandboxTableCounts = sbx.counts;
          if (!sbx.ok) sandboxError = sbx.error;
        } else {
          warnings.push('ملف SQLite لا يحتوي على json_backup أو بيانات منتجات/فواتير كافية.');
        }
      }

      const structureValid =
        tableNames.length > 0 &&
        (missingCore.length === 0 || (sandboxTested && sandboxRestorable)) &&
        sha256Status !== 'mismatch';

      return {
        fileId: meta.fileId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        parents: meta.parents,
        driveFileKind: meta.driveFileKind,
        downloadMethod: meta.downloadMethod,
        verifiedAt,
        sizeBytes,
        reportedSizeBytes,
        format: 'sqlite3',
        structureValid,
        sandboxTested,
        sandboxRestorable,
        computedSha256,
        storedSha256,
        sha256Status,
        sha256Note,
        jsonPayloadSha256,
        storedJsonPayloadSha256,
        md5Checksum: meta.md5Checksum,
        storeName,
        exportedAt,
        tables,
        totalRecords,
        sandboxTableCounts,
        warnings,
        error: sandboxError,
      };
    } catch (err: any) {
      return {
        fileId: meta.fileId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        parents: meta.parents,
        driveFileKind: meta.driveFileKind,
        downloadMethod: meta.downloadMethod,
        verifiedAt,
        sizeBytes,
        reportedSizeBytes,
        format: 'sqlite3',
        structureValid: false,
        sandboxTested: false,
        sandboxRestorable: false,
        computedSha256,
        storedSha256,
        sha256Status,
        sha256Note,
        md5Checksum: meta.md5Checksum,
        tables: [],
        totalRecords: 0,
        warnings,
        error: `فشل قراءة قاعدة SQLite: ${err?.message || String(err)}`,
      };
    } finally {
      if (sqlDb) {
        try {
          sqlDb.close();
        } catch {
          // ignore
        }
      }
    }
  }

  // Case 2: JSON backup (.json or JSON fallback stored in .db)
  try {
    const text = new TextDecoder('utf-8').decode(uint8);
    const parsed = JSON.parse(text);

    if (parsed?.format === 'CashierProCompleteDexieBackup' && parsed?.data) {
      const validation = await validateBackupInSandbox(parsed);
      const tableCounts = validation.manifest?.tableCounts || parsed.tableCounts || {};
      const tables = Object.entries(tableCounts).map(([name, rows]) => ({
        name,
        rows: Number(rows) || 0,
      }));
      const totalRecords = tables.reduce((s, t) => s + t.rows, 0);

      // For CompleteDexieBackupFile, internal checksum IS SHA-256 of canonical data
      const finalShaStatus =
        sha256Status !== 'no_reference'
          ? sha256Status
          : validation.valid
            ? 'matched'
            : 'mismatch';
      const finalShaNote =
        sha256Status !== 'no_reference'
          ? sha256Note
          : validation.valid
            ? 'تطابقت البصمة الرقمية الداخلية لملف Dexie v2 (SHA-256)، ولا توجد بصمة ملف منفصلة في خصائص Drive.'
            : validation.error || 'فشل التحقق من البصمة الداخلية لملف Dexie v2.';

      return {
        fileId: meta.fileId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        parents: meta.parents,
        driveFileKind: meta.driveFileKind,
        downloadMethod: meta.downloadMethod,
        verifiedAt,
        sizeBytes,
        reportedSizeBytes,
        format: 'dexie_v2_json',
        structureValid: validation.valid && finalShaStatus !== 'mismatch',
        sandboxTested: true,
        sandboxRestorable: validation.valid,
        computedSha256,
        storedSha256: storedSha256 || parsed.checksum,
        sha256Status: finalShaStatus,
        sha256Note: finalShaNote,
        md5Checksum: meta.md5Checksum,
        storeName: validation.manifest?.storeName || parsed.storeName,
        exportedAt: validation.manifest?.createdAt || parsed.createdAt,
        tables,
        totalRecords,
        sandboxTableCounts: tableCounts,
        warnings,
        error: validation.valid ? undefined : validation.error,
      };
    }

    if (parsed && Array.isArray(parsed.products)) {
      const sbx = await testSnapshotInIsolatedSandbox(parsed);
      const tables = Object.entries(sbx.counts).map(([name, rows]) => ({ name, rows }));
      const totalRecords = tables
        .filter((t) => t.name !== 'settings')
        .reduce((s, t) => s + t.rows, 0);

      return {
        fileId: meta.fileId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        parents: meta.parents,
        driveFileKind: meta.driveFileKind,
        downloadMethod: meta.downloadMethod,
        verifiedAt,
        sizeBytes,
        reportedSizeBytes,
        format: 'legacy_json',
        structureValid: sbx.ok && sha256Status !== 'mismatch',
        sandboxTested: true,
        sandboxRestorable: sbx.ok,
        computedSha256,
        storedSha256,
        sha256Status,
        sha256Note,
        md5Checksum: meta.md5Checksum,
        storeName: parsed.settings?.storeName,
        exportedAt: parsed.timestamp,
        tables,
        totalRecords,
        sandboxTableCounts: sbx.counts,
        warnings,
        error: sbx.error,
      };
    }

    return {
      fileId: meta.fileId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      parents: meta.parents,
      driveFileKind: meta.driveFileKind,
      downloadMethod: meta.downloadMethod,
      verifiedAt,
      sizeBytes,
      reportedSizeBytes,
      format: 'unknown',
      structureValid: false,
      sandboxTested: false,
      sandboxRestorable: false,
      computedSha256,
      storedSha256,
      sha256Status,
      sha256Note,
      md5Checksum: meta.md5Checksum,
      tables: [],
      totalRecords: 0,
      warnings,
      error: 'تنسيق JSON غير معروف ولا يتطابق مع بنية Cashier Pro.',
    };
  } catch (err: any) {
    return {
      fileId: meta.fileId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      parents: meta.parents,
      driveFileKind: meta.driveFileKind,
      downloadMethod: meta.downloadMethod,
      verifiedAt,
      sizeBytes,
      reportedSizeBytes,
      format: 'unknown',
      structureValid: false,
      sandboxTested: false,
      sandboxRestorable: false,
      computedSha256,
      storedSha256,
      sha256Status,
      sha256Note,
      md5Checksum: meta.md5Checksum,
      tables: [],
      totalRecords: 0,
      warnings,
      error: `الملف ليس SQLite صالحاً ولا JSON قابلاً للقراءة: ${err?.message || String(err)}`,
    };
  }
}
