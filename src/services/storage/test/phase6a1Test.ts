import { runFinalCutoverSafetyAudit, Audit6A1Results } from '../audit/finalCutoverSafetyAudit';

export interface Phase6a1TestOutcome {
  testId: number;
  title: string;
  passed: boolean;
  details: string;
  metrics?: Record<string, any>;
}

export async function runPhase6a1SafetyTestSuite(): Promise<{
  allPassed: boolean;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: Audit6A1Results;
  outcomes: Phase6a1TestOutcome[];
}> {
  const startTime = Date.now();
  const outcomes: Phase6a1TestOutcome[] = [];

  const audit = await runFinalCutoverSafetyAudit();
  const r = audit.results;

  // 1. Change Journal Coverage
  outcomes.push({
    testId: 1,
    title: 'تغطية Change Journal لجميع عمليات الكتابة وإعادة البناء الزمني (Journal Coverage)',
    passed: r.journalCoverage.passed,
    details: r.journalCoverage.details,
    metrics: { totalEntries: r.journalCoverage.totalJournalEntries, operationsCovered: r.journalCoverage.coveredOperationsCount },
  });

  // 2. Concurrency Control with Version
  outcomes.push({
    testId: 2,
    title: 'تدقيق تعارض التعديلات المتزامنة بنظام Revision/Version وحظر الكتابة الصامتة (OCC Concurrency)',
    passed: r.concurrencyControl.passed,
    details: r.concurrencyControl.details,
  });

  // 3. Multi-Window Sync & Missed Notifications
  outcomes.push({
    testId: 3,
    title: 'مزامنة النوافذ الحية واسترجاع الإشعارات الفائتة مباشرة من Dexie (Window Sync & Recovery)',
    passed: r.windowSyncMissedNotifications.passed,
    details: r.windowSyncMissedNotifications.details,
    metrics: { missedRecovered: r.windowSyncMissedNotifications.missedRecoveredCount },
  });

  // 4. Cache vs IndexedDB Latency Separation
  outcomes.push({
    testId: 4,
    title: 'تدقيق سلامة Cache Adapter وقياس زمن قراءة الكاش مفصولاً عن زمن قراءة IndexedDB (Latency Separation)',
    passed: r.cacheVsIndexedDbLatency.passed,
    details: r.cacheVsIndexedDbLatency.details,
    metrics: {
      cacheAvgMs: r.cacheVsIndexedDbLatency.cacheReadLatencyMs.getProductsAvgMs,
      indexedDbAvgMs: r.cacheVsIndexedDbLatency.indexedDbReadLatencyMs.getProductsAvgMs,
      speedRatio: r.cacheVsIndexedDbLatency.speedRatio,
    },
  });

  // 5. 50 Concurrent Invoices
  outcomes.push({
    testId: 5,
    title: 'ترقيم 50 فاتورة متزامنة دون تصادم واستئناف الترقيم بعد إعادة التشغيل (50 Concurrent Invoices)',
    passed: r.concurrent50Invoices.passed,
    details: r.concurrent50Invoices.details,
    metrics: {
      total: r.concurrent50Invoices.totalConcurrent,
      unique: r.concurrent50Invoices.uniqueNumbersCount,
      collisions: r.concurrent50Invoices.collisionCount,
    },
  });

  // 6. Full Disaster Recovery
  outcomes.push({
    testId: 6,
    title: 'خطة التعافي وإعادة البناء الشامل واعتماد Dexie كمصدر وحيد للحقيقة (Disaster Recovery)',
    passed: r.fullDisasterRecovery.passed,
    details: r.fullDisasterRecovery.details,
    metrics: { accuracy: r.fullDisasterRecovery.accuracyPercent },
  });

  // 7. Immutability Gate
  outcomes.push({
    testId: 7,
    title: 'التأكيد القاطع على بقاء localStorage وقاعدة CashierPro_DB الأصلية دون مساس (Immutability Gate)',
    passed: r.immutabilityGate.passed,
    details: r.immutabilityGate.details,
  });

  const durationMs = Date.now() - startTime;
  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.filter((o) => !o.passed).length;

  return {
    allPassed: failedCount === 0,
    total: outcomes.length,
    passed: passedCount,
    failed: failedCount,
    durationMs,
    results: r,
    outcomes,
  };
}
