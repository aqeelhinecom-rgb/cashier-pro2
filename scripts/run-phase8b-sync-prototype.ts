import { SimulatedCloudSyncServer, SimulatedDeviceClient } from '../src/services/sync/syncEnginePrototype';
import { generateUUID } from '../src/services/storage/uuid';

async function main() {
  console.log('================================================================');
  console.log('   Cashier Pro — Phase 8B: Isolated Cloud Sync Prototype');
  console.log('   محاكاة المزامنة السحابية وتعدد الأجهزة وحل التعارضات');
  console.log('================================================================\n');

  const server = new SimulatedCloudSyncServer();
  const storeId = 'store_synthetic_8b_test';

  // 1. Authorize Device A and Device B
  const deviceAId = 'dev_tablet_cashier_01';
  const deviceBId = 'dev_phone_manager_02';

  server.registerDevice({
    deviceId: deviceAId,
    storeId,
    label: 'جهاز التابلت كاشير 1',
    platform: 'android',
    status: 'active',
    registeredAt: new Date().toISOString(),
  });

  server.registerDevice({
    deviceId: deviceBId,
    storeId,
    label: 'هاتف المدير المسؤول',
    platform: 'android',
    status: 'active',
    registeredAt: new Date().toISOString(),
  });

  const clientA = new SimulatedDeviceClient(deviceAId, storeId, server);
  const clientB = new SimulatedDeviceClient(deviceBId, storeId, server);

  const checks: { title: string; passed: boolean; details: string }[] = [];

  // =========================================================================
  // Test 1: Sync Products, Parties, Invoices, Items, Payments, Expenses
  // =========================================================================
  const productUuid1 = `prod_${generateUUID().substring(0, 8)}`;
  clientA.enqueueLocalOperation('products', 'create', productUuid1, {
    name: 'شاشة حماية 11 Pro',
    buy_price: 2000,
    sell_price: 3500,
    qty: 50,
  }, 1);

  const partyUuid1 = `party_${generateUUID().substring(0, 8)}`;
  clientA.enqueueLocalOperation('parties', 'create', partyUuid1, {
    name: 'الزبون علي هادي',
    phone: '0770112233',
    balance: 0,
  }, 1);

  const invoiceUuid1 = `inv_${generateUUID().substring(0, 8)}`;
  clientA.enqueueLocalOperation('invoices', 'create', invoiceUuid1, {
    invoice_number: 'INV-A-001',
    type: 'sale',
    total: 3500,
    paid: 3500,
  }, 1);

  const paymentUuid1 = `pay_${generateUUID().substring(0, 8)}`;
  clientA.enqueueLocalOperation('payments', 'create', paymentUuid1, {
    amount: 3500,
    date: new Date().toISOString(),
  }, 1);

  const expenseUuid1 = `exp_${generateUUID().substring(0, 8)}`;
  clientA.enqueueLocalOperation('expenses', 'create', expenseUuid1, {
    recipient: 'صيانة دورية',
    amount: 500,
  }, 1);

  const syncRes1 = await clientA.syncPendingQueue();
  const allSynced1 = syncRes1.synced === 5 && syncRes1.failed === 0 && clientA.getLocalQueueLength() === 0;

  checks.push({
    title: '1. مزامنة المنتجات والجهات والفواتير والمدفوعات والمصروفات',
    passed: allSynced1,
    details: `تمت مزامنة 5 عمليات مختلفة بنجاح وتفريغ طابور الجهاز A (مزامنة المنتجات، العملاء، الفواتير، الدفعات، المصروفات).`,
  });

  // =========================================================================
  // Test 2: Offline Disconnect, Queue Accumulation, and Reconnection
  // =========================================================================
  clientA.isOnline = false; // Disconnect internet
  clientA.enqueueLocalOperation('invoices', 'create', `inv_offline_${generateUUID().substring(0, 6)}`, {
    invoice_number: 'INV-A-OFFLINE-001',
    total: 7000,
  }, 1);
  clientA.enqueueLocalOperation('invoices', 'create', `inv_offline_${generateUUID().substring(0, 6)}`, {
    invoice_number: 'INV-A-OFFLINE-002',
    total: 10500,
  }, 1);

  const offlineTry = await clientA.syncPendingQueue();
  const offlineQueued = offlineTry.synced === 0 && clientA.getLocalQueueLength() === 2;

  // Reconnect internet
  clientA.isOnline = true;
  const onlineDrain = await clientA.syncPendingQueue();
  const reconnectedAndDrained = onlineDrain.synced === 2 && clientA.getLocalQueueLength() === 0;

  checks.push({
    title: '2. اختبار انقطاع الإنترنت (Offline) وتراكم العمليات ثم إعادة المزامنة عند الاتصال',
    passed: offlineQueued && reconnectedAndDrained,
    details: `تم حفظ عمليتي بيع في الطابور المحلي أثناء انقطاع الشبكة، وتم تفريغ الطابور ومزامنة العمليتين فور عودة الاتصال بنجاح.`,
  });

  // =========================================================================
  // Test 3: Idempotency & Duplicate Operation Guard
  // =========================================================================
  // Enqueue an identical operation twice (simulating mobile network retry with same idempotency key)
  const dupOp = clientA.enqueueLocalOperation('products', 'update', productUuid1, { qty: 45 }, 2);
  const firstPush = await clientA.syncPendingQueue();

  // Force re-push of same op with same idempotencyKey
  const duplicateOutcome = server.pushOperation(dupOp);
  const duplicateIgnored = duplicateOutcome.success && duplicateOutcome.duplicateIgnored === true;

  checks.push({
    title: '3. اختبار Idempotency وحظر تكرار العمليات عند إعادة إرسال الحزم من الشبكة',
    passed: duplicateIgnored,
    details: `تم اكتشاف تكرار العملية (${dupOp.idempotencyKey}) وتجاهلها بأمان دون تكرار أي قيد في قاعدة البيانات.`,
  });

  // =========================================================================
  // Test 4: Concurrent Modifications on Same Product & Conflict Resolution (OCC)
  // =========================================================================
  // Device A modifies product price to 3800 (version 3)
  clientA.enqueueLocalOperation('products', 'update', productUuid1, { sell_price: 3800 }, 3);
  await clientA.syncPendingQueue();

  // Device B concurrently modified product price based on older version 2
  clientB.enqueueLocalOperation('products', 'update', productUuid1, { sell_price: 4000, name: 'شاشة حماية 11 Pro Max' }, 2);
  const syncB = await clientB.syncPendingQueue();

  const conflictsRecorded = server.getConflicts();
  const conflictResolved = conflictsRecorded.length > 0;
  const finalDoc = server.getDoc('products', productUuid1);

  checks.push({
    title: '4. اختبار تعديل المنتج والمخزون بالتزامن من جهازين مختلفين وحل التعارض (OCC Conflict Resolution)',
    passed: conflictResolved && finalDoc !== undefined && finalDoc.version >= 4,
    details: `تم رصد التعارض بدقة عند إرسال الجهاز B تعديلاً مبنياً على إصدار قديم، وتم دمج الحقول وتسجيل النزاع في سجل التعارضات (Conflict Record: ${conflictsRecorded[0]?.id}) مع رفع الإصدار إلى ${finalDoc?.version}.`,
  });

  // =========================================================================
  // Test 5: Concurrent Invoice Creation from Device A & Device B
  // =========================================================================
  const invA = `inv_concurrent_a_${generateUUID().substring(0, 6)}`;
  const invB = `inv_concurrent_b_${generateUUID().substring(0, 6)}`;

  clientA.enqueueLocalOperation('invoices', 'create', invA, { invoice_number: 'INV-A-101', total: 15000 }, 1);
  clientB.enqueueLocalOperation('invoices', 'create', invB, { invoice_number: 'INV-B-101', total: 20000 }, 1);

  const [resA, resB] = await Promise.all([clientA.syncPendingQueue(), clientB.syncPendingQueue()]);
  const bothInvoicesSynced = resA.synced === 1 && resB.synced === 1;

  checks.push({
    title: '5. اختبار إنشاء فواتير متزامنة من جهازين مختلفين في نفس الثانية',
    passed: bothInvoicesSynced,
    details: `تمت مزامنة فاتورة الجهاز A (INV-A-101) وفاتورة الجهاز B (INV-B-101) دون أي تداخل في المعرفات.`,
  });

  // =========================================================================
  // Test 6: Invoice Voiding Sync
  // =========================================================================
  clientA.enqueueLocalOperation('invoices', 'void', invA, { isDeleted: true, voidReason: 'خطأ إدخال كاشير' }, 2);
  const voidSync = await clientA.syncPendingQueue();
  const voidedDoc = server.getDoc('invoices', invA);
  const voidPassed = voidSync.synced === 1 && voidedDoc?.isDeleted === true;

  checks.push({
    title: '6. اختبار إلغاء الفواتير ومزامنة حالة الحذف الإداري (Void)',
    passed: voidPassed,
    details: `تمت مزامنة إلغاء الفاتورة ${invA} مع توثيق سبب الإلغاء (isDeleted: true) دون حذف السجل المالي.`,
  });

  // =========================================================================
  // Test 7: Unauthorized / Revoked Device Access Prevention
  // =========================================================================
  const rogueClient = new SimulatedDeviceClient('dev_rogue_unauthorized_99', storeId, server);
  rogueClient.enqueueLocalOperation('products', 'create', 'fake_prod_99', { name: 'منتج غير مصرح' }, 1);

  let blockedRogue = false;
  try {
    await rogueClient.syncPendingQueue();
    blockedRogue = rogueClient.getLocalQueueLength() > 0; // failed to push
  } catch (err: any) {
    blockedRogue = true;
  }

  checks.push({
    title: '7. اختبار منع الأجهزة غير المصرح بها أو الملغاة من المزامنة',
    passed: blockedRogue,
    details: `تم حظر الجهاز غير المصرح به (dev_rogue_unauthorized_99) ورفض وصوله لقاعدة البيانات السحابية.`,
  });

  console.log('📊 نتائج اختبارات المزامنة السحابية للنموذج الأولي (Phase 8B):');
  checks.forEach((c) => {
    console.log(`\n${c.passed ? '✅' : '❌'} ${c.title}`);
    console.log(`   📝 ${c.details}`);
  });

  const allPassed = checks.every((c) => c.passed);
  console.log('\n----------------------------------------------------------------');
  console.log(`🏆 نتيجة المرحلة 8B (Isolated Cloud Sync Prototype): ${allPassed ? '✅ ناجح 100%' : '❌ فشل'}`);
  console.log('================================================================\n');

  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
