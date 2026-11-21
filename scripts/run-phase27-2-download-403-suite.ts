/**
 * Cashier Pro — Phase 27.2 Download-403 Diagnostic & File-Type Routing Verification Suite
 *
 * التصنيف الصريح للاختبارات:
 * - [Automated Mock Test]: محاكاة استجابات Google Drive API لاختبار:
 *   1) استبعاد المجلدات (application/vnd.google-apps.folder) من القائمة ورفض تنزيلها.
 *   2) فحص الملفات الثنائية (.db / .json) عبر files.get?alt=media.
 *   3) ملفات Google Docs Editor عبر files.export فقط إذا كان المحتوى نسخة احتياطية صالحة،
 *      ورفض المستندات العادية أو الجداول (Spreadsheet) دون تحويل قسري.
 *   4) معالجة أخطاء HTTP 403 الخاصة بالملف (insufficientFilePermissions / appNotAuthorizedToFile /
 *      fileNotDownloadable) مع عرض id, name, mimeType, size, parents, md5Checksum والحفاظ على اتصال Drive.
 * - [Isolated Integration Test]: إثبات أن CashierPro_DB / القاعدة النشطة لا تُمس وأن أي دالة استعادة لا تُستدعى.
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import { terminate } from 'firebase/firestore';
import { deleteApp } from 'firebase/app';
import { CashierDatabase } from '../src/services/storage/schema';
import { storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { DB } from '../src/services/db';
import { createSqliteDbBlob } from '../src/services/dbFormat';
import { createFullDexieBackup } from '../src/services/storage/backup/dexieBackupEngine';
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  listGoogleDriveBackups,
  verifyBackupOnGoogleDrive,
  downloadDriveBackupWithMetadata,
  classifyDriveFileKind,
  getGoogleDriveState,
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
  console.log('  Cashier Pro — P27.2-Download-403 Diagnostic & Routing Suite');
  console.log('==================================================================\n');

  const srcDb = new CashierDatabase(`Cashier_P27_2_403_Src_${Date.now()}`);
  const activeGuardDb = new CashierDatabase(`Cashier_P27_2_403_Guard_${Date.now()}`);

  try {
    // 1. Seed source DB to generate realistic SQLite & Dexie JSON payloads
    await srcDb.open();
    await DB.initializeAsync(srcDb);
    const p1 = await DB.saveProduct({
      name: 'شاشة اختبارية P27.2-403',
      barcode: '403001',
      category: 'شاشات',
      buy_price: 50000,
      sell_price: 75000,
      qty: 12,
    });
    await DB.saveInvoice({
      type: 'sale',
      items: [{ product_id: p1.id, name: p1.name, qty: 1, price: 75000, cost: 50000 }],
      discount: 0,
      paid: 75000,
    });

    const sqliteExport = await createSqliteDbBlob();
    const dexieExport = await createFullDexieBackup(srcDb, 'manual');

    // Switch DB active instance to isolated Guard DB (simulates CashierPro_DB untouched guarantee)
    await activeGuardDb.open();
    await DB.initializeAsync(activeGuardDb);
    const sentinelProd = await DB.saveProduct({
      name: 'بيانات محل نشطة محمية',
      barcode: '999403',
      category: 'حماية',
      buy_price: 1000,
      sell_price: 2000,
      qty: 55,
    });

    // Track if any restore method is ever invoked during verifyBackupOnGoogleDrive
    let restoreCallCount = 0;
    const origRestoreDataAsync = DB.restoreDataAsync.bind(DB);
    (DB as any).restoreDataAsync = async (...args: any[]) => {
      restoreCallCount++;
      return (origRestoreDataAsync as any)(...args);
    };

    try {
      let lastListQuery = '';
      const requestLog: string[] = [];

      const mockFiles: Record<
        string,
        {
          meta: any;
          mediaStatus?: number;
          mediaBody?: BodyInit;
          exportStatus?: number;
          exportBody?: BodyInit;
        }
      > = {
        folder_cashier_backups: {
          meta: {
            id: 'folder_cashier_backups',
            name: 'Cashier_Backups',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          },
        },
        file_sqlite_valid: {
          meta: {
            id: 'file_sqlite_valid',
            name: sqliteExport.fileName,
            mimeType: 'application/x-sqlite3',
            size: String(sqliteExport.binary.byteLength),
            parents: ['folder_cashier_backups'],
            md5Checksum: 'abc123sqlite456md5',
            capabilities: { canDownload: true },
          },
          mediaStatus: 200,
          mediaBody: sqliteExport.binary.buffer.slice(
            sqliteExport.binary.byteOffset,
            sqliteExport.binary.byteOffset + sqliteExport.binary.byteLength
          ) as ArrayBuffer,
        },
        file_sqlite_403_app_auth: {
          meta: {
            id: 'file_sqlite_403_app_auth',
            name: 'data (autoSave) old_client.db',
            mimeType: 'application/octet-stream',
            size: '18432',
            parents: ['folder_cashier_backups'],
            md5Checksum: 'old999md5check',
            capabilities: { canDownload: true },
          },
          mediaStatus: 403,
          mediaBody: JSON.stringify({
            error: {
              code: 403,
              message: 'The user has not granted the app 350661523968 write access to the file.',
              errors: [
                {
                  domain: 'global',
                  reason: 'appNotAuthorizedToFile',
                  message: 'The user has not granted the app write access to the file.',
                },
              ],
            },
          }),
        },
        file_gdoc_valid_backup: {
          meta: {
            id: 'file_gdoc_valid_backup',
            name: 'Cashier_Backup_Doc_Valid',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder_cashier_backups'],
          },
          exportStatus: 200,
          exportBody: dexieExport.jsonString,
        },
        file_gdoc_plain_note: {
          meta: {
            id: 'file_gdoc_plain_note',
            name: 'ملاحظات backup غير صالحة',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder_cashier_backups'],
          },
          exportStatus: 200,
          exportBody: 'هذا مستند نصي عادي وليس نسخة احتياطية لنظام Cashier Pro.',
        },
        file_gsheet_unsupported: {
          meta: {
            id: 'file_gsheet_unsupported',
            name: 'Cashier_Report_Sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['folder_cashier_backups'],
          },
        },
      };

      setDriveTestOverrides({
        oauthRequester: async () => ({
          accessToken: 'p27_2_403_test_token',
          expiresInSec: 3600,
        }),
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          requestLog.push(url);

          if (url.includes('/oauth2/v3/userinfo')) {
            return new Response(JSON.stringify({ email: 'diag.test@example.com' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (url.includes('/drive/v3/files?q=')) {
            const parsed = new URL(url);
            lastListQuery = parsed.searchParams.get('q') || '';
            // Return both valid file and an erroneously injected folder to test client filter too
            return new Response(
              JSON.stringify({
                files: [
                  mockFiles.folder_cashier_backups.meta,
                  mockFiles.file_sqlite_valid.meta,
                  mockFiles.file_sqlite_403_app_auth.meta,
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          const match = url.match(/\/drive\/v3\/files\/([^/?]+)(?:\/export)?/);
          if (match) {
            const fid = decodeURIComponent(match[1]);
            const entry = mockFiles[fid];
            if (!entry) return new Response('Not found', { status: 404 });

            if (url.includes('/export?')) {
              return new Response(entry.exportBody ?? '', {
                status: entry.exportStatus ?? 200,
              });
            }
            if (url.includes('?alt=media')) {
              return new Response(entry.mediaBody ?? '', {
                status: entry.mediaStatus ?? 200,
              });
            }
            if (url.includes('?fields=')) {
              return new Response(JSON.stringify(entry.meta), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }

          return new Response('Unhandled URL', { status: 500 });
        }) as typeof fetch,
      });

      await connectGoogleDrive({ prompt: '' });

      // -------------------------------------------------------------------
      // Case 1: Folder exclusion from list & clean rejection if verified directly
      // -------------------------------------------------------------------
      const listed = await listGoogleDriveBackups();
      const folderVerifyRes = await verifyBackupOnGoogleDrive(
        mockFiles.folder_cashier_backups.meta
      );

      record(
        'P27.2-403-01',
        'Automated Mock Test',
        'استبعاد المجلدات من قائمة النسخ الاحتياطية ورفض تنزيل المجلد دون إرسال alt=media',
        lastListQuery.includes("mimeType != 'application/vnd.google-apps.folder'") &&
          !listed.some((f) => f.id === 'folder_cashier_backups') &&
          listed.length === 2 &&
          folderVerifyRes.driveFileKind === 'folder' &&
          folderVerifyRes.downloadMethod === 'rejected' &&
          folderVerifyRes.driveErrorReason === 'folder_not_downloadable' &&
          !requestLog.some((u) => u.includes('folder_cashier_backups?alt=media')),
        `listedCount=${listed.length}, queryExcludesFolder=true, folderReason=${folderVerifyRes.driveErrorReason}`
      );

      // -------------------------------------------------------------------
      // Case 2: Valid Binary SQLite downloads via alt=media & passes Sandbox
      // -------------------------------------------------------------------
      const sqliteVerifyRes = await verifyBackupOnGoogleDrive(mockFiles.file_sqlite_valid.meta);

      record(
        'P27.2-403-02',
        'Automated Mock Test',
        'تنزيل ملف SQLite الثنائي عبر files.get?alt=media وفحصه في Sandbox مع إرجاع البيانات الكاملة',
        sqliteVerifyRes.httpStatus === 200 &&
          sqliteVerifyRes.driveFileKind === 'sqlite' &&
          sqliteVerifyRes.downloadMethod === 'alt_media' &&
          sqliteVerifyRes.structureValid === true &&
          sqliteVerifyRes.sandboxRestorable === true &&
          sqliteVerifyRes.mimeType === 'application/x-sqlite3' &&
          sqliteVerifyRes.md5Checksum === 'abc123sqlite456md5' &&
          sqliteVerifyRes.parents?.[0] === 'folder_cashier_backups',
        `kind=${sqliteVerifyRes.driveFileKind}, method=${sqliteVerifyRes.downloadMethod}, records=${sqliteVerifyRes.totalRecords}, md5=${sqliteVerifyRes.md5Checksum}`
      );

      // -------------------------------------------------------------------
      // Case 3: Simulated 403 returns full Drive API diagnostics & keeps session alive
      // -------------------------------------------------------------------
      const err403Res = await verifyBackupOnGoogleDrive(mockFiles.file_sqlite_403_app_auth.meta);
      const driveStateAfter403 = getGoogleDriveState();

      record(
        'P27.2-403-03',
        'Automated Mock Test',
        'عرض التشخيص الكامل لخطأ 403 (id, name, mimeType, size, parents, md5, reason) دون إسقاط جلسة Drive',
        err403Res.fileId === 'file_sqlite_403_app_auth' &&
          err403Res.fileName === 'data (autoSave) old_client.db' &&
          err403Res.mimeType === 'application/octet-stream' &&
          err403Res.reportedSizeBytes === 18432 &&
          err403Res.parents?.[0] === 'folder_cashier_backups' &&
          err403Res.md5Checksum === 'old999md5check' &&
          err403Res.httpStatus === 403 &&
          err403Res.driveErrorReason === 'appNotAuthorizedToFile' &&
          Boolean(err403Res.driveRawErrorMessage?.includes('350661523968')) &&
          err403Res.structureValid === false &&
          driveStateAfter403.status === 'connected' &&
          driveStateAfter403.tokenValid === true,
        `http=${err403Res.httpStatus}, reason=${err403Res.driveErrorReason}, driveStatus=${driveStateAfter403.status}`
      );

      // -------------------------------------------------------------------
      // Case 4: Google Docs Editor (files.export) — valid backup passes, non-backup/sheet rejected
      // -------------------------------------------------------------------
      const validDocRes = await verifyBackupOnGoogleDrive(mockFiles.file_gdoc_valid_backup.meta);
      const invalidDocRes = await verifyBackupOnGoogleDrive(mockFiles.file_gdoc_plain_note.meta);
      const unsupportedSheetRes = await verifyBackupOnGoogleDrive(
        mockFiles.file_gsheet_unsupported.meta
      );

      record(
        'P27.2-403-04',
        'Automated Mock Test',
        'دعم files.export لمستندات Google Docs الصالحة فقط ورفض المستندات/الجداول غير الصالحة دون تحويل قسري',
        classifyDriveFileKind(mockFiles.file_gdoc_valid_backup.meta) === 'google_docs_editor' &&
          validDocRes.downloadMethod === 'files_export' &&
          validDocRes.format === 'dexie_v2_json' &&
          validDocRes.structureValid === true &&
          validDocRes.sandboxRestorable === true &&
          invalidDocRes.driveErrorReason === 'non_backup_google_doc' &&
          invalidDocRes.structureValid === false &&
          unsupportedSheetRes.driveErrorReason === 'unsupported_google_workspace_type' &&
          unsupportedSheetRes.downloadMethod === 'rejected' &&
          unsupportedSheetRes.structureValid === false,
        `validDoc=${validDocRes.sandboxRestorable}, invalidDocReason=${invalidDocRes.driveErrorReason}, sheetReason=${unsupportedSheetRes.driveErrorReason}`
      );

      // -------------------------------------------------------------------
      // Case 5: Active DB & CashierPro_DB safety guarantee + zero restore calls
      // -------------------------------------------------------------------
      // Also verify direct download helper rejects non-backup doc cleanly
      let directDocErrorReason = '';
      try {
        await downloadDriveBackupWithMetadata('file_gdoc_plain_note');
      } catch (e: any) {
        directDocErrorReason = e?.driveErrorReason || '';
      }

      const guardProducts = DB.getProducts();
      const guardInvoices = DB.getInvoices();
      const guardIntact =
        guardProducts.length === 1 &&
        guardProducts[0].id === sentinelProd.id &&
        guardProducts[0].name === 'بيانات محل نشطة محمية' &&
        guardProducts[0].qty === 55 &&
        guardInvoices.length === 0 &&
        restoreCallCount === 0;

      record(
        'P27.2-403-05',
        'Isolated Integration Test',
        'عدم استدعاء أي دالة استعادة وعدم المساس بالقاعدة النشطة أثناء جميع عمليات الفحص والرفض',
        guardIntact && directDocErrorReason === 'non_backup_google_doc',
        `restoreCalls=${restoreCallCount}, guardIntact=${guardIntact}, directDocReject=${directDocErrorReason}`
      );
    } finally {
      (DB as any).restoreDataAsync = origRestoreDataAsync;
    }

    console.log('\n==================================================================');
    console.log(`✅ اكتملت اختبارات P27.2-Download-403 بنجاح (${results.length}/${results.length})`);
    console.log('   - ملاحظة: الشبكة محاكاة؛ يلزم فحص النسختين الفعليتين من متصفح المستخدم لقراءة حقولهما الحية من Drive.');
    console.log('==================================================================');
  } finally {
    await disconnectGoogleDrive().catch(() => {});
    clearDriveToken();
    setDriveTestOverrides(null);
    storageCacheAdapter.dispose();
    for (const db of [srcDb, activeGuardDb]) {
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
  console.error('\n❌ فشل تشغيل حزمة التحقق P27.2-Download-403:', err);
  process.exitCode = 1;
});
