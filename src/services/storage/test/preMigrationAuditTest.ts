// @ts-ignore
import 'fake-indexeddb/auto';
import { CashierDatabase } from '../schema';
import { MigrationPipeline } from '../migration/pipeline';
import {
  createSafeChunkedSnapshot,
  restoreSafeChunkedSnapshot,
  SnapshotManifest,
} from '../migration/chunkedSnapshot';
import { LegacyLocalStorageDump } from '../migration/reader';
import { DB } from '../../db';

export interface AuditTestReport {
  allPassed: boolean;
  totalTests: number;
  passedTests: number;
  results: {
    id: number;
    category: string;
    name: string;
    passed: boolean;
    details: string;
  }[];
}

export async function runPreMigrationAuditSuite(): Promise<AuditTestReport> {
  const results: AuditTestReport['results'] = [];

  // -------------------------------------------------------------
  // Test 1: Full Audit of Static & Dynamic localStorage Keys
  // -------------------------------------------------------------
  try {
    DB.init();

    // 1. Static keys expected
    const expectedStaticKeys = [
      'cashier_products_v1',
      'cashier_parties_v1',
      'cashier_invoices_v1',
      'cashier_invoice_items_v1',
      'cashier_payments_v1',
      'cashier_expenses_v1',
      'cashier_settings_v1',
      'cashier_categories_v1',
    ];

    const currentKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) currentKeys.push(k);
    }

    // Check all static keys exist
    for (const k of expectedStaticKeys) {
      if (!currentKeys.includes(k)) {
        throw new Error(`المفتاح الثابت الأساسي "${k}" غير موجود في localStorage`);
      }
    }

    // 2. Simulate dynamic keys (cashier_held_*)
    localStorage.setItem('cashier_held_sale', JSON.stringify([{ id: 'h1', time: '12:00', items: [] }]));
    localStorage.setItem('cashier_held_purchase', JSON.stringify([{ id: 'h2', time: '12:30', items: [] }]));

    const testDb = new CashierDatabase(`Audit_Keys_${Date.now()}`);
    const pipeline = new MigrationPipeline(testDb);
    const hasLegacy = pipeline.detectLegacyData();

    // Clean up dynamic test keys
    localStorage.removeItem('cashier_held_sale');
    localStorage.removeItem('cashier_held_purchase');
    await testDb.delete();

    if (!hasLegacy) {
      throw new Error('فشل اكتشاف المفاتيح الديناميكية المحفوظة');
    }

    results.push({
      id: 1,
      category: 'تدقيق المفاتيح',
      name: 'تدقيق وحصر المفاتيح الثابتة والديناميكية (cashier_held_*)',
      passed: true,
      details: `تم التحقق من المفاتيح الثابتة الأساسية (${expectedStaticKeys.length}) والمفاتيح الديناميكية للفواتير المعلقة دون أي فقدان.`,
    });
  } catch (err: any) {
    results.push({
      id: 1,
      category: 'تدقيق المفاتيح',
      name: 'تدقيق وحصر المفاتيح الثابتة والديناميكية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 2: Snapshot Verification & Restoration Integrity
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Audit_SnapshotRestore_${Date.now()}`);
    await testDb.open();

    const sampleDump: LegacyLocalStorageDump = {
      products: [
        { id: 1, name: 'منتج أ', barcode: '111', category: 'عام', description: '', buy_price: 100, sell_price: 200, qty: 10 },
      ],
      parties: [
        { id: 1, name: 'عميل أ', phone: '0770', type: 'customer', balance: 0 },
      ],
      invoices: [],
      invoice_items: [],
      payments: [],
      expenses: [],
      settings: { storeName: 'متجر التدقيق', currency: 'د.ع', phone: '', address: '', taxRate: 0, receiptFooter: '' },
      categories: ['عام'],
      permissionsGranted: true,
      heldInvoices: [],
      rawKeyCounts: { products: 1, parties: 1 },
      timestamp: new Date().toISOString(),
    };

    // Create snapshot
    const { manifest } = await createSafeChunkedSnapshot(sampleDump, testDb);

    // Restore snapshot from IndexedDB
    const { data: restored, verified, error } = await restoreSafeChunkedSnapshot(manifest.snapshotId, testDb);

    if (!verified || !restored) {
      throw new Error(`فشلت استعادة اللقطة السليمة: ${error}`);
    }

    if (restored.products.length !== 1 || restored.products[0].name !== 'منتج أ') {
      throw new Error('البيانات المسترجعة لا تطابق الأصل');
    }

    await testDb.delete();

    results.push({
      id: 2,
      category: 'تدقيق Snapshot',
      name: 'استعادة الـ Snapshot والتحقق من سلامة البصمة (Valid Snapshot Restoration)',
      passed: true,
      details: `تمت استعادة اللقطة (${manifest.snapshotId}) وإعادة تجميع أجزائها والتحقق من البصمة (${manifest.checksum}) بنجاح 100%.`,
    });
  } catch (err: any) {
    results.push({
      id: 2,
      category: 'تدقيق Snapshot',
      name: 'استعادة الـ Snapshot والتحقق من سلامة البصمة',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 3: Snapshot Tampering & Corruption Detection
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Audit_SnapshotCorruption_${Date.now()}`);
    await testDb.open();

    const sampleDump: LegacyLocalStorageDump = {
      products: [{ id: 1, name: 'أصيل', barcode: '1', category: 'عام', description: '', buy_price: 50, sell_price: 100, qty: 5 }],
      parties: [],
      invoices: [],
      invoice_items: [],
      payments: [],
      expenses: [],
      settings: null,
      categories: [],
      permissionsGranted: false,
      heldInvoices: [],
      rawKeyCounts: { products: 1 },
      timestamp: new Date().toISOString(),
    };

    const { manifest } = await createSafeChunkedSnapshot(sampleDump, testDb);

    // Corrupt the data chunk in IndexedDB intentionally
    await testDb.migration_state.put({
      key: `snapshot_products_${manifest.snapshotId}`,
      value: [{ id: 1, name: 'بيانات ملعوب بها', barcode: 'TAMPERED', category: 'عام', buy_price: 99999, sell_price: 99999, qty: 99 }],
      timestamp: new Date().toISOString(),
    });

    // Attempt restoration: Checksum MUST catch tampering!
    const { verified, error } = await restoreSafeChunkedSnapshot(manifest.snapshotId, testDb);

    if (verified) {
      throw new Error('تم قبول لقطة متلاعب بها دون اكتشاف اختلاف البصمة الرقمية!');
    }

    // Now test missing/truncated chunk
    await testDb.migration_state.delete(`snapshot_parties_${manifest.snapshotId}`);
    const missingRes = await restoreSafeChunkedSnapshot(manifest.snapshotId, testDb);

    if (missingRes.verified) {
      throw new Error('تم قبول لقطة ناقصة تفتقر لأحد الأجزاء الأساسية!');
    }

    await testDb.delete();

    results.push({
      id: 3,
      category: 'تدقيق Snapshot',
      name: 'اكتشاف التلاعب واللقطات التالفة والناقصة (Tamper & Corruption Detection)',
      passed: true,
      details: `تم كشف التلاعب فوراً عبر عدم تطابق البصمة Checksum، وحظر استعادة اللقطة الناقصة برسالة خطأ صريحة.`,
    });
  } catch (err: any) {
    results.push({
      id: 3,
      category: 'تدقيق Snapshot',
      name: 'اكتشاف التلاعب واللقطات التالفة',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 4: Resume Audit - Interruption Scenarios & Idempotency
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Audit_ResumeIdempotency_${Date.now()}`);
    await testDb.open();
    const pipeline = new MigrationPipeline(testDb);

    const testDump: LegacyLocalStorageDump = {
      products: [
        { id: 10, name: 'منتج اختبار الاستئناف', barcode: '999', category: 'عام', description: '', buy_price: 500, sell_price: 1000, qty: 25 },
      ],
      parties: [
        { id: 20, name: 'عميل اختبار الاستئناف', phone: '07709998877', type: 'customer', balance: 5000 },
      ],
      invoices: [
        { id: 30, type: 'sale', party_id: 20, party_name: 'عميل اختبار الاستئناف', date: new Date().toISOString(), discount: 0, total: 5000, paid: 0, currency: 'د.ع' },
      ],
      invoice_items: [
        { id: 40, invoice_id: 30, product_id: 10, name: 'منتج اختبار الاستئناف', category: 'عام', qty: 5, price: 1000, cost: 500 },
      ],
      payments: [
        { id: 50, party_id: 20, party_name: 'عميل اختبار الاستئناف', amount: 2000, date: new Date().toISOString(), notes: 'دفعة نقدية', currency: 'د.ع' },
      ],
      expenses: [
        { id: 60, recipient: 'مصروف وقود', amount: 3000, date: new Date().toISOString(), notes: '', currency: 'د.ع' },
      ],
      settings: { storeName: 'متجر الاستئناف', currency: 'د.ع', phone: '', address: '', taxRate: 0, receiptFooter: '' },
      categories: ['عام'],
      permissionsGranted: true,
      heldInvoices: [],
      rawKeyCounts: {},
      timestamp: new Date().toISOString(),
    };

    // Scenario A: First execution
    const run1 = await pipeline.executeMigration(testDump);
    if (!run1.success) throw new Error('فشلت الدفعة الأولى من الترحيل');

    const p1 = await testDb.products.get(10);
    const pay1 = await testDb.payments.where('id').equals(50).toArray();

    if (p1?.qty !== 25) throw new Error(`رصيد المخزن بعد الدفعة الأولى غير صحيح: ${p1?.qty}`);
    if (pay1.length !== 1) throw new Error('تكرر سجل الدفعات');

    // Scenario B: Repeat the EXACT same batch again (Simulating resume after crash)
    const run2 = await pipeline.executeMigration(testDump);
    if (!run2.success) throw new Error('فشلت إعادة تنفيذ نفس الدفعة');

    const p2 = await testDb.products.get(10);
    const allProducts = await testDb.products.toArray();
    const allPayments = await testDb.payments.toArray();
    const allInvoices = await testDb.invoices.toArray();

    // STRICT CHECK: Count must remain 1, stock must remain 25 (NEVER 50), payment must remain 1 (NEVER 2)
    if (allProducts.length !== 1 || p2?.qty !== 25) {
      throw new Error(`تضاعف رصيد المخزن أو تكرر المنتج عند إعادة المحاولة! العدد=${allProducts.length}, الرصيد=${p2?.qty}`);
    }
    if (allPayments.length !== 1) {
      throw new Error(`تكررت الدفعات المالية عند إعادة الاستئناف! العدد=${allPayments.length}`);
    }
    if (allInvoices.length !== 1) {
      throw new Error(`تكررت الفواتير عند إعادة الاستئناف! العدد=${allInvoices.length}`);
    }

    await testDb.delete();

    results.push({
      id: 4,
      category: 'تدقيق الاستئناف',
      name: 'اختبار حالات الانقطاع وإعادة التنفيذ وحظر تكرار السجلات أو تضاعف الأرصدة (Idempotency Audit)',
      passed: true,
      details: 'تمت إعادة تنفيذ الدفعة ذاتها؛ أثبتت التجربة ثبات السجلات 100% وعدم تضاعف أرصدة المخزن (25 قطعة) أو الدفعات المالية نهائياً.',
    });
  } catch (err: any) {
    results.push({
      id: 4,
      category: 'تدقيق الاستئناف',
      name: 'اختبار حالات الانقطاع وإعادة التنفيذ',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 5: Relational Audit - Retail Cash Invoices (party_id = null)
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Audit_RetailNullParty_${Date.now()}`);
    await testDb.open();
    const pipeline = new MigrationPipeline(testDb);

    // Retail cash invoice with party_id: null and party_name: "مفرد"
    const retailDump: LegacyLocalStorageDump = {
      products: [{ id: 1, name: 'بيبسي علبة', barcode: '123', category: 'مشروبات', description: '', buy_price: 500, sell_price: 750, qty: 100 }],
      parties: [], // No customers table needed for walk-in retail!
      invoices: [
        { id: 100, type: 'sale', party_id: null, party_name: 'مفرد', date: new Date().toISOString(), discount: 0, total: 750, paid: 750, currency: 'د.ع' },
      ],
      invoice_items: [
        { id: 200, invoice_id: 100, product_id: 1, name: 'بيبسي علبة', category: 'مشروبات', qty: 1, price: 750, cost: 500 },
      ],
      payments: [],
      expenses: [],
      settings: null,
      categories: ['مشروبات'],
      permissionsGranted: true,
      heldInvoices: [],
      rawKeyCounts: {},
      timestamp: new Date().toISOString(),
    };

    const res = await pipeline.executeMigration(retailDump);

    if (!res.success) {
      throw new Error(`فشل قبول الفاتورة النقدية ذات party_id: null: ${res.report.errors.join(', ')}`);
    }

    const relationalErrors = await pipeline.validateRelationalIntegrity();
    if (relationalErrors.length > 0) {
      throw new Error(`خطأ في التحقق العلائقي لمبيعات المفرد: ${relationalErrors.join('; ')}`);
    }

    await testDb.delete();

    results.push({
      id: 5,
      category: 'التدقيق المالي والعلائقي',
      name: 'قبول فواتير المفرد النقدية (party_id = null) دون اشتراط جهة تعامل إجبارية',
      passed: true,
      details: 'تم تأكيد قبول فواتير البيع النقدي المباشر ("مفرد") ذات party_id: null دون فرض علاقة غير منطقية بجدول العملاء.',
    });
  } catch (err: any) {
    results.push({
      id: 5,
      category: 'التدقيق المالي والعلائقي',
      name: 'قبول فواتير المفرد النقدية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 6: Financial Audit - Credit, Returns, and Financial Reconciliations
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Audit_FinancialReconcile_${Date.now()}`);
    await testDb.open();
    const pipeline = new MigrationPipeline(testDb);

    const financialDump: LegacyLocalStorageDump = {
      products: [
        { id: 1, name: 'سمن نباتي', barcode: '900', category: 'غذائية', description: '', buy_price: 4000, sell_price: 6000, qty: 20 },
      ],
      parties: [
        { id: 50, name: 'زبون آجل سامر', phone: '0771', type: 'customer', balance: 6000 },
      ],
      invoices: [
        // Credit sale: total 12000, paid 6000 => remaining debt = 6000
        { id: 701, type: 'sale', party_id: 50, party_name: 'زبون آجل سامر', date: new Date().toISOString(), discount: 0, total: 12000, paid: 6000, currency: 'د.ع' },
        // Sale return: total 2000, paid 2000
        { id: 702, type: 'sale_return', party_id: 50, party_name: 'زبون آجل سامر', date: new Date().toISOString(), discount: 0, total: 2000, paid: 2000, currency: 'د.ع' },
      ],
      invoice_items: [
        { id: 801, invoice_id: 701, product_id: 1, name: 'سمن نباتي', category: 'غذائية', qty: 2, price: 6000, cost: 4000 },
        { id: 802, invoice_id: 702, product_id: 1, name: 'سمن نباتي', category: 'غذائية', qty: 1, price: 2000, cost: 4000 },
      ],
      payments: [
        { id: 901, party_id: 50, party_name: 'زبون آجل سامر', amount: 6000, date: new Date().toISOString(), notes: 'دفعة سداد نقدية', currency: 'د.ع' },
      ],
      expenses: [
        { id: 950, recipient: 'أجور صيانة', amount: 15000, date: new Date().toISOString(), notes: 'كهرباء', currency: 'د.ع' },
      ],
      settings: null,
      categories: ['غذائية'],
      permissionsGranted: true,
      heldInvoices: [],
      rawKeyCounts: {},
      timestamp: new Date().toISOString(),
    };

    const res = await pipeline.executeMigration(financialDump);
    if (!res.success) {
      throw new Error(`فشل ترحيل العمليات المالية: ${res.report.errors.join('; ')}`);
    }

    // Verify financial match
    const rep = res.report;
    if (!rep.financials.matches || !rep.financials.expensesMatch || !rep.financials.paymentsMatch) {
      throw new Error('عدم تطابق الإجماليات المالية بين المصدر والوجهة!');
    }

    if (rep.financials.originalInvoicesTotal !== 14000 || rep.financials.originalExpensesTotal !== 15000) {
      throw new Error('احتساب الإجماليات المالية غير دقيق');
    }

    await testDb.delete();

    results.push({
      id: 6,
      category: 'التدقيق المالي والعلائقي',
      name: 'تدقيق العمليات المالية والآجلة والمرتجعات والمطابقة الحسابية الدقيقة',
      passed: true,
      details: 'تم تدقيق الفواتير الآجلة والمرتجعات والمصروفات بمطابقة مالية تامة (فواتير: 14,000 د.ع، مصروفات: 15,000 د.ع، دفعات: 6,000 د.ع).',
    });
  } catch (err: any) {
    results.push({
      id: 6,
      category: 'التدقيق المالي والعلائقي',
      name: 'تدقيق العمليات المالية والآجلة والمرتجعات',
      passed: false,
      details: err.message,
    });
  }

  const passedTests = results.filter((r) => r.passed).length;
  const allPassed = passedTests === results.length;

  return {
    allPassed,
    totalTests: results.length,
    passedTests,
    results,
  };
}
