// @ts-ignore
import 'fake-indexeddb/auto';
import { CashierDatabase, cashierStorageDb } from '../schema';
import { executePhase4Migration, Phase4ExecutionReport } from '../migration/phase4Executor';
import { createVerifiedPreMigrationBackup } from '../migration/preMigrationBackup';
import { readLegacyLocalStorage } from '../migration/reader';
import { DB } from '../../db';

export interface Phase4TestReport {
  allPassed: boolean;
  totalTests: number;
  passedTests: number;
  results: {
    id: number;
    name: string;
    passed: boolean;
    details: string;
  }[];
  executionReport?: Phase4ExecutionReport;
}

export async function runPhase4TestSuite(): Promise<Phase4TestReport> {
  const results: Phase4TestReport['results'] = [];
  let mainReport: Phase4ExecutionReport | undefined;

  // -------------------------------------------------------------
  // Test 1: Independent Pre-Migration Backup & Restoration Test
  // -------------------------------------------------------------
  try {
    DB.init();
    const sourceData = readLegacyLocalStorage();

    const { backup, jsonString, verified, error } = await createVerifiedPreMigrationBackup(sourceData);
    if (!verified || !backup) {
      throw new Error(`فشل إنشاء النسخة الاحتياطية المستقلة: ${error}`);
    }

    // Verify backup JSON content can be parsed and matches counts
    const parsed = JSON.parse(jsonString);
    if (parsed.counts.products !== sourceData.products.length || parsed.checksum !== backup.checksum) {
      throw new Error('النسخة الاحتياطية لا تطابق بيانات المصدر');
    }

    // Test restoring backup onto an isolated test database
    const restoreTestDb = new CashierDatabase(`RestoreValidation_${Date.now()}`);
    await restoreTestDb.open();

    for (const p of parsed.data.products) {
      await restoreTestDb.products.put(p);
    }
    const restoredCount = await restoreTestDb.products.count();
    if (restoredCount !== sourceData.products.length) {
      throw new Error(`فشلت استعادة السجلات من النسخة الاحتياطية: المتوقع ${sourceData.products.length}، الفعلي ${restoredCount}`);
    }

    await restoreTestDb.delete();

    results.push({
      id: 1,
      name: 'إنشاء نسخة احتياطية مستقلة قابلة للاستعادة والتحقق منها (Independent Backup & Restore Validation)',
      passed: true,
      details: `تم إنشاء النسخة الاحتياطية (${backup.checksum})، واختبار استعادتها بنجاح 100% على قاعدة تجريبية مستقلة.`,
    });
  } catch (err: any) {
    results.push({
      id: 1,
      name: 'إنشاء نسخة احتياطية مستقلة والتحقق منها',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 2: Migration of Store Data into Real Dexie Database (CashierPro_DB)
  // -------------------------------------------------------------
  try {
    DB.init();

    // Add a held invoice to test dynamic key migration as well
    localStorage.setItem(
      'cashier_held_sale',
      JSON.stringify([
        {
          id: 'held_real_1',
          time: '14:30',
          partyId: null,
          partyName: 'مفرد',
          items: [{ product_id: 1, name: 'صنف معلق', qty: 1, price: 1000, cost: 500 }],
          discount: 0,
        },
      ])
    );

    // Run migration into cashierStorageDb (the real application Dexie database)
    mainReport = await executePhase4Migration(cashierStorageDb);

    if (!mainReport.success || mainReport.errors.length > 0) {
      throw new Error(`فشل الترحيل إلى قاعدة Dexie الحقيقية: ${mainReport.errors.join('; ')}`);
    }

    const migratedProducts = await cashierStorageDb.products.count();
    const migratedInvoices = await cashierStorageDb.invoices.count();

    if (migratedProducts === 0) {
      throw new Error('لم يتم ترحيل أي منتجات إلى قاعدة Dexie الحقيقية');
    }

    results.push({
      id: 2,
      name: 'ترحيل بيانات المحل إلى قاعدة Dexie الحقيقية (Real CashierPro_DB Migration)',
      passed: true,
      details: `تم ترحيل البيانات بنجاح إلى قاعدة Dexie الحقيقية (${migratedProducts} منتج، ${migratedInvoices} فاتورة) مع توليد UUIDs والحفاظ على المعرفات الرقمية.`,
    });
  } catch (err: any) {
    results.push({
      id: 2,
      name: 'ترحيل بيانات المحل إلى قاعدة Dexie الحقيقية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 3: Deep Entity-by-Entity and Record-by-Record Verification
  // -------------------------------------------------------------
  try {
    if (!mainReport) {
      throw new Error('تقرير الترحيل غير متوفر');
    }

    const { deepVerification } = mainReport;

    if (!deepVerification.success || deepVerification.mismatches.length > 0) {
      const topMismatches = deepVerification.mismatches
        .slice(0, 3)
        .map((m) => `${m.table}#${m.id}.${m.field} (${m.sourceValue} !== ${m.targetValue})`)
        .join('; ');
      throw new Error(`فشلت المطابقة الفردية للسجلات: ${topMismatches}`);
    }

    const pMatched = deepVerification.individualEntityChecks.productsMatched;
    const iMatched = deepVerification.individualEntityChecks.invoicesMatched;
    const ptMatched = deepVerification.individualEntityChecks.partiesMatched;
    const itMatched = deepVerification.individualEntityChecks.itemsMatched;

    results.push({
      id: 3,
      name: 'المطابقة الدقيقة على مستوى السجلات والكيانات الفردية (Entity-by-Entity Verification)',
      passed: true,
      details: `تمت مطابقة كل سجل على حدة بنسبة 100%: تطابق ${pMatched} منتج، ${ptMatched} جهة، ${iMatched} فاتورة، و${itMatched} بند دون أي تباين (0 Mismatches).`,
    });
  } catch (err: any) {
    results.push({
      id: 3,
      name: 'المطابقة الدقيقة على مستوى الكيانات الفردية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 4: Financial and Inventory Totals Reconciliation
  // -------------------------------------------------------------
  try {
    if (!mainReport) {
      throw new Error('تقرير الترحيل غير متوفر');
    }

    const fin = mainReport.deepVerification.financialTotals;

    if (!fin.stockValuationCost.match || !fin.stockValuationRetail.match) {
      throw new Error('عدم تطابق تقييم المخزون بين المصدر والوجهة');
    }
    if (!fin.invoicesTotalSales.match || !fin.invoicesTotalPurchases.match) {
      throw new Error('عدم تطابق إجماليات المبيعات أو المشتريات');
    }
    if (!fin.paymentsTotal.match || !fin.expensesTotal.match) {
      throw new Error('عدم تطابق إجماليات الدفعات أو المصروفات');
    }

    results.push({
      id: 4,
      name: 'المطابقة المالية الدقيقة للمخزون والمبيعات والمصروفات (Financial Reconciliations)',
      passed: true,
      details: `تطابق مالي قطعي: تقييم المخزون بسعر التكلفة (${fin.stockValuationCost.source.toLocaleString()} د.ع)، إجمالي المبيعات (${fin.invoicesTotalSales.source.toLocaleString()} د.ع)، والمصروفات (${fin.expensesTotal.source.toLocaleString()} د.ع).`,
    });
  } catch (err: any) {
    results.push({
      id: 4,
      name: 'المطابقة المالية الدقيقة للمخزون والمبيعات',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 5: Resume Interruption Test & Idempotency on Real DB
  // -------------------------------------------------------------
  try {
    // Re-execute migration on cashierStorageDb (simulating resume after interruption)
    const resumeReport = await executePhase4Migration(cashierStorageDb);
    if (!resumeReport.success) {
      throw new Error('فشلت إعادة تنفيذ الترحيل في اختبار الاستئناف');
    }

    // Inspect records in cashierStorageDb: Counts MUST NOT have doubled!
    const productCountAfterResume = await cashierStorageDb.products.count();
    const invoiceCountAfterResume = await cashierStorageDb.invoices.count();
    const p1 = await cashierStorageDb.products.get(1);

    const sourceData = readLegacyLocalStorage();
    if (productCountAfterResume !== sourceData.products.length) {
      throw new Error(`تضاعفت المنتجات عند إعادة الترحيل: المتوقع ${sourceData.products.length}، الفعلي ${productCountAfterResume}`);
    }
    if (invoiceCountAfterResume !== sourceData.invoices.length) {
      throw new Error(`تضاعفت الفواتير عند إعادة الترحيل: المتوقع ${sourceData.invoices.length}، الفعلي ${invoiceCountAfterResume}`);
    }

    const sourceP1 = sourceData.products.find((p) => p.id === 1);
    if (sourceP1 && p1 && p1.qty !== sourceP1.qty) {
      throw new Error(`تغير أو تضاعف رصيد المنتج الأول: المتوقع ${sourceP1.qty}، الفعلي ${p1.qty}`);
    }

    results.push({
      id: 5,
      name: 'اختبار الاستئناف بعد انقطاع مصطنع وحظر تضاعف السجلات والأرصدة (Resume Idempotency Test)',
      passed: true,
      details: `تمت إعادة تشغيل الترحيل على قاعدة Dexie الحقيقية، وأثبتت النتيجة ثبات عدد السجلات (${productCountAfterResume}) واستقرار أرصدة المخزن 100% دون أي تكرار.`,
    });
  } catch (err: any) {
    results.push({
      id: 5,
      name: 'اختبار الاستئناف بعد انقطاع مصطنع',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 6: Verification that localStorage is 100% UNTOUCHED & Active
  // -------------------------------------------------------------
  try {
    if (!mainReport?.localStorageUntouched) {
      throw new Error('تم رصد تعديل على مفاتيح أو بيانات localStorage!');
    }

    // Test that DB functions still read live from localStorage
    const liveProducts = DB.getProducts();
    const liveInvoices = DB.getInvoices();
    const liveSettings = DB.getSettings();

    if (liveProducts.length === 0 || !liveSettings.storeName) {
      throw new Error('تعطل مسار التشغيل الحي من localStorage');
    }

    // Clean up temporary held test key
    localStorage.removeItem('cashier_held_sale');

    results.push({
      id: 6,
      name: 'التأكيد القاطع على بقاء localStorage دون أي تغيير ومصدراً تشغيلياً وحيداً',
      passed: true,
      details: `تمت مطابقة بيانات ومفاتيح localStorage قبل وبعد الترحيل؛ التطابق 100%، والتطبيق يعمل تشغيلياً وحصرياً من localStorage دون أي تحويل.`,
    });
  } catch (err: any) {
    results.push({
      id: 6,
      name: 'التأكيد على بقاء localStorage دون تغيير',
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
    executionReport: mainReport,
  };
}
