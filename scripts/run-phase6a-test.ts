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

import { DB } from '../src/services/db';
import { cashierStorageDb } from '../src/services/storage/schema';
import { readLegacyLocalStorage } from '../src/services/storage/migration/reader';
import { migrateLegacyDataToDexie } from '../src/services/storage/migration/migrator';
import { runPhase6aRehearsalTests } from '../src/services/storage/test/phase6aTest';

async function main() {
  console.log('================================================================');
  console.log('   بدء تشغيل اختبارات المرحلة السادسة A: محاكاة التبديل التشغيلي المدار (Switchover Rehearsal)');
  console.log('================================================================\n');

  // Initialize store data and cashierStorageDb if needed
  DB.init();
  if ((await cashierStorageDb.products.count()) === 0) {
    const dump = readLegacyLocalStorage();
    await migrateLegacyDataToDexie(dump, cashierStorageDb);
  }

  try {
    const result = await runPhase6aRehearsalTests();

    result.outcomes.forEach((o) => {
      const symbol = o.passed ? '✅ [نجاح]' : '❌ [فشل]';
      console.log(`${symbol} #${o.testId}: ${o.title}`);
      console.log(`   التفاصيل: ${o.details}\n`);
    });

    if (result.metrics?.pillar2CacheAdapter.readLatencyMs) {
      const lat = result.metrics.pillar2CacheAdapter.readLatencyMs;
      console.log('----------------------------------------------------------------');
      console.log('📊 قياسات سرعة القراءة الفعلية (Measured Latency):');
      console.log(`   - جلب كافة المنتجات (getProducts): ${lat.getProductsAvgMs} ms`);
      console.log(`   - استعلام الباركود (Barcode Lookup): ${lat.barcodeLookupAvgMs} ms`);
      console.log(`   - البحث والفلترة (Search Filtering): ${lat.searchFilterAvgMs} ms`);
      console.log('----------------------------------------------------------------\n');
    }

    console.log('----------------------------------------------------------------');
    console.log(`إجمالي الاختبارات: ${result.total} | الناجحة: ${result.passed} | الفاشلة: ${result.failed}`);
    console.log(`الوقت المستغرق: ${result.durationMs} ms`);
    console.log(`الحالة النهائية: ${result.allPassed ? 'نجحت جميع اختبارات محاكاة التبديل التشغيلي للمرحلة السادسة A بنسبة 100%' : 'توجد إخفاقات تتطلب المعالجة'}`);
    console.log('----------------------------------------------------------------');

    if (!result.allPassed) {
      process.exit(1);
    }
  } catch (err) {
    console.error('حدث خطأ أثناء تشغيل اختبارات المرحلة السادسة A:', err);
    process.exit(1);
  }
}

main();
