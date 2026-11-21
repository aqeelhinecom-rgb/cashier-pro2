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

import { runPhase5OperationalReadinessTests } from '../src/services/storage/test/phase5Test';

async function main() {
  console.log('================================================================');
  console.log('   بدء تشغيل اختبارات المرحلة الخامسة: تدقيق الجاهزية التشغيلية (Operational Readiness Audit)');
  console.log('================================================================\n');

  try {
    const result = await runPhase5OperationalReadinessTests();

    result.outcomes.forEach((o) => {
      const symbol = o.passed ? '✅ [نجاح]' : '❌ [فشل]';
      console.log(`${symbol} #${o.testId}: ${o.title}`);
      console.log(`   التفاصيل: ${o.details}\n`);
    });

    console.log('----------------------------------------------------------------');
    console.log(`إجمالي الاختبارات: ${result.total} | الناجحة: ${result.passed} | الفاشلة: ${result.failed}`);
    console.log(`الوقت المستغرق: ${result.durationMs} ms`);
    console.log(`الحالة النهائية: ${result.allPassed ? 'نجحت جميع اختبارات الجاهزية التشغيلية للمرحلة الخامسة بنسبة 100%' : 'توجد إخفاقات تتطلب المعالجة'}`);
    console.log('----------------------------------------------------------------');

    if (!result.allPassed) {
      process.exit(1);
    }
  } catch (err) {
    console.error('حدث خطأ أثناء تشغيل اختبارات المرحلة الخامسة:', err);
    process.exit(1);
  }
}

main();
