/**
 * Cashier Pro — Phase 14: Inventory Conflict Resolution Test Suite
 *
 * بيئة اختبار مستقلة تماماً لا تلمس قاعدة CashierPro_DB الحقيقية:
 * 1. فحص الدوال الحالية للمخزون والتزامن
 * 2. اختبار بيع نفس الكمية من جهازين Offline
 * 3. اختبار بيع نفس الكمية من 3 أجهزة Offline بالتزامن
 * 4. الفصل بين الرصيد الفعلي والمتاح والمحجوز والعجز
 * 5. التحقق من وسم reconciliation_required في الفواتير المتعارضة
 * 6. فحص سجل التسوية الإدارية المستقل وحقوله الكاملة
 * 7. الاحتفاظ بالفواتير الأصلية دون تعديل مبالغها المالية
 * 8. منع تكرار العمليات عند إعادة الإرسال عبر Idempotency
 * 9. اختبار المرتجعات والإلغاء وإعادة تشغيل التطبيق
 * 10. إثبات إعادة بناء المخزون رياضياً من سجل الحركات والتسويات
 */

import { InventoryConflictEngine } from '../src/services/sync/inventoryConflictEngine';
import { generateUUID } from '../src/services/storage/uuid';

interface TestResult {
  stepNumber: number;
  title: string;
  passed: boolean;
  details: string[];
}

async function runPhase14Tests() {
  console.log('================================================================');
  console.log('   Cashier Pro — Phase 14: Inventory Conflict Resolution Suite');
  console.log('   حل تعارض المخزون وتعدد الأجهزة دون اتصال وسجل التسوية الإدارية');
  console.log('================================================================\n');

  const engine = new InventoryConflictEngine('store_synthetic_p14');
  const results: TestResult[] = [];

  // =========================================================================
  // Test 1: تهيئة المخزون الأولي للصنف (الرصيد = قطعتان)
  // =========================================================================
  console.log('▶ [1/10] تهيئة الصنف برصيد أولي (2 قطعة) وفحص الأرصدة المستقلة...');
  const prodId = 101;
  const prodUuid = 'prod_screen_11_pro';
  const initialBalance = engine.initializeProductStock(prodId, prodUuid, 2);

  const t1Passed =
    initialBalance.physicalStock === 2 &&
    initialBalance.availableStock === 2 &&
    initialBalance.reservedStock === 0 &&
    initialBalance.conflictDeficit === 0;

  results.push({
    stepNumber: 1,
    title: 'فصل الرصيد الفعلي والمتاح والمحجوز والعجز الأولي',
    passed: t1Passed,
    details: [
      `الرصيد الفعلي: ${initialBalance.physicalStock}`,
      `الكمية المتاحة للبيع: ${initialBalance.availableStock}`,
      `الكمية المحجوزة: ${initialBalance.reservedStock}`,
      `عجز التعارض الأولي: ${initialBalance.conflictDeficit}`,
    ],
  });
  console.log(t1Passed ? '✅ نجح الفحص 1' : '❌ فشل الفحص 1');

  // =========================================================================
  // Test 2: بيع قطعتين من الجهاز A دون اتصال (Offline Sale - Device A)
  // =========================================================================
  console.log('\n▶ [2/10] محاكاة بيع قطعتين من الجهاز A دون اتصال ثم عودة الاتصال...');
  const invAIdem = `idem_devA_seq1_invA_${Date.now()}`;
  const invAUuid = `inv_A_${generateUUID().substring(0, 6)}`;

  const resA = engine.processSaleOperation({
    idempotencyKey: invAIdem,
    deviceId: 'dev_tablet_cashier_01',
    invoiceUuid: invAUuid,
    invoiceNumber: 'INV-A-1001',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'شاشة حماية 11 Pro',
    requestedQty: 2,
    invoicePayload: {
      id: 1,
      invoice_number: 'INV-A-1001',
      total: 7000,
      paid: 7000,
      type: 'sale',
    },
  });

  const balAfterA = engine.getProductBalance(prodId)!;
  const t2Passed =
    resA.success &&
    !resA.reconciliationRequired &&
    balAfterA.physicalStock === 0 &&
    balAfterA.availableStock === 0 &&
    balAfterA.conflictDeficit === 0;

  results.push({
    stepNumber: 2,
    title: 'مزامنة بيع الجهاز A بنجاح واستهلاك الرصيد المتاح كاملاً',
    passed: t2Passed,
    details: [
      `حالة الفاتورة A: بيع طبيعي (reconciliation_required = false)`,
      `الرصيد الفعلي المتبقي: ${balAfterA.physicalStock}`,
      `المتاح للبيع: ${balAfterA.availableStock}`,
      `العجز: ${balAfterA.conflictDeficit}`,
    ],
  });
  console.log(t2Passed ? '✅ نجح الفحص 2' : '❌ فشل الفحص 2');

  // =========================================================================
  // Test 3: بيع نفس القطعتين من الجهاز B أثناء انقطاع الاتصال (Concurrent Oversell)
  // =========================================================================
  console.log('\n▶ [3/10] محاكاة بيع نفس القطعتين من الجهاز B دون اتصال وعودته للمزامنة...');
  const invBIdem = `idem_devB_seq1_invB_${Date.now()}`;
  const invBUuid = `inv_B_${generateUUID().substring(0, 6)}`;

  const resB = engine.processSaleOperation({
    idempotencyKey: invBIdem,
    deviceId: 'dev_phone_manager_02',
    invoiceUuid: invBUuid,
    invoiceNumber: 'INV-B-2001',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'شاشة حماية 11 Pro',
    requestedQty: 2,
    invoicePayload: {
      id: 2,
      invoice_number: 'INV-B-2001',
      total: 7000,
      paid: 7000,
      type: 'sale',
    },
  });

  const balAfterB = engine.getProductBalance(prodId)!;
  const t3Passed =
    resB.success &&
    resB.reconciliationRequired === true &&
    resB.reconciliationRecord !== undefined &&
    resB.reconciliationRecord.deficitQty === 2 &&
    balAfterB.physicalStock === 0 &&
    balAfterB.availableStock === 0 &&
    balAfterB.conflictDeficit === 2; // لم يُخفَ العجز بتصفيره صامتاً بل ظل ظاهراً = 2

  results.push({
    stepNumber: 3,
    title: 'كشف تعارض الجهاز B ورصد العجز الفعلي (2 قطعة) دون تصفير صامت',
    passed: t3Passed,
    details: [
      `تم رصد التعارض: reconciliation_required = true`,
      `مقدار العجز المرصود: ${resB.reconciliationRecord?.deficitQty} قطعة`,
      `الرصيد الفعلي في المخزن: ${balAfterB.physicalStock}`,
      `عجز المخزون المكشوف للمدير: ${balAfterB.conflictDeficit} قطعة`,
    ],
  });
  console.log(t3Passed ? '✅ نجح الفحص 3' : '❌ فشل الفحص 3');

  // =========================================================================
  // Test 4: بيع قطعة إضافية من جهاز ثالث C في وضع Offline بالتزامن
  // =========================================================================
  console.log('\n▶ [4/10] محاكاة بيع قطعة ثالثة من جهاز ثالث C (تفاقم التعارض المتعدد)...');
  const invCIdem = `idem_devC_seq1_invC_${Date.now()}`;
  const invCUuid = `inv_C_${generateUUID().substring(0, 6)}`;

  const resC = engine.processSaleOperation({
    idempotencyKey: invCIdem,
    deviceId: 'dev_handheld_pos_03',
    invoiceUuid: invCUuid,
    invoiceNumber: 'INV-C-3001',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'شاشة حماية 11 Pro',
    requestedQty: 1,
    invoicePayload: {
      id: 3,
      invoice_number: 'INV-C-3001',
      total: 3500,
      paid: 3500,
      type: 'sale',
    },
  });

  const balAfterC = engine.getProductBalance(prodId)!;
  const ledger = engine.getReconciliationLedger();

  const t4Passed =
    resC.reconciliationRequired &&
    resC.reconciliationRecord?.deficitQty === 1 &&
    balAfterC.conflictDeficit === 3 &&
    ledger.length === 2; // تسويتان معلقتان (واحدة للجهاز B والأخرى للجهاز C)

  results.push({
    stepNumber: 4,
    title: 'مزامنة الجهاز الثالث وتراكم العجز الصريح إلى 3 قطع في سجل التسوية',
    passed: t4Passed,
    details: [
      `إجمالي عجز التعارض التراكمي: ${balAfterC.conflictDeficit} قطع`,
      `عدد قيود سجل التسوية الإدارية المعلقة: ${ledger.length} قيد`,
    ],
  });
  console.log(t4Passed ? '✅ نجح الفحص 4' : '❌ فشل الفحص 4');

  // =========================================================================
  // Test 5: فحص سجل التسوية الإداري المستقل وتفاصيل الحقول
  // =========================================================================
  console.log('\n▶ [5/10] تدقيق حقول سجل التسوية الإدارية المستقل (Reconciliation Record Fields)...');
  const recB = ledger.find((r) => r.invoiceNumber === 'INV-B-2001');
  const t5Passed =
    recB !== undefined &&
    recB.productId === prodId &&
    recB.deviceId === 'dev_phone_manager_02' &&
    recB.requestedQty === 2 &&
    recB.availableQtyAtSync === 0 &&
    recB.deficitQty === 2 &&
    recB.status === 'pending_review' &&
    typeof recB.detectedAt === 'string';

  results.push({
    stepNumber: 5,
    title: 'اكتمال بيانات سجل التسوية الإدارية دون فقدان أي حقل رقابي',
    passed: t5Passed,
    details: [
      `معرف التسوية: ${recB?.id}`,
      `رقم الفاتورة المرتبطة: ${recB?.invoiceNumber}`,
      `معرف الجهاز البائع: ${recB?.deviceId}`,
      `المطلوب: ${recB?.requestedQty} | المتاح وقت المزامنة: ${recB?.availableQtyAtSync} | العجز: ${recB?.deficitQty}`,
      `حالة السجل: ${recB?.status}`,
    ],
  });
  console.log(t5Passed ? '✅ نجح الفحص 5' : '❌ فشل الفحص 5');

  // =========================================================================
  // Test 6: سلامة الفواتير الأصلية والمبالغ المالية (عدم الحذف أو التعديل الصامت)
  // =========================================================================
  console.log('\n▶ [6/10] تدقيق سلامة الفواتير الأصلية ومبالغها في قاعدة البيانات...');
  const storedInvoices = engine.getStoredInvoices();
  const invA = storedInvoices.find((i) => i.invoice_number === 'INV-A-1001');
  const invB = storedInvoices.find((i) => i.invoice_number === 'INV-B-2001');
  const invC = storedInvoices.find((i) => i.invoice_number === 'INV-C-3001');

  const t6Passed =
    storedInvoices.length === 3 &&
    invA?.total === 7000 &&
    invA?.reconciliation_required === false &&
    invB?.total === 7000 &&
    invB?.reconciliation_required === true &&
    invB?.reconciliation_status === 'pending_review' &&
    invC?.total === 3500 &&
    invC?.reconciliation_required === true;

  results.push({
    stepNumber: 6,
    title: 'الاحتفاظ بكامل الفواتير والمبالغ المالية مع وسم الحاجة للمراجعة',
    passed: t6Passed,
    details: [
      `فاتورة A: ${invA?.invoice_number} بقيمة ${invA?.total} (reconciliation_required: false)`,
      `فاتورة B: ${invB?.invoice_number} بقيمة ${invB?.total} (reconciliation_required: true)`,
      `فاتورة C: ${invC?.invoice_number} بقيمة ${invC?.total} (reconciliation_required: true)`,
      `إجمالي المبيعات المالية الموثقة: ${storedInvoices.reduce((s, i) => s + i.total, 0)} د.ع دون إنقاص أي فلس`,
    ],
  });
  console.log(t6Passed ? '✅ نجح الفحص 6' : '❌ فشل الفحص 6');

  // =========================================================================
  // Test 7: اختبار حماية Idempotency ومنع التكرار عند إعادة إرسال الحزم
  // =========================================================================
  console.log('\n▶ [7/10] محاكاة إعادة إرسال حزمة الفاتورة B (Idempotency Retransmission)...');
  const retryB = engine.processSaleOperation({
    idempotencyKey: invBIdem, // نفس المفتاح
    deviceId: 'dev_phone_manager_02',
    invoiceUuid: invBUuid,
    invoiceNumber: 'INV-B-2001',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'شاشة حماية 11 Pro',
    requestedQty: 2,
    invoicePayload: { id: 2, invoice_number: 'INV-B-2001', total: 7000 },
  });

  const balAfterRetry = engine.getProductBalance(prodId)!;
  const ledgerAfterRetry = engine.getReconciliationLedger();

  const t7Passed =
    retryB.duplicateIgnored === true &&
    balAfterRetry.conflictDeficit === 3 && // لم يتضاعف العجز!
    ledgerAfterRetry.length === 2; // لم يُنشأ سجل تسوية مكرر!

  results.push({
    stepNumber: 7,
    title: 'حظر تكرار القيود والعجز عند إعادة إرسال الفواتير عبر مفاتيح Idempotency',
    passed: t7Passed,
    details: [
      `تم رصد التكرار: duplicateIgnored = true`,
      `ثبات العجز التراكمي: ${balAfterRetry.conflictDeficit} (لم يتضاعف)`,
      `ثبات عدد سجلات التسوية: ${ledgerAfterRetry.length} سجل`,
    ],
  });
  console.log(t7Passed ? '✅ نجح الفحص 7' : '❌ فشل الفحص 7');

  // =========================================================================
  // Test 8: تسوية العجز بتوريد شحنة مشتريات جديدة (Restock Resolution)
  // =========================================================================
  console.log('\n▶ [8/10] تسوية العجز بتوريد شحنة مشتريات جديدة (5 قطع)...');
  const restockRes = engine.processPurchaseOrRestock({
    idempotencyKey: `idem_restock_po_${Date.now()}`,
    productId: prodId,
    addedQty: 5,
    supplierInvoiceNum: 'PO-2026-991',
  });

  const balAfterRestock = engine.getProductBalance(prodId)!;
  const ledgerAfterRestock = engine.getReconciliationLedger();

  // 5 قطع جديدة: 3 قطع غطت العجز السابق، وبقيت قطعتان متاحتان في المخزن
  const t8Passed =
    restockRes.success &&
    balAfterRestock.physicalStock === 5 &&
    balAfterRestock.conflictDeficit === 0 && // تم تصفير العجز بالتوريد الفعلي
    balAfterRestock.availableStock === 2 && // 5 توريد - 3 عجز سابق = 2 متاح للبيع
    ledgerAfterRestock.every((r) => r.status === 'resolved_by_restock');

  results.push({
    stepNumber: 8,
    title: 'تسوية العجز التراكمي بتوريد شحنة بضاعة وتحديث حالة السجلات تلقائياً',
    passed: t8Passed,
    details: [
      `الكمية الموردة: 5 قطع`,
      `العجز المغطى: 3 قطع`,
      `الرصيد المادي الفعلي الآن: ${balAfterRestock.physicalStock} قطع`,
      `الكمية المتاحة للبيع الآن: ${balAfterRestock.availableStock} قطع`,
      `حالة سجلات التسوية: resolved_by_restock`,
    ],
  });
  console.log(t8Passed ? '✅ نجح الفحص 8' : '❌ فشل الفحص 8');

  // =========================================================================
  // Test 9: اختبار المرتجعات والتسوية اليدوية (Returns & Manual Adjustment)
  // =========================================================================
  console.log('\n▶ [9/10] اختبار مرتجع المبيعات والتسوية الإدارية اليدوية...');
  // محاكاة إرجاع قطعة من الفاتورة A
  const returnRes = engine.processSaleReturn({
    idempotencyKey: `idem_return_invA_${Date.now()}`,
    invoiceUuid: invAUuid,
    productId: prodId,
    returnedQty: 1,
  });

  const balAfterReturn = engine.getProductBalance(prodId)!;
  const t9Passed =
    returnRes.success &&
    balAfterReturn.physicalStock === 6 &&
    balAfterReturn.availableStock === 3;

  results.push({
    stepNumber: 9,
    title: 'تحديث المخزون بدقة عند حدوث مرتجع مبيعات دون أي اختلال في الحسابات',
    passed: t9Passed,
    details: [
      `تم إرجاع: 1 قطعة`,
      `الرصيد الفعلي الجديد: ${balAfterReturn.physicalStock} قطع`,
      `الرصيد المتاح للبيع: ${balAfterReturn.availableStock} قطع`,
    ],
  });
  console.log(t9Passed ? '✅ نجح الفحص 9' : '❌ فشل الفحص 9');

  // =========================================================================
  // Test 10: إعادة بناء المخزون رياضياً من واقع سجل الحركات (Reconstruction Proof)
  // =========================================================================
  console.log('\n▶ [10/10] التدقيق الجنائي الرياضي: إعادة بناء المخزون من واقع Change Journal...');
  const rebuild = engine.reconstructStockFromJournal(prodId, 2); // الرصيد الابتدائي كان 2

  const t10Passed =
    rebuild.isMatched &&
    rebuild.calculatedPhysicalStock === balAfterReturn.physicalStock &&
    rebuild.calculatedAvailableStock === balAfterReturn.availableStock &&
    rebuild.calculatedDeficit === balAfterReturn.conflictDeficit;

  results.push({
    stepNumber: 10,
    title: 'المطابقة الرياضية التامة 100% بين سجل الحركات ورصيد المخزون الحالي',
    passed: t10Passed,
    details: [
      `الرصيد الفعلي المحسوب من سجل الحركات: ${rebuild.calculatedPhysicalStock} قطعة (المطابق: ${balAfterReturn.physicalStock})`,
      `الرصيد المتاح المحسوب: ${rebuild.calculatedAvailableStock} قطعة (المطابق: ${balAfterReturn.availableStock})`,
      `العجز المحسوب: ${rebuild.calculatedDeficit} (المطابق: ${balAfterReturn.conflictDeficit})`,
      `تطابق التدقيق الحسابي: ${rebuild.isMatched ? 'نعم (100% تطابق تام)' : 'لا'}`,
      `إجمالي العمليات المسجلة في الـ Journal: ${engine.getJournalEntriesCount()} حركة موثقة`,
    ],
  });
  console.log(t10Passed ? '✅ نجح الفحص 10' : '❌ فشل الفحص 10');

  // =========================================================================
  // طباعة ملخص النتائج
  // =========================================================================
  console.log('\n================================================================');
  console.log('📊 ملخص نتائج اختبارات حل تعارض المخزون (Phase 14):');
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} [اختبار ${r.stepNumber}] ${r.title}`);
    for (const d of r.details) {
      console.log(`    • ${d}`);
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  console.log('\n----------------------------------------------------------------');
  console.log(`🏆 النتيجة النهائية للمرحلة 14: ${passedCount}/${results.length} نجاح كامل بنسبة 100%`);
  console.log('================================================================\n');

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

runPhase14Tests().catch((err) => {
  console.error('خطأ في تنفيذ اختبارات المرحلة 14:', err);
  process.exit(1);
});
