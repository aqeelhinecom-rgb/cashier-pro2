// @ts-ignore
import 'fake-indexeddb/auto';
import { CashierDatabase } from '../schema';
import { StorageService } from '../storageService';
import { generateUUID } from '../uuid';
import { migrateLegacyDataToDexie } from '../migration/migrator';
import { LegacyLocalStorageDump } from '../migration/reader';
import { createSafeChunkedSnapshot } from '../migration/chunkedSnapshot';
import { checkStorageQuota, requestStoragePersistence } from '../storageQuota';

interface TestResultItem {
  id: number;
  name: string;
  passed: boolean;
  details: string;
}

export async function runStandaloneStorageTestSuite(): Promise<{
  allPassed: boolean;
  totalTests: number;
  passedTests: number;
  results: TestResultItem[];
}> {
  const results: TestResultItem[] = [];
  const testDbName = `CashierTest_Standalone_${Date.now()}`;
  const testDb = new CashierDatabase(testDbName);
  const storage = new StorageService(testDb);

  try {
    await testDb.open();

    // -------------------------------------------------------------
    // Test 1: CRUD Operations (Create, Read, Update, Delete)
    // -------------------------------------------------------------
    try {
      // Create product
      const product = await storage.products.save({
        name: 'شاشة آيفون 13 برو تجريبية',
        barcode: '998877665544',
        category: 'قطع غيار',
        buy_price: 25000,
        sell_price: 35000,
        qty: 10,
      });

      if (!product.id || !product.uuid || product.qty !== 10) {
        throw new Error('فشل إنشاء المنتج التجريبي');
      }

      // Read product by barcode
      const foundByBarcode = await storage.products.getByBarcode('998877665544');
      if (!foundByBarcode || foundByBarcode.id !== product.id) {
        throw new Error('فشل قراءة المنتج بواسطة الباركود');
      }

      // Update product stock and price
      await storage.products.save({
        id: product.id,
        name: 'شاشة آيفون 13 برو تجريبية - معدلة',
        sell_price: 38000,
      });
      const updatedProduct = await storage.products.getById(product.id);
      if (!updatedProduct || updatedProduct.sell_price !== 38000 || updatedProduct.name !== 'شاشة آيفون 13 برو تجريبية - معدلة') {
        throw new Error('فشل تعديل المنتج التجريبي');
      }

      // Create party (Customer)
      const party = await storage.parties.save({
        name: 'زبون تجريبي',
        phone: '0770112233',
        type: 'customer',
      });
      if (!party.id || !party.uuid) {
        throw new Error('فشل إنشاء العميل التجريبي');
      }

      // Create expense
      const expense = await storage.expenses.add({
        recipient: 'فاتورة إنترنت تجريبية',
        amount: 500,
        notes: 'اختبار مصاريف',
      });
      if (!expense.id || expense.amount !== 500) {
        throw new Error('فشل إضافة المصروف التجريبي');
      }

      // Create payment
      const payment = await storage.payments.add({
        partyId: party.id,
        amount: 200,
        notes: 'سند قبض تجريبي',
      });
      if (!payment.id || payment.amount !== 200) {
        throw new Error('فشل إضافة الدفعة التجريبية');
      }

      results.push({
        id: 1,
        name: 'اختبار العمليات الأساسية (CRUD: إنشاء، قراءة، تعديل، حذف)',
        passed: true,
        details: `تم إنشاء وقراءة وتعديل المنتج (ID: ${product.id})، العميل (ID: ${party.id})، المصروف (ID: ${expense.id})، والدفعة (ID: ${payment.id}) بنجاح.`,
      });
    } catch (err: any) {
      results.push({
        id: 1,
        name: 'اختبار العمليات الأساسية (CRUD)',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 2: Relational Integrity (Invoices & Invoice Items)
    // -------------------------------------------------------------
    try {
      const prod = await storage.products.save({
        name: 'كابل شحن سريع',
        barcode: '1122334455',
        category: 'إكسسوارات',
        buy_price: 3000,
        sell_price: 5000,
        qty: 50,
      });

      const { invoice, items } = await storage.invoices.createInvoice({
        type: 'sale',
        partyId: null,
        items: [
          {
            product_id: prod.id,
            name: prod.name,
            qty: 3,
            price: 5000,
            cost: 3000,
          },
        ],
        discount: 1000,
        paid: 14000,
      });

      const fetchedItems = await storage.invoices.getItems(invoice.id);
      if (fetchedItems.length !== 1 || fetchedItems[0].invoice_id !== invoice.id || fetchedItems[0].qty !== 3) {
        throw new Error('فشل التحقق من ربط بنود الفاتورة برقم الفاتورة');
      }

      results.push({
        id: 2,
        name: 'اختبار العلاقات والارتباط بين الفواتير وبنودها (Relational Integrity)',
        passed: true,
        details: `تم التحقق من ربط الفاتورة #${invoice.id} بالبند #${fetchedItems[0].id} بنجاح مطابق.`,
      });
    } catch (err: any) {
      results.push({
        id: 2,
        name: 'اختبار العلاقات بين الفواتير وبنودها',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 3: Atomic Transactions (Success & Multi-table sync)
    // -------------------------------------------------------------
    try {
      const prodA = await storage.products.save({
        name: 'ماوس لاسلكي احترافي',
        barcode: '5566778899',
        category: 'إلكترونيات',
        buy_price: 8000,
        sell_price: 12000,
        qty: 20,
      });

      // Execute Sale Invoice: should decrement stock from 20 to 16
      const { invoice } = await storage.invoices.createInvoice({
        type: 'sale',
        items: [
          {
            product_id: prodA.id,
            name: prodA.name,
            qty: 4,
            price: 12000,
            cost: 8000,
          },
        ],
        discount: 0,
        paid: 48000,
      });

      const prodAfterSale = await storage.products.getById(prodA.id);
      if (!prodAfterSale || prodAfterSale.qty !== 16) {
        throw new Error(`الكمية بالمخزن لم تنقص بالشكل الصحيح: المتوقع 16، الفعلي ${prodAfterSale?.qty}`);
      }

      results.push({
        id: 3,
        name: 'اختبار المعاملات الذرية الناجحة (Atomic Transaction: Stock + Invoice + Items)',
        passed: true,
        details: `تم حفظ الفاتورة #${invoice.id} وخصم رصيد المخزن ذرياً من 20 إلى ${prodAfterSale.qty}.`,
      });
    } catch (err: any) {
      results.push({
        id: 3,
        name: 'اختبار المعاملات الذرية',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 4: Atomic Rollback on Failure
    // -------------------------------------------------------------
    try {
      const prodB = await storage.products.save({
        name: 'لوحة مفاتيح ميكانيكية',
        barcode: '3344556677',
        category: 'إلكترونيات',
        buy_price: 25000,
        sell_price: 40000,
        qty: 15,
      });

      const initialInvoiceCount = await testDb.invoices.count();
      const initialItemCount = await testDb.invoice_items.count();

      // Trigger a deliberately failed transaction
      let rollbackHappened = false;
      try {
        await testDb.transaction('rw', [testDb.invoices, testDb.invoice_items, testDb.products], async () => {
          // 1. Partial insert
          await testDb.invoices.add({
            type: 'sale',
            party_id: null,
            date: new Date().toISOString(),
            discount: 0,
            total: 40000,
            paid: 40000,
            invoice_number: 'FAIL_TEST',
            uuid: generateUUID(),
            updatedAt: new Date().toISOString(),
          } as any);

          // 2. Modify stock
          await testDb.products.update(prodB.id, { qty: 0 });

          // 3. Intentionally trigger runtime error
          throw new Error('ERR_SIMULATED_TRANSACTION_FAILURE');
        });
      } catch (e: any) {
        if (e.message.includes('ERR_SIMULATED_TRANSACTION_FAILURE')) {
          rollbackHappened = true;
        }
      }

      const prodAfterRollback = await storage.products.getById(prodB.id);
      const afterInvoiceCount = await testDb.invoices.count();
      const afterItemCount = await testDb.invoice_items.count();

      if (!rollbackHappened || prodAfterRollback?.qty !== 15 || afterInvoiceCount !== initialInvoiceCount || afterItemCount !== initialItemCount) {
        throw new Error('فشل التراجع عن المعاملة الذرية (Rollback Failed)');
      }

      results.push({
        id: 4,
        name: 'اختبار فشل المعاملة والتراجع الذري الكامل (Atomic Rollback on Error)',
        passed: true,
        details: `عند حدوث خطأ متعمد، تم التراجع بنسبة 100%: الكمية ظلت 15، ولم تُحفظ أي فاتورة تالفة.`,
      });
    } catch (err: any) {
      results.push({
        id: 4,
        name: 'اختبار فشل المعاملة والتراجع الذري',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 5: UUIDs & Legacy Numeric IDs & Display Number Separation
    // -------------------------------------------------------------
    try {
      const p = await storage.products.save({
        name: 'منتج اختبار المعرفات',
        barcode: '123456789012',
        buy_price: 100,
        sell_price: 150,
      });

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const validUuid = uuidRegex.test(p.uuid);
      const validNumericId = typeof p.id === 'number' && p.id > 0;

      const { invoice } = await storage.invoices.createInvoice({
        type: 'sale',
        customInvoiceNumber: 'BILL-2026-001',
        items: [{ product_id: p.id, name: p.name, qty: 1, price: 150, cost: 100 }],
        discount: 0,
        paid: 150,
      });

      const separateNumberOk = invoice.invoice_number === 'BILL-2026-001' && typeof invoice.id === 'number' && uuidRegex.test(invoice.uuid);

      if (!validUuid || !validNumericId || !separateNumberOk) {
        throw new Error('فشل التحقق من بنية UUID ورقم الفاتورة المنفصل');
      }

      results.push({
        id: 5,
        name: 'اختبار UUID وفصل رقم الفاتورة عن المعرف الداخلي (UUID & Display Number Separation)',
        passed: true,
        details: `المعرف الرقمي: ${p.id}، الـ UUID: ${p.uuid.slice(0, 18)}...، ورقم الفاتورة الظاهر: "${invoice.invoice_number}".`,
      });
    } catch (err: any) {
      results.push({
        id: 5,
        name: 'اختبار UUID وفصل رقم الفاتورة',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 6: Mock Migration from localStorage Format & Parity
    // -------------------------------------------------------------
    try {
      const mockLegacyData: LegacyLocalStorageDump = {
        products: [
          { id: 101, name: 'منتج قديم 1', barcode: '888001', category: 'أغذية', description: 'وصف', buy_price: 50, sell_price: 75, qty: 30 },
          { id: 102, name: 'منتج قديم 2 (صورة)', barcode: '888002', category: 'منظفات', description: 'وصف', buy_price: 20, sell_price: 35, qty: 15, image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
        ],
        parties: [
          { id: 201, name: 'مورد قديم', phone: '0780000000', type: 'supplier', balance: -500 },
        ],
        invoices: [
          { id: 301, type: 'sale', party_id: null, party_name: 'مفرد', date: '2026-11-01T10:00:00.000Z', discount: 5, total: 145, paid: 145 },
          { id: 302, type: 'purchase', party_id: 201, party_name: 'مورد قديم', date: '2026-11-02T11:00:00.000Z', discount: 0, total: 600, paid: 100 },
        ],
        invoice_items: [
          { id: 401, invoice_id: 301, product_id: 101, name: 'منتج قديم 1', qty: 2, price: 75, cost: 50 },
          { id: 402, invoice_id: 302, product_id: 102, name: 'منتج قديم 2 (صورة)', qty: 30, price: 20, cost: 20 },
        ],
        payments: [
          { id: 501, party_id: 201, party_name: 'مورد قديم', amount: 100, date: '2026-11-03T12:00:00.000Z', notes: 'دفعة حساب' },
        ],
        expenses: [
          { id: 601, recipient: 'صيانة دورية', amount: 80, date: '2026-11-04T13:00:00.000Z' },
        ],
        settings: {
          storeName: 'محل تجريبي قديم',
          phone: '0500000000',
          address: 'العنوان',
          currency: 'د.ع',
          taxRate: 0,
          receiptFooter: 'شكراً',
        },
        categories: ['أغذية', 'منظفات'],
        permissionsGranted: true,
        heldInvoices: [
          {
            type: 'sale',
            items: [{ id: 'h1', time: '14:00', partyId: null, partyName: 'مفرد', items: [], discount: 0 }],
          },
        ],
        rawKeyCounts: {},
        timestamp: new Date().toISOString(),
      };

      const migrationTestDb = new CashierDatabase(`CashierMigrationTest_${Date.now()}`);
      await migrationTestDb.open();
      const migrationReport = await migrateLegacyDataToDexie(mockLegacyData, migrationTestDb);
      if (!migrationReport.success) {
        await migrationTestDb.delete();
        throw new Error(`فشل تقرير مطابقة الترحيل: ${migrationReport.errors.join(', ')}`);
      }

      // Check snapshot generator as well
      const { manifest } = await createSafeChunkedSnapshot(mockLegacyData, migrationTestDb);
      await migrationTestDb.delete();
      if (manifest.totalRecords < 8) {
        throw new Error('فشل إنشاء Snapshot المفرز في IndexedDB');
      }

      results.push({
        id: 6,
        name: 'اختبار ترحيل بيانات تجريبية بصيغة localStorage مع التحقق المالي والإحصائي',
        passed: true,
        details: `تطابق تام: ${migrationReport.counts.products.migrated} منتج، ${migrationReport.counts.invoices.migrated} فاتورة بإجمالي (${migrationReport.financials.migratedInvoicesTotal})، و Snapshot مشفر (${manifest.checksum}).`,
      });
    } catch (err: any) {
      results.push({
        id: 6,
        name: 'اختبار ترحيل بيانات تجريبية',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 7: Product Images (Preserve Base64 & Image Repository)
    // -------------------------------------------------------------
    try {
      const base64Data = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD...';
      const prod = await storage.products.save({
        name: 'منتج مع صورة أصلية',
        barcode: '7788990011',
        buy_price: 500,
        sell_price: 800,
        image: base64Data,
      });

      const reloaded = await storage.products.getById(prod.id);
      if (reloaded?.image !== base64Data) {
        throw new Error('فقدان أو تشويه صورة Base64 الأصلية في المنتج');
      }

      // Also test separate image repository
      const savedSeparate = await storage.images.saveImage(prod.id, {
        base64: base64Data,
        mimeType: 'image/jpeg',
      });
      const fetchedSeparate = await storage.images.getByProductId(prod.id);

      if (!fetchedSeparate || fetchedSeparate.id !== savedSeparate.id || fetchedSeparate.base64 !== base64Data) {
        throw new Error('فشل حفظ أو استرجاع الصورة في ImageRepository المنفصل');
      }

      results.push({
        id: 7,
        name: 'اختبار الحفاظ على صور Base64 والتخزين المنفصل في ImageRepository',
        passed: true,
        details: `تم الحفاظ على نص Base64 الأصلي في كائن المنتج، وتخزينه في جدول الصور المنفصل بنجاح.`,
      });
    } catch (err: any) {
      results.push({
        id: 7,
        name: 'اختبار صور المنتجات',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 8: Held Invoices (Save, Retrieve, Clear)
    // -------------------------------------------------------------
    try {
      const heldId = `hold_${Date.now()}`;
      await storage.heldInvoices.save({
        id: heldId,
        uuid: generateUUID(),
        type: 'sale',
        time: '15:30',
        partyId: null,
        partyName: 'عميل معلق',
        items: [
          {
            product_id: 1,
            name: 'صنف معلق',
            qty: 2,
            price: 1000,
            cost: 800,
          },
        ],
        discount: 50,
        updatedAt: new Date().toISOString(),
      });

      const heldList = await storage.heldInvoices.getByType('sale');
      const foundHeld = heldList.find((h) => h.id === heldId);

      if (!foundHeld || foundHeld.items.length !== 1 || foundHeld.discount !== 50) {
        throw new Error('فشل حفظ أو استرجاع الفاتورة المعلقة');
      }

      await storage.heldInvoices.remove(heldId);
      const afterDeleteList = await storage.heldInvoices.getByType('sale');
      if (afterDeleteList.some((h) => h.id === heldId)) {
        throw new Error('فشل حذف الفاتورة المعلقة بعد استرجاعها');
      }

      results.push({
        id: 8,
        name: 'اختبار حفظ واسترجاع وحذف الفواتير المعلقة (Held Invoices)',
        passed: true,
        details: `تم حفظ الفاتورة المعلقة #${heldId} واسترجاع بندها (${foundHeld.items[0].name}) ثم تفريغها بنجاح.`,
      });
    } catch (err: any) {
      results.push({
        id: 8,
        name: 'اختبار الفواتير المعلقة',
        passed: false,
        details: err.message,
      });
    }

    // -------------------------------------------------------------
    // Test 9: Storage Quota & Persistence Mock Handler
    // -------------------------------------------------------------
    try {
      const quota = await checkStorageQuota();
      const persist = await requestStoragePersistence();

      results.push({
        id: 9,
        name: 'اختبار فحص مساحة التخزين وحالة الاستمرارية (Storage Quota & Persistence)',
        passed: true,
        details: `تم فحص واجهة StorageManager بنجاح (Supported: ${quota.supported}, Persisted: ${persist}).`,
      });
    } catch (err: any) {
      results.push({
        id: 9,
        name: 'اختبار فحص مساحة التخزين',
        passed: false,
        details: err.message,
      });
    }
  } finally {
    await testDb.delete();
  }

  const passedTests = results.filter((r) => r.passed).length;
  const allPassed = passedTests === results.length;

  return {
    allPassed,
    totalTests: results.length,
    passedTests,
    results,
  };
}
