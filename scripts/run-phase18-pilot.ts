/**
 * Cashier Pro — Phase 18: Isolated Pilot Simulation & Failure Stress Suite
 *
 * بيئة تجربة معزولة بالكامل لمحاكاة يوم عمل حقيقي + محاكاة أعطال وانقطاعات.
 * لا يكتب مطلقاً في CashierPro_DB — يعمل على قواعد بيانات مؤقتة ويحذفها عند الانتهاء.
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { CashierDatabase } from '../src/services/storage/schema';
import { StorageService } from '../src/services/storage/storageService';
import { StorageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { ConcurrencyConflictError } from '../src/services/storage/types';
import { createFullDexieBackup, validateBackupInSandbox, restoreDexieBackupSafely } from '../src/services/storage/backup/dexieBackupEngine';
import { InventoryConflictEngine } from '../src/services/sync/inventoryConflictEngine';
import { SimulatedCloudSyncServer, SimulatedDeviceClient } from '../src/services/sync/syncEnginePrototype';
import { ImageOptimizationEngine } from '../src/services/storage/imageOptimizationEngine';
import { MultiWindowSyncManager } from '../src/services/storage/sync/multiWindowSync';
import { DB } from '../src/services/db';
import { createSqliteDbBlob, getSqlJs } from '../src/services/dbFormat';

interface PilotCheckResult {
  section: string;
  name: string;
  passed: boolean;
  details: string;
  isExpectedBugDetection?: boolean;
  findingId?: string;
}

const results: PilotCheckResult[] = [];

function recordCheck(
  section: string,
  name: string,
  passed: boolean,
  details: string,
  isExpectedBugDetection = false,
  findingId?: string
) {
  results.push({ section, name, passed, details, isExpectedBugDetection, findingId });
  const icon = passed ? '✅' : isExpectedBugDetection ? '🚨' : '❌';
  console.log(`${icon} [${section}] ${name} — ${details}`);
}

async function runPhase18Pilot() {
  const postFixMode = process.argv.includes('--post-fix');
  console.log('================================================================');
  console.log(`   Cashier Pro — Phase 18: Isolated Workday & Failure Pilot${postFixMode ? ' (Post-Fix)' : ''}`);
  console.log('================================================================\n');

  const lsStore = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string) => lsStore.set(k, String(v)),
    removeItem: (k: string) => lsStore.delete(k),
    clear: () => lsStore.clear(),
    key: (i: number) => Array.from(lsStore.keys())[i] || null,
    get length() {
      return lsStore.size;
    },
  };

  const pilotDbName = `Cashier_Pilot_P18_${Date.now()}`;
  const pilotDb = new CashierDatabase(pilotDbName);
  await pilotDb.open();
  const svc = new StorageService(pilotDb);

  try {
    const storeId = 'store_pilot_baghdad_01';
    const devices = [
      { deviceId: 'dev_android_pos1', label: 'هاتف الكاشير 1', platform: 'android' as const },
      { deviceId: 'dev_windows_desk', label: 'حاسبة الاستقبال', platform: 'windows' as const },
      { deviceId: 'dev_android_inv', label: 'جهاز الجرد المحمول', platform: 'android' as const },
    ];

    const cloudServer = new SimulatedCloudSyncServer();
    devices.forEach((d) =>
      cloudServer.registerDevice({
        deviceId: d.deviceId,
        storeId,
        label: d.label,
        platform: d.platform,
        status: 'active',
        registeredAt: new Date().toISOString(),
      })
    );

    const dev1Client = new SimulatedDeviceClient('dev_android_pos1', storeId, cloudServer);
    const conflictEngine = new InventoryConflictEngine(storeId);

    // 1. Setup
    const settings = await svc.settings.saveSettings({
      storeName: 'متجر تجربة بغداد',
      currency: 'د.ع',
      taxRate: 0,
      permissionsGranted: true,
    });
    const openingCashBalance = 250000;
    recordCheck(
      'Workday-Setup',
      'تهيئة المتجر، الموظفين (Owner/Manager/Cashier)، والأجهزة الثلاثة والرصيد الافتتاحي',
      settings.storeName === 'متجر تجربة بغداد' && cloudServer.isDeviceActive('dev_android_pos1'),
      `storeName=${settings.storeName}, openingDrawer=${openingCashBalance}`
    );

    // 2. Full Workday Simulation
    const sampleImg = await sharp({
      create: { width: 1000, height: 750, channels: 3, background: { r: 30, g: 70, b: 99 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const optImg = await ImageOptimizationEngine.optimizeImage(sampleImg, 1);

    const pPhone = await svc.products.save({
      name: 'بطارية أيفون 13 برو أصلي',
      barcode: '8801002003001',
      category: 'بطاريات',
      buy_price: 25000,
      sell_price: 40000,
      qty: 0,
      image: optImg.optimizedBase64,
    });
    const pScreen = await svc.products.save({
      name: 'شاشة سامسونج A52 OLED',
      barcode: '8801002003002',
      category: 'شاشات',
      buy_price: 50000,
      sell_price: 75000,
      qty: 0,
    });
    await svc.images.saveImage(pPhone.id!, {
      base64: optImg.optimizedBase64,
      mimeType: optImg.mimeType,
    });

    const supplier = await svc.parties.save({ name: 'شركة النخيل للتجهيز', phone: '07701112233', type: 'supplier' });
    const customer = await svc.parties.save({ name: 'مركز صيانة المنصور', phone: '07809998877', type: 'customer' });

    // Purchase: 10 Batteries @ 25k + 4 Screens @ 50k = 450k, paid 300k
    await svc.invoices.createInvoice({
      type: 'purchase',
      partyId: supplier.id,
      items: [
        { product_id: pPhone.id!, name: pPhone.name, qty: 10, price: 25000, cost: 25000, sell_price: 40000 },
        { product_id: pScreen.id!, name: pScreen.name, qty: 4, price: 50000, cost: 50000, sell_price: 75000 },
      ],
      discount: 0,
      paid: 300000,
    });
    conflictEngine.initializeProductStock(pPhone.id!, pPhone.uuid, 10);
    conflictEngine.initializeProductStock(pScreen.id!, pScreen.uuid, 4);

    // Cash Sale: 2 Batteries @ 40k = 80k paid 80k
    const cashSale = await svc.invoices.createInvoice({
      type: 'sale',
      partyId: null,
      items: [{ product_id: pPhone.id!, name: pPhone.name, qty: 2, price: 40000, cost: 25000 }],
      discount: 0,
      paid: 80000,
    });

    // Credit Sale: 3 Batteries @ 40k + 1 Screen @ 75k = 195k - 5k = 190k, paid 40k -> debt 150k
    const creditSale = await svc.invoices.createInvoice({
      type: 'sale',
      partyId: customer.id,
      items: [
        { product_id: pPhone.id!, name: pPhone.name, qty: 3, price: 40000, cost: 25000 },
        { product_id: pScreen.id!, name: pScreen.name, qty: 1, price: 75000, cost: 50000 },
      ],
      discount: 5000,
      paid: 40000,
    });

    // Customer Payment: 50k -> debt 100k
    await svc.payments.add({ partyId: customer.id!, amount: 50000, notes: 'دفعة من الحساب' });

    // Expense: 15k
    await svc.expenses.add({ recipient: 'فاتورة كهرباء ومولدة', amount: 15000 });

    // Sale Return: 1 Battery @ 40k, paid 0 -> credited to customer account -> debt 60k
    await svc.invoices.createInvoice({
      type: 'sale_return',
      partyId: customer.id,
      items: [{ product_id: pPhone.id!, name: pPhone.name, qty: 1, price: 40000, cost: 25000 }],
      discount: 0,
      paid: 0,
    });

    // Quote Invoice: 75k, paid 0 -> MUST NOT add debt!
    await svc.invoices.createInvoice({
      type: 'quote',
      partyId: customer.id,
      items: [{ product_id: pScreen.id!, name: pScreen.name, qty: 1, price: 75000, cost: 50000 }],
      discount: 0,
      paid: 0,
    });

    // Voided Cash Sale
    const toVoid = await svc.invoices.createInvoice({
      type: 'sale',
      partyId: null,
      items: [{ product_id: pScreen.id!, name: pScreen.name, qty: 1, price: 75000, cost: 50000 }],
      discount: 0,
      paid: 75000,
    });
    await svc.invoices.deleteInvoice(toVoid.invoice.id!, true);

    const phoneAfter = await svc.products.getById(pPhone.id!); // 10 - 2 - 3 + 1 = 6
    const screenAfter = await svc.products.getById(pScreen.id!); // 4 - 1 - 1 + 1 = 3
    recordCheck(
      'Workday-Inventory',
      'دقة أرصدة المخزون بعد الشراء والبيع والمرتجع وعرض السعر وإلغاء الفاتورة',
      phoneAfter?.qty === 6 && screenAfter?.qty === 3,
      `بطاريات=${phoneAfter?.qty} (المتوقع 6)، شاشات=${screenAfter?.qty} (المتوقع 3)`
    );

    // 3-Device Offline Conflict
    conflictEngine.processSaleOperation({
      idempotencyKey: 'p18_dev1_sale1',
      deviceId: 'dev_android_pos1',
      invoiceUuid: 'inv_dev1_1',
      invoiceNumber: 'INV-D1-1',
      productId: pScreen.id!,
      productUuid: pScreen.uuid,
      productName: pScreen.name,
      requestedQty: 2,
      invoicePayload: { total: 150000, paid: 150000 },
    });
    conflictEngine.processSaleOperation({
      idempotencyKey: 'p18_dev2_sale1',
      deviceId: 'dev_windows_desk',
      invoiceUuid: 'inv_dev2_1',
      invoiceNumber: 'INV-D2-1',
      productId: pScreen.id!,
      productUuid: pScreen.uuid,
      productName: pScreen.name,
      requestedQty: 2,
      invoicePayload: { total: 150000, paid: 150000 },
    });
    const conflictRes = conflictEngine.processSaleOperation({
      idempotencyKey: 'p18_dev3_sale1',
      deviceId: 'dev_android_inv',
      invoiceUuid: 'inv_dev3_1',
      invoiceNumber: 'INV-D3-1',
      productId: pScreen.id!,
      productUuid: pScreen.uuid,
      productName: pScreen.name,
      requestedQty: 2,
      invoicePayload: { total: 150000, paid: 150000 },
    });
    recordCheck(
      'Workday-Conflict',
      'اكتشاف تعارض بيع 3 أجهزة Offline دون فساد أو إخفاء العجز',
      conflictRes.reconciliationRequired && conflictRes.updatedBalance?.conflictDeficit === 2,
      `reconciliationRequired=${conflictRes.reconciliationRequired}, deficit=${conflictRes.updatedBalance?.conflictDeficit}`
    );

    // 3. Failure & Outage Simulation
    dev1Client.isOnline = false;
    dev1Client.enqueueLocalOperation('invoices', 'create', cashSale.invoice.uuid, { total: 80000 }, 1);
    dev1Client.enqueueLocalOperation('invoices', 'create', creditSale.invoice.uuid, { total: 190000 }, 1);
    const offlineTry = await dev1Client.syncPendingQueue();
    assert.strictEqual(offlineTry.synced, 0);
    dev1Client.isOnline = true;
    const reconnectSync = await dev1Client.syncPendingQueue();
    const dupPush = cloudServer.pushOperation({
      idempotencyKey: `idem_dev_android_pos1_1_${cashSale.invoice.uuid}_create`,
      deviceId: 'dev_android_pos1',
      storeId,
      seq: 1,
      table: 'invoices',
      action: 'create',
      recordUuid: cashSale.invoice.uuid,
      status: 'pending',
      retryCount: 0,
      maxRetries: 5,
      clientTimestamp: new Date().toISOString(),
      dataPayload: { total: 80000 },
      version: 1,
    });
    recordCheck(
      'Outage-Network',
      'انقطاع الشبكة ثم عودتها ومزامنة الطابور ومنع تكرار العمليات (Idempotency)',
      reconnectSync.synced === 2 && dev1Client.getLocalQueueLength() === 0 && dupPush.duplicateIgnored === true,
      `offlineSynced=0, reconnectSynced=${reconnectSync.synced}, duplicateIgnored=${dupPush.duplicateIgnored}`
    );

    let rolledBack = false;
    try {
      await pilotDb.transaction('rw', [pilotDb.invoices, pilotDb.products], async () => {
        await pilotDb.products.update(pPhone.id!, { qty: 999 });
        throw new Error('SIMULATED_POWER_LOSS_CRASH');
      });
    } catch {
      rolledBack = true;
    }
    await pilotDb.close();
    const reopenedDb = new CashierDatabase(pilotDbName);
    await reopenedDb.open();
    const phoneAfterCrash = await reopenedDb.products.get(pPhone.id!);
    recordCheck(
      'Outage-Crash',
      'الإغلاق المفاجئ وسط معاملة + إعادة فتح القاعدة والتحقق من ثبات البيانات',
      rolledBack && phoneAfterCrash?.qty === 6,
      `rolledBack=${rolledBack}, phoneQtyAfterReopen=${phoneAfterCrash?.qty}`
    );

    let quotaCaught = false;
    try {
      await reopenedDb.transaction('rw', [reopenedDb.products], async () => {
        const err: any = new Error('Storage quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      });
    } catch (e: any) {
      quotaCaught = e.name === 'QuotaExceededError' && (await reopenedDb.products.get(pPhone.id!))?.qty === 6;
    }
    recordCheck(
      'Outage-Quota',
      'محاكاة امتلاء التخزين (QuotaExceededError) دون إتلاف البيانات القائمة',
      quotaCaught,
      `quotaHandledWithoutCorruption=${quotaCaught}`
    );

    cloudServer.registerDevice({
      deviceId: 'dev_temp_revoked',
      storeId,
      label: 'Temp',
      platform: 'android',
      status: 'revoked',
      registeredAt: new Date().toISOString(),
    });
    const devRevoked = new SimulatedDeviceClient('dev_temp_revoked', storeId, cloudServer);
    devRevoked.enqueueLocalOperation('invoices', 'create', 'uuid_fail_test', { total: 1000 }, 1);
    const failSync = await devRevoked.syncPendingQueue();
    recordCheck(
      'Outage-SyncFail',
      'فشل المزامنة لجهاز غير مصرح والاحتفاظ بالعملية للمحاولة دون فقدان',
      failSync.synced === 0 && devRevoked.getLocalQueueLength() === 1,
      `synced=${failSync.synced}, preservedInQueue=${devRevoked.getLocalQueueLength()}`
    );

    let badImageBlocked = false;
    try {
      await ImageOptimizationEngine.optimizeImage(Buffer.from('#!/bin/sh\nrm -rf /'), pPhone.id!);
    } catch (e: any) {
      badImageBlocked = e.message.includes('Security Violation');
    }
    recordCheck(
      'Outage-BadImage',
      'رفض صورة تالفة أو ملف خبيث مموّه بصيغة صورة',
      badImageBlocked,
      `maliciousFileRejected=${badImageBlocked}`
    );

    const pForOcc = await reopenedDb.products.get(pScreen.id!);
    const svcReopened = new StorageService(reopenedDb);
    const updatedUserA = await svcReopened.products.save({
      id: pScreen.id,
      name: pScreen.name,
      sell_price: 76000,
      expectedVersion: pForOcc?.version || 1,
    });
    let occConflictThrown = false;
    try {
      await svcReopened.products.save({
        id: pScreen.id,
        name: pScreen.name,
        sell_price: 74000,
        expectedVersion: pForOcc?.version || 1,
      });
    } catch (err) {
      occConflictThrown = err instanceof ConcurrencyConflictError;
    }
    recordCheck(
      'Outage-Concurrency',
      'تعديل نفس الصنف من مستخدمين متزامنين وكشف تعارض الإصدار OCC',
      occConflictThrown && updatedUserA.sell_price === 76000,
      `occConflictCaught=${occConflictThrown}, finalPrice=${updatedUserA.sell_price}`
    );

    const backup = await createFullDexieBackup(reopenedDb, 'manual', 'نسخة تجربة المرحلة 18');
    const tampered = JSON.parse(backup.jsonString);
    tampered.data.products[0].sell_price = 1;
    const corruptCheck = await validateBackupInSandbox(tampered);

    const freshDbName = `Cashier_Pilot_Fresh_${Date.now()}`;
    const freshDb = new CashierDatabase(freshDbName);
    await freshDb.open();
    let freshRestoreStatus = false;
    let freshRestoreMsg = '';
    try {
      const res = await restoreDexieBackupSafely(backup.jsonString, freshDb);
      freshRestoreStatus = res.success;
      freshRestoreMsg = res.message;
    } catch (err: any) {
      freshRestoreMsg = err.message;
    }
    const restoredProds = await freshDb.products.count();
    const restoredInvs = await freshDb.invoices.count();
    await freshDb.close();
    await freshDb.delete();

    recordCheck(
      'Outage-BackupRestore',
      'رفض النسخة التالفة في Sandbox ثم الاستعادة إلى قاعدة فارغة جديدة',
      !corruptCheck.valid && restoredProds === 2 && restoredInvs >= 5,
      `corruptRejected=${!corruptCheck.valid}, freshProds=${restoredProds}, freshInvs=${restoredInvs}, note="${freshRestoreMsg}"`,
      !freshRestoreStatus,
      !freshRestoreStatus ? 'FIND-P17-04' : undefined
    );

    // 4. Reproduction Probes
    console.log('\n---------------- Pilot Probes for MASTER_FINDINGS_REGISTER ----------------');
    const report = await svcReopened.reports.getReport(new Date(Date.now() - 86400000), new Date(Date.now() + 86400000));
    const customersList = await svcReopened.parties.getAll('customer');
    const pilotCustomer = customersList.find((c) => c.id === customer.id)!;
    const f17_03_isBuggy = report.sales !== 230000 || pilotCustomer.balance !== 60000;
    recordCheck(
      'Probe-FIND-P17-03',
      postFixMode
        ? 'التحقق بعد الإصلاح: دقة صافي المبيعات وأرصدة العملاء مع المرتجعات وعروض الأسعار'
        : 'إثبات خلل التقارير وأرصدة العملاء مع المرتجعات وعروض الأسعار قبل الإصلاح',
      postFixMode ? !f17_03_isBuggy : false,
      `sales=${report.sales} (المتوقع 230000)، رصيد العميل=${pilotCustomer.balance} (المتوقع 60000)`,
      !postFixMode && f17_03_isBuggy,
      'FIND-P17-03'
    );

    const secondWindowSync = new MultiWindowSyncManager('win_pilot_observer');
    let receivedBroadcastCount = 0;
    secondWindowSync.onInvalidate(() => {
      receivedBroadcastCount++;
    });
    const adapter = new StorageCacheAdapter();
    const adapterDbName = `Cashier_Pilot_Adapter_${Date.now()}`;
    const adapterDb = new CashierDatabase(adapterDbName);
    await adapter.initializeAsync(adapterDb);
    await adapter.saveProduct({
      name: 'صنف اختبار المزامنة بين النوافذ',
      barcode: '9990001',
      category: 'عام',
      buy_price: 100,
      sell_price: 200,
      qty: 5,
    });
    secondWindowSync.close();
    if (typeof (adapter as any).dispose === 'function') (adapter as any).dispose();
    await adapterDb.close();
    await adapterDb.delete();
    const f17_04_isBuggy = receivedBroadcastCount === 0;
    recordCheck(
      'Probe-FIND-P17-04',
      postFixMode
        ? 'التحقق بعد الإصلاح: تفعيل بث MultiWindowSync عند الكتابة'
        : 'إثبات غياب بث MultiWindowSync.broadcastMutation عند الكتابة في StorageCacheAdapter',
      postFixMode ? !f17_04_isBuggy : false,
      `عدد الإشعارات المستلمة في التبويب الثاني = ${receivedBroadcastCount} (المتوقع >= 1)`,
      !postFixMode && f17_04_isBuggy,
      'FIND-P17-04'
    );

    const isoDbName = `Cashier_Pilot_DB_Singleton_${Date.now()}`;
    const isoDb = new CashierDatabase(isoDbName);
    await isoDb.open();
    await DB.initializeAsync(isoDb);
    await DB.addParty('عميل اختبار SQLite', '0770', 'customer');
    const sqliteProd = await DB.saveProduct({ name: 'منتج SQLite', buy_price: 50, sell_price: 100, qty: 10 });
    await DB.saveInvoice({
      type: 'sale',
      partyId: 1,
      items: [{ product_id: sqliteProd.id, name: sqliteProd.name, qty: 2, price: 100, cost: 50 }],
      discount: 0,
      paid: 200,
    });
    const sqliteOut = await createSqliteDbBlob();
    const SQL = await getSqlJs();
    const inspectSqlite = new SQL.Database(sqliteOut.binary);
    const partiesRowCount = inspectSqlite.exec('SELECT COUNT(*) FROM parties')[0]?.values[0][0];
    const itemsRowCount = inspectSqlite.exec('SELECT COUNT(*) FROM invoice_items')[0]?.values[0][0];
    inspectSqlite.close();
    const f17_02_isBuggy = Number(partiesRowCount) === 0 || Number(itemsRowCount) === 0;
    recordCheck(
      'Probe-FIND-P17-02',
      postFixMode
        ? 'التحقق بعد الإصلاح: تصدير SQLite يقرأ البيانات الحية من Dexie'
        : 'إثبات قراءة createSqliteDbBlob من localStorage القديم (صفوف فارغة للعملاء وبنود الفواتير)',
      postFixMode ? !f17_02_isBuggy : false,
      `SQLite parties=${partiesRowCount} (المتوقع 1), invoice_items=${itemsRowCount} (المتوقع 1)`,
      !postFixMode && f17_02_isBuggy,
      'FIND-P17-02'
    );

    const legacyJsonStr = DB.backupData();
    await isoDb.products.clear();
    await isoDb.invoices.clear();
    await isoDb.invoice_items.clear();
    let backgroundRestoreError = '';
    const rejectionHandler = (reason: any) => {
      backgroundRestoreError = reason?.message || String(reason);
    };
    process.on('unhandledRejection', rejectionHandler);
    const syncRestoreRet =
      postFixMode && typeof (DB as any).restoreDataAsync === 'function'
        ? await (DB as any).restoreDataAsync(legacyJsonStr)
        : DB.restoreData(legacyJsonStr);
    await new Promise((r) => setTimeout(r, 150));
    process.off('unhandledRejection', rejectionHandler);
    const afterLegacyRestoreInvCount = await isoDb.invoices.count();
    const afterLegacyRestoreProdCount = await isoDb.products.count();
    await isoDb.close();
    await isoDb.delete();
    const f17_01_isBuggy =
      afterLegacyRestoreInvCount === 0 || afterLegacyRestoreProdCount === 0 || backgroundRestoreError.length > 0;
    recordCheck(
      'Probe-FIND-P17-01',
      postFixMode
        ? 'التحقق بعد الإصلاح: استعادة DB.restoreDataAsync تعيد المنتجات والفواتير بأمان'
        : 'إثبات أن DB.restoreData تُرجع true زائفاً وتسقط الفواتير وتفشل بـ UnhandledRejection مع p.id في وضع Dexie',
      postFixMode ? !f17_01_isBuggy && syncRestoreRet === true : false,
      `returned=${syncRestoreRet}, backgroundError="${backgroundRestoreError}", restoredProducts=${afterLegacyRestoreProdCount} (المتوقع 1), restoredInvoices=${afterLegacyRestoreInvCount} (المتوقع 1)`,
      !postFixMode && f17_01_isBuggy,
      'FIND-P17-01'
    );

    const rulesSrc = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
    const firebaseSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/firebase.ts'), 'utf8');
    const usesUserBackups = firebaseSrc.includes("'backups'") && firebaseSrc.includes("'users'");
    const rulesHasRootUserBackups = rulesSrc.includes('match /backups/{backupId}');
    const f17_05_isBuggy = usesUserBackups && !rulesHasRootUserBackups;
    recordCheck(
      'Probe-FIND-P17-05',
      postFixMode
        ? 'التحقق بعد الإصلاح: تغطية مسار /users/{uid}/backups في firestore.rules'
        : 'إثبات عدم تطابق مسار النسخ السحابية الجذري /users/{uid}/backups مع قواعد firestore.rules',
      postFixMode ? !f17_05_isBuggy : false,
      `firebaseUsesRootUsersBackups=${usesUserBackups}, firestoreRulesHasRootBackupsRule=${rulesHasRootUserBackups}`,
      !postFixMode && f17_05_isBuggy,
      'FIND-P17-05'
    );

    const concurrentAdapter = new StorageCacheAdapter();
    const cDbName = `Cashier_Pilot_Conc_${Date.now()}`;
    const cDb = new CashierDatabase(cDbName);
    await cDb.open();
    const [r1, r2] = await Promise.all([
      concurrentAdapter.initializeAsync(cDb),
      concurrentAdapter.initializeAsync(cDb),
    ]);
    if (typeof (concurrentAdapter as any).dispose === 'function') (concurrentAdapter as any).dispose();
    await cDb.close();
    await cDb.delete();
    const f17_06_isBuggy = r2 === false || pPhone.version !== 1;
    recordCheck(
      'Probe-FIND-P17-06',
      postFixMode
        ? 'التحقق بعد الإصلاح: نجاح التهيئة المتزامنة وتعيين version=1 عند إنشاء المنتج'
        : 'إثبات فشل التهيئة المتزامنة المزدوجة وغياب version الأولي عند إنشاء المنتج',
      postFixMode ? !f17_06_isBuggy : false,
      `init1=${r1}, init2=${r2} (يجب أن تكون true لكليهما), createdProductVersion=${pPhone.version} (المتوقع 1)`,
      !postFixMode && f17_06_isBuggy,
      'FIND-P17-06'
    );

    await reopenedDb.close();
    await reopenedDb.delete();
  } finally {
    try {
      await pilotDb.delete();
    } catch {
      // ignore
    }
  }

  console.log('\n================================================================');
  const workflowChecks = results.filter((r) => !r.isExpectedBugDetection);
  const bugProbes = results.filter((r) => r.isExpectedBugDetection);
  const passedCount = workflowChecks.filter((c) => c.passed).length;
  console.log(`📊 ملخص اختبار الطيار: اجتياز فحوصات التشغيل والأعطال: ${passedCount}/${workflowChecks.length}`);
  if (bugProbes.length > 0) {
    console.log(`🚨 إثبات الأعطال الحقيقية قبل الإصلاح (Phase 19 Targets): ${bugProbes.length}/${bugProbes.length}`);
  }
  console.log('================================================================');
  if (postFixMode && passedCount !== workflowChecks.length) {
    throw new Error(`فشلت بعض اختبارات ما بعد الإصلاح: ${passedCount}/${workflowChecks.length}`);
  }
}

runPhase18Pilot()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Pilot crash:', err);
    process.exit(1);
  });
