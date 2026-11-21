import { runStandaloneStorageTestSuite } from '../src/services/storage/test/standaloneTest';

async function main() {
  console.log('====================================================');
  console.log('   بدء تشغيل الاختبارات المستقلة لمحرك Dexie Storage');
  console.log('====================================================\n');

  const start = Date.now();
  const suite = await runStandaloneStorageTestSuite();
  const duration = Date.now() - start;

  suite.results.forEach((res) => {
    const symbol = res.passed ? '✅ [نجاح]' : '❌ [فشل]';
    console.log(`${symbol} #${res.id}: ${res.name}`);
    console.log(`   التفاصيل: ${res.details}\n`);
  });

  console.log('----------------------------------------------------');
  console.log(`إجمالي الاختبارات: ${suite.totalTests} | الناجحة: ${suite.passedTests} | الفاشلة: ${suite.totalTests - suite.passedTests}`);
  console.log(`الوقت المستغرق: ${duration} ms`);
  console.log(`الحالة النهائية: ${suite.allPassed ? 'نجحت جميع الاختبارات بنسبة 100%' : 'توجد اختبارات فاشلة'}`);
  console.log('----------------------------------------------------');

  if (!suite.allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
