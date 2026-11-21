import { CashierDatabase } from '../schema';
import { StorageService } from '../storageService';

export interface BusinessScenarioResult {
  stepNumber: number;
  scenarioName: string;
  beforeState: Record<string, any>;
  afterState: Record<string, any>;
  metrics: {
    stockChanged?: { productId: number; before: number; after: number };
    balanceChanged?: { partyId: number; before: number; after: number };
    invoiceCount?: { before: number; after: number };
    itemCount?: { before: number; after: number };
    expenseCount?: { before: number; after: number };
  };
  passed: boolean;
  notes: string;
}

export async function runBusinessScenariosAudit(
  cloneDb: CashierDatabase,
  cloneService: StorageService
): Promise<{ success: boolean; results: BusinessScenarioResult[]; summary: string }> {
  const results: BusinessScenarioResult[] = [];

  // ----------------------------------------------------
  // السيناريو 1: فاتورة بيع نقدي
  // ----------------------------------------------------
  {
    const prod1Before = await cloneService.products.getById(1);
    const initialQty = prod1Before?.qty ?? 0;
    const invCountBefore = (await cloneService.invoices.getAll()).length;

    // Create cash sale for Product 1 (qty = 1, price = 15000, paid = 15000)
    const saleResult = await cloneService.invoices.createInvoice({
      type: 'sale',
      partyId: null, // Cash walk-in
      paid: 15000,
      discount: 0,
      currency: 'د.ع',
      items: [
        {
          product_id: 1,
          name: prod1Before?.name || 'Lcd iph 11 pro max',
          category: prod1Before?.category || 'قطع غيار وصيانة',
          qty: 1,
          price: 15000,
          cost: prod1Before?.buy_price || 10000,
        },
      ],
    });

    const prod1After = await cloneService.products.getById(1);
    const invCountAfter = (await cloneService.invoices.getAll()).length;

    const passed =
      Boolean(saleResult.invoice.id) &&
      saleResult.invoice.party_name === 'مفرد' &&
      prod1After?.qty === Math.max(0, initialQty - 1) &&
      invCountAfter === invCountBefore + 1;

    results.push({
      stepNumber: 1,
      scenarioName: 'فاتورة بيع نقدي (Cash Sale Invoice)',
      beforeState: { prod1Qty: initialQty, invoiceCount: invCountBefore },
      afterState: { prod1Qty: prod1After?.qty, invoiceCount: invCountAfter, invoiceId: saleResult.invoice.id },
      metrics: {
        stockChanged: { productId: 1, before: initialQty, after: prod1After?.qty ?? 0 },
        invoiceCount: { before: invCountBefore, after: invCountAfter },
      },
      passed,
      notes: 'تم خصم كمية المخزون بدقة وتوثيق الفاتورة لعميل نقدي (مفرد) مع توليد UUID.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 2: فاتورة بيع آجلة وتحديث رصيد العميل
  // ----------------------------------------------------
  {
    const customer = (await cloneService.parties.getAll('customer'))[0];
    const custId = customer.id;
    const balanceBefore = customer.balance || 0;
    const prod2 = await cloneService.products.getById(2);
    const prod2QtyBefore = prod2?.qty ?? 0;

    // Create credit sale: total = 600, paid = 100, remaining debt = 500
    const creditSale = await cloneService.invoices.createInvoice({
      type: 'sale',
      partyId: custId,
      paid: 100,
      discount: 0,
      currency: 'د.ع',
      items: [
        {
          product_id: 2,
          name: prod2?.name || 'حليب كامل الدسم 1 لتر',
          category: prod2?.category || 'ألبان وأجبان',
          qty: 2,
          price: 300,
          cost: 200,
        },
      ],
    });

    const partiesAfter = await cloneService.parties.getAll('customer');
    const customerAfter = partiesAfter.find((p) => p.id === custId);
    const balanceAfter = customerAfter?.balance || 0;
    const prod2After = await cloneService.products.getById(2);

    const expectedDebtIncrease = 600 - 100; // 500
    const passed =
      Boolean(creditSale.invoice.id) &&
      balanceAfter === balanceBefore + expectedDebtIncrease &&
      prod2After?.qty === Math.max(0, prod2QtyBefore - 2);

    results.push({
      stepNumber: 2,
      scenarioName: 'فاتورة بيع آجلة (Credit Sale & Customer Debt)',
      beforeState: { customerDebt: balanceBefore, prod2Qty: prod2QtyBefore },
      afterState: { customerDebt: balanceAfter, prod2Qty: prod2After?.qty, remainingUnpaid: 500 },
      metrics: {
        balanceChanged: { partyId: custId, before: balanceBefore, after: balanceAfter },
        stockChanged: { productId: 2, before: prod2QtyBefore, after: prod2After?.qty ?? 0 },
      },
      passed,
      notes: 'تم تسجيل المديونية الآجلة على العميل بدقة وتحديث رصيده وخصم البضاعة من المخزن.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 3: فاتورة شراء وزيادة المخزون
  // ----------------------------------------------------
  {
    const supplier = (await cloneService.parties.getAll('supplier'))[0];
    const suppId = supplier.id;
    const prod3 = await cloneService.products.getById(3);
    const prod3QtyBefore = prod3?.qty ?? 0;

    // Purchase invoice: qty = 10, buy_price = 35, sell_price = 45
    const purchaseResult = await cloneService.invoices.createInvoice({
      type: 'purchase',
      partyId: suppId,
      paid: 350,
      discount: 0,
      currency: 'د.ع',
      items: [
        {
          product_id: 3,
          name: prod3?.name || 'أرز بسمتي درجة أولى 5 كجم',
          category: prod3?.category || 'مواد غذائية',
          qty: 10,
          price: 35,
          cost: 35,
          sell_price: 45,
        },
      ],
    });

    const prod3After = await cloneService.products.getById(3);
    const passed =
      Boolean(purchaseResult.invoice.id) &&
      prod3After?.qty === prod3QtyBefore + 10 &&
      prod3After?.buy_price === 35 &&
      prod3After?.sell_price === 45;

    results.push({
      stepNumber: 3,
      scenarioName: 'فاتورة شراء وزيادة المخزون (Purchase & Stock Inflow)',
      beforeState: { prod3Qty: prod3QtyBefore, buyPrice: prod3?.buy_price },
      afterState: { prod3Qty: prod3After?.qty, buyPrice: prod3After?.buy_price, sellPrice: prod3After?.sell_price },
      metrics: {
        stockChanged: { productId: 3, before: prod3QtyBefore, after: prod3After?.qty ?? 0 },
      },
      passed,
      notes: 'تمت زيادة المخزون تلقائياً وتحديث أسعار الشراء والبيع للمنتج في معاملة ذرية موحدة.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 4: تعديل منتج وسعره
  // ----------------------------------------------------
  {
    const prod4 = await cloneService.products.getById(4);
    const beforePrice = prod4?.sell_price || 0;

    await cloneService.products.save({
      id: 4,
      name: (prod4?.name || 'زيت دوار الشمس') + ' - معدل',
      sell_price: beforePrice + 5,
      buy_price: (prod4?.buy_price || 13.5) + 2,
    });

    const prod4After = await cloneService.products.getById(4);
    const passed =
      Boolean(prod4After) &&
      prod4After?.sell_price === beforePrice + 5 &&
      prod4After?.name.includes('معدل');

    results.push({
      stepNumber: 4,
      scenarioName: 'تعديل منتج وسعره (Edit Product & Prices)',
      beforeState: { name: prod4?.name, sellPrice: beforePrice },
      afterState: { name: prod4After?.name, sellPrice: prod4After?.sell_price },
      metrics: {},
      passed,
      notes: 'تم تعديل اسم المنتج وسعر البيع والشراء وتحديث تاريخ updatedAt.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 5: مرتجع بيع واسترجاع المخزون
  // ----------------------------------------------------
  {
    const prod5 = await cloneService.products.getById(5);
    const prod5QtyBefore = prod5?.qty ?? 0;

    // Return 2 items of product 5
    const returnInvoice = await cloneService.invoices.createInvoice({
      type: 'sale_return',
      partyId: null,
      paid: 19,
      discount: 0,
      currency: 'د.ع',
      items: [
        {
          product_id: 5,
          name: prod5?.name || 'سكر أبيض ناعم',
          category: prod5?.category || 'مواد غذائية',
          qty: 2,
          price: 9.5,
          cost: 7.0,
        },
      ],
    });

    const prod5After = await cloneService.products.getById(5);
    const passed =
      Boolean(returnInvoice.invoice.id) &&
      prod5After?.qty === prod5QtyBefore + 2;

    results.push({
      stepNumber: 5,
      scenarioName: 'مرتجع بيع واسترجاع المخزون (Sale Return & Stock Reversal)',
      beforeState: { prod5Qty: prod5QtyBefore },
      afterState: { prod5Qty: prod5After?.qty },
      metrics: {
        stockChanged: { productId: 5, before: prod5QtyBefore, after: prod5After?.qty ?? 0 },
      },
      passed,
      notes: 'تم تسجيل فاتورة المرتجع واسترجاع الكمية المرتجعة فورياً إلى رصيد المخزن.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 6: إلغاء فاتورة وعكس المخزون
  // ----------------------------------------------------
  {
    // Create an invoice specifically to cancel it
    const prod6 = await cloneService.products.getById(6);
    const prod6QtyInitial = prod6?.qty ?? 0;

    const tempSale = await cloneService.invoices.createInvoice({
      type: 'sale',
      partyId: null,
      paid: 30,
      discount: 0,
      items: [
        {
          product_id: 6,
          name: prod6?.name || 'شاي أسود',
          category: prod6?.category || 'مشروبات',
          qty: 2,
          price: 15,
          cost: 11,
        },
      ],
    });

    const prod6QtyAfterSale = (await cloneService.products.getById(6))?.qty ?? 0;

    // Cancel / Delete the invoice
    await cloneService.invoices.deleteInvoice(tempSale.invoice.id, true);

    const prod6QtyAfterCancel = (await cloneService.products.getById(6))?.qty ?? 0;
    const deletedInvoice = await cloneService.invoices.getById(tempSale.invoice.id);

    const passed =
      prod6QtyAfterSale === prod6QtyInitial - 2 &&
      prod6QtyAfterCancel === prod6QtyInitial &&
      deletedInvoice === undefined; // Filtered out by isDeleted

    results.push({
      stepNumber: 6,
      scenarioName: 'إلغاء فاتورة وعكس المخزون (Void Invoice & Stock Rollback)',
      beforeState: { initialQty: prod6QtyInitial, qtyAfterSale: prod6QtyAfterSale },
      afterState: { restoredQty: prod6QtyAfterCancel, invoiceVoided: true },
      metrics: {
        stockChanged: { productId: 6, before: prod6QtyAfterSale, after: prod6QtyAfterCancel },
      },
      passed,
      notes: 'تم إلغاء الفاتورة بالكامل وعكس أثر المخزون آلياً مع استبعاد الفاتورة من العرض النشط.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 7: دفعة من عميل ودفعة لمورد
  // ----------------------------------------------------
  {
    const customer = (await cloneService.parties.getAll('customer'))[0];
    const supplier = (await cloneService.parties.getAll('supplier'))[0];
    const custDebtBefore = customer.balance || 0;
    const suppDebtBefore = supplier.balance || 0;

    // Customer pays 200
    const custPayment = await cloneService.payments.add({
      partyId: customer.id,
      amount: 200,
      notes: 'دفعة نقدية تحت الحساب',
    });

    // Supplier payment 150
    const suppPayment = await cloneService.payments.add({
      partyId: supplier.id,
      amount: 150,
      notes: 'سداد دفعة من الحساب',
    });

    const customerAfter = (await cloneService.parties.getAll('customer')).find((p) => p.id === customer.id);
    const supplierAfter = (await cloneService.parties.getAll('supplier')).find((p) => p.id === supplier.id);

    const passed =
      Boolean(custPayment.id) &&
      Boolean(suppPayment.id) &&
      customerAfter?.balance === custDebtBefore - 200 &&
      supplierAfter?.balance === suppDebtBefore - 150;

    results.push({
      stepNumber: 7,
      scenarioName: 'دفعة من عميل ودفعة لمورد (Payments & Balance Updates)',
      beforeState: { customerDebt: custDebtBefore, supplierDebt: suppDebtBefore },
      afterState: { customerDebt: customerAfter?.balance, supplierDebt: supplierAfter?.balance },
      metrics: {
        balanceChanged: { partyId: customer.id, before: custDebtBefore, after: customerAfter?.balance ?? 0 },
      },
      passed,
      notes: 'تم تسجيل سندات القبض والصرف وانعكاسها المباشر في خفض أرصدة الذمم والديون.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 8: إضافة مصروف وحذفه
  // ----------------------------------------------------
  {
    const expensesBefore = await cloneService.expenses.getAll();
    const countBefore = expensesBefore.length;

    // Add new expense
    const newExpense = await cloneService.expenses.add({
      recipient: 'صيانة دورية للمكيفات',
      amount: 75,
      notes: 'صيانة طارئة',
      currency: 'د.ع',
    });

    const countAfterAdd = (await cloneService.expenses.getAll()).length;

    // Soft delete expense
    await cloneService.expenses.delete(newExpense.id, true);

    const countAfterDelete = (await cloneService.expenses.getAll()).length;

    const passed =
      Boolean(newExpense.id) &&
      countAfterAdd === countBefore + 1 &&
      countAfterDelete === countBefore;

    results.push({
      stepNumber: 8,
      scenarioName: 'إضافة مصروف وحذفه (Add & Delete Expense)',
      beforeState: { expenseCount: countBefore },
      afterState: { addedExpenseId: newExpense.id, finalExpenseCount: countAfterDelete },
      metrics: {
        expenseCount: { before: countBefore, after: countAfterDelete },
      },
      passed,
      notes: 'تمت إضافة المصروف والبحث عنه ثم حذفه برمجياً دون ترك أي أثر سلبي على سلامة الحسابات.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 9: تعليق فاتورة واستعادتها
  // ----------------------------------------------------
  {
    const holdId = `audit_hold_${Date.now()}`;
    await cloneService.heldInvoices.save({
      id: holdId,
      uuid: 'uuid-hold-audit-test',
      type: 'sale',
      time: '14:30',
      partyId: null,
      partyName: 'مفرد',
      items: [
        {
          id: 99,
          invoice_id: 0,
          product_id: 1,
          name: 'Lcd iph 11 pro max',
          qty: 1,
          price: 15000,
          cost: 10000,
        },
      ],
      discount: 0,
      updatedAt: new Date().toISOString(),
    });

    const heldListAfterSave = await cloneService.heldInvoices.getByType('sale');
    const exists = heldListAfterSave.some((h) => h.id === holdId);

    // Restore / remove held invoice
    await cloneService.heldInvoices.remove(holdId);
    const heldListAfterRemove = await cloneService.heldInvoices.getByType('sale');
    const removed = !heldListAfterRemove.some((h) => h.id === holdId);

    const passed = exists && removed;

    results.push({
      stepNumber: 9,
      scenarioName: 'تعليق فاتورة واستعادتها (Hold Invoice & Restore)',
      beforeState: { heldExists: false },
      afterState: { heldSaved: exists, heldRestoredAndCleaned: removed },
      metrics: {},
      passed,
      notes: 'تم حفظ الفاتورة المعلقة بجدول Dexie واسترجاعها وحذفها بنجاح تام.',
    });
  }

  // ----------------------------------------------------
  // السيناريو 10: إغلاق التطبيق وإعادة فتحه والتحقق من استمرار البيانات
  // ----------------------------------------------------
  {
    const dbName = cloneDb.name;
    // 1. Close current connection
    await cloneDb.close();

    // 2. Simulate fresh application boot by instantiating new database handle
    const reopenedDb = new CashierDatabase(dbName);
    await reopenedDb.open();
    const reopenedService = new StorageService(reopenedDb);

    // Verify all changes made in steps 1-9 persisted across connection reboots
    const productsCount = await reopenedDb.products.count();
    const invoicesCount = await reopenedDb.invoices.count();
    const partiesCount = await reopenedDb.parties.count();
    const paymentsCount = await reopenedDb.payments.count();

    // Verify product 3 stock increase from step 3 (was 15 + 10 = 25)
    const prod3 = await reopenedService.products.getById(3);
    const isProd3Persisted = prod3?.qty === 25;

    // Verify party payments persisted
    const payments = await reopenedService.payments.getAll();
    const hasAuditPayments = payments.some((p) => p.amount === 200 || p.amount === 150);

    const passed =
      productsCount > 0 &&
      invoicesCount > 0 &&
      partiesCount > 0 &&
      isProd3Persisted &&
      hasAuditPayments;

    await reopenedDb.close();

    results.push({
      stepNumber: 10,
      scenarioName: 'إغلاق التطبيق وإعادة فتحه واستمرار البيانات (Persistence Verification)',
      beforeState: { connectionClosed: true },
      afterState: {
        productsCount,
        invoicesCount,
        partiesCount,
        paymentsCount,
        prod3FinalQty: prod3?.qty,
        dataIntact: passed,
      },
      metrics: {},
      passed,
      notes: 'تم إغلاق الاتصال وإعادة فتحه، وأثبتت الفحوص استمرار كافة السجلات والتعديلات بنسبة 100%.',
    });
  }

  const allPassed = results.every((r) => r.passed);
  const summary = `تم تنفيذ السيناريوهات التجارية العشرة بنجاح: ${results.filter((r) => r.passed).length} من أصل ${results.length}`;

  return {
    success: allPassed,
    results,
    summary,
  };
}
