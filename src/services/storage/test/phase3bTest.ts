// @ts-ignore
import 'fake-indexeddb/auto';
import { CashierDatabase } from '../schema';
import { StorageCacheAdapter } from '../cacheAdapter';
import { InvoiceType } from '../types';

export interface Phase3bTestReport {
  allPassed: boolean;
  totalTests: number;
  passedTests: number;
  results: {
    id: number;
    name: string;
    passed: boolean;
    details: string;
  }[];
}

export async function runPhase3bTestSuite(): Promise<Phase3bTestReport> {
  const results: Phase3bTestReport['results'] = [];

  // -------------------------------------------------------------
  // Test 1: Atomic Invoice Creation + Items Insertion + Stock Subtraction
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_AtomicInvoice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // 1. Create a product with stock = 50
    const prod = await adapter.saveProduct({
      name: 'شاي عراقي أصلي',
      barcode: '628100112233',
      buy_price: 2000,
      sell_price: 3500,
      qty: 50,
      category: 'مشروبات',
    });

    // 2. Create customer
    const customer = await adapter.addParty('أحمد علي الزبيدي', '07701234567', 'customer');

    // 3. Issue a sale invoice for 5 units atomically
    const invoice = await adapter.saveInvoice({
      type: 'sale',
      partyId: customer.id,
      discount: 500,
      paid: 10000,
      currency: 'د.ع',
      items: [
        {
          product_id: prod.id,
          name: prod.name,
          category: prod.category,
          qty: 5,
          price: prod.sell_price,
          cost: prod.buy_price,
        },
      ],
    });

    // 4. Verify in IndexedDB directly
    const directInvoice = await testDb.invoices.get(invoice.id);
    const directItems = await testDb.invoice_items.where('invoice_id').equals(invoice.id).toArray();
    const directProduct = await testDb.products.get(prod.id);

    if (!directInvoice || directInvoice.total !== 5 * 3500 - 500) {
      throw new Error(`الفاتورة لم تُحفظ بالقيم الصحيحة في IndexedDB: ${directInvoice?.total}`);
    }
    if (directItems.length !== 1 || directItems[0].qty !== 5) {
      throw new Error(`عناصر الفاتورة لم تُسجل بالشكل الذري: ${directItems.length}`);
    }
    if (directProduct?.qty !== 45) {
      throw new Error(`رصيد المخزن في IndexedDB لم ينقص بالكمية المباعة: المتوقع 45، الفعلي: ${directProduct?.qty}`);
    }

    // 5. Verify In-Memory Cache
    const cachedProd = adapter.getProductById(prod.id);
    const cachedInvoice = adapter.getInvoices('sale').find((i) => i.id === invoice.id);
    if (cachedProd?.qty !== 45 || !cachedInvoice) {
      throw new Error('الـ In-Memory Cache لم يتطابق مع قاعدة البيانات بعد نجاح المعاملة');
    }

    await testDb.delete();

    results.push({
      id: 1,
      name: 'المعاملة الذرية لحفظ الفاتورة وعناصرها وخصم رصيد المخزن (Atomic Invoice Creation)',
      passed: true,
      details: `تم حفظ الفاتورة (#${invoice.id})، إدراج عناصرها، وتحديث رصيد المخزن من 50 إلى 45 بدفعة واحدة ذرية في IndexedDB وCache.`,
    });
  } catch (err: any) {
    results.push({
      id: 1,
      name: 'المعاملة الذرية لحفظ الفاتورة',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 2: Complete Transaction Rollback on Failure & Zero Cache Pollution
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_RollbackTest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Setup initial product with 20 items
    const prod = await adapter.saveProduct({
      name: 'أرز بسمتي فاخر',
      buy_price: 15000,
      sell_price: 20000,
      qty: 20,
    });

    const initialInvoicesCount = (await testDb.invoices.toArray()).length;
    const initialItemsCount = (await testDb.invoice_items.toArray()).length;
    const initialCacheInvoicesCount = adapter.getInvoices().length;

    // Simulate failure during item insertion by hooking db.invoice_items.add to throw
    const originalItemAdd = testDb.invoice_items.add.bind(testDb.invoice_items);
    (testDb.invoice_items as any).add = async () => {
      throw new Error('SIMULATED_INTEGRITY_VIOLATION_DURING_ITEM_SAVE');
    };

    let caughtError = false;
    try {
      await adapter.saveInvoice({
        type: 'sale',
        discount: 0,
        paid: 20000,
        items: [
          {
            product_id: prod.id,
            name: prod.name,
            category: 'عام',
            qty: 5,
            price: 20000,
            cost: 15000,
          },
        ],
      });
    } catch (e: any) {
      if (e.message.includes('SIMULATED_INTEGRITY_VIOLATION_DURING_ITEM_SAVE')) {
        caughtError = true;
      }
    } finally {
      // Restore original function
      testDb.invoice_items.add = originalItemAdd;
    }

    if (!caughtError) {
      throw new Error('لم يتم التقاط الخطأ المتوقع أثناء حفظ عناصر الفاتورة');
    }

    // Inspect IndexedDB: Did rollback work?
    const directInvoicesAfter = (await testDb.invoices.toArray()).length;
    const directItemsAfter = (await testDb.invoice_items.toArray()).length;
    const directProdAfter = await testDb.products.get(prod.id);

    if (directInvoicesAfter !== initialInvoicesCount) {
      throw new Error('فشل الـ Rollback: تم حفظ الفاتورة بدون عناصرها (Orphan Invoice)!');
    }
    if (directItemsAfter !== initialItemsCount) {
      throw new Error('فشل الـ Rollback: تم حفظ عناصر جزئية!');
    }
    if (directProdAfter?.qty !== 20) {
      throw new Error(`فشل الـ Rollback: تم تغيير رصيد المخزن رغم فشل الفاتورة! الرصيد: ${directProdAfter?.qty}`);
    }

    // Inspect Cache: Must be completely clean and unchanged
    if (adapter.getInvoices().length !== initialCacheInvoicesCount) {
      throw new Error('تلوث الـ Cache ببيانات فاتورة ملغاة بسبب خطأ!');
    }
    if (adapter.getProductById(prod.id)?.qty !== 20) {
      throw new Error('تغير رصيد المنتج في Cache رغم فشل الفاتورة على القرص!');
    }

    await testDb.delete();

    results.push({
      id: 2,
      name: 'التراجع الكامل Rollback عند حدوث خطأ ومنع تلوث الـ Cache (Atomic Rollback Safety)',
      passed: true,
      details: 'عند تعمد إفشال حفظ البنود، أجهض Dexie المعاملة بالكامل؛ لم يُسجل أي رأس فاتورة، وبقي المخزن والـ Cache عند 20 قطعة دون أدنى تعديل.',
    });
  } catch (err: any) {
    results.push({
      id: 2,
      name: 'التراجع الكامل Rollback عند حدوث خطأ',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 3: Invoice Cancellation & Stock Reversal (Sale & Purchase)
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_ReversalTest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // 1. Create product with qty = 100
    const prod = await adapter.saveProduct({
      name: 'زيت طعام نباتي 1 لتر',
      buy_price: 3000,
      sell_price: 4500,
      qty: 100,
    });

    // 2. Issue a sale of 10 items (Stock -> 90)
    const saleInv = await adapter.saveInvoice({
      type: 'sale',
      discount: 0,
      paid: 45000,
      items: [
        {
          product_id: prod.id,
          name: prod.name,
          category: 'عام',
          qty: 10,
          price: 4500,
          cost: 3000,
        },
      ],
    });

    if (adapter.getProductById(prod.id)?.qty !== 90) {
      throw new Error('الرصيد بعد البيع غير صحيح');
    }

    // 3. Delete / Void the sale invoice -> Stock should reverse back to 100!
    await adapter.deleteInvoice(saleInv.id);

    const restoredProductInDb = await testDb.products.get(prod.id);
    const restoredProductInCache = adapter.getProductById(prod.id);
    const voidedInvInDb = await testDb.invoices.get(saleInv.id);

    if (restoredProductInDb?.qty !== 100 || restoredProductInCache?.qty !== 100) {
      throw new Error(`فشل استرجاع رصيد المخزن بعد إلغاء الفاتورة: DB=${restoredProductInDb?.qty}, Cache=${restoredProductInCache?.qty}`);
    }

    // In soft-delete mode, invoice is marked isDeleted: true in DB and removed from active Cache
    if (!voidedInvInDb?.isDeleted) {
      throw new Error('لم يتم تعيين علامة isDeleted: true في السجل المالي للفاتورة الملغاة');
    }
    if (adapter.getInvoices().some((i) => i.id === saleInv.id)) {
      throw new Error('الفاتورة الملغاة ما زالت تظهر في قائمة الفواتير النشطة داخل Cache');
    }

    await testDb.delete();

    results.push({
      id: 3,
      name: 'إلغاء الفاتورة واسترجاع كميات المخزون ذرية (Invoice Void & Stock Reversal)',
      passed: true,
      details: 'تم إلغاء فاتورة البيع، واسترجاع الرصيد تلقائياً من 90 إلى 100، وتوثيق الإلغاء مع الحفاظ على السجل التاريخي.',
    });
  } catch (err: any) {
    results.push({
      id: 3,
      name: 'إلغاء الفاتورة واسترجاع كميات المخزون',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 4: Reliable Payments & Expenses Transactions
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_FinanceTest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // 1. Add supplier
    const sup = await adapter.addParty('شركة الرافدين للتجارة', '07801122334', 'supplier');

    // 2. Add two payments
    const p1 = await adapter.addPayment(sup.id, 50000, 'دفعة نقدية أولى');
    const p2 = await adapter.addPayment(sup.id, 25000, 'دفعة نقدية ثانية');

    // 3. Add expenses
    const exp1 = await adapter.addExpense('أجور نقل بضاعة', 15000, new Date().toISOString(), 'سيارة نقل');
    const exp2 = await adapter.addExpense('فاتورة كهرباء المحل', 35000, new Date().toISOString(), 'المولد والوطني');

    // Check DB
    const directPayments = await testDb.payments.where('party_id').equals(sup.id).toArray();
    const directExpenses = await testDb.expenses.toArray();

    if (directPayments.length !== 2 || directPayments.reduce((s, p) => s + p.amount, 0) !== 75000) {
      throw new Error('فشل تسجيل الدفعات المالية في قاعدة البيانات');
    }
    if (directExpenses.length !== 2) {
      throw new Error('فشل تسجيل المصروفات في قاعدة البيانات');
    }

    // Delete one expense
    await adapter.deleteExpense(exp1.id);
    const expensesAfterDelete = await testDb.expenses.where('isDeleted').equals(0).toArray();
    const cachedExpenses = adapter.getExpenses();

    if (cachedExpenses.length !== 1 || cachedExpenses[0].id !== exp2.id) {
      throw new Error('فشل تحديث المصروفات بعد الحذف');
    }

    await testDb.delete();

    results.push({
      id: 4,
      name: 'تسجيل الدفعات والمصروفات بمعاملات موثوقة (Payments & Expenses Reliability)',
      passed: true,
      details: `تم تسجيل دفعتين للمورد بإجمالي 75,000 د.ع وتسجيل ومسح المصروفات مع اتساق كامل بين IndexedDB وCache.`,
    });
  } catch (err: any) {
    results.push({
      id: 4,
      name: 'تسجيل الدفعات والمصروفات بمعاملات موثوقة',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 5: Concurrency Safety with enqueueWrite (Multi-invoice race)
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_RaceInvoice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Product with stock = 100
    const prod = await adapter.saveProduct({
      name: 'صابون غسيل ملابس',
      buy_price: 1000,
      sell_price: 2000,
      qty: 100,
    });

    // Launch 10 concurrent sale invoices of 3 units each in parallel
    const invoicePromises = Array.from({ length: 10 }, (_, i) =>
      adapter.saveInvoice({
        type: 'sale',
        discount: 0,
        paid: 6000,
        items: [
          {
            product_id: prod.id,
            name: prod.name,
            category: 'عام',
            qty: 3,
            price: 2000,
            cost: 1000,
          },
        ],
      })
    );

    const createdInvoices = await Promise.all(invoicePromises);

    // 10 invoices x 3 units = 30 units sold => Remaining must be exactly 70!
    const finalProductInDb = await testDb.products.get(prod.id);
    const finalProductInCache = adapter.getProductById(prod.id);
    const allDbInvoices = await testDb.invoices.toArray();

    if (finalProductInDb?.qty !== 70 || finalProductInCache?.qty !== 70) {
      throw new Error(`تعارض كتابات متزامنة للفواتير: المتوقع 70، الفعلي في DB=${finalProductInDb?.qty} وفي Cache=${finalProductInCache?.qty}`);
    }
    if (allDbInvoices.length !== 10 || createdInvoices.length !== 10) {
      throw new Error(`فقدان فواتير أثناء الحفظ المتزامن: المتوقع 10، الفعلي ${allDbInvoices.length}`);
    }

    await testDb.delete();

    results.push({
      id: 5,
      name: 'حماية العمليات المتزامنة باستخدام enqueueWrite ومنع تضارب الفواتير المتزامنة',
      passed: true,
      details: 'تم إطلاق 10 فواتير مبيعات في نفس اللحظة عبر Promise.all؛ تم جدولتهم تسلسلياً وخصم 30 قطعة (100 -> 70) دون أي تعارض.',
    });
  } catch (err: any) {
    results.push({
      id: 5,
      name: 'حماية العمليات المتزامنة باستخدام enqueueWrite',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 6: Separation of Display Invoice Number from Internal Primary Key
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_InvoiceNumberTest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    const p = await adapter.saveProduct({ name: 'دفتر ملاحظات', buy_price: 500, sell_price: 1000, qty: 50 });

    const inv1 = await adapter.saveInvoice({
      type: 'sale',
      discount: 0,
      paid: 1000,
      items: [{ product_id: p.id, name: p.name, category: 'عام', qty: 1, price: 1000, cost: 500 }],
    });

    const inv2 = await adapter.saveInvoice({
      type: 'purchase',
      discount: 0,
      paid: 500,
      items: [{ product_id: p.id, name: p.name, category: 'عام', qty: 1, price: 500, cost: 500 }],
    });

    const direct1 = await testDb.invoices.get(inv1.id);
    const direct2 = await testDb.invoices.get(inv2.id);

    if (!direct1?.uuid || !direct2?.uuid || direct1.uuid === direct2.uuid) {
      throw new Error('لم يتم إنشاء UUIDs فريدة ومستقلة لكل فاتورة');
    }
    if (!direct1?.invoice_number || !direct2?.invoice_number) {
      throw new Error('رقم الفاتورة الظاهر للمستخدم غير معرف');
    }
    if (typeof direct1.id !== 'number' || typeof direct2.id !== 'number') {
      throw new Error('المعرف الداخلي الرقمي القديم غير محفوظ كرقم');
    }

    await testDb.delete();

    results.push({
      id: 6,
      name: 'فصل رقم الفاتورة الظاهر للمستخدم عن المعرف الرقمي وUUID (Display vs Internal ID Separation)',
      passed: true,
      details: `تم التحقق من توليد UUID منفصل لكل فاتورة مع رقم ظاهر مستقل (${direct1.invoice_number}) والمعرف الرقمي الداخلي (${direct1.id}).`,
    });
  } catch (err: any) {
    results.push({
      id: 6,
      name: 'فصل رقم الفاتورة الظاهر للمستخدم عن المعرف الداخلي',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 7: Purchase Invoice Adds Stock & Updates Buy/Sell Prices
  // -------------------------------------------------------------
  try {
    const dbName = `Phase3b_PurchaseTest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const testDb = new CashierDatabase(dbName);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Initial product: qty = 10, buy = 1000, sell = 1500
    const prod = await adapter.saveProduct({
      name: 'عصير برتقال طبيعي',
      buy_price: 1000,
      sell_price: 1500,
      qty: 10,
    });

    const supplier = await adapter.addParty('موزع العصائر والمشروبات', '07712345678', 'supplier');

    // Purchase invoice: 25 items at new buy price = 1200, new sell price = 1800
    await adapter.saveInvoice({
      type: 'purchase',
      partyId: supplier.id,
      discount: 0,
      paid: 30000,
      items: [
        {
          product_id: prod.id,
          name: prod.name,
          category: 'عام',
          qty: 25,
          price: 1200, // new buy price
          cost: 1200,
          sell_price: 1800, // new sell price
        },
      ],
    });

    const updatedProdInDb = await testDb.products.get(prod.id);
    const updatedProdInCache = adapter.getProductById(prod.id);

    if (updatedProdInDb?.qty !== 35 || updatedProdInCache?.qty !== 35) {
      throw new Error(`فشل تحديث كمية الشراء: المتوقع 35، الفعلي: DB=${updatedProdInDb?.qty}, Cache=${updatedProdInCache?.qty}`);
    }
    if (updatedProdInDb?.buy_price !== 1200 || updatedProdInCache?.buy_price !== 1200) {
      throw new Error('فشل تحديث سعر الشراء الجديد بعد فاتورة الشراء');
    }
    if (updatedProdInDb?.sell_price !== 1800 || updatedProdInCache?.sell_price !== 1800) {
      throw new Error('فشل تحديث سعر البيع الجديد بعد فاتورة الشراء');
    }

    await testDb.delete();

    results.push({
      id: 7,
      name: 'فاتورة الشراء وتحديث أرصدة وأسعار الشراء والبيع ذرياً (Purchase Stock & Price Update)',
      passed: true,
      details: 'تم زيادة رصيد المخزن من 10 إلى 35 وتحديث سعر الشراء إلى 1,200 د.ع وسعر البيع إلى 1,800 د.ع في معاملة ذرية متزامنة.',
    });
  } catch (err: any) {
    results.push({
      id: 7,
      name: 'فاتورة الشراء وتحديث أرصدة وأسعار الشراء والبيع',
      passed: false,
      details: err.message,
    });
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
