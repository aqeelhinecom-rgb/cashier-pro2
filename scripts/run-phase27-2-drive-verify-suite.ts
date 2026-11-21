/**
 * Cashier Pro — Phase 27.2: Google Drive Backup Download, Sandbox Verification & SHA-256 Suite
 *
 * التصنيف الصريح للاختبارات:
 * - [Isolated Integration Test]: اختبارات تكامل محلية على SQLite WASM + fake-indexeddb/auto
 *   لا تلمس CashierPro_DB الحقيقية ولا تتصل بخوادم Google أو Firebase الحية.
 * - [Automated Mock Test]: محاكاة Google Drive REST API لاختبار حفظ ومقارنة SHA-256 وكشف التلف.
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import { terminate } from 'firebase/firestore';
import { deleteApp } from 'firebase/app';
import { CashierDatabase } from '../src/services/storage/schema';
import { storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { DB } from '../src/services/db';
import { createSqliteDbBlob, restoreFromSqliteBinary } from '../src/services/dbFormat';
import { createFullDexieBackup } from '../src/services/storage/backup/dexieBackupEngine';
import { verifyDriveBackupInSandbox } from '../src/services/storage/backup/driveBackupVerifier';
import { computeBytesSha256, computeBytesSha256Sync } from '../src/services/cloud/sha256';
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  uploadBackupToGoogleDrive,
  verifyBackupOnGoogleDrive,
  setDriveTestOverrides,
  clearDriveToken,
} from '../src/services/cloud/googleDriveService';
import { app, firestore } from '../src/services/cloud/firebaseCloudService';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
}

type TestClassification = 'Automated Mock Test' | 'Isolated Integration Test';

interface TestMetric {
  id: string;
  classification: TestClassification;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestMetric[] = [];

function record(
  id: string,
  classification: TestClassification,
  name: string,
  passed: boolean,
  details: string
) {
  results.push({ id, classification, name, passed, details });
  if (!passed) {
    throw new Error(`❌ فشل [${id}] (${classification}) ${name} | ${details}`);
  }
  console.log(`✅ [${id}] [${classification}] ${name}\n   ${details}`);
}

async function main() {
  console.log('==================================================================');
  console.log('  Cashier Pro — Phase 27.2: Drive Sandbox Verify & SHA-256 Suite');
  console.log('==================================================================\n');

  const srcDb = new CashierDatabase(`Cashier_P27_2_Src_${Date.now()}`);
  const liveGuardDb = new CashierDatabase(`Cashier_P27_2_Guard_${Date.now()}`);
  const compatDstDb = new CashierDatabase(`Cashier_P27_2_Compat_${Date.now()}`);

  try {
    // Prepare isolated source data and generate SQLite .db + Dexie v2 JSON
    await srcDb.open();
    await DB.initializeAsync(srcDb);
    const prod = await DB.saveProduct({
      name: 'صنف اختباري Drive P27.2',
      barcode: '272001',
      category: 'إلكترونيات',
      buy_price: 10000,
      sell_price: 15000,
      qty: 20,
    });
    const cust = await DB.addParty('زبون اختباري P27.2', '07701112233', 'customer');
    await DB.saveInvoice({
      type: 'sale',
      partyId: cust.id,
      items: [{ product_id: prod.id, name: prod.name, qty: 2, price: 15000, cost: 10000 }],
      discount: 0,
      paid: 30000,
    });

    const sqliteExport = await createSqliteDbBlob();
    const dexieExport = await createFullDexieBackup(srcDb, 'manual');

    // -----------------------------------------------------------------------
    // P27.2-01: Byte-level SHA-256 parity & legacy Drive file (no ref hash)
    // -----------------------------------------------------------------------
    {
      const subtleSha = await computeBytesSha256(sqliteExport.binary);
      const syncSha = computeBytesSha256Sync(sqliteExport.binary);

      // Simulate an older uploaded .db without Drive appProperties.cashierSha256
      const legacyCheck = await verifyDriveBackupInSandbox(
        sqliteExport.binary.buffer.slice(
          sqliteExport.binary.byteOffset,
          sqliteExport.binary.byteOffset + sqliteExport.binary.byteLength
        ) as ArrayBuffer,
        {
          fileId: 'legacy_drive_file_1',
          fileName: 'data (autoSave) old.db',
          reportedSize: String(sqliteExport.binary.byteLength),
        }
      );

      record(
        'P27.2-01',
        'Isolated Integration Test',
        'تطابق SHA-256 الثنائي وفحص نسخة قديمة بدون appProperties في Sandbox',
        subtleSha === syncSha &&
          subtleSha.length === 64 &&
          legacyCheck.sizeBytes === sqliteExport.binary.byteLength &&
          legacyCheck.format === 'sqlite3' &&
          legacyCheck.structureValid === true &&
          legacyCheck.sandboxTested === true &&
          legacyCheck.sandboxRestorable === true &&
          legacyCheck.sha256Status === 'no_reference' &&
          legacyCheck.computedSha256 === subtleSha &&
          legacyCheck.tables.some((t) => t.name === 'products' && t.rows === 1) &&
          legacyCheck.tables.some((t) => t.name === 'invoices' && t.rows === 1),
        `shaMatch=${subtleSha === syncSha}, size=${legacyCheck.sizeBytes}B, shaStatus=${legacyCheck.sha256Status}, tables=${legacyCheck.tables.length}, records=${legacyCheck.totalRecords}`
      );
    }

    // -----------------------------------------------------------------------
    // P27.2-02: Upload saves SHA-256 appProperties + Verify matches & detects tampering
    // -----------------------------------------------------------------------
    {
      let capturedMetaAppProps: Record<string, string> | undefined;
      let storedBytes = new Uint8Array(sqliteExport.binary);

      setDriveTestOverrides({
        oauthRequester: async () => ({
          accessToken: 'p27_2_mock_drive_token',
          expiresInSec: 3600,
        }),
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('/oauth2/v3/userinfo')) {
            return new Response(JSON.stringify({ email: 'verify.test@example.com' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (url.includes('/drive/v3/files?q=') && url.includes('folder')) {
            return new Response(JSON.stringify({ files: [{ id: 'drv_folder_1', name: 'Cashier_Backups' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (url.includes('/upload/drive/v3/files')) {
            const bodyBlob = init?.body as Blob;
            const bodyText = await bodyBlob.text();
            const partMarker = 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
            const startIdx = bodyText.indexOf(partMarker);
            if (startIdx >= 0) {
              const afterHeader = bodyText.slice(startIdx + partMarker.length);
              const endIdx = afterHeader.indexOf('\r\n--');
              const jsonStr = endIdx >= 0 ? afterHeader.slice(0, endIdx) : afterHeader;
              const parsedMeta = JSON.parse(jsonStr);
              capturedMetaAppProps = parsedMeta.appProperties;
            }
            return new Response(
              JSON.stringify({
                id: 'new_drive_file_1',
                name: sqliteExport.fileName,
                size: String(storedBytes.byteLength),
                createdTime: new Date().toISOString(),
                appProperties: capturedMetaAppProps,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.includes('/drive/v3/files/new_drive_file_1?alt=media')) {
            return new Response(storedBytes, { status: 200 });
          }
          if (url.includes('/drive/v3/files/new_drive_file_1?fields=')) {
            return new Response(
              JSON.stringify({
                id: 'new_drive_file_1',
                name: sqliteExport.fileName,
                mimeType: 'application/x-sqlite3',
                size: String(storedBytes.byteLength),
                parents: ['drv_folder_1'],
                md5Checksum: 'mock_md5_123456',
                appProperties: capturedMetaAppProps,
                capabilities: { canDownload: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        }) as typeof fetch,
      });

      await connectGoogleDrive({ prompt: '' });
      const uploaded = await uploadBackupToGoogleDrive(sqliteExport.binary, sqliteExport.fileName);

      const verifiedOk = await verifyBackupOnGoogleDrive({
        id: uploaded.id,
        name: uploaded.name,
        size: String(sqliteExport.binary.byteLength),
        appProperties: capturedMetaAppProps,
      });

      // Tamper 1 byte near end of downloaded copy -> must flag mismatch!
      const tampered = new Uint8Array(sqliteExport.binary);
      tampered[tampered.length - 10] ^= 0xff;
      storedBytes = tampered;

      const verifiedTampered = await verifyBackupOnGoogleDrive({
        id: uploaded.id,
        name: uploaded.name,
        size: String(tampered.byteLength),
        appProperties: capturedMetaAppProps,
      });

      record(
        'P27.2-02',
        'Automated Mock Test',
        'حفظ SHA-256 في خصائص الرفع على Drive ومطابقتها وكشف أي تعديل أو تلف بالملف',
        Boolean(capturedMetaAppProps?.cashierSha256) &&
          capturedMetaAppProps?.cashierSha256 === uploaded.sha256 &&
          verifiedOk.sha256Status === 'matched' &&
          verifiedOk.structureValid === true &&
          verifiedOk.sandboxRestorable === true &&
          verifiedTampered.sha256Status === 'mismatch' &&
          verifiedTampered.structureValid === false,
        `uploadedSha=${uploaded.sha256.slice(0, 12)}..., okStatus=${verifiedOk.sha256Status}, tamperedStatus=${verifiedTampered.sha256Status}`
      );
    }

    // -----------------------------------------------------------------------
    // P27.2-03: Sandbox Verification NEVER modifies active DB + Restore remains compatible
    // -----------------------------------------------------------------------
    {
      await liveGuardDb.open();
      await DB.initializeAsync(liveGuardDb);
      const sentinel = await DB.saveProduct({
        name: 'منتج حي لا يُمس أثناء الفحص',
        barcode: '999888',
        category: 'حماية',
        buy_price: 5000,
        sell_price: 9000,
        qty: 99,
      });

      // Verify BOTH SQLite backup and Dexie v2 JSON backup while liveGuardDb is active
      const sqliteVerify = await verifyDriveBackupInSandbox(
        sqliteExport.binary.buffer.slice(
          sqliteExport.binary.byteOffset,
          sqliteExport.binary.byteOffset + sqliteExport.binary.byteLength
        ) as ArrayBuffer,
        {
          fileId: 'sbx_guard_sqlite',
          fileName: sqliteExport.fileName,
        }
      );

      const dexieBytes = new TextEncoder().encode(dexieExport.jsonString);
      const dexieVerify = await verifyDriveBackupInSandbox(
        dexieBytes.buffer.slice(
          dexieBytes.byteOffset,
          dexieBytes.byteOffset + dexieBytes.byteLength
        ) as ArrayBuffer,
        {
          fileId: 'sbx_guard_dexie',
          fileName: dexieExport.fileName,
        }
      );

      const liveProductsAfter = DB.getProducts();
      const liveInvoicesAfter = DB.getInvoices();
      const sentinelStillIntact =
        liveProductsAfter.length === 1 &&
        liveProductsAfter[0].id === sentinel.id &&
        liveProductsAfter[0].name === 'منتج حي لا يُمس أثناء الفحص' &&
        liveProductsAfter[0].qty === 99 &&
        liveInvoicesAfter.length === 0;

      // Also verify backwards-compatible restore still works on disposable compatDstDb
      await compatDstDb.open();
      await DB.initializeAsync(compatDstDb);
      const restoredOk = await restoreFromSqliteBinary(sqliteExport.binary);
      const restoredProducts = DB.getProducts();
      const restoredInvoices = DB.getInvoices();

      record(
        'P27.2-03',
        'Isolated Integration Test',
        'فحص Sandbox لا يلمس القاعدة النشطة وتوافق الاستعادة مع البصمة الجديدة محفوظ 100%',
        sqliteVerify.sandboxRestorable &&
          dexieVerify.sandboxRestorable &&
          dexieVerify.sha256Status === 'matched' &&
          sentinelStillIntact &&
          restoredOk &&
          restoredProducts.length === 1 &&
          restoredProducts[0].name === 'صنف اختباري Drive P27.2' &&
          restoredInvoices.length === 1,
        `liveUntouched=${sentinelStillIntact}, sqliteSbx=${sqliteVerify.sandboxRestorable}, dexieSbx=${dexieVerify.sandboxRestorable}, compatRestore=${restoredOk}`
      );
    }

    console.log('\n==================================================================');
    console.log(`✅ اكتملت اختبارات المرحلة 27.2 بنجاح (${results.length}/${results.length})`);
    console.log('   - ملاحظة: الشبكة محاكاة فقط؛ لم يُنزَّل ملف فعلي من حساب Drive الحي.');
    console.log('==================================================================');
  } finally {
    await disconnectGoogleDrive().catch(() => {});
    clearDriveToken();
    setDriveTestOverrides(null);
    storageCacheAdapter.dispose();
    for (const db of [srcDb, liveGuardDb, compatDstDb]) {
      try {
        await db.close();
        await db.delete();
      } catch {
        // ignore
      }
    }
    await terminate(firestore).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n❌ فشل تشغيل حزمة التحقق Phase 27.2:', err);
  process.exitCode = 1;
});
