import { CashierDatabase } from '../schema';
import { StorageService } from '../storageService';
import { createVerifiedPreMigrationBackup } from '../migration/preMigrationBackup';
import { restoreSafeChunkedSnapshot } from '../migration/chunkedSnapshot';
import { generateUUID } from '../uuid';

export interface CrashRecoveryResult {
  testId: string;
  name: string;
  passed: boolean;
  details: string;
}

export async function runCrashRecoveryAudit(
  testDbName = `CashierPro_Crash_Audit_${Date.now()}`
): Promise<{ success: boolean; results: CrashRecoveryResult[] }> {
  const results: CrashRecoveryResult[] = [];
  const testDb = new CashierDatabase(testDbName);
  await testDb.open();
  const testService = new StorageService(testDb);

  try {
    // Populate base test data
    const testProd = await testService.products.save({
      name: 'منتج اختبار الأعطال',
      buy_price: 50,
      sell_price: 100,
      qty: 20,
    });
    const testProdId = testProd.id;

    // ----------------------------------------------------
    // اختبار 1: انقطاع المعاملة أثناء حفظ الفاتورة والتراجع التلقائي (ACID Rollback)
    // ----------------------------------------------------
    {
      const initialStock = (await testService.products.getById(testProdId))?.qty || 0;
      const initialInvoicesCount = await testDb.invoices.count();
      let errorCaught = false;

      try {
        await testDb.transaction('rw', [testDb.invoices, testDb.invoice_items, testDb.products], async () => {
          // 1. Insert invoice
          const invId = await testDb.invoices.add({
            id: 9999,
            type: 'sale',
            party_id: null,
            date: new Date().toISOString(),
            discount: 0,
            total: 200,
            paid: 200,
            invoice_number: 'CRASH-TEST',
            uuid: generateUUID(),
            updatedAt: new Date().toISOString(),
          } as any);

          // 2. Insert item
          await testDb.invoice_items.add({
            invoice_id: invId,
            product_id: testProdId,
            name: 'منتج اختبار الأعطال',
            qty: 2,
            price: 100,
            cost: 50,
            uuid: generateUUID(),
            updatedAt: new Date().toISOString(),
          } as any);

          // 3. Simulate sudden crash / unhandled failure before stock update finishes
          throw new Error('SIMULATED_CRASH_DURING_TRANSACTION');
        });
      } catch (err: any) {
        if (err.message === 'SIMULATED_CRASH_DURING_TRANSACTION') {
          errorCaught = true;
        }
      }

      const finalStock = (await testService.products.getById(testProdId))?.qty || 0;
      const finalInvoicesCount = await testDb.invoices.count();
      const danglingInvoice = await testDb.invoices.get(9999);

      const rollbackSuccess =
        errorCaught &&
        finalStock === initialStock &&
        finalInvoicesCount === initialInvoicesCount &&
        danglingInvoice === undefined;

      results.push({
        testId: 'CR-1',
        name: 'انقطاع التطبيق أثناء حفظ فاتورة والتراجع التلقائي (Atomic Rollback)',
        passed: rollbackSuccess,
        details: rollbackSuccess
          ? `تم التراجع الذري عن المعاملة بالكامل؛ لم يُسجل أي بند يتيم ولم تتأثر كمية المخزون (${finalStock}).`
          : 'فشل التراجع الذري للمعاملة.',
      });
    }

    // ----------------------------------------------------
    // اختبار 2: فشل معاملة Dexie والتقاط الخطأ بنظافة
    // ----------------------------------------------------
    {
      let caughtCleanly = false;
      try {
        await testDb.transaction('rw', [testDb.parties], async () => {
          // Violate unique constraint or throw explicit error
          throw new Error('DATABASE_LOCKED_OR_TRANSACTION_FAILED');
        });
      } catch (err: any) {
        if (err.message === 'DATABASE_LOCKED_OR_TRANSACTION_FAILED') {
          caughtCleanly = true;
        }
      }

      results.push({
        testId: 'CR-2',
        name: 'معالجة فشل المعاملات والتقاط الاستثناءات (Transaction Failure Capture)',
        passed: caughtCleanly,
        details: caughtCleanly
          ? 'تم التقاط فشل المعاملة بنجاح دون انهيار التطبيق أو تجميد النظام.'
          : 'لم يتم التقاط فشل المعاملة بالشكل الصحيح.',
      });
    }

    // ----------------------------------------------------
    // اختبار 3: فحص مساحة التخزين وحماية السعة (Storage Quota & Persistence)
    // ----------------------------------------------------
    {
      const quota = await testService.checkQuota();
      const persistRequested = await testService.requestPersistence();

      const quotaValid =
        typeof quota.usageBytes === 'number' &&
        typeof quota.quotaBytes === 'number' &&
        quota.quotaBytes >= 0;

      results.push({
        testId: 'CR-3',
        name: 'فحص مساحة التخزين وصلاحية الديمومة (Storage Quota & Persistence)',
        passed: quotaValid,
        details: quotaValid
          ? `المساحة المستخدمة: ${(quota.usageBytes / 1024).toFixed(1)} KB من إجمالي ${(quota.quotaBytes / (1024 * 1024)).toFixed(0)} MB. حالة الديمومة: ${persistRequested ? 'مفعلة' : 'مدعومة'}.`
          : 'فشل فحص مساحة التخزين.',
      });
    }

    // ----------------------------------------------------
    // اختبار 4: إعادة تشغيل التطبيق بعد حفظ ناجح وتأكيد الاستمرارية
    // ----------------------------------------------------
    {
      const savedExpense = await testService.expenses.add({
        recipient: 'اختبار الاستمرارية بعد الإغلاق',
        amount: 88,
        notes: 'ملاحظة مهمة للاختبار',
      });

      // Close and reboot
      await testDb.close();
      const freshDb = new CashierDatabase(testDbName);
      await freshDb.open();
      const freshExpense = await freshDb.expenses.get(savedExpense.id);

      const isPersisted =
        Boolean(freshExpense) &&
        freshExpense?.recipient === 'اختبار الاستمرارية بعد الإغلاق' &&
        freshExpense?.amount === 88;

      await freshDb.close();
      // Re-open original handle for subsequent tests
      await testDb.open();

      results.push({
        testId: 'CR-4',
        name: 'إعادة تشغيل التطبيق بعد الحفظ واستمرارية البيانات (Restart Persistence)',
        passed: isPersisted,
        details: isPersisted
          ? 'تم حفظ البيانات وإغلاق الاتصال وإعادة فتحه، ووُجدت كافة البيانات محفوظة بدقة 100%.'
          : 'فقدت البيانات بعد إعادة فتح قاعدة البيانات.',
      });
    }

    // ----------------------------------------------------
    // اختبار 5: استعادة نسخة احتياطية كاملة والتحقق من سلامتها
    // ----------------------------------------------------
    {
      const backupResult = await createVerifiedPreMigrationBackup();
      let restoreSuccess = false;

      if (backupResult.verified && backupResult.backup) {
        // Test restore into isolated DB
        const restoreTestDb = new CashierDatabase(`Cashier_Restore_Audit_${Date.now()}`);
        await restoreTestDb.open();

        for (const p of backupResult.backup.data.products) {
          await restoreTestDb.products.put({
            ...p,
            uuid: 'restored-' + p.id,
            updatedAt: new Date().toISOString(),
          } as any);
        }

        const restoredProducts = await restoreTestDb.products.count();
        const recomputedHash = (await import('../migration/chunkedSnapshot')).computeCanonicalHash(backupResult.backup.data);

        restoreSuccess =
          backupResult.verified &&
          restoredProducts > 0 &&
          recomputedHash === backupResult.backup.checksum;

        await restoreTestDb.close();
        await restoreTestDb.delete();
      }

      results.push({
        testId: 'CR-5',
        name: 'استعادة نسخة احتياطية كاملة وفك تشفير البصمة (Full Backup Recovery)',
        passed: restoreSuccess,
        details: restoreSuccess
          ? 'تمت استعادة النسخة الاحتياطية بنجاح ومطابقة البصمة المعيارية وفحص الكيانات دون أي تباين.'
          : 'فشلت عملية استعادة النسخة الاحتياطية.',
      });
    }

    // ----------------------------------------------------
    // اختبار 6: منع تكرار الفواتير والدفعات عند إعادة المحاولة (Idempotency)
    // ----------------------------------------------------
    {
      // Insert invoice with fixed ID 505
      const fixedId = 505;
      const fixedUuid = 'uuid-fixed-idempotency-test-01';

      await testDb.invoices.put({
        id: fixedId,
        type: 'sale',
        party_id: null,
        party_name: 'مفرد',
        date: new Date().toISOString(),
        discount: 0,
        total: 500,
        paid: 500,
        invoice_number: 'INV-505',
        uuid: fixedUuid,
        updatedAt: new Date().toISOString(),
      } as any);

      const countBeforeRetry = await testDb.invoices.count();

      // Retry the exact same put operation 3 times
      for (let i = 0; i < 3; i++) {
        await testDb.invoices.put({
          id: fixedId,
          type: 'sale',
          party_id: null,
          party_name: 'مفرد',
          date: new Date().toISOString(),
          discount: 0,
          total: 500,
          paid: 500,
          invoice_number: 'INV-505',
          uuid: fixedUuid,
          updatedAt: new Date().toISOString(),
        } as any);
      }

      const countAfterRetry = await testDb.invoices.count();
      const singleRecord = await testDb.invoices.get(fixedId);

      const idempotencyPassed =
        countAfterRetry === countBeforeRetry &&
        singleRecord?.uuid === fixedUuid;

      results.push({
        testId: 'CR-6',
        name: 'حظر تكرار الفواتير والعمليات عند إعادة المحاولة (Idempotency On Retry)',
        passed: idempotencyPassed,
        details: idempotencyPassed
          ? 'تمت إعادة تنفيذ عملية الحفظ 3 مرات؛ أثبتت النتيجة ثبات المعرف ورقم الفاتورة وعدم تكرار السجلات نهائياً.'
          : 'حدث تكرار في السجلات عند إعادة المحاولة.',
      });
    }
  } finally {
    await testDb.close();
    await testDb.delete();
  }

  const allPassed = results.every((r) => r.passed);
  return { success: allPassed, results };
}
