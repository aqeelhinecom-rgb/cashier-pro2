import 'fake-indexeddb/auto';

// Polyfill in-memory localStorage for Node test environment
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
import { runPhase7aVerification } from '../src/services/storage/test/phase7aTest';

import { readLegacyLocalStorage } from '../src/services/storage/migration/reader';
import { migrateLegacyDataToDexie } from '../src/services/storage/migration/migrator';

async function main() {
  console.log('================================================================');
  console.log('   بدء تنفيذ تدقيق واختبار المرحلة 7A: محرك النسخ الاحتياطي الكامل لـ Dexie');
  console.log('================================================================\n');

  // Initialize DB and ensure Dexie has the store data
  setOperationalSource('localStorage');
  DB.init();

  // Seed Dexie from current DB state if empty so tests run against genuine catalog
  const prodCount = await cashierStorageDb.products.count();
  if (prodCount === 0) {
    const legacyDump = readLegacyLocalStorage();
    await migrateLegacyDataToDexie(legacyDump, cashierStorageDb);
  }

  // Switch to Dexie operational source as required
  setOperationalSource('dexie');

  try {
    const report = await runPhase7aVerification();

    console.log(`⏱️ وقت انتهاء الاختبار: ${report.timestamp}`);
    console.log(`📊 إجمالي السجلات الأصلية: ${report.metrics.originalRecordsCount}`);
    console.log(`📊 إجمالي السجلات المستعادة: ${report.metrics.restoredRecordsCount}`);
    console.log(`💾 حجم ملف النسخة الاحتياطية: ${(report.metrics.backupSizeBytes / 1024).toFixed(2)} KB`);
    console.log(`🔑 بصمة التحقق الرقمية SHA-256: ${report.metrics.checksum}`);
    console.log(`📂 عدد النسخ في السجل التاريخي: ${report.metrics.historicalBackupsCount}\n`);

    console.log('----------------------------------------------------------------');
    console.log('🧪 نتائج الفحوصات الثمانية للمرحلة 7A:');
    report.checks.forEach((c) => {
      console.log(`\n${c.passed ? '✅' : '❌'} ${c.testName}`);
      console.log(`   📝 التفاصيل: ${c.details}`);
    });
    console.log('\n----------------------------------------------------------------');
    console.log(`🏆 النتيجة الإجمالية للمرحلة 7A: ${report.success ? '✅ اكتملت جميع اختبارات 7A بنجاح 100%' : '❌ فشل أحد الاختبارات'}`);
    console.log('================================================================');

    process.exit(report.success ? 0 : 1);
  } catch (err: any) {
    console.error('❌ خطأ أثناء تشغيل اختبارات المرحلة 7A:', err);
    process.exit(1);
  }
}

main();
