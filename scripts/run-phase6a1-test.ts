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
import { runPhase6a1SafetyTestSuite } from '../src/services/storage/test/phase6a1Test';

async function main() {
  console.log('================================================================');
  console.log('   بدء تشغيل اختبارات المرحلة 6A.1: تدقيق السلامة النهائي قبل التبديل (Final Cutover Safety Audit)');
  console.log('================================================================\n');

  // Initialize store data and cashierStorageDb if needed
  DB.init();
  if ((await cashierStorageDb.products.count()) === 0) {
    const dump = readLegacyLocalStorage();
    await migrateLegacyDataToDexie(dump, cashierStorageDb);
  }

  try {
    const suite = await runPhase6a1SafetyTestSuite();

    suite.outcomes.forEach((o) => {
      const symbol = o.passed ? '✅ [نجاح]' : '❌ [فشل]';
      console.log(`${symbol} #${o.testId}: ${o.title}`);
      console.log(`   التفاصيل: ${o.details}\n`);
    });

    const lat = suite.results.cacheVsIndexedDbLatency;
    console.log('----------------------------------------------------------------');
    console.log('📊 قياسات سرعة القراءة الفعلية المنفصلة:');
    console.log(`   - قراءة الذاكرة (In-Memory Cache):       ${lat.cacheReadLatencyMs.getProductsAvgMs} ms`);
    console.log(`   - استعلام الباركود في الذاكرة (Cache):   ${lat.cacheReadLatencyMs.barcodeLookupAvgMs} ms`);
    console.log(`   - قراءة القرص (IndexedDB Disk):         ${lat.indexedDbReadLatencyMs.getProductsAvgMs} ms`);
    console.log(`   - استعلام الباركود في القرص (IndexedDB): ${lat.indexedDbReadLatencyMs.barcodeLookupAvgMs} ms`);
    console.log(`   - فارق السرعة: الكاش أسرع بـ ${lat.speedRatio} ضعفاً من الاستعلام المباشر من القرص.`);
    console.log('----------------------------------------------------------------\n');

    console.log('----------------------------------------------------------------');
    console.log(`إجمالي الاختبارات: ${suite.total} | الناجحة: ${suite.passed} | الفاشلة: ${suite.failed}`);
    console.log(`الوقت المستغرق: ${suite.durationMs} ms`);
    console.log(`الحالة النهائية: ${suite.allPassed ? 'نجحت جميع اختبارات تدقيق السلامة للمرحلة 6A.1 بنسبة 100%' : 'توجد إخفاقات تتطلب المعالجة'}`);
    console.log('----------------------------------------------------------------');

    process.exit(suite.allPassed ? 0 : 1);
  } catch (err) {
    console.error('حدث خطأ أثناء تشغيل اختبارات المرحلة 6A.1:', err);
    process.exit(1);
  }
}

main();
