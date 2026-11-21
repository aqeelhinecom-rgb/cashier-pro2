/**
 * Cashier Pro — Phase 17: Final Findings Resolution & Full Regression Audit Suite
 *
 * اختبارات الانحدار الشاملة على بيئات معزولة تماماً (لا تلمس CashierPro_DB):
 * A. تعارض المخزون والحجز والإلغاء وإعادة البناء الرياضي
 * B. التحقق من قواعد Firestore & Storage المحصنة
 * C. ضغط الصور ووضوح أرقام القطع الصغيرة والشفافية
 * D. الدورة المالية والمخزنية والنسخ الاحتياطي والاستعادة الكاملة عبر StorageService الفعلي
 * E. قياس الأداء التسلسلي الواقعي للعمليات الفردية
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) || null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
}

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { CashierDatabase } from '../src/services/storage/schema';
import { StorageService } from '../src/services/storage/storageService';
import {
  createFullDexieBackup,
  validateBackupInSandbox,
  restoreDexieBackupSafely,
} from '../src/services/storage/backup/dexieBackupEngine';
import { InventoryConflictEngine } from '../src/services/sync/inventoryConflictEngine';
import { ImageOptimizationEngine } from '../src/services/storage/imageOptimizationEngine';
import { generateUUID } from '../src/services/storage/uuid';

interface AssertionLog {
  section: string;
  name: string;
  passed: boolean;
  details: string;
}

const assertions: AssertionLog[] = [];

function check(section: string, name: string, condition: boolean, details: string) {
  assertions.push({ section, name, passed: condition, details });
  if (!condition) {
    throw new Error(`❌ فشل اختبار [${section}] ${name}: ${details}`);
  }
  console.log(`✅ [${section}] ${name} — ${details}`);
}

async function runPartA_InventoryConflict() {
  console.log('\n================ Part A: Inventory Conflict & Reservation Regression ================');
  const engine = new InventoryConflictEngine('store_p17_test');
  const prodId = 500;
  const prodUuid = 'prod_p17_partA';

  // 1. مخزون أولي = 5 قطع
  engine.initializeProductStock(prodId, prodUuid, 5);

  // 2. حجز قطعتين لفاتورة معلقة (Held Invoice)
  const holdRes = engine.reserveStockForHeldInvoice({
    idempotencyKey: 'idem_hold_1',
    productId: prodId,
    qty: 2,
    deviceId: 'dev_pos_01',
  });
  check(
    'Part A',
    'فصل الكمية المحجوزة عن المتاحة مع ثبات الرصيد الفعلي',
    holdRes.success &&
      holdRes.updatedBalance!.physicalStock === 5 &&
      holdRes.updatedBalance!.availableStock === 3 &&
      holdRes.updatedBalance!.reservedStock === 2 &&
      holdRes.updatedBalance!.conflictDeficit === 0,
    `Physical=5, Available=3, Reserved=2, Deficit=0`
  );

  // 3. بيع 3 قطع متاحة من الجهاز A Offline (يستهلك كل المتاح 3)
  const saleA = engine.processSaleOperation({
    idempotencyKey: 'idem_p17_sale_A',
    deviceId: 'dev_pos_A',
    invoiceUuid: 'inv_uuid_A',
    invoiceNumber: 'INV-P17-A',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'آي سي شحن 13 Pro',
    requestedQty: 3,
    invoicePayload: { id: 1, invoice_number: 'INV-P17-A', qty: 3, total: 45000, paid: 45000, type: 'sale' },
  });
  check('Part A', 'بيع الجهاز A للمتاح (3 قطع)', !saleA.reconciliationRequired && saleA.updatedBalance!.availableStock === 0, 'Available=0, Physical=2 (محجوز)');

  // 4. بيع قطعتين من الجهاز B Offline + قطعة من الجهاز C Offline (تعارض 3 أجهزة)
  const saleB = engine.processSaleOperation({
    idempotencyKey: 'idem_p17_sale_B',
    deviceId: 'dev_pos_B',
    invoiceUuid: 'inv_uuid_B',
    invoiceNumber: 'INV-P17-B',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'آي سي شحن 13 Pro',
    requestedQty: 2,
    invoicePayload: { id: 2, invoice_number: 'INV-P17-B', qty: 2, total: 30000, paid: 30000, type: 'sale' },
  });
  const saleC = engine.processSaleOperation({
    idempotencyKey: 'idem_p17_sale_C',
    deviceId: 'dev_pos_C',
    invoiceUuid: 'inv_uuid_C',
    invoiceNumber: 'INV-P17-C',
    productId: prodId,
    productUuid: prodUuid,
    productName: 'آي سي شحن 13 Pro',
    requestedQty: 1,
    invoicePayload: { id: 3, invoice_number: 'INV-P17-C', qty: 1, total: 15000, paid: 15000, type: 'sale' },
  });
  check(
    'Part A',
    'كشف تعارض 3 أجهزة دون إخفاء العجز',
    saleB.reconciliationRequired && saleC.reconciliationRequired && saleC.updatedBalance!.conflictDeficit === 3,
    `Deficit ظاهر = 3 قطع (B:2 + C:1)`
  );

  // 5. إلغاء فاتورة الجهاز B (Void) -> يعكس العجز بمقدار 2 مع حفظ الفاتورة الأصلية بـ isDeleted: true
  const voidB = engine.voidSaleInvoice({
    idempotencyKey: 'idem_p17_void_B',
    invoiceUuid: 'inv_uuid_B',
    productId: prodId,
    voidedBy: 'mgr_user_1',
    reason: 'إلغاء فاتورة تعارض',
  });
  const storedB = engine.getStoredInvoices().find((i) => i.invoice_number === 'INV-P17-B');
  check(
    'Part A',
    'إلغاء الفاتورة المتعارضة وحل تسويتها تلقائياً دون حذفها',
    voidB.success &&
      voidB.updatedBalance!.conflictDeficit === 1 &&
      storedB?.isDeleted === true &&
      storedB?.total === 30000,
    `Deficit انخفض من 3 إلى 1، الفاتورة محفوظة بـ isDeleted=true`
  );

  // 6. منع تكرار التسوية الإدارية (Duplicate Reconciliation Guard)
  const pendingRec = engine.getReconciliationLedger('pending_review')[0];
  const firstResolve = engine.resolveReconciliationManually({
    reconciliationId: pendingRec.id,
    action: 'resolved_by_adjustment',
    managerName: 'owner_1',
    notes: 'تسوية جردية معتمدة',
  });
  const secondResolve = engine.resolveReconciliationManually({
    reconciliationId: pendingRec.id,
    action: 'resolved_by_adjustment',
    managerName: 'owner_1',
    notes: 'محاولة تكرار التسوية',
  });
  check(
    'Part A',
    'منع تكرار تسوية نفس سجل التعارض',
    firstResolve === true && secondResolve === false,
    `أول تسوية نجحت وتكرارها رُفض (false)`
  );

  // 7. فك حجز الفاتورة المعلقة
  const relHold = engine.releaseReservedStock({
    idempotencyKey: 'idem_release_1',
    productId: prodId,
    qty: 2,
    deviceId: 'dev_pos_01',
  });
  check(
    'Part A',
    'فك حجز الفاتورة المعلقة وإعادتها للمتاح',
    relHold.updatedBalance!.reservedStock === 0 && relHold.updatedBalance!.availableStock === 2,
    `Reserved=0, Available=2, Physical=2`
  );

  // 8. مطابقة إعادة البناء من Change Journal بنسبة 100%
  const rebuild = engine.reconstructStockFromJournal(prodId, 5);
  check(
    'Part A',
    'إعادة بناء جميع أرصدة المخزون الأربعة من Change Journal',
    rebuild.isMatched,
    `Physical=${rebuild.calculatedPhysicalStock}, Available=${rebuild.calculatedAvailableStock}, Reserved=${rebuild.calculatedReservedStock}, Deficit=${rebuild.calculatedDeficit}`
  );
}

async function runPartB_CloudSecurityRulesCheck() {
  console.log('\n================ Part B: Firestore & Storage Rules Regression ================');
  const firestoreRules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
  const storageRules = fs.readFileSync(path.join(process.cwd(), 'storage.rules'), 'utf8');

  check(
    'Part B',
    'التحقق من وجود قاعدة change_journal غير القابلة للتعديل في firestore.rules',
    firestoreRules.includes('match /change_journal/{entryId}') && firestoreRules.includes('allow update, delete: if false;'),
    'change_journal محمي من التعديل والحذف من العميل'
  );
  check(
    'Part B',
    'التحقق من فرض isAuthorizedDevice على المنتجات والفواتير والدفعات',
    (firestoreRules.match(/isAuthorizedDevice\(/g) || []).length >= 7,
    `تم العثور على ${(firestoreRules.match(/isAuthorizedDevice\(/g) || []).length} مواضع تتحقق من الجهاز المعتمد`
  );
  check(
    'Part B',
    'التحقق من عزل المتجر وRBAC وفحص الجهاز داخل storage.rules',
    storageRules.includes('firestore.exists(/databases/(default)/documents/stores/$(storeId)/users/') &&
      storageRules.includes('isInventoryManagerOrHigher(storeId)') &&
      storageRules.includes('isAuthorizedDeviceFromMetadata(storeId)') &&
      !storageRules.includes('allow read, write: if isSignedIn() &&'),
    'تم سد ثغرة SEC-02 في storage.rules بعزل كامل للمتجر والأدوار والأجهزة'
  );
}

async function runPartC_ImageAndEngravingClarity() {
  console.log('\n================ Part C: Image Optimization & Part-Number Clarity ================');

  // إنشاء صورة عالية التباين تحتوي على رقم قطعة دقيق (نقش صغير SN-11PM-8842)
  const engravingSvg = `
    <svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="800" fill="#1e293b"/>
      <rect x="200" y="180" width="800" height="440" rx="20" fill="#0f172a" stroke="#94a3b8" stroke-width="4"/>
      <text x="600" y="390" font-family="monospace" font-size="36" font-weight="bold" fill="#f8fafc" text-anchor="middle">IC-PMU-338S00616</text>
      <text x="600" y="450" font-family="monospace" font-size="22" fill="#cbd5e1" text-anchor="middle">SN-11PM-8842-REV4</text>
    </svg>
  `;
  const chipJpeg = await sharp(Buffer.from(engravingSvg)).jpeg({ quality: 95 }).toBuffer();

  const optResult = await ImageOptimizationEngine.optimizeImage(chipJpeg, 777);
  // فحص أن النسخة المضغوطة حافظت على أبعاد كافية لقراءة النقوش الصغيرة (800x533) وحدّة تباين عالية
  const optStats = await sharp(optResult.optimizedBuffer).stats();
  const hasHighContrast = optStats.channels.some((c) => c.stdev > 20);

  check(
    'Part C',
    'وضوح النقوش وأرقام القطع الصغيرة بعد الضغط (800px WebP)',
    optResult.optimizedWidth === 800 && optResult.optimizedHeight === 533 && hasHighContrast && optResult.compressionRatio > 0,
    `${optResult.originalWidth}x${optResult.originalHeight} (${(optResult.originalSizeBytes / 1024).toFixed(1)}KB) -> ${optResult.optimizedWidth}x${optResult.optimizedHeight} (${(optResult.optimizedSizeBytes / 1024).toFixed(1)}KB), stdev=${optStats.channels[0].stdev.toFixed(1)}`
  );
  check(
    'Part C',
    'حفظ الصورة الأصلية والمصغرة وبصمة SHA-256',
    optResult.originalBase64.length > 0 && optResult.thumbnailBase64.length > 0 && optResult.checksum.length === 64,
    `Checksum=${optResult.checksum.substring(0, 16)}... | Thumb=${(optResult.thumbnailSizeBytes / 1024).toFixed(1)}KB`
  );
}

async function runPartD_FullFinancialAndBackupRegression() {
  console.log('\n================ Part D: Interconnected Financial, Inventory & Backup/Restore Regression ================');
  const srcDbName = `Cashier_P17_Fin_${Date.now()}`;
  const cleanDbName = `Cashier_P17_CleanRestore_${Date.now()}`;
  const srcDb = new CashierDatabase(srcDbName);
  await srcDb.open();
  const service = new StorageService(srcDb);

  // 1. اختبار حفظ الإعدادات (إثبات إصلاح خطأ Transaction committed too early)
  const savedSettings = await service.settings.saveSettings({ storeName: 'متجر المرحلة 17 للاختبار', theme: 'dark' });
  check('Part D', 'تحديث الإعدادات دون خطأ Transaction committed too early', savedSettings.theme === 'dark', 'تم الحفظ في settings + change_journal داخل معاملة ذرية سليمة');

  // 2. إضافة عميل ومورد ومنتج
  const customer = await service.parties.save({ name: 'أحمد الزبون', phone: '0770111222', type: 'customer' });
  const supplier = await service.parties.save({ name: 'شركة النخبة للتوريد', phone: '0780333444', type: 'supplier' });
  const product = await service.products.save({
    name: 'بطارية أصلية 13 Pro',
    barcode: '628000017171',
    category: 'قطع غيار وصيانة',
    buy_price: 10000,
    sell_price: 15000,
    qty: 0,
  });

  // حفظ صورة للمنتج
  await service.images.saveImage(product.id!, { base64: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=', mimeType: 'image/webp' });

  // 3. فاتورة شراء مخزون: 10 قطع بسعر تكلفة 10,000 = 100,000 د.ع، مدفوع للمورد 60,000 د.ع (متبقي للمورد 40,000)
  await service.invoices.createInvoice({
    type: 'purchase',
    partyId: supplier.id,
    items: [{ product_id: product.id!, name: product.name, qty: 10, price: 10000, cost: 10000, sell_price: 15000 }],
    discount: 0,
    paid: 60000,
  });

  // 4. فاتورة بيع نقدي: 3 قطع × 15,000 = 45,000 (مدفوع 45,000)
  await service.invoices.createInvoice({
    type: 'sale',
    partyId: null,
    items: [{ product_id: product.id!, name: product.name, qty: 3, price: 15000, cost: 10000 }],
    discount: 0,
    paid: 45000,
  });

  // 5. فاتورة بيع آجل للعميل: 2 قطعة × 15,000 = 30,000 (مدفوع 10,000 -> دين 20,000)
  await service.invoices.createInvoice({
    type: 'sale',
    partyId: customer.id,
    items: [{ product_id: product.id!, name: product.name, qty: 2, price: 15000, cost: 10000 }],
    discount: 0,
    paid: 10000,
  });

  // 6. قبض دفعة من العميل: 15,000 (يصبح رصيد العميل المتبقي 5,000)
  await service.payments.add({ partyId: customer.id!, amount: 15000 });

  // 7. مرتجع مبيعات نقدي: قطعة واحدة × 15,000 (تعود للمخزون +1)
  await service.invoices.createInvoice({
    type: 'sale_return',
    partyId: null,
    items: [{ product_id: product.id!, name: product.name, qty: 1, price: 15000, cost: 10000 }],
    discount: 0,
    paid: 15000,
  });

  // 8. فاتورة بيع ثم إلغاؤها (Void): قطعة واحدة تُباع ثم تُلغى -> يعود المخزون كما كان قبلها ويسقط أثرها من التقرير
  const tempSale = await service.invoices.createInvoice({
    type: 'sale',
    partyId: null,
    items: [{ product_id: product.id!, name: product.name, qty: 1, price: 15000, cost: 10000 }],
    discount: 0,
    paid: 15000,
  });
  await service.invoices.deleteInvoice(tempSale.invoice.id!); // Soft void & stock reversal

  // 9. مصروف تشغيلي: 5,000 د.ع
  await service.expenses.add({ recipient: 'فاتورة إنترنت المحل', amount: 5000 });

  // التحقق من المعادلات المحاسبية الدقيقة قبل النسخ الاحتياطي:
  // المخزون: 10 (شراء) - 3 (بيع نقدي) - 2 (بيع آجل) + 1 (مرتجع) - 1 (بيع مؤقت) + 1 (إلغاء) = 6 قطع
  // قيمة المخزون بالتكلفة: 6 × 10,000 = 60,000 د.ع
  // صافي المبيعات بعد خصم المرتجع (FIND-P17-03): (45,000 + 30,000) - 15,000 = 60,000 د.ع (الفاتورة الملغاة مستبعدة)
  // صافي هامش الربح بعد خصم المرتجع (FIND-P17-03): 25,000 - 5,000 = 20,000 د.ع
  // المصروفات: 5,000 د.ع | المشتريات: 100,000 د.ع | مرتجع المبيعات المسجل: 15,000 د.ع
  // رصيد العميل: 30,000 - 10,000 (مدفوع بالفاتورة) - 15,000 (سند قبض) = 5,000 د.ع
  // رصيد المورد: 100,000 - 60,000 = 40,000 د.ع
  const prodAfter = await service.products.getById(product.id!);
  const custRec = (await service.parties.getAll('customer')).find((c) => c.id === customer.id);
  const suppRec = (await service.parties.getAll('supplier')).find((s) => s.id === supplier.id);
  const custBal = custRec?.balance ?? -1;
  const suppBal = suppRec?.balance ?? -1;
  const fromEpoch = new Date(0);
  const toFuture = new Date(Date.now() + 86400000);
  const reportBefore = await service.reports.getReport(fromEpoch, toFuture);
  const returnsBefore = (await service.invoices.getAll('sale_return')).reduce((s, r) => s + r.total, 0);

  check('Part D', 'دقة رصيد المخزون الفعلي', prodAfter?.qty === 6, `المخزون الفعلي = ${prodAfter?.qty} (المتوقع 6)`);
  check('Part D', 'دقة قيمة المخزون بالتكلفة', reportBefore.stockValue === 60000, `قيمة المخزون بالتكلفة = ${reportBefore.stockValue}`);
  check(
    'Part D',
    'دقة صافي المبيعات والمشتريات بعد خصم المرتجع واستبعاد الفاتورة الملغاة',
    reportBefore.sales === 60000 && reportBefore.purchases === 100000 && returnsBefore === 15000,
    `صافي المبيعات=${reportBefore.sales}، المرتجعات=${returnsBefore}، المشتريات=${reportBefore.purchases}`
  );
  check(
    'Part D',
    'دقة صافي هامش الربح والمصروفات بعد خصم المرتجع',
    reportBefore.expenses === 5000 && reportBefore.profit === 20000,
    `هامش الربح الصافي=${reportBefore.profit}، المصروفات=${reportBefore.expenses}`
  );
  check('Part D', 'دقة رصيد العميل والمورد', custBal === 5000 && suppBal === 40000, `العميل=${custBal}، المورد=${suppBal}`);

  // 10. إنشاء نسخة احتياطية مستقلة واستعادتها إلى قاعدة بيانات نظيفة تماماً (صفر سجلات مسبقة)
  const backupRes = await createFullDexieBackup(srcDb, 'manual', 'نسخة تدقيق المرحلة 17');
  const cleanDb = new CashierDatabase(cleanDbName);
  await cleanDb.open();

  const sandboxCheck = await validateBackupInSandbox(backupRes.jsonString);
  check(
    'Part D',
    'التحقق من سلامة البصمة SHA-256 في Sandbox',
    sandboxCheck.valid && Boolean(sandboxCheck.manifest?.checksum),
    `سجلات=${sandboxCheck.manifest?.totalRecords}, checksum=${sandboxCheck.manifest?.checksum?.substring(0, 12)}...`
  );

  const restoreRes = await restoreDexieBackupSafely(backupRes.jsonString, cleanDb);
  check('Part D', 'نجاح استعادة النسخة إلى بيئة نظيفة', restoreRes.success, restoreRes.message);
  const cleanService = new StorageService(cleanDb);
  const restoredReport = await cleanService.reports.getReport(fromEpoch, toFuture);
  const restoredImg = await cleanService.images.getByProductId(product.id!);
  const restoredCustBal = (await cleanService.parties.getAll('customer')).find((c) => c.id === customer.id)?.balance ?? -1;
  const restoredSuppBal = (await cleanService.parties.getAll('supplier')).find((s) => s.id === supplier.id)?.balance ?? -1;

  check(
    'Part D',
    'استعادة جميع الحسابات والصور إلى بيئة نظيفة دون الاعتماد على backup_history',
    restoredReport.sales === 60000 &&
      restoredReport.stockValue === 60000 &&
      restoredReport.profit === 20000 &&
      restoredReport.expenses === 5000 &&
      restoredCustBal === 5000 &&
      restoredSuppBal === 40000 &&
      Boolean(restoredImg?.base64?.startsWith('data:image/webp')),
    `صافي المبيعات=${restoredReport.sales}, المخزون=${restoredReport.stockValue}, صافي الربح=${restoredReport.profit}, العميل=${restoredCustBal}, المورد=${restoredSuppBal}, الصورة مستعادة بنجاح`
  );

  await srcDb.close();
  await srcDb.delete();
  await cleanDb.close();
  await cleanDb.delete();
}

async function runPartE_RealisticSequentialLatency() {
  console.log('\n================ Part E: Realistic Sequential Single-Op Latency (Node/fake-indexeddb) ================');
  const perfDb = new CashierDatabase(`Cashier_P17_Perf_${Date.now()}`);
  const tOpen0 = performance.now();
  await perfDb.open();
  const openMs = performance.now() - tOpen0;

  const service = new StorageService(perfDb);
  // حقن 1,000 صنف كقاعدة محل متوسطة ثم قياس العمليات الفردية الواحدة تلو الأخرى
  const batch = [];
  for (let i = 1; i <= 1000; i++) {
    batch.push({
      id: i,
      uuid: `perf_uuid_${i}`,
      name: `صنف اختبار واقعي ${i}`,
      barcode: `628100${String(i).padStart(6, '0')}`,
      category: 'عام',
      buy_price: 5000,
      sell_price: 7500,
      qty: 50,
      updatedAt: new Date().toISOString(),
      isDeleted: false,
    } as any);
  }
  await perfDb.products.bulkPut(batch);

  const tBarcode0 = performance.now();
  const foundProd = await perfDb.products.where('barcode').equals('628100000750').first();
  const barcodeMs = performance.now() - tBarcode0;

  const tInv0 = performance.now();
  await service.invoices.createInvoice({
    type: 'sale',
    partyId: null,
    items: [{ product_id: foundProd!.id!, name: foundProd!.name, qty: 2, price: 7500, cost: 5000 }],
    discount: 0,
    paid: 15000,
  });
  const singleInvoiceMs = performance.now() - tInv0;

  const tRep0 = performance.now();
  await service.reports.getReport(new Date(0), new Date(Date.now() + 86400000));
  const reportMs = performance.now() - tRep0;

  const tBkp0 = performance.now();
  const bkp = await createFullDexieBackup(perfDb, 'manual', 'قياس أداء');
  const backupMs = performance.now() - tBkp0;

  console.log(`⏱️  فتح القاعدة: ${openMs.toFixed(2)}ms | بحث باركود منفرد: ${barcodeMs.toFixed(2)}ms`);
  console.log(`⏱️  إنشاء فاتورة مفردة (شامل تحديث المخزون والترقيم وChange Journal): ${singleInvoiceMs.toFixed(2)}ms`);
  console.log(`⏱️  حساب تقرير الأرباح والمخزون: ${reportMs.toFixed(2)}ms | إنشاء نسخة احتياطية (1000 منتج): ${backupMs.toFixed(2)}ms (${(bkp.backupRecord.sizeBytes / 1024).toFixed(1)}KB)`);

  check('Part E', 'اكتمال قياس الأداء التسلسلي للعمليات الفردية', singleInvoiceMs < 200 && barcodeMs < 50, `Invoice=${singleInvoiceMs.toFixed(2)}ms, Barcode=${barcodeMs.toFixed(2)}ms`);

  await perfDb.close();
  await perfDb.delete();
}

async function main() {
  console.log('================================================================');
  console.log('   Cashier Pro — Phase 17: Full Regression & Findings Verification');
  console.log('================================================================');

  await runPartA_InventoryConflict();
  await runPartB_CloudSecurityRulesCheck();
  await runPartC_ImageAndEngravingClarity();
  await runPartD_FullFinancialAndBackupRegression();
  await runPartE_RealisticSequentialLatency();

  console.log('\n================================================================');
  console.log(`🏆 إجمالي الفحوصات الناجحة في المرحلة 17: ${assertions.filter((a) => a.passed).length}/${assertions.length} (100%)`);
  console.log('================================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ توقف التنفيذ لوجود خطأ حرج:', err);
  process.exit(1);
});
