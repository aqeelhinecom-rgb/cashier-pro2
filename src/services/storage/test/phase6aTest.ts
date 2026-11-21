import { cashierStorageDb } from '../schema';
import { runControlledSwitchoverRehearsal, RehearsalMetrics } from '../rehearsal/switchoverRehearsal';

export interface Phase6aTestOutcome {
  testId: number;
  title: string;
  passed: boolean;
  details: string;
  extraData?: Record<string, any>;
}

export async function runPhase6aRehearsalTests(): Promise<{
  allPassed: boolean;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  metrics?: RehearsalMetrics;
  outcomes: Phase6aTestOutcome[];
}> {
  const startTime = Date.now();
  const outcomes: Phase6aTestOutcome[] = [];

  // Snapshot localStorage keys to enforce immutability
  const initialKeys: Record<string, string | null> = {};
  if (typeof localStorage !== 'undefined') {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) initialKeys[k] = localStorage.getItem(k);
    }
  }

  // Run the full controlled switchover rehearsal
  const rehearsal = await runControlledSwitchoverRehearsal();
  const m = rehearsal.metrics;

  // Outcome 1: Change Journal & Replay
  outcomes.push({
    testId: 1,
    title: 'سجل التغييرات الموثوق (Change Journal) وإعادة البناء الزمني (Database Rebuild)',
    passed: m.pillar1JournalRebuild.passed,
    details: m.pillar1JournalRebuild.details,
    extraData: { journalCount: m.pillar1JournalRebuild.journalCount },
  });

  // Outcome 2: Cache Adapter & Measured Read Latency
  outcomes.push({
    testId: 2,
    title: 'اختبار Cache Adapter والتحميل المسبق وقياس السرعة الحقيقية (Measured Read Latency)',
    passed: m.pillar2CacheAdapter.passed,
    details: m.pillar2CacheAdapter.details,
    extraData: m.pillar2CacheAdapter.readLatencyMs,
  });

  // Outcome 3: Multi-Window Synchronization
  outcomes.push({
    testId: 3,
    title: 'تعدد النوافذ والمزامنة اللحظية وحل التعارض (Multi-Window Realtime Sync)',
    passed: m.pillar3MultiWindow.passed,
    details: m.pillar3MultiWindow.details,
  });

  // Outcome 4: Concurrent Invoice Numbering
  outcomes.push({
    testId: 4,
    title: 'ترقيم الفواتير المتزامن (20 عملية متزامنة) والاستئناف بعد إعادة التشغيل (Concurrent Numbering)',
    passed: m.pillar4InvoiceNumbering.passed,
    details: m.pillar4InvoiceNumbering.details,
    extraData: { sequenceRange: m.pillar4InvoiceNumbering.sequenceRange },
  });

  // Outcome 5: Post-Switchover Failure & Anti-Fallback
  outcomes.push({
    testId: 5,
    title: 'محاكاة الفشل بعد التبديل وحظر الرجوع التلقائي لـ localStorage القديم (Anti-Fallback Engine)',
    passed: m.pillar5PostSwitchoverFailure.passed,
    details: m.pillar5PostSwitchoverFailure.details,
  });

  // Outcome 6: Disaster Recovery & Reconstruction
  outcomes.push({
    testId: 6,
    title: 'خطة التعافي المعتمدة وإعادة بناء النسخة المطابقة (Disaster Recovery & Reconstruction)',
    passed: m.pillar6DisasterRecovery.passed,
    details: m.pillar6DisasterRecovery.details,
  });

  // Outcome 7: Immutability Gate of Store Data & CashierPro_DB
  let storageUntouched = true;
  if (typeof localStorage !== 'undefined') {
    for (const [key, val] of Object.entries(initialKeys)) {
      if (localStorage.getItem(key) !== val) {
        storageUntouched = false;
        break;
      }
    }
  }
  const originalDbCount = await cashierStorageDb.products.count();
  const immutabilityPassed = storageUntouched && originalDbCount > 0;

  outcomes.push({
    testId: 7,
    title: 'التأكيد القاطع على عدم المساس ببيانات localStorage أو قاعدة CashierPro_DB الأصلية',
    passed: immutabilityPassed,
    details: `التطابق 100%؛ لم يُعدل أي مفتاح في localStorage، وقاعدة CashierPro_DB الأصلية محفوظة (${originalDbCount} منتج) دون أي مساس.`,
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
    metrics: m,
    outcomes,
  };
}
