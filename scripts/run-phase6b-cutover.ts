import 'fake-indexeddb/auto';

// Polyfill in-memory localStorage for Node test runner
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

import { DB, setOperationalSource } from '../src/services/db';
import { cashierStorageDb } from '../src/services/storage/schema';
import { executePhase6BCutover } from '../src/services/storage/cutover/phase6bCutoverExecutor';

async function main() {
  console.log('================================================================');
  console.log('   بدء تنفيذ المرحلة 6B: التبديل التشغيلي الحقيقي (Real Controlled Switchover)');
  console.log('================================================================\n');

  // Ensure initial legacy data exists in localStorage for testing
  setOperationalSource('localStorage');
  DB.init();

  try {
    const report = await executePhase6BCutover(cashierStorageDb);

    console.log(`⏱️ وقت التبديل: ${report.timestamp}`);
    console.log(`🔒 مدة تجميد العمليات (Write Freeze): ${report.writeFreezeDurationMs} ms`);
    console.log(`🔄 مزامنة الدلتا: ${report.deltaSyncExecuted ? `نعم (${report.deltaRecordsSynced} سجل)` : 'غير مطلوبة (البيانات مطابقة)'}\n`);

    console.log('----------------------------------------------------------------');
    console.log('📊 أعداد السجلات والأرصدة المالية قبل التبديل:');
    console.log(`   - المنتجات:            ${report.preMetricsLocalStorage.productsCount}`);
    console.log(`   - إجمالي المخزون:      ${report.preMetricsLocalStorage.totalStockQuantity} قطعة`);
    console.log(`   - قيمة المخزون التقديرية: ${report.preMetricsLocalStorage.totalInventoryCost} د.ع`);
    console.log(`   - العملاء والموردون:   ${report.preMetricsLocalStorage.partiesCount}`);
    console.log(`   - الفواتير:             ${report.preMetricsLocalStorage.invoicesCount}`);
    console.log(`   - إجمالي المبيعات:      ${report.preMetricsLocalStorage.totalSalesAmount} د.ع`);
    console.log(`   - إجمالي المقبوض:      ${report.preMetricsLocalStorage.totalPaidAmount} د.ع`);
    console.log(`   - المصروفات:            ${report.preMetricsLocalStorage.totalExpensesAmount} د.ع`);
    console.log('----------------------------------------------------------------\n');

    console.log('----------------------------------------------------------------');
    console.log('💾 النسخ الاحتياطية المستقلة والتحقق من الاستعادة:');
    console.log(`   - نسخة localStorage:  بصمة (${report.backups.localStorageBackup.checksum.substring(0, 16)}...) | التحقق: ${report.backups.localStorageBackup.verifiedRestorable ? '✅ تم التحقق والاستعادة' : '❌ فشل'}`);
    console.log(`   - نسخة CashierPro_DB: بصمة (${report.backups.dexieBackup.checksum.substring(0, 16)}...) | التحقق: ${report.backups.dexieBackup.verifiedRestorable ? '✅ تم التحقق والاستعادة' : '❌ فشل'}`);
    console.log('----------------------------------------------------------------\n');

    console.log('----------------------------------------------------------------');
    console.log('🧪 نتائج اختبارات التشغيل الفعلية بعد التبديل (Live Smoke Tests):');
    report.smokeTests.details.forEach((d, idx) => {
      console.log(`   ${idx + 1}. ✅ ${d}`);
    });
    console.log('----------------------------------------------------------------\n');

    console.log('----------------------------------------------------------------');
    console.log(`🛡️ مصدر التشغيل النشط الآن:     ${report.operationalSourceNow.toUpperCase()} (Single Source of Truth)`);
    console.log(`🚫 حظر الكتابة التشغيلية المزدوجة: ${report.dualWritePrevented ? '✅ مؤكد (0 بايت كُتبت في localStorage)' : '❌ فشل'}`);
    console.log(`🏆 النتيجة الإجمالية للمرحلة 6B:  ${report.success ? '✅ اكتملت بنجاح 100%' : '❌ فشلت'}`);
    console.log('----------------------------------------------------------------');

    process.exit(report.success ? 0 : 1);
  } catch (err: any) {
    console.error('❌ خطأ أثناء تنفيذ المرحلة 6B:', err);
    process.exit(1);
  }
}

main();
