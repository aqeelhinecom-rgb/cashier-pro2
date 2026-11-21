import { cashierStorageDb as cashierDb } from '../schema';
import {
  createFullDexieBackup,
  validateBackupInSandbox,
  restoreDexieBackupSafely,
  listHistoricalBackups,
  deleteHistoricalBackup,
  checkAndRunDailyAutoBackup,
} from '../backup/dexieBackupEngine';

export interface Phase7aTestReport {
  timestamp: string;
  success: boolean;
  checks: {
    testName: string;
    passed: boolean;
    details: string;
  }[];
  metrics: {
    originalRecordsCount: number;
    restoredRecordsCount: number;
    historicalBackupsCount: number;
    backupSizeBytes: number;
    checksum: string;
  };
}

export async function runPhase7aVerification(): Promise<Phase7aTestReport> {
  const checks: Phase7aTestReport['checks'] = [];

  // Step 1: Capture initial production state
  const initialCounts = {
    products: await cashierDb.products.count(),
    parties: await cashierDb.parties.count(),
    invoices: await cashierDb.invoices.count(),
    invoice_items: await cashierDb.invoice_items.count(),
    payments: await cashierDb.payments.count(),
    expenses: await cashierDb.expenses.count(),
    held_invoices: await cashierDb.held_invoices.count(),
    categories: await cashierDb.categories.count(),
    settings: await cashierDb.settings.count(),
    product_images: await cashierDb.product_images.count(),
    change_journal: await cashierDb.change_journal.count(),
    migration_state: await cashierDb.migration_state.count(),
  };

  const initialTotalRecords = Object.values(initialCounts).reduce((a, b) => a + b, 0);

  // Test 1: Full Backup Creation
  let backupResult: Awaited<ReturnType<typeof createFullDexieBackup>>;
  try {
    backupResult = await createFullDexieBackup('manual', 'نسخة تدقيق 7A');
    const file = backupResult.backupFile;
    const isChecksumValid = typeof file.checksum === 'string' && file.checksum.length === 64;
    const allTablesPresent = Object.keys(file.data).length === 12;

    checks.push({
      testName: '1. إنشاء نسخة احتياطية كاملة (12 جدول + بصمة SHA-256)',
      passed: isChecksumValid && allTablesPresent && file.totalRecords === initialTotalRecords,
      details: `تم إنشاء النسخة (${backupResult.fileName}) بإجمالي ${file.totalRecords} سجل، وحجم ${backupResult.backupRecord.sizeBytes} بايت، والبصمة: ${file.checksum.substring(0, 16)}...`,
    });
  } catch (err: any) {
    checks.push({
      testName: '1. إنشاء نسخة احتياطية كاملة',
      passed: false,
      details: `فشل إنشاء النسخة: ${err.message}`,
    });
    throw err;
  }

  // Test 2: Isolated Sandbox Verification
  try {
    const sandboxCheck = await validateBackupInSandbox(backupResult.jsonString);
    checks.push({
      testName: '2. فحص النسخة في بيئة Sandbox معزولة مؤقتة',
      passed: sandboxCheck.valid && sandboxCheck.manifest?.checksum === backupResult.backupFile.checksum,
      details: sandboxCheck.valid
        ? `نجح الفحص في Sandbox: تطابقت البصمة والسجلات (${sandboxCheck.manifest?.totalRecords} سجل) وتم تدمير قاعدة Sandbox بعد الفحص`
        : `فشل الفحص: ${sandboxCheck.error}`,
    });
  } catch (err: any) {
    checks.push({
      testName: '2. فحص النسخة في بيئة Sandbox معزولة',
      passed: false,
      details: `استثناء أثناء فحص Sandbox: ${err.message}`,
    });
  }

  // Test 3: Corrupt Payload & Tamper Detection
  try {
    // Tamper with payload without updating checksum
    const tamperedPayload = JSON.parse(backupResult.jsonString);
    if (tamperedPayload.data.products.length > 0) {
      tamperedPayload.data.products[0].name = 'منتج معدل غير مصرح';
    }
    const tamperedJson = JSON.stringify(tamperedPayload);
    const tamperedCheck = await validateBackupInSandbox(tamperedJson);

    // Completely malformed JSON test
    const malformedCheck = await validateBackupInSandbox('{"format": "CashierProCompleteDexieBackup", invalid json');

    checks.push({
      testName: '3. كشف أي تلاعب أو تلف في البيانات والبصمة Checksum',
      passed: !tamperedCheck.valid && !malformedCheck.valid,
      details: `تم رفض البيانات المعدلة بنجاح: "${tamperedCheck.error}"، وتم رفض JSON التالف بنجاح: "${malformedCheck.error}"`,
    });
  } catch (err: any) {
    checks.push({
      testName: '3. كشف أي تلاعب أو تلف في البيانات',
      passed: false,
      details: `استثناء أثناء اختبار التلاعب: ${err.message}`,
    });
  }

  // Test 4: Missing Images Graceful Handling
  try {
    const noImagesPayload = JSON.parse(backupResult.jsonString);
    // Remove images table contents and recalculate checksum
    noImagesPayload.data.product_images = [];
    noImagesPayload.tableCounts.product_images = 0;
    noImagesPayload.totalRecords = Object.values(noImagesPayload.tableCounts).reduce((a: any, b: any) => a + b, 0);
    // Recompute proper checksum for the no-image payload
    const { computeBackupChecksum } = await import('../backup/dexieBackupEngine');
    noImagesPayload.checksum = computeBackupChecksum(noImagesPayload.data);

    const noImagesValidation = await validateBackupInSandbox(JSON.stringify(noImagesPayload));
    checks.push({
      testName: '4. معالجة النسخ في حال عدم وجود صور أو فقدانها',
      passed: noImagesValidation.valid,
      details: noImagesValidation.valid
        ? 'تم التحقق من قبول النسخ حتى عند خلو جدول الصور دون انهيار أو توقف'
        : `فشل التحقق: ${noImagesValidation.error}`,
    });
  } catch (err: any) {
    checks.push({
      testName: '4. معالجة النسخ في حال عدم وجود صور',
      passed: false,
      details: `استثناء: ${err.message}`,
    });
  }

  // Test 5: Safe Restore Verification with Pre-restore Safety Snapshot
  let restoredRecordsCount = 0;
  try {
    const restoreRes = await restoreDexieBackupSafely(backupResult.jsonString);

    const postRestoreCounts = {
      products: await cashierDb.products.count(),
      parties: await cashierDb.parties.count(),
      invoices: await cashierDb.invoices.count(),
      invoice_items: await cashierDb.invoice_items.count(),
      payments: await cashierDb.payments.count(),
      expenses: await cashierDb.expenses.count(),
      held_invoices: await cashierDb.held_invoices.count(),
      categories: await cashierDb.categories.count(),
      settings: await cashierDb.settings.count(),
      product_images: await cashierDb.product_images.count(),
      change_journal: await cashierDb.change_journal.count(),
      migration_state: await cashierDb.migration_state.count(),
    };

    restoredRecordsCount = Object.values(postRestoreCounts).reduce((a, b) => a + b, 0);

    const tablesMatch = (Object.keys(initialCounts) as (keyof typeof initialCounts)[]).every(
      (k) => postRestoreCounts[k] === initialCounts[k]
    );

    // Verify pre-restore safety snapshot was taken
    const historicalList = await listHistoricalBackups();
    const safetySnapshotExists = historicalList.some((b) => b.type === 'pre_restore_safety');

    checks.push({
      testName: '5. استرجاع البيانات الآمن والتطابق التام 100% مع إنشاء نسخة أمان تلقائية',
      passed: restoreRes.success && tablesMatch && safetySnapshotExists,
      details: `تمت الاستعادة بنجاح: السجلات المستعادة ${restoredRecordsCount} تطابق الأصل ${initialTotalRecords}. تم تأكيد وجود لقطة أمان pre_restore_safety في السجل التاريخي.`,
    });
  } catch (err: any) {
    checks.push({
      testName: '5. استرجاع البيانات الآمن',
      passed: false,
      details: `فشل الاسترجاع: ${err.message}`,
    });
  }

  // Test 6: Historical Backups Management (List, Retention & Delete)
  let historicalCount = 0;
  try {
    const list = await listHistoricalBackups();
    historicalCount = list.length;
    const hasManual = list.some((b) => b.type === 'manual');
    const hasSafety = list.some((b) => b.type === 'pre_restore_safety');

    checks.push({
      testName: '6. إدارة السجل التاريخي والاحتفاظ بعدة نسخ دون استبدال',
      passed: list.length >= 2 && hasManual && hasSafety,
      details: `تم تأكيد وجود ${list.length} نسخ تاريخية مسجلة ومفهرسة تشمل (يدوية ونسخة أمان قبل الاسترجاع)`,
    });
  } catch (err: any) {
    checks.push({
      testName: '6. إدارة السجل التاريخي',
      passed: false,
      details: `فشل: ${err.message}`,
    });
  }

  // Test 7: Daily Automated Backup Check
  try {
    // 1. First trigger creates the daily auto backup if not already present
    const firstTrigger = await checkAndRunDailyAutoBackup();
    // 2. Immediate second trigger within 24h MUST return null (no duplicate backup)
    const secondTrigger = await checkAndRunDailyAutoBackup();
    const skippedProperly = secondTrigger === null && (firstTrigger !== null || (await listHistoricalBackups()).some((b) => b.type === 'daily_auto'));

    checks.push({
      testName: '7. فحص النسخ الاحتياطي التلقائي اليومي (24 ساعة)',
      passed: skippedProperly,
      details: 'تم التحقق من إنشاء النسخة التلقائية اليومية بنجاح ومنع التكرار العبثي عند انقضاء أقل من 24 ساعة',
    });
  } catch (err: any) {
    checks.push({
      testName: '7. فحص النسخ الاحتياطي التلقائي',
      passed: false,
      details: `فشل: ${err.message}`,
    });
  }

  // Test 8: Reboot and Persistence Simulation
  try {
    // Reopen Dexie DB to verify persistent schemas and storage
    await cashierDb.close();
    await cashierDb.open();

    const reopenCounts = {
      products: await cashierDb.products.count(),
      invoices: await cashierDb.invoices.count(),
      backup_history: await cashierDb.backup_history.count(),
    };

    const persistent = reopenCounts.products === initialCounts.products &&
      reopenCounts.invoices === initialCounts.invoices &&
      reopenCounts.backup_history >= 2;

    checks.push({
      testName: '8. بقاء البيانات وسلامتها بعد إغلاق وإعادة فتح قاعدة البيانات (Persistence Check)',
      passed: persistent,
      details: `تم إغلاق وإعادة فتح Dexie بنجاح: المنتجات (${reopenCounts.products})، الفواتير (${reopenCounts.invoices})، سجل النسخ (${reopenCounts.backup_history})`,
    });
  } catch (err: any) {
    checks.push({
      testName: '8. بقاء البيانات بعد إعادة الفتح',
      passed: false,
      details: `فشل: ${err.message}`,
    });
  }

  const allPassed = checks.every((c) => c.passed);

  return {
    timestamp: new Date().toISOString(),
    success: allPassed,
    checks,
    metrics: {
      originalRecordsCount: initialTotalRecords,
      restoredRecordsCount,
      historicalBackupsCount: historicalCount,
      backupSizeBytes: backupResult?.backupRecord.sizeBytes || 0,
      checksum: backupResult?.backupFile.checksum || '',
    },
  };
}
