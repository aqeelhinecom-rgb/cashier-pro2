// Polyfill minimal in-memory localStorage for Node test runner before running tests
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

import { runPhase3bTestSuite } from '../src/services/storage/test/phase3bTest';

async function main() {
  console.log('====================================================');
  console.log('   بدء تشغيل اختبارات المرحلة 3B للمعاملات الذرية في Dexie');
  console.log('====================================================\n');

  const start = Date.now();
  const suite = await runPhase3bTestSuite();
  const duration = Date.now() - start;

  suite.results.forEach((res) => {
    const symbol = res.passed ? '✅ [نجاح]' : '❌ [فشل]';
    console.log(`${symbol} #${res.id}: ${res.name}`);
    console.log(`   التفاصيل: ${res.details}\n`);
  });

  console.log('----------------------------------------------------');
  console.log(`إجمالي الاختبارات: ${suite.totalTests} | الناجحة: ${suite.passedTests} | الفاشلة: ${suite.totalTests - suite.passedTests}`);
  console.log(`الوقت المستغرق: ${duration} ms`);
  console.log(`الحالة النهائية: ${suite.allPassed ? 'نجحت جميع اختبارات المرحلة 3B بنسبة 100%' : 'توجد اختبارات فاشلة'}`);
  console.log('----------------------------------------------------');

  if (!suite.allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal Phase 3B Test Runner Error:', err);
  process.exit(1);
});
