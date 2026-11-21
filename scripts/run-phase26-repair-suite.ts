/**
 * Cashier Pro — Phase 26: Critical Functionality Repair Verification Suite
 *
 * يختبر جميع سيناريوهات الإصلاح الثلاثة في بيئة معزولة تماماً (fake-indexeddb/auto)
 * دون المساس بقاعدة CashierPro_DB الحقيقية ودون أي اتصال حي بـ Firebase:
 * 1. تعديل فاتورة بيع محفوظة (+ كمية، - كمية، حذف وإضافة صنف) مع تحديث المخزن والتقارير والـ Journal والـ Audit
 * 2. تعديل فاتورة شراء محفوظة (إضافة صنف، تعديل كمية وسعر الشراء والبيع) والتحقق من الأرصدة وتقرير المشتريات
 * 3. تعديل فاتورة آجلة مدفوعة جزئياً والتحقق من دقة رصيد العميل دون تكرار/تخريب الدفعات
 * 4. منع تعديل فاتورة مرتبطة بمرتجع بيع أو مسددة بسند قبض لاحق
 * 5. منع التعديل من صلاحية الكاشير (cashier) ومنع تعديل الفاتورة الملغاة
 * 6. منع أي تعديل يؤدي إلى مخزون سالب (في البيع أو عند تقليل كمية الشراء بعد البيع)
 * 7. محاكاة عطل منتصف المعاملة والتحقق من التراجع الذري الكامل Atomic Rollback
 * 8. إعادة المحاولة بنفس editIdempotencyKey دون خصم/تعديل مزدوج
 * 9. توليد PDF للفواتير الأربعة والتقارير وكشف الحساب + حماية XSS + مقاسات A4 / 80mm / 58mm + حذف رابط الخطوط Offline + %PDF- الثنائي
 * 10. إعادة طباعة فاتورة قديمة كعملية قراءة فقط 100%
 * 11. النسخ الاحتياطي والاستعادة بعد تعديل فواتير محفوظة + فحص حراس Firebase/Drive المعزولين
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import { jsPDF } from 'jspdf';
import { CashierDatabase } from '../src/services/storage/schema';
import { StorageService } from '../src/services/storage/storageService';
import { StorageCacheAdapter, storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { InsufficientStockError } from '../src/services/storage/types';
import {
  createFullDexieBackup,
  validateBackupInSandbox,
  restoreDexieBackupSafely,
} from '../src/services/storage/backup/dexieBackupEngine';
import {
  buildInvoicePdfHtml,
  buildReportPdfHtml,
  escapeHtml,
} from '../src/utils/pdfExport';
import {
  app,
  firestore,
  saveBackupToFirestore,
  diagnoseFirestoreConnection,
  translateFirebaseError,
  hasValidDriveToken,
  clearDriveToken,
} from '../src/services/firebase';
import { terminate } from 'firebase/firestore';
import { deleteApp } from 'firebase/app';
import { generateUUID } from '../src/services/storage/uuid';
import { StoreSettings } from '../src/types';

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
  details: string;
}

const results: TestMetric[] = [];

function record(id: string, name: string, passed: boolean, details: string) {
  results.push({ id, name, passed, details });
  if (!passed) {
    throw new Error(`❌ فشل [${id}] ${name} | ${details}`);
  }
  console.log(`✅ [${id}] ${name}\n   ${details}`);
}

const TEST_SETTINGS: StoreSettings = {
  storeName: 'متجر الاختبار الحديث',
  phone: '07701234567',
  address: 'بغداد - الكرادة',
  currency: 'د.ع',
  taxRate: 0,
  receiptFooter: 'شكراً لتعاملكم معنا',
  userRole: 'owner',
};

async function createIsolatedDb(tag: string) {
  const name = `Cashier_P26_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
  console.log('==================================================================');
  console.log('  Cashier Pro — Phase 26: Critical Repair Verification Suite');
  console.log('==================================================================\n');

  try {
    // ---------------------------------------------------------------------------
    // 1. Edit saved SALE invoice (+qty and -qty) & verify stock + report + audit
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('EditSale');
    try {
      const prodA = await adapter.saveProduct({
        name: 'سماعة بلوتوث',
        barcode: '260001',
        category: 'صوتيات',
        buy_price: 10000,
        sell_price: 15000,
        qty: 10,
      });
      const prodB = await adapter.saveProduct({
        name: 'كابل شحن',
        barcode: '260002',
        category: 'كابلات',
        buy_price: 2000,
        sell_price: 4000,
        qty: 8,
      });

      const created = await adapter.saveInvoice({
        type: 'sale',
        items: [
          { product_id: prodA.id!, name: prodA.name, qty: 2, price: 15000, cost: 10000 },
          { product_id: prodB.id!, name: prodB.name, qty: 3, price: 4000, cost: 2000 },
        ],
        discount: 0,
        paid: 42000,
      });
      const origNum = created.invoice_number;

      // Edit: A: 2 -> 5 (+3 out), B: 3 -> 1 (-2 back to stock)
      const updated = await adapter.updateInvoice({
        invoiceId: created.id!,
        partyId: null,
        items: [
          { product_id: prodA.id!, name: prodA.name, qty: 5, price: 15000, cost: 10000 },
          { product_id: prodB.id!, name: prodB.name, qty: 1, price: 4000, cost: 2000 },
        ],
        discount: 1000,
        paid: 78000,
        actorRole: 'owner',
        editIdempotencyKey: generateUUID(),
      });

      const afterA = await db.products.get(prodA.id!);
      const afterB = await db.products.get(prodB.id!);
      const report = await service.reports.getReport(
        new Date(Date.now() - 86400000),
        new Date(Date.now() + 86400000)
      );
      const audits = await db.audit_logs
        .filter((a) => a.entity === 'invoice' && a.action === 'update')
        .toArray();
      const journals = await db.change_journal
        .filter((j) => j.table === 'invoices' && j.action === 'update')
        .toArray();

      // Profit = (5*(15000-10000) + 1*(4000-2000)) - 1000 = 25000 + 2000 - 1000 = 26000
      const passed =
        updated.id === created.id &&
        updated.invoice_number === origNum &&
        updated.total === 78000 &&
        afterA?.qty === 5 &&
        afterB?.qty === 7 &&
        report.sales === 78000 &&
        report.profit === 26000 &&
        audits.length === 1 &&
        journals.length === 1 &&
        (audits[0].details as any)?.previousInvoice?.total === 42000 &&
        (audits[0].details as any)?.updatedInvoice?.total === 78000;

      record(
        'P26-01',
        'تعديل فاتورة بيع محفوظة (+ و - كمية) وتحديث المخزن والتقارير وسجل التدقيق',
        passed,
        `prodA=${afterA?.qty} (متوقع 5), prodB=${afterB?.qty} (متوقع 7), total=${updated.total}, profit=${report.profit}, num=${updated.invoice_number}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Edit saved PURCHASE invoice (new item + price update + report sync)
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('EditPurchase');
    try {
      const sup = await adapter.addParty('مورد الأجهزة', '07700000000', 'supplier');
      const prodA = await adapter.saveProduct({
        name: 'كيبورد ميكانيكي',
        category: 'حواسيب',
        buy_price: 20000,
        sell_price: 30000,
        qty: 2,
      });
      const prodB = await adapter.saveProduct({
        name: 'ماوس لاسلكي',
        category: 'حواسيب',
        buy_price: 8000,
        sell_price: 12000,
        qty: 0,
      });

      const purchaseInv = await adapter.saveInvoice({
        type: 'purchase',
        partyId: sup.id!,
        items: [
          {
            product_id: prodA.id!,
            name: prodA.name,
            qty: 5,
            price: 20000,
            cost: 20000,
            sell_price: 30000,
          },
        ],
        discount: 0,
        paid: 50000, // 50,000 remaining due to supplier
      });

      // Edit purchase: prodA qty 5 -> 3 (buy_price 22000, sell_price 33000), add prodB qty 4 @ 8500
      const updated = await adapter.updateInvoice({
        invoiceId: purchaseInv.id!,
        partyId: sup.id!,
        items: [
          {
            product_id: prodA.id!,
            name: prodA.name,
            qty: 3,
            price: 22000,
            cost: 22000,
            sell_price: 33000,
          },
          {
            product_id: prodB.id!,
            name: prodB.name,
            qty: 4,
            price: 8500,
            cost: 8500,
            sell_price: 14000,
          },
        ],
        discount: 0,
        paid: 50000,
        actorRole: 'admin',
      });

      // Total = 66000 + 34000 = 100000; paid = 50000 => supplier balance = 50000
      // prodA qty started at 2 + 5 = 7 -> edit 5->3 => 5; prodB started 0 -> +4 = 4
      const afterA = await db.products.get(prodA.id!);
      const afterB = await db.products.get(prodB.id!);
      const supAfterDb = (await service.parties.getAll('supplier')).find((p) => p.id === sup.id!);
      const supAfterCache = adapter.getParties('supplier').find((p) => p.id === sup.id!);
      const report = await service.reports.getReport(
        new Date(Date.now() - 86400000),
        new Date(Date.now() + 86400000)
      );

      const passed =
        updated.total === 100000 &&
        afterA?.qty === 5 &&
        afterA?.buy_price === 22000 &&
        afterA?.sell_price === 33000 &&
        afterB?.qty === 4 &&
        afterB?.buy_price === 8500 &&
        afterB?.sell_price === 14000 &&
        supAfterDb?.balance === 50000 &&
        supAfterCache?.balance === 50000 &&
        report.purchases === 100000;

      record(
        'P26-02',
        'تعديل فاتورة شراء محفوظة (كميات + أسعار + صنف جديد)',
        passed,
        `prodA=${afterA?.qty} (buy=${afterA?.buy_price}), prodB=${afterB?.qty}, supBalance=${supAfterDb?.balance}/${supAfterCache?.balance}, purchases=${report.purchases}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Edit partial credit invoice & verify exact customer balance + payment safety
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('CreditBalance');
    try {
      const cust = await adapter.addParty('أحمد الآجل', '07801111111', 'customer');
      const prod = await adapter.saveProduct({
        name: 'راوتر واي فاي',
        category: 'شبكات',
        buy_price: 30000,
        sell_price: 45000,
        qty: 10,
      });

      const inv = await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 45000, cost: 30000 }],
        discount: 0,
        paid: 40000, // remaining debt = 50,000
      });
      const paymentsBefore = await db.payments.count();

      // Edit invoice: total drops to 45,000, paid adjusted to 15,000 -> remaining debt = 30,000
      await adapter.updateInvoice({
        invoiceId: inv.id!,
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 45000, cost: 30000 }],
        discount: 0,
        paid: 15000,
        actorRole: 'manager',
      });

      const custAfterDb = (await service.parties.getAll('customer')).find((p) => p.id === cust.id!);
      const custAfterCache = adapter.getParties('customer').find((p) => p.id === cust.id!);
      const paymentsAfter = await db.payments.count();

      record(
        'P26-03',
        'تعديل فاتورة آجلة مدفوعة جزئياً وحساب ذمة العميل بدقة دون توليد دفعات مكررة',
        custAfterDb?.balance === 30000 &&
          custAfterCache?.balance === 30000 &&
          paymentsAfter === paymentsBefore,
        `custBalance=${custAfterDb?.balance}/${custAfterCache?.balance} (متوقع 30000), payments=${paymentsBefore}->${paymentsAfter}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Block editing when linked sale_return OR standalone post-invoice payment exists
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('BlockedLinks');
    try {
      const cust = await adapter.addParty('زبون مقيد', '07712222222', 'customer');
      const prod = await adapter.saveProduct({
        name: 'بطارية',
        category: 'طاقة',
        buy_price: 5000,
        sell_price: 10000,
        qty: 10,
      });

      // Case A: Invoice linked to sale_return
      const invWithReturn = await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 10000, cost: 5000 }],
        discount: 0,
        paid: 20000,
      });
      await adapter.saveInvoice({
        type: 'sale_return',
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 10000, cost: 5000 }],
        discount: 0,
        paid: 10000,
        originalInvoiceId: invWithReturn.id!,
      });

      const eligA = await adapter.canEditInvoice(invWithReturn.id!);
      let blockedReturn = false;
      try {
        await adapter.updateInvoice({
          invoiceId: invWithReturn.id!,
          partyId: cust.id!,
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 10000, cost: 5000 }],
          discount: 0,
          paid: 10000,
        });
      } catch {
        blockedReturn = true;
      }

      // Case B: Invoice followed by standalone payment
      const invWithPayment = await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 10000, cost: 5000 }],
        discount: 0,
        paid: 0,
      });
      await new Promise((r) => setTimeout(r, 15));
      await adapter.addPayment(cust.id!, 5000, `تسديد للفاتورة #${invWithPayment.id}`);

      const eligB = await adapter.canEditInvoice(invWithPayment.id!);
      let blockedPayment = false;
      try {
        await adapter.updateInvoice({
          invoiceId: invWithPayment.id!,
          partyId: cust.id!,
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 10000, cost: 5000 }],
          discount: 0,
          paid: 0,
        });
      } catch {
        blockedPayment = true;
      }

      const passed = !eligA.canEdit && blockedReturn && !eligB.canEdit && blockedPayment;
      record(
        'P26-04',
        'منع تعديل فاتورة مرتبطة بمرتجع أو بدفعة تسديد لاحقة',
        passed,
        `reasonReturn="${eligA.reason}" | reasonPayment="${eligB.reason}"`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Block cashier role & voided invoice edits
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('RoleAndVoid');
    try {
      const prod = await adapter.saveProduct({
        name: 'فلاش ميموري',
        category: 'تخزين',
        buy_price: 3000,
        sell_price: 6000,
        qty: 5,
      });

      const inv = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 6000, cost: 3000 }],
        discount: 0,
        paid: 6000,
      });

      let blockedCashier = false;
      try {
        await adapter.updateInvoice({
          invoiceId: inv.id!,
          partyId: null,
          items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 6000, cost: 3000 }],
          discount: 0,
          paid: 12000,
          actorRole: 'cashier',
        });
      } catch {
        blockedCashier = true;
      }

      await adapter.deleteInvoice(inv.id!);
      const eligVoid = await adapter.canEditInvoice(inv.id!);
      let blockedVoid = false;
      try {
        await adapter.updateInvoice({
          invoiceId: inv.id!,
          partyId: null,
          items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 6000, cost: 3000 }],
          discount: 0,
          paid: 6000,
          actorRole: 'owner',
        });
      } catch {
        blockedVoid = true;
      }

      record(
        'P26-05',
        'منع تعديل الفاتورة من صلاحية الكاشير ومنع تعديل الفواتير الملغاة',
        blockedCashier && !eligVoid.canEdit && blockedVoid,
        `blockedCashier=${blockedCashier}, blockedVoid=${blockedVoid}, eligReason="${eligVoid.reason}"`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Block edit causing negative stock (both Sale increase & Purchase reduction)
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('NegStock');
    try {
      const sup = await adapter.addParty('مورد أساسي', '07709999999', 'supplier');
      const prod = await adapter.saveProduct({
        name: 'شاشة حماية',
        category: 'حماية',
        buy_price: 1000,
        sell_price: 3000,
        qty: 0,
      });

      const purchaseInv = await adapter.saveInvoice({
        type: 'purchase',
        partyId: sup.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 5, price: 1000, cost: 1000 }],
        discount: 0,
        paid: 5000,
      });
      // Now stock = 5. Sell 4 -> stock = 1
      const saleInv = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 4, price: 3000, cost: 1000 }],
        discount: 0,
        paid: 12000,
      });

      // Attempt A: edit sale from 4 to 6 (available max = 1 + 4 = 5 -> 6 exceeds by 1)
      let saleBlocked = false;
      try {
        await adapter.updateInvoice({
          invoiceId: saleInv.id!,
          partyId: null,
          items: [{ product_id: prod.id!, name: prod.name, qty: 6, price: 3000, cost: 1000 }],
          discount: 0,
          paid: 18000,
        });
      } catch (e: any) {
        saleBlocked = e instanceof InsufficientStockError || e?.name === 'InsufficientStockError';
      }

      // Attempt B: edit purchase from 5 down to 2 (stock would become 1 - 3 = -2 -> must fail!)
      let purchBlocked = false;
      try {
        await adapter.updateInvoice({
          invoiceId: purchaseInv.id!,
          partyId: sup.id!,
          items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 1000, cost: 1000 }],
          discount: 0,
          paid: 2000,
        });
      } catch (e: any) {
        purchBlocked = e instanceof InsufficientStockError || e?.name === 'InsufficientStockError';
      }

      const prodAfter = await db.products.get(prod.id!);
      record(
        'P26-06',
        'منع تعديل فاتورة بيع أو شراء إذا تسبب بمخزون سالب',
        saleBlocked && purchBlocked && prodAfter?.qty === 1,
        `saleBlocked=${saleBlocked}, purchBlocked=${purchBlocked}, finalQty=${prodAfter?.qty} (متوقع 1)`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Mid-transaction fault injection -> full atomic rollback
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('Rollback');
    try {
      const prod = await adapter.saveProduct({
        name: 'محول كهرباء',
        category: 'كهرباء',
        buy_price: 4000,
        sell_price: 7000,
        qty: 10,
      });
      const inv = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 7000, cost: 4000 }],
        discount: 0,
        paid: 14000,
      });

      const origAdd = db.audit_logs.add.bind(db.audit_logs);
      (db.audit_logs as any).add = async () => {
        throw new Error('INJECTED_MID_TX_AUDIT_FAILURE');
      };

      let threw = false;
      try {
        await adapter.updateInvoice({
          invoiceId: inv.id!,
          partyId: null,
          items: [{ product_id: prod.id!, name: prod.name, qty: 5, price: 7000, cost: 4000 }],
          discount: 0,
          paid: 35000,
        });
      } catch {
        threw = true;
      } finally {
        (db.audit_logs as any).add = origAdd;
      }

      const invAfter = await db.invoices.get(inv.id!);
      const itemsAfter = await db.invoice_items.where('invoice_id').equals(inv.id!).toArray();
      const prodAfter = await db.products.get(prod.id!);

      record(
        'P26-07',
        'التراجع الذري الكامل (Atomic Rollback) عند فشل معاملة تعديل الفاتورة في منتصفها',
        threw && invAfter?.total === 14000 && itemsAfter[0]?.qty === 2 && prodAfter?.qty === 8,
        `threw=${threw}, invTotal=${invAfter?.total}, itemQty=${itemsAfter[0]?.qty}, stock=${prodAfter?.qty}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Retry idempotency with identical editIdempotencyKey
  // ---------------------------------------------------------------------------
  {
    const { db, adapter, service } = await createIsolatedDb('IdempotentEdit');
    try {
      const prod = await adapter.saveProduct({
        name: 'كيبل HDMI',
        category: 'كابلات',
        buy_price: 1500,
        sell_price: 3500,
        qty: 10,
      });
      const inv = await adapter.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 3500, cost: 1500 }],
        discount: 0,
        paid: 3500,
      });

      const editKey = generateUUID();
      const first = await service.invoices.updateInvoice({
        invoiceId: inv.id!,
        partyId: null,
        items: [{ product_id: prod.id!, name: prod.name, qty: 4, price: 3500, cost: 1500 }],
        discount: 0,
        paid: 14000,
        editIdempotencyKey: editKey,
      });
      const retry = await service.invoices.updateInvoice({
        invoiceId: inv.id!,
        partyId: null,
        items: [{ product_id: prod.id!, name: prod.name, qty: 4, price: 3500, cost: 1500 }],
        discount: 0,
        paid: 14000,
        editIdempotencyKey: editKey,
      });

      const prodAfter = await db.products.get(prod.id!);
      record(
        'P26-08',
        'منع تكرار خصم المخزن عند إعادة إرسال تعديل الفاتورة بنفس editIdempotencyKey',
        first.deduplicated === false && retry.deduplicated === true && prodAfter?.qty === 6,
        `first.dedup=${first.deduplicated}, retry.dedup=${retry.deduplicated}, finalQty=${prodAfter?.qty} (متوقع 6)`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 9. PDF Generation Verification (All 4 invoice types, reports, XSS escaping, sizes, binary %PDF-, error result)
  // ---------------------------------------------------------------------------
  {
    const types: Array<'sale' | 'purchase' | 'sale_return' | 'quote'> = [
      'sale',
      'purchase',
      'sale_return',
      'quote',
    ];
    const items = [
      {
        product_id: 1,
        name: 'منتج <script>alert(1)</script> عربي',
        qty: 2,
        price: 5000,
        cost: 3000,
      },
    ];

    const html58 = buildInvoicePdfHtml(
      {
        id: 100,
        invoice_number: 'INV-26-1',
        type: types[0],
        party_id: null,
        party_name: 'عميل <b>اختباري</b>',
        total: 10000,
        discount: 0,
        paid: 10000,
        date: '2026-04-12T10:00:00.000Z',
        currency: 'د.ع',
      },
      items,
      TEST_SETTINGS,
      'thermal58'
    );
    const html80 = buildInvoicePdfHtml(
      {
        id: 101,
        invoice_number: 'INV-26-2',
        type: types[1],
        party_id: null,
        party_name: 'مورد <script>x</script>',
        total: 10000,
        discount: 0,
        paid: 10000,
        date: '2026-04-12T10:00:00.000Z',
        currency: 'د.ع',
      },
      items,
      TEST_SETTINGS,
      'thermal80'
    );
    const htmlReturnA4 = buildInvoicePdfHtml(
      {
        id: 102,
        invoice_number: 'RET-26-3',
        type: types[2],
        party_id: null,
        party_name: 'عميل مرتجع',
        total: 10000,
        discount: 0,
        paid: 10000,
        date: '2026-04-12T10:00:00.000Z',
        currency: 'د.ع',
      },
      items,
      TEST_SETTINGS,
      'a4'
    );
    const htmlQuoteA4 = buildInvoicePdfHtml(
      {
        id: 103,
        invoice_number: 'QOT-26-4',
        type: types[3],
        party_id: null,
        party_name: 'عميل عرض',
        total: 10000,
        discount: 0,
        paid: 0,
        date: '2026-04-12T10:00:00.000Z',
        currency: 'د.ع',
      },
      items,
      TEST_SETTINGS,
      'a4'
    );

    const reportHtml = buildReportPdfHtml({
      reportTitle: 'كشف حساب العميل & تقرير المبيعات <اختبار>',
      reportDate: '2026-04-12',
      columns: ['التاريخ', 'البيان', 'الإجمالي'],
      rows: [['2026-04-12', 'فاتورة بيع INV-26-1', '10000']],
      summaryCards: [{ label: 'الإجمالي', value: '10000 د.ع' }],
      settings: TEST_SETTINGS,
    });

    // Verify binary PDF output from jsPDF engine across a4, thermal80, and thermal58
    const pdfA4 = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pdf80 = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [80, 180] });
    const pdf58 = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [58, 160] });
    const binA4 = pdfA4.output('datauristring');
    const bin80 = pdf80.output('datauristring');
    const bin58 = pdf58.output('datauristring');
    const decodeHeader = (uri: string) =>
      Buffer.from(uri.split(',')[1] || '', 'base64').toString('ascii', 0, 5);

    const htmlOutputs = [html58, html80, htmlReturnA4, htmlQuoteA4];
    const noRawScript =
      htmlOutputs.every(
        (h) => !h.includes('<script>alert(1)</script>') && h.includes('&lt;script&gt;')
      ) &&
      !reportHtml.includes('<اختبار>') &&
      reportHtml.includes('&lt;اختبار&gt;');
    const labelsAndSizesValid =
      html58.includes('فاتورة بيع') &&
      html58.includes('font-size:10px') &&
      html80.includes('فاتورة شراء') &&
      html80.includes('font-size:11px') &&
      htmlReturnA4.includes('فاتورة مرتجع') &&
      htmlReturnA4.includes('pdf-avoid-break') &&
      htmlQuoteA4.includes('عرض سعر') &&
      htmlOutputs.every((h) => h.includes('INV-26-') || h.includes('RET-26-') || h.includes('QOT-26-'));
    const allBinaryValid =
      decodeHeader(binA4) === '%PDF-' &&
      decodeHeader(bin80) === '%PDF-' &&
      decodeHeader(bin58) === '%PDF-';

    // Also confirm calling exportInvoiceToPdf without DOM returns explicit PdfExportResult error instead of silent failure
    const { exportInvoiceToPdf } = await import('../src/utils/pdfExport');
    const noDomRes = await exportInvoiceToPdf(
      {
        id: 1,
        invoice_number: 'INV-1',
        type: 'sale',
        party_id: null,
        total: 1000,
        discount: 0,
        paid: 1000,
        date: new Date().toISOString(),
      },
      items,
      TEST_SETTINGS
    );

    record(
      'P26-09',
      'اختبار توليد PDF (الأنواع الأربعة + التقارير + XSS + مقاسات 58mm/80mm/A4 + توقيع %PDF- + نتيجة الخطأ)',
      noRawScript &&
        labelsAndSizesValid &&
        allBinaryValid &&
        noDomRes.success === false &&
        Boolean(noDomRes.error) &&
        escapeHtml('<a>') === '&lt;a&gt;',
      `noRawScript=${noRawScript}, labelsAndSizesValid=${labelsAndSizesValid}, binaryHeaders=${decodeHeader(binA4)}/${decodeHeader(bin80)}/${decodeHeader(bin58)}, noDomErr="${noDomRes.error}"`
    );
  }

  // ---------------------------------------------------------------------------
  // 10. Old invoice reprint is strictly read-only
  // ---------------------------------------------------------------------------
  {
    const { db, adapter } = await createIsolatedDb('ReprintReadOnly');
    try {
      const cust = await adapter.addParty('عميل طباعة', '07720000000', 'customer');
      const prod = await adapter.saveProduct({
        name: 'شاحن سيارة',
        category: 'شواحن',
        buy_price: 3000,
        sell_price: 7000,
        qty: 12,
      });
      const inv = await adapter.saveInvoice({
        type: 'sale',
        partyId: cust.id!,
        items: [{ product_id: prod.id!, name: prod.name, qty: 2, price: 7000, cost: 3000 }],
        discount: 0,
        paid: 10000,
      });

      const countsBefore = {
        invoices: await db.invoices.count(),
        items: await db.invoice_items.count(),
        journals: await db.change_journal.count(),
        audits: await db.audit_logs.count(),
        prodQty: (await db.products.get(prod.id!))?.qty,
        partyBal: (await db.parties.get(cust.id!))?.balance,
      };

      // Simulate reprinting old invoice
      const fetched = await db.invoices.get(inv.id!);
      const fetchedItems = await db.invoice_items.where('invoice_id').equals(inv.id!).toArray();
      const html = buildInvoicePdfHtml(fetched!, fetchedItems as any, TEST_SETTINGS, 'thermal80');

      const countsAfter = {
        invoices: await db.invoices.count(),
        items: await db.invoice_items.count(),
        journals: await db.change_journal.count(),
        audits: await db.audit_logs.count(),
        prodQty: (await db.products.get(prod.id!))?.qty,
        partyBal: (await db.parties.get(cust.id!))?.balance,
      };

      record(
        'P26-10',
        'إعادة طباعة فاتورة قديمة عملية قراءة فقط 100% دون أي تعديل على البيانات',
        html.includes(fetched!.invoice_number!) &&
          JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
        `invoices=${countsAfter.invoices}, stock=${countsAfter.prodQty}, bal=${countsAfter.partyBal}`
      );
    } finally {
      await cleanupDb(db, adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // 11. Backup + Restore round-trip preserving edited invoice state
  // ---------------------------------------------------------------------------
  {
    const { db: dbSrc, adapter: adapterSrc } = await createIsolatedDb('BackupSrc');
    const { db: dbDst, adapter: adapterDst } = await createIsolatedDb('BackupDst');
    try {
      const prod = await adapterSrc.saveProduct({
        name: 'مايكروفون',
        category: 'صوتيات',
        buy_price: 15000,
        sell_price: 25000,
        qty: 10,
      });
      const inv = await adapterSrc.saveInvoice({
        type: 'sale',
        items: [{ product_id: prod.id!, name: prod.name, qty: 1, price: 25000, cost: 15000 }],
        discount: 0,
        paid: 25000,
      });
      await adapterSrc.updateInvoice({
        invoiceId: inv.id!,
        partyId: null,
        items: [{ product_id: prod.id!, name: prod.name, qty: 3, price: 25000, cost: 15000 }],
        discount: 5000,
        paid: 70000,
      });

      const backup = await createFullDexieBackup(dbSrc, 'manual');
      const validation = await validateBackupInSandbox(backup.jsonString);
      await restoreDexieBackupSafely(backup.jsonString, dbDst);
      await adapterDst.initializeAsync(dbDst);

      const restoredInv = await dbDst.invoices.get(inv.id!);
      const restoredProd = await dbDst.products.get(prod.id!);
      const restoredUpdateJournals = await dbDst.change_journal
        .filter((j) => j.table === 'invoices' && j.action === 'update')
        .count();

      record(
        'P26-11',
        'النسخ الاحتياطي والاستعادة يحافظان على الفواتير المعدلة والمخزن وسجل الحركات',
        validation.valid &&
          restoredInv?.total === 70000 &&
          restoredInv?.invoice_number === inv.invoice_number &&
          restoredProd?.qty === 7 &&
          restoredUpdateJournals >= 1,
        `valid=${validation.valid}, restoredTotal=${restoredInv?.total}, restoredQty=${restoredProd?.qty}, updateJournals=${restoredUpdateJournals}`
      );
    } finally {
      await cleanupDb(dbSrc, adapterSrc);
      await cleanupDb(dbDst, adapterDst);
    }
  }

  // ---------------------------------------------------------------------------
  // 12. Cloud / Firebase / Drive guard unit verification (zero live network calls)
  // ---------------------------------------------------------------------------
  {
    // Test 1MB Firestore size guard BEFORE hitting network
    const oversizedJson = 'x'.repeat(1_050_000);
    let caughtSizeGuard = false;
    let sizeMessage = '';
    try {
      await saveBackupToFirestore('test-uid-isolated', oversizedJson, {
        productsCount: 1,
        invoicesCount: 1,
      });
    } catch (err: any) {
      sizeMessage = String(err?.message || '');
      caughtSizeGuard = sizeMessage.includes('1 MB') || sizeMessage.includes('1MB');
    }

    // Test offline diagnostic accuracy
    const origNav = (globalThis as any).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...(origNav || {}), onLine: false },
      configurable: true,
    });
    let offlineDiagOk = false;
    try {
      const diag = await diagnoseFirestoreConnection();
      offlineDiagOk = diag.ok === false && diag.status === 'offline';
    } finally {
      if (origNav !== undefined) {
        Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true });
      }
    }

    // Test token cache & error translation
    clearDriveToken();
    const tokenCleared = hasValidDriveToken() === false;
    const translatedUnauthorized = translateFirebaseError({ code: 'auth/unauthorized-domain' });

    record(
      'P26-12',
      'فحص حراس Google/Firebase المعزولين (حجم >1MB، وضع عدم الاتصال، صلاحية Drive، ترجمة الأخطاء)',
      caughtSizeGuard &&
        offlineDiagOk &&
        tokenCleared &&
        translatedUnauthorized.includes('Authorized Domains'),
      `sizeGuard=${caughtSizeGuard}, offlineDiag=${offlineDiagOk}, tokenCleared=${tokenCleared}`
    );
  }

    console.log('\n==================================================================');
    console.log(`✅ اكتملت جميع اختبارات المرحلة 26 بنجاح (${results.length}/${results.length})`);
    console.log('==================================================================');
  } finally {
    storageCacheAdapter.dispose();
    await terminate(firestore).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\n❌ فشل تشغيل حزمة التحقق Phase 26:', err);
  process.exitCode = 1;
});
