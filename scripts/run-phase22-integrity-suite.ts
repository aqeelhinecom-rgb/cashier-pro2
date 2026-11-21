/**
 * Cashier Pro — Phase 22: Critical Data Integrity & Invoice Safety Verification Suite
 *
 * يختبر جميع سيناريوهات المرحلة 22 على قواعد بيانات معزولة تماماً (fake-indexeddb/auto):
 * 1. بيع كمية 1 عندما يكون المخزون = 0 (منع قاطع في Repository + Cache + DB)
 * 2. بيع كمية 6 عندما يكون المخزون = 5 (بما فيها دمج نفس الصنف في سطرين [3, 3])
 * 3. بيع صحيح ثم إلغاء الفاتورة مرة واحدة (عكس حركة Journal الفعلية فقط)
 * 4. محاولة إلغاء الفاتورة نفسها مرتين + فحص فاتورة تاريخية متعارضة (0 -> 0) دون تصنيع مخزون وهمي
 * 5. إعادة إرسال نفس idempotencyKey إلى طبقة التخزين
 * 6. عمليتا بيع متزامنتان (Promise.all) على نفس الصنف
 * 7. محاكاة فشل في منتصف المعاملة والتحقق من التراجع الكامل Atomic Rollback
 * 8. استعادة نسخة احتياطية (Dexie v2 + Legacy) والتحقق من تسلسل الفواتير دون إعادة ترقيم الفواتير القديمة
 * 9. التحقق من فصل أرباح الاستحقاق مقابل النقد المحصل والآجل وفصل عدادات الفواتير
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import { CashierDatabase } from '../src/services/storage/schema';
import { StorageService } from '../src/services/storage/storageService';
import { StorageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { InsufficientStockError } from '../src/services/storage/types';
import {
  createFullDexieBackup,
  restoreDexieBackupSafely,
} from '../src/services/storage/backup/dexieBackupEngine';
import { generateUUID } from '../src/services/storage/uuid';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
}

interface TestMetric {
  id: string;
  name: string;
  passed: boolean;
  before: string;
  after: string;
}

const results: TestMetric[] = [];

function record(id: string, name: string, passed: boolean, before: string, after: string) {
  results.push({ id, name, passed, before, after });
  if (!passed) {
    throw new Error(`❌ فشل [${id}] ${name} | قبل: ${before} | بعد: ${after}`);
  }
  console.log(`✅ [${id}] ${name}\n   قبل: ${before}\n   بعد: ${after}`);
}

async function createIsolatedDb(tag: string) {
  const name = `Cashier_P22_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const db = new CashierDatabase(name);
  await db.open();
  const adapter = new StorageCacheAdapter(db);
  await adapter.initializeAsync(db);
  const service = new StorageService(db);
  return { db, adapter, service };
}

async function cleanupDb(db: CashierDatabase, adapter?: StorageCacheAdapter) {
  try {
    adapter?.dispose();
  } catch {
    // ignore
  }
  try {
    await db.close();
    await db.delete();
  } catch {
    // ignore
  }
}

async function main() {
  console.log('================================================================');
  console.log('  Cashier Pro — Phase 22: Data Integrity & Invoice Safety Suite');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. Stock = 0 -> Sell 1 (Must block with InsufficientStockError)
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('ZeroStock');
    try {
      const prod = await adapter.saveProduct({
        name: 'شاحن أصلي',
        barcode: '220001',
        category: 'اكسسوارات',
        buy_price: 5000,
        sell_price: 8000,
        qty: 0,
      });

      let repoThrewInsufficient = false;
      try {
        await service.invoices.createInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 8000, cost: 5000 }],
          discount: 0,
          paid: 8000,
        });
      } catch (e: any) {
        repoThrewInsufficient = e instanceof InsufficientStockError || e?.name === 'InsufficientStockError';
      }

      let cacheThrewInsufficient = false;
      try {
        await adapter.saveInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 8000, cost: 5000 }],
          discount: 0,
          paid: 8000,
        });
      } catch (e: any) {
        cacheThrewInsufficient = e instanceof InsufficientStockError || e?.name === 'InsufficientStockError';
      }

      const dbProd = await db.products.get(prod.id!);
      const invCount = await db.invoices.count();
      const cacheQty = adapter.getProductById(prod.id!)?.qty;

      record(
        'T1',
        'منع البيع عند مخزون = 0 (طلب بيع 1 قطعة)',
        repoThrewInsufficient &&
          cacheThrewInsufficient &&
          dbProd?.qty === 0 &&
          cacheQty === 0 &&
          invCount === 0,
        'Stock=0, Invoices=0',
        `Rejected=${repoThrewInsufficient && cacheThrewInsufficient}, DBStock=${dbProd?.qty}, CacheStock=${cacheQty}, Invoices=${invCount}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Stock = 5 -> Sell 6 (including split rows [3, 3])
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('Oversell5to6');
    try {
      const prod = await adapter.saveProduct({
        name: 'سماعة بلوتوث',
        barcode: '220002',
        category: 'صوتيات',
        buy_price: 10000,
        sell_price: 15000,
        qty: 5,
      });

      let rejectedSingle = false;
      try {
        await adapter.saveInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 6, price: 15000, cost: 10000 }],
          discount: 0,
          paid: 90000,
        });
      } catch (e: any) {
        rejectedSingle = e instanceof InsufficientStockError;
      }

      let rejectedSplitRows = false;
      try {
        await service.invoices.createInvoice({
          type: 'sale',
          items: [
            { product_id: prod.id!, name: prod.name, qty: 3, price: 15000, cost: 10000 },
            { product_id: prod.id!, name: prod.name, qty: 3, price: 15000, cost: 10000 },
          ],
          discount: 0,
          paid: 90000,
        });
      } catch (e: any) {
        rejectedSplitRows = e instanceof InsufficientStockError;
      }

      const dbProd = await db.products.get(prod.id!);
      const invCount = await db.invoices.count();

      record(
        'T2',
        'منع البيع عند مخزون = 5 (طلب 6 قطع سواءً بسطر واحد أو سطرين [3+3])',
        rejectedSingle && rejectedSplitRows && dbProd?.qty === 5 && invCount === 0,
        'Stock=5, Invoices=0',
        `RejectedSingle=${rejectedSingle}, RejectedSplit=${rejectedSplitRows}, Stock=${dbProd?.qty}, Invoices=${invCount}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 3 & 4. Valid sale -> Void once -> Attempt double void -> Historical 0->0 check
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('VoidAndDoubleVoid');
    try {
      const prod = await adapter.saveProduct({
        name: 'كابل شحن سريع',
        barcode: '220003',
        category: 'كابلات',
        buy_price: 2000,
        sell_price: 5000,
        qty: 10,
      });

      const sale = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 4, price: 5000, cost: 2000 }],
        discount: 0,
        paid: 20000,
      });

      const stockAfterSale = (await db.products.get(prod.id!))?.qty;
      const journalCountAfterSale = await db.change_journal.count();

      // Void once
      await adapter.deleteInvoice(sale.id);
      const stockAfterFirstVoid = (await db.products.get(prod.id!))?.qty;
      const cacheStockAfterFirstVoid = adapter.getProductById(prod.id!)?.qty;

      // Attempt voiding same invoice a second time directly & via adapter
      const secondVoidRes = await service.invoices.deleteInvoice(sale.id);
      await adapter.deleteInvoice(sale.id);
      const stockAfterSecondVoid = (await db.products.get(prod.id!))?.qty;
      const voidJournalEntries = await db.change_journal
        .where('recordId')
        .equals(sale.id)
        .filter((e) => e.table === 'invoices' && e.action === 'void')
        .count();
      const totalJournalAfterVoid = await db.change_journal.count();

      // Verify historical inconsistent oversell invoice (qty=5 while journal recorded delta=0)
      const histProd = await adapter.saveProduct({
        name: 'صنف فاتورة تاريخية متعارضة',
        barcode: '220003H',
        category: 'عام',
        buy_price: 1000,
        sell_price: 2000,
        qty: 0,
      });
      const histProdDb = await db.products.get(histProd.id!);
      const histTs = '2026-01-01T10:00:00.000Z';
      const histInvId = await db.invoices.add({
        uuid: generateUUID(),
        invoice_number: 'INV-HIST-1',
        type: 'sale',
        party_id: null,
        party_name: 'مفرد',
        date: histTs,
        discount: 0,
        total: 10000,
        paid: 10000,
        currency: 'د.ع',
        updatedAt: histTs,
        isDeleted: false,
      } as any);
      await db.invoice_items.add({
        uuid: generateUUID(),
        invoice_id: histInvId,
        product_id: histProd.id!,
        name: histProd.name,
        qty: 5,
        price: 2000,
        cost: 1000,
        updatedAt: histTs,
      });
      await db.change_journal.add({
        operationId: generateUUID(),
        table: 'products',
        action: 'stock_change',
        recordId: histProd.id!,
        recordUuid: histProdDb?.uuid || generateUUID(),
        timestamp: histTs,
        diff: { oldQty: 0, newQty: 0, delta: 0 },
      });

      const histVoidRes = await service.invoices.deleteInvoice(histInvId);
      const histProdAfterVoid = await db.products.get(histProd.id!);
      const auditConflicts = await db.audit_logs
        .filter((a) => a.entity === 'invoice' && a.entityId === histInvId)
        .count();

      record(
        'T3',
        'بيع صحيح (4 من 10) ثم إلغاء الفاتورة مرة واحدة مع حفظ السجل السابق',
        stockAfterSale === 6 &&
          stockAfterFirstVoid === 10 &&
          cacheStockAfterFirstVoid === 10 &&
          totalJournalAfterVoid > journalCountAfterSale,
        'Stock=10 -> AfterSale=6',
        `AfterVoid DB=${stockAfterFirstVoid}, Cache=${cacheStockAfterFirstVoid}, JournalRows=${journalCountAfterSale}->${totalJournalAfterVoid}`
      );

      record(
        'T4',
        'منع تكرار عكس المخزون عند إلغاء نفس الفاتورة مرتين + كشف تعارض الفواتير التاريخية دون مخزون وهمي',
        secondVoidRes.voided === false &&
          secondVoidRes.alreadyVoided === true &&
          stockAfterSecondVoid === 10 &&
          voidJournalEntries === 1 &&
          histVoidRes.voided === true &&
          histVoidRes.conflicts.length === 1 &&
          histProdAfterVoid?.qty === 0 &&
          auditConflicts === 1,
        `DoubleVoid initial=10 | HistoricalStock=0 (invoice qty=5, recorded delta=0)`,
        `After2ndVoid=${stockAfterSecondVoid}, VoidLogs=${voidJournalEntries} | HistStockAfterVoid=${histProdAfterVoid?.qty} (0 phantom stock), Conflicts=${auditConflicts}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Resend same idempotencyKey to storage layer
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('Idempotency');
    try {
      const prod = await adapter.saveProduct({
        name: 'بطارية أصلية',
        barcode: '220005',
        category: 'بطاريات',
        buy_price: 7000,
        sell_price: 12000,
        qty: 10,
      });

      const key = generateUUID();
      const first = await service.invoices.createInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 12000, cost: 7000 }],
        discount: 0,
        paid: 24000,
        idempotencyKey: key,
      });
      const retryRepo = await service.invoices.createInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 12000, cost: 7000 }],
        discount: 0,
        paid: 24000,
        idempotencyKey: key,
      });
      await adapter.refreshCacheFromDb();
      const retryCache = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 12000, cost: 7000 }],
        discount: 0,
        paid: 24000,
        idempotencyKey: key,
      });

      const dbCount = await db.invoices.count();
      const cacheCount = adapter.getInvoices().length;
      const stockAfter = (await db.products.get(prod.id!))?.qty;

      record(
        'T5',
        'إعادة إرسال نفس idempotencyKey إلى Repository وCacheAdapter دون تكرار',
        first.deduplicated === false &&
          retryRepo.deduplicated === true &&
          retryRepo.invoice.id === first.invoice.id &&
          retryCache.id === first.invoice.id &&
          dbCount === 1 &&
          cacheCount === 1 &&
          stockAfter === 8,
        'Stock=10, Invoices=0',
        `DBInvoices=${dbCount}, CacheInvoices=${cacheCount}, ReturnedSameId=${retryCache.id === first.invoice.id}, Stock=${stockAfter}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Two concurrent sales targeting same product
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('ConcurrentSales');
    try {
      const prod = await adapter.saveProduct({
        name: 'كفر حماية متين',
        barcode: '220006',
        category: 'اكسسوارات',
        buy_price: 1500,
        sell_price: 4000,
        qty: 5,
      });

      const [r1, r2] = await Promise.allSettled([
        service.invoices.createInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 3, price: 4000, cost: 1500 }],
          discount: 0,
          paid: 12000,
          idempotencyKey: 'conc-key-1',
        }),
        service.invoices.createInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 3, price: 4000, cost: 1500 }],
          discount: 0,
          paid: 12000,
          idempotencyKey: 'conc-key-2',
        }),
      ]);

      const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      const failed = [r1, r2].filter((r) => r.status === 'rejected').length;
      const invCount = await db.invoices.count();
      const stockAfter = (await db.products.get(prod.id!))?.qty;

      record(
        'T6',
        'عمليتا بيع متزامنتان (3 + 3 قطع) على مخزون = 5',
        succeeded === 1 && failed === 1 && invCount === 1 && stockAfter === 2,
        'Stock=5, ConcurrentRequests=[3, 3]',
        `Succeeded=${succeeded}, Rejected=${failed}, Invoices=${invCount}, Stock=${stockAfter}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Mid-transaction failure during stock/item mutation -> full atomic rollback
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('MidTxFailure');
    try {
      const prod = await adapter.saveProduct({
        name: 'شاشة قياس اختبارية',
        barcode: '220007',
        category: 'قطع غيار',
        buy_price: 20000,
        sell_price: 35000,
        qty: 12,
      });

      const origUpdate = db.products.update.bind(db.products);
      (db.products as any).update = async () => {
        throw new Error('SIMULATED_MID_TX_STOCK_UPDATE_FAILURE');
      };

      let threw = false;
      try {
        await adapter.saveInvoice({
          type: 'sale',
          items: [{ product_id: prod.id!, name: prod.name, qty: 4, price: 35000, cost: 20000 }],
          discount: 0,
          paid: 140000,
        });
      } catch (err: any) {
        threw = String(err?.message || '').includes('SIMULATED_MID_TX_STOCK_UPDATE_FAILURE');
      } finally {
        (db.products as any).update = origUpdate;
      }

      const dbInvCount = await db.invoices.count();
      const dbItemsCount = await db.invoice_items.count();
      const dbStock = (await db.products.get(prod.id!))?.qty;
      const cacheInvCount = adapter.getInvoices().length;
      const cacheStock = adapter.getProductById(prod.id!)?.qty;

      record(
        'T7',
        'فشل منتصف المعاملة عند تعديل المخزون وتراجع Dexie والـ Cache بالكامل',
        threw &&
          dbInvCount === 0 &&
          dbItemsCount === 0 &&
          dbStock === 12 &&
          cacheInvCount === 0 &&
          cacheStock === 12,
        'Stock=12, DBInvoices=0, CacheInvoices=0',
        `Threw=${threw}, DBInvoices=${dbInvCount}, DBItems=${dbItemsCount}, DBStock=${dbStock}, CacheInvoices=${cacheInvCount}, CacheStock=${cacheStock}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Backup Restore + Per-type Invoice Sequences without renumbering
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('BackupSeq');
    try {
      const cust = await adapter.addParty('عميل التسلسل', '07700000001', 'customer');
      const prod = await adapter.saveProduct({
        name: 'منتج تسلسل الفواتير',
        barcode: '220008',
        category: 'عام',
        buy_price: 1000,
        sell_price: 2000,
        qty: 50,
      });

      const sale1 = await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 2000, cost: 1000 }],
        discount: 0,
        paid: 4000,
      });
      const purch1 = await adapter.saveInvoice({
        type: 'purchase',
        items: [{ product_id: prod.id!, name: prod.name, qty: 5, price: 1000, cost: 1000 }],
        discount: 0,
        paid: 5000,
      });

      const backup = await createFullDexieBackup(db, 'manual', 'P22 seq backup');

      // Wipe and test restoreDexieBackupSafely (with explicit seq mismatch check)
      const targetDbName = `Cashier_P22_RestoreTarget_${Date.now()}`;
      const targetDb = new CashierDatabase(targetDbName);
      await targetDb.open();
      try {
        await restoreDexieBackupSafely(backup.jsonString, targetDb);
        const restoredSale = await targetDb.invoices.get(sale1.id);
        const restoredPurch = await targetDb.invoices.get(purch1.id);
        const targetSvc = new StorageService(targetDb);
        const nextSale = await targetSvc.invoices.createInvoice({
          type: 'sale',
          partyId: cust.id,
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 2000, cost: 1000 }],
          discount: 0,
          paid: 2000,
        });

        // Also test legacy restoreSnapshotAsync
        const legacyPayload = {
          products: await db.products.toArray(),
          parties: await db.parties.toArray(),
          invoices: await db.invoices.toArray(),
          invoice_items: await db.invoice_items.toArray(),
          payments: await db.payments.toArray(),
          expenses: await db.expenses.toArray(),
          settings: adapter.getSettings(),
        };
        await adapter.restoreSnapshotAsync(legacyPayload);
        const seqSaleSetting = await db.settings.get('seq_sale');
        const nextSaleAfterSnap = await adapter.saveInvoice({
          type: 'sale',
          partyId: cust.id,
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 2000, cost: 1000 }],
          discount: 0,
          paid: 2000,
        });

        const sameNumsPreserved =
          restoredSale?.invoice_number === sale1.invoice_number &&
          restoredPurch?.invoice_number === purch1.invoice_number &&
          nextSale.invoice.invoice_number !== sale1.invoice_number &&
          nextSaleAfterSnap.invoice_number !== sale1.invoice_number &&
          nextSaleAfterSnap.id > sale1.id &&
          nextSaleAfterSnap.id > purch1.id &&
          typeof seqSaleSetting?.value === 'number' &&
          seqSaleSetting.value >= 2;

        record(
          'T8',
          'الاستعادة (Dexie v2 + Legacy Snapshot) وحفظ seq_${type} بدون إعادة ترقيم',
          sameNumsPreserved,
          `Original sale=${sale1.invoice_number}, purchase=${purch1.invoice_number}`,
          `Preserved=[${restoredSale?.invoice_number}, ${restoredPurch?.invoice_number}], PostDexieRestoreNext=${nextSale.invoice.invoice_number}, PostSnapNext=${nextSaleAfterSnap.invoice_number}, seq_sale=${seqSaleSetting?.value}`
        );
      } finally {
        await targetDb.close();
        await targetDb.delete();
      }
      assert(service);
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 9. P2-02 Separated Invoice Counts & Accrual vs Collected vs Deferred Profit
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('ReportAccounting');
    try {
      const cust = await adapter.addParty('عميل التقارير', '07711112222', 'customer');
      const prod = await adapter.saveProduct({
        name: 'منتج أرباح مفصول',
        barcode: '220009',
        category: 'عام',
        buy_price: 600,
        sell_price: 1000,
        qty: 50,
      });

      // Sale 1: Cash paid in full -> 10 * 1000 = 10,000, cost = 6,000, profit = 4,000 (collected=4,000, deferred=0)
      await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id,
        items: [{ product_id: prod.id!, name: prod.name, qty: 10, price: 1000, cost: 600 }],
        discount: 0,
        paid: 10000,
      });
      // Sale 2: Credit unpaid -> 5 * 1000 = 5,000, cost = 3,000, profit = 2,000 (collected=0, deferred=2,000)
      await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id,
        items: [{ product_id: prod.id!, name: prod.name, qty: 5, price: 1000, cost: 600 }],
        discount: 0,
        paid: 0,
      });
      // Purchase 1
      await adapter.saveInvoice({
        type: 'purchase',
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 600, cost: 600 }],
        discount: 0,
        paid: 1200,
      });
      // Sale return: 2 units paid cash -> total 2,000, profit reversed = 800 (collected=-800)
      await adapter.saveInvoice({
        type: 'sale_return',
        partyId: cust.id,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 1000, cost: 600 }],
        discount: 0,
        paid: 2000,
      });
      // Quote 1 (must NOT count in sales or purchases or profit)
      await adapter.saveInvoice({
        type: 'quote',
        partyId: cust.id,
        items: [{ product_id: prod.id!, name: prod.name, qty: 10, price: 1000, cost: 600 }],
        discount: 0,
        paid: 0,
      });
      await adapter.addExpense('إيجار', 500);

      const rep = await service.reports.getReport(new Date(0), new Date(Date.now() + 86400000));
      // Expected:
      // Net Sales = 10000 + 5000 - 2000 = 13000
      // Collected Sales = 10000 + 0 - 2000 = 8000, Credit Remaining = 5000
      // Accrual Gross Profit = (4000 + 2000) - 800 = 5200
      // Collected Profit = 4000 + 0 - 800 = 3200
      // Deferred Profit = 0 + 2000 - 0 = 2000
      // Net Profit = 5200 - 500 = 4700
      // Counts: sales=2, purchase=1, return=1, quotes=1, invoicesCount(operational)=4
      const ok =
        rep.sales === 13000 &&
        rep.collectedSales === 8000 &&
        rep.creditSalesRemaining === 5000 &&
        rep.profit === 5200 &&
        rep.collectedProfit === 3200 &&
        rep.deferredProfit === 2000 &&
        rep.collectedProfit! + rep.deferredProfit! === rep.profit &&
        rep.netProfit === 4700 &&
        rep.salesInvoicesCount === 2 &&
        rep.purchasesInvoicesCount === 1 &&
        rep.returnsInvoicesCount === 1 &&
        rep.quotesCount === 1 &&
        rep.invoicesCount === 4;

      record(
        'T9',
        'فصل عدادات الفواتير وفصل الربح الاستحقاقي والمحصل نقداً والآجل وصافي الربح',
        ok,
        '2 Sales (1 cash, 1 credit), 1 Purchase, 1 Return, 1 Quote, 1 Expense',
        `sales=${rep.sales}, accrualProfit=${rep.profit}, collectedProfit=${rep.collectedProfit}, deferredProfit=${rep.deferredProfit}, netProfit=${rep.netProfit}, counts=[sale:${rep.salesInvoicesCount}, purch:${rep.purchasesInvoicesCount}, ret:${rep.returnsInvoicesCount}, quote:${rep.quotesCount}]`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  console.log('\n================================================================');
  console.log(`🏆 اجتازت حزمة اختبارات المرحلة 22 بنجاح: ${results.length}/${results.length} (100%)`);
  console.log('================================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ فشلت حزمة المرحلة 22:', err);
    process.exit(1);
  });
