/**
 * Cashier Pro — Phase 27: Cloud Services Isolation & Connection Diagnostics Verification Suite
 *
 * التصنيف الصريح للاختبارات في هذا الملف:
 * - [Automated Mock Test]: اختبارات وحدة ومحاكاة معزولة لا تتصل فعلياً بخوادم Google أو Firebase الحية.
 * - [Isolated Integration Test]: اختبارات تكامل محلية باستخدام fake-indexeddb/auto وقاعدة معزولة تماماً
 *   (لا تلمس CashierPro_DB الحقيقية ولا ترسل بيانات المتجر إلى Firebase).
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { terminate } from 'firebase/firestore';
import { deleteApp } from 'firebase/app';
import { CashierDatabase } from '../src/services/storage/schema';
import { storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { DB } from '../src/services/db';
import {
  GOOGLE_DRIVE_SCOPES,
  connectGoogleDrive,
  disconnectGoogleDrive,
  getGoogleDriveState,
  hasValidDriveToken,
  uploadBackupToGoogleDrive,
  listGoogleDriveBackups,
  downloadBackupFromGoogleDrive,
  deleteBackupFromGoogleDrive,
  setDriveTestOverrides,
  clearDriveToken,
} from '../src/services/cloud/googleDriveService';
import {
  app,
  firestore,
  firebaseAuthProvider,
  getFirebaseState,
  configureTestFirebaseProject,
  diagnoseFirestoreConnection,
  runFirestoreTestProjectDiagnostic,
  disconnectFirebase,
} from '../src/services/cloud/firebaseCloudService';
import * as LegacyFirebaseFacade from '../src/services/firebase';
import firebaseConfig from '../firebase-applet-config.json';

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

interface TestRecord {
  id: string;
  classification: TestClassification;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestRecord[] = [];

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
  console.log('  Cashier Pro — Phase 27: Cloud Services Isolation Suite');
  console.log('==================================================================\n');

  const isolatedDbName = `Cashier_P27_Iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const isolatedDb = new CashierDatabase(isolatedDbName);

  try {
    // -----------------------------------------------------------------------
    // P27-01: Scopes & Facade Isolation Verification [Isolated Integration Test]
    // -----------------------------------------------------------------------
    {
      const providerScopes: string[] =
        typeof (firebaseAuthProvider as any).getScopes === 'function'
          ? (firebaseAuthProvider as any).getScopes()
          : Array.isArray((firebaseAuthProvider as any).scopes)
            ? (firebaseAuthProvider as any).scopes
            : [];

      const hasDriveScopeInFirebase = providerScopes.some((s) =>
        String(s).toLowerCase().includes('drive')
      );

      const firebaseServiceSrc = fs.readFileSync(
        path.resolve(process.cwd(), 'src/services/cloud/firebaseCloudService.ts'),
        'utf-8'
      );
      const srcMentionsDriveScope =
        firebaseServiceSrc.includes('googleapis.com/auth/drive') ||
        firebaseServiceSrc.includes('drive.file') ||
        firebaseServiceSrc.includes('drive.appdata');

      const hasRequiredDriveScopes =
        GOOGLE_DRIVE_SCOPES.includes('https://www.googleapis.com/auth/drive.file') &&
        GOOGLE_DRIVE_SCOPES.includes('https://www.googleapis.com/auth/drive.appdata');

      const legacyExportsPresent =
        typeof LegacyFirebaseFacade.initAuth === 'function' &&
        typeof LegacyFirebaseFacade.signInWithGoogle === 'function' &&
        typeof LegacyFirebaseFacade.signOutGoogle === 'function' &&
        typeof LegacyFirebaseFacade.getAccessToken === 'function' &&
        typeof LegacyFirebaseFacade.getCurrentUser === 'function' &&
        typeof LegacyFirebaseFacade.uploadBackupToGoogleDrive === 'function' &&
        typeof LegacyFirebaseFacade.saveBackupToFirestore === 'function';

      record(
        'P27-01',
        'Isolated Integration Test',
        'فصل صلاحيات Google Drive عن Firebase Auth والحفاظ على التوافق البرمجي',
        !hasDriveScopeInFirebase &&
          !srcMentionsDriveScope &&
          hasRequiredDriveScopes &&
          legacyExportsPresent,
        `firebaseScopes=${providerScopes.length}, srcHasDriveScope=${srcMentionsDriveScope}, legacyExports=${legacyExportsPresent}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-02: Google Drive Independent Flow & CRUD [Automated Mock Test]
    // -----------------------------------------------------------------------
    {
      const SECRET_DRIVE_TOKEN = 'p27_mock_drive_token_only_in_memory';
      const driveApiCalls: Array<{ url: string; method: string; authHeader: string | null }> = [];
      let uploadedFileId = 'drv_file_001';

      setDriveTestOverrides({
        oauthRequester: async ({ scopes }) => {
          assert(scopes.includes('https://www.googleapis.com/auth/drive.file'));
          return {
            accessToken: SECRET_DRIVE_TOKEN,
            expiresInSec: 3600,
            grantedScopes: scopes.join(' '),
          };
        },
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method || 'GET').toUpperCase();
          const headersObj = (init?.headers || {}) as Record<string, string>;
          const authHeader = headersObj.Authorization || headersObj.authorization || null;
          driveApiCalls.push({ url, method, authHeader });

          if (url.includes('/oauth2/v3/userinfo')) {
            return new Response(
              JSON.stringify({ email: 'drive.shop@example.com', name: 'متجر الاختبار' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.includes('/drive/v3/files?q=') && url.includes('folder')) {
            return new Response(JSON.stringify({ files: [{ id: 'folder_p27', name: 'Cashier_Backups' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (url.includes('/upload/drive/v3/files')) {
            return new Response(
              JSON.stringify({
                id: uploadedFileId,
                name: 'data (autoSave) test.db',
                createdTime: '2026-04-12T12:00:00.000Z',
                size: '128',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.includes('/drive/v3/files?q=')) {
            return new Response(
              JSON.stringify({
                files: [
                  {
                    id: uploadedFileId,
                    name: 'data (autoSave) test.db',
                    createdTime: '2026-04-12T12:00:00.000Z',
                    size: '128',
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.includes(`/drive/v3/files/${uploadedFileId}?alt=media`)) {
            return new Response(new Uint8Array([83, 81, 76, 105]), { status: 200 });
          }
          if (url.includes(`/drive/v3/files/${uploadedFileId}?fields=`)) {
            return new Response(
              JSON.stringify({
                id: uploadedFileId,
                name: 'data (autoSave) test.db',
                mimeType: 'application/x-sqlite3',
                size: '4',
                parents: ['folder_p27'],
                capabilities: { canDownload: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (url.includes(`/drive/v3/files/${uploadedFileId}`) && method === 'DELETE') {
            return new Response(null, { status: 204 });
          }
          return new Response('Unexpected URL', { status: 500 });
        }) as typeof fetch,
      });

      const driveConn = await connectGoogleDrive({ prompt: 'select_account' });
      const fbDuringDrive = getFirebaseState();

      const uploadRes = await uploadBackupToGoogleDrive(
        new Uint8Array([83, 81, 76, 105]),
        'data (autoSave) test.db'
      );
      const listRes = await listGoogleDriveBackups();
      const dlBuf = await downloadBackupFromGoogleDrive(uploadedFileId);
      await deleteBackupFromGoogleDrive(uploadedFileId);

      const allAuthValid = driveApiCalls.every((c) => c.authHeader === `Bearer ${SECRET_DRIVE_TOKEN}`);

      record(
        'P27-02',
        'Automated Mock Test',
        'ربط وتشغيل Google Drive (رفع/جلب/تنزيل/حذف) بشكل مستقل عن Firebase',
        driveConn.status === 'connected' &&
          driveConn.tokenValid === true &&
          driveConn.account?.email === 'drive.shop@example.com' &&
          fbDuringDrive.status === 'disconnected' &&
          fbDuringDrive.user === null &&
          uploadRes.id === uploadedFileId &&
          listRes.length === 1 &&
          dlBuf.byteLength === 4 &&
          allAuthValid,
        `driveStatus=${driveConn.status}, fbStatus=${fbDuringDrive.status}, calls=${driveApiCalls.length}, allAuthBearerMatch=${allAuthValid}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-03: Token Isolation & Storage Safety [Isolated Integration Test]
    // -----------------------------------------------------------------------
    {
      await isolatedDb.open();
      await DB.initializeAsync(isolatedDb);

      await DB.saveSettings({
        googleDriveLinked: true,
        driveAccountEmail: 'drive.shop@example.com',
        driveLastBackupAt: new Date().toISOString(),
        firebaseLinked: true,
        firebaseAccountEmail: 'fb.shop@example.com',
        firebaseProjectId: 'cashier-p27-sandbox-test',
        permissionsGranted: true,
      });

      const allSettings = await isolatedDb.settings.toArray();
      const serializedDexie = JSON.stringify(allSettings);
      const lsDump = JSON.stringify(
        Array.from({ length: localStorage.length }, (_, i) => {
          const k = localStorage.key(i)!;
          return [k, localStorage.getItem(k)];
        })
      );

      const leaksToken =
        serializedDexie.includes('p27_mock_drive_token_only_in_memory') ||
        lsDump.includes('p27_mock_drive_token_only_in_memory') ||
        serializedDexie.includes('accessToken') ||
        serializedDexie.includes('refreshToken') ||
        lsDump.includes('accessToken') ||
        lsDump.includes('refreshToken');

      record(
        'P27-03',
        'Isolated Integration Test',
        'عدم تخزين أي Access Token أو Refresh Token في Dexie أو localStorage',
        hasValidDriveToken() === true && !leaksToken,
        `inMemoryTokenActive=${hasValidDriveToken()}, leakedToDisk=${leaksToken}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-04: Drive 401 Error Handling & Independent Disconnect [Automated Mock Test]
    // -----------------------------------------------------------------------
    {
      setDriveTestOverrides({
        fetchImpl: (async () => {
          return new Response('Unauthorized', { status: 401 });
        }) as typeof fetch,
      });

      let caught401 = false;
      try {
        await listGoogleDriveBackups();
      } catch {
        caught401 = true;
      }
      const errState = getGoogleDriveState();
      const fbStillUnaffected = getFirebaseState().status === 'disconnected';

      const disconnectedDrive = await disconnectGoogleDrive();

      record(
        'P27-04',
        'Automated Mock Test',
        'انتهاء صلاحية رمز Drive (401) وفصل Drive لا يؤثران على Firebase',
        caught401 &&
          errState.status === 'error' &&
          errState.tokenValid === false &&
          fbStillUnaffected &&
          disconnectedDrive.status === 'disconnected' &&
          disconnectedDrive.account === null,
        `caught401=${caught401}, afterErrStatus=${errState.status}, afterDisconnect=${disconnectedDrive.status}, fbStatus=${getFirebaseState().status}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-05: Firebase Test Project Sandbox Security Guards [Isolated Integration Test]
    // -----------------------------------------------------------------------
    {
      // Guard A: Refuse when no test project is configured
      await configureTestFirebaseProject(null);
      const noTestRes = await runFirestoreTestProjectDiagnostic();

      // Guard B: Refuse when test project matches production projectId
      await configureTestFirebaseProject({
        projectId: firebaseConfig.projectId,
        apiKey: 'AIzaSyFakeKeyForGuardTestOnly123456',
        authDomain: `${firebaseConfig.projectId}.firebaseapp.com`,
        appId: '1:123456:web:abcdef',
        firestoreDatabaseId: '(default)',
      });
      const prodBlockRes = await runFirestoreTestProjectDiagnostic();

      // Guard C: Valid isolated test project updates state safely
      const testConfigured = await configureTestFirebaseProject({
        projectId: 'cashier-p27-sandbox-test',
        apiKey: 'AIzaSyFakeTestProjectKeyOnly987654',
        authDomain: 'cashier-p27-sandbox-test.firebaseapp.com',
        appId: '1:999999:web:testonly',
        firestoreDatabaseId: '(default)',
      });

      record(
        'P27-05',
        'Isolated Integration Test',
        'حماية المشروع الرئيسي من اختبارات الكتابة وتفعيل مشروع اختباري معزول',
        !noTestRes.ok &&
          !noTestRes.writeOk &&
          !prodBlockRes.ok &&
          !prodBlockRes.writeOk &&
          prodBlockRes.message.includes('ممنوع') &&
          testConfigured.isTestProject === true &&
          testConfigured.projectId === 'cashier-p27-sandbox-test',
        `noTestOk=${noTestRes.ok}, prodBlockMsg="${prodBlockRes.message}", activeTarget=${testConfigured.projectId}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-06: Cross-Service Fault Isolation (Drive Connected while Firebase Fails)
    //         [Automated Mock Test + Isolated Integration Test]
    // -----------------------------------------------------------------------
    {
      // Connect Drive via mock while Firebase fails offline diagnostic
      setDriveTestOverrides({
        oauthRequester: async () => ({
          accessToken: 'p27_drive_stays_alive_token',
          expiresInSec: 3600,
        }),
        fetchImpl: (async (input: RequestInfo | URL) => {
          if (String(input).includes('/oauth2/v3/userinfo')) {
            return new Response(JSON.stringify({ email: 'resilient.drive@example.com' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      });

      await connectGoogleDrive({ prompt: '' });
      assert.strictEqual(getGoogleDriveState().status, 'connected');

      const origNav = (globalThis as any).navigator;
      Object.defineProperty(globalThis, 'navigator', {
        value: { ...(origNav || {}), onLine: false },
        configurable: true,
      });

      let diagOffline;
      try {
        diagOffline = await diagnoseFirestoreConnection();
      } finally {
        if (origNav !== undefined) {
          Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true });
        }
      }

      const driveAfterFirebaseErr = getGoogleDriveState();
      const fbAfterErr = getFirebaseState();

      await disconnectFirebase();
      const driveAfterFirebaseDisconnect = getGoogleDriveState();

      record(
        'P27-06',
        'Automated Mock Test',
        'فشل أو فصل Firebase لا يعطل Google Drive المتصل والعكس صحيح',
        diagOffline.ok === false &&
          diagOffline.status === 'offline' &&
          fbAfterErr.status === 'error' &&
          driveAfterFirebaseErr.status === 'connected' &&
          driveAfterFirebaseDisconnect.status === 'connected' &&
          hasValidDriveToken() === true,
        `fbDiag=${diagOffline.status}, fbStatus=${fbAfterErr.status}, driveAfterFbErr=${driveAfterFirebaseErr.status}, driveAfterFbDisconnect=${driveAfterFirebaseDisconnect.status}`
      );
    }

    // -----------------------------------------------------------------------
    // P27-07: Non-Destructive Disconnect & Local POS Continuity [Isolated Integration Test]
    // -----------------------------------------------------------------------
    {
      const prod = await DB.saveProduct({
        name: 'منتج مستمر بدون إنترنت',
        barcode: '270001',
        category: 'عام',
        buy_price: 5000,
        sell_price: 8000,
        qty: 10,
      });

      const invBefore = await DB.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id, name: prod.name, qty: 2, price: 8000, cost: 5000 }],
        discount: 0,
        paid: 16000,
      });

      // Disconnect Drive metadata first -> Firebase link remains intact
      await DB.clearGoogleDriveLink();
      const settingsMid = DB.getSettings();
      assert.strictEqual(settingsMid.googleDriveLinked, false);
      assert.strictEqual(settingsMid.firebaseLinked, true);

      // Disconnect Firebase metadata & legacy helper -> permissionsGranted stays true!
      await DB.clearFirebaseLink();
      await DB.clearGoogleAccount();
      const settingsAfter = DB.getSettings();

      // Local POS must keep working seamlessly with both cloud services disconnected
      const invAfter = await DB.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id, name: prod.name, qty: 1, price: 8000, cost: 5000 }],
        discount: 0,
        paid: 8000,
      });

      const finalProd = DB.getProductById(prod.id);
      const totalInvoices = DB.getInvoices('sale').length;

      record(
        'P27-07',
        'Isolated Integration Test',
        'فصل الحسابات غير مدمر: بقاء بيانات المحل وصلاحيات الإذن المحلية وعمل POS بلا إنترنت',
        settingsMid.firebaseLinked === true &&
          settingsAfter.googleDriveLinked === false &&
          settingsAfter.firebaseLinked === false &&
          settingsAfter.permissionsGranted === true &&
          invBefore.total === 16000 &&
          invAfter.total === 8000 &&
          finalProd?.qty === 7 &&
          totalInvoices === 2,
        `permissionsGranted=${settingsAfter.permissionsGranted}, prodQty=${finalProd?.qty} (متوقع 7), saleInvoices=${totalInvoices}`
      );
    }

    console.log('\n==================================================================');
    console.log(`✅ اكتملت اختبارات المرحلة 27 بنجاح (${results.length}/${results.length})`);
    console.log('   - ملاحظة: جميع اختبارات الشبكة هنا محاكاة/معزولة؛ لم يُنفَّذ اتصال حي فعلي.');
    console.log('==================================================================');
  } finally {
    clearDriveToken();
    setDriveTestOverrides(null);
    await configureTestFirebaseProject(null).catch(() => {});
    storageCacheAdapter.dispose();
    try {
      await isolatedDb.close();
      await isolatedDb.delete();
    } catch {
      // ignore
    }
    await terminate(firestore).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n❌ فشل تشغيل حزمة التحقق Phase 27:', err);
  process.exitCode = 1;
});
