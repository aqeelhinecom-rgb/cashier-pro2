import { CashierDatabase } from '../schema';
import { LegacyLocalStorageDump } from './reader';

export interface EntityVerificationMismatch {
  table: string;
  id: string | number;
  field: string;
  sourceValue: any;
  targetValue: any;
}

export interface EntityVerificationReport {
  success: boolean;
  timestamp: string;
  counts: {
    products: { source: number; target: number; match: boolean };
    parties: { source: number; target: number; match: boolean };
    invoices: { source: number; target: number; match: boolean };
    invoice_items: { source: number; target: number; match: boolean };
    payments: { source: number; target: number; match: boolean };
    expenses: { source: number; target: number; match: boolean };
    categories: { source: number; target: number; match: boolean };
    heldInvoices: { source: number; target: number; match: boolean };
  };
  individualEntityChecks: {
    productsChecked: number;
    productsMatched: number;
    partiesChecked: number;
    partiesMatched: number;
    invoicesChecked: number;
    invoicesMatched: number;
    itemsChecked: number;
    itemsMatched: number;
    paymentsChecked: number;
    paymentsMatched: number;
    expensesChecked: number;
    expensesMatched: number;
    heldInvoicesChecked: number;
    heldInvoicesMatched: number;
    settingsMatched: boolean;
  };
  financialTotals: {
    stockValuationCost: { source: number; target: number; match: boolean };
    stockValuationRetail: { source: number; target: number; match: boolean };
    invoicesTotalSales: { source: number; target: number; match: boolean };
    invoicesTotalPurchases: { source: number; target: number; match: boolean };
    invoicesTotalReturns: { source: number; target: number; match: boolean };
    invoicesTotalPaid: { source: number; target: number; match: boolean };
    invoicesTotalRemaining: { source: number; target: number; match: boolean };
    paymentsTotal: { source: number; target: number; match: boolean };
    expensesTotal: { source: number; target: number; match: boolean };
  };
  imagesVerified: {
    sourceWithImages: number;
    targetWithImages: number;
    match: boolean;
  };
  mismatches: EntityVerificationMismatch[];
  errors: string[];
}

/**
 * Performs a deep, entity-by-entity, record-by-record comparison
 * between the source localStorage dump and the target Dexie database.
 */
export async function verifyEntityByEntity(
  source: LegacyLocalStorageDump,
  targetDb: CashierDatabase
): Promise<EntityVerificationReport> {
  const mismatches: EntityVerificationMismatch[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();

  // 1. Fetch all records from target database
  const targetProducts = await targetDb.products.toArray();
  const targetParties = await targetDb.parties.toArray();
  const targetInvoices = await targetDb.invoices.toArray();
  const targetItems = await targetDb.invoice_items.toArray();
  const targetPayments = await targetDb.payments.toArray();
  const targetExpenses = await targetDb.expenses.toArray();
  const targetCategories = await targetDb.categories.toArray();
  const targetHeld = await targetDb.held_invoices.toArray();
  const targetSettingsRecords = await targetDb.settings.toArray();

  const targetSettings: Record<string, any> = {};
  targetSettingsRecords.forEach((r) => {
    targetSettings[r.key] = r.value;
  });

  // Maps for fast O(1) lookups
  const targetProductMap = new Map(targetProducts.map((p) => [p.id, p]));
  const targetPartyMap = new Map(targetParties.map((p) => [p.id, p]));
  const targetInvoiceMap = new Map(targetInvoices.map((i) => [i.id, i]));
  const targetItemMap = new Map(targetItems.map((it) => [it.id, it]));
  const targetPaymentMap = new Map(targetPayments.map((p) => [p.id, p]));
  const targetExpenseMap = new Map(targetExpenses.map((e) => [e.id, e]));

  // --- Entity Check: Products ---
  let productsMatched = 0;
  let sourceWithImages = 0;
  let targetWithImages = 0;

  for (const sp of source.products) {
    if (sp.image) sourceWithImages++;
    const tp = targetProductMap.get(sp.id);
    if (!tp) {
      mismatches.push({ table: 'products', id: sp.id, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    if (tp.image) targetWithImages++;

    let productHasError = false;
    if (tp.name !== sp.name) {
      mismatches.push({ table: 'products', id: sp.id, field: 'name', sourceValue: sp.name, targetValue: tp.name });
      productHasError = true;
    }
    if ((tp.barcode || '') !== (sp.barcode || '')) {
      mismatches.push({ table: 'products', id: sp.id, field: 'barcode', sourceValue: sp.barcode, targetValue: tp.barcode });
      productHasError = true;
    }
    if ((tp.category || 'عام') !== (sp.category || 'عام')) {
      mismatches.push({ table: 'products', id: sp.id, field: 'category', sourceValue: sp.category, targetValue: tp.category });
      productHasError = true;
    }
    if (Math.abs((tp.buy_price || 0) - (sp.buy_price || 0)) > 0.001) {
      mismatches.push({ table: 'products', id: sp.id, field: 'buy_price', sourceValue: sp.buy_price, targetValue: tp.buy_price });
      productHasError = true;
    }
    if (Math.abs((tp.sell_price || 0) - (sp.sell_price || 0)) > 0.001) {
      mismatches.push({ table: 'products', id: sp.id, field: 'sell_price', sourceValue: sp.sell_price, targetValue: tp.sell_price });
      productHasError = true;
    }
    if (Math.abs((tp.qty || 0) - (sp.qty || 0)) > 0.001) {
      mismatches.push({ table: 'products', id: sp.id, field: 'qty', sourceValue: sp.qty, targetValue: tp.qty });
      productHasError = true;
    }
    if ((tp.image || '') !== (sp.image || '')) {
      mismatches.push({ table: 'products', id: sp.id, field: 'image', sourceValue: sp.image ? 'Base64 Present' : 'Empty', targetValue: tp.image ? 'Base64 Present' : 'Empty' });
      productHasError = true;
    }

    if (!productHasError) {
      productsMatched++;
    }
  }

  // --- Entity Check: Parties ---
  let partiesMatched = 0;
  for (const sp of source.parties) {
    const tp = targetPartyMap.get(sp.id);
    if (!tp) {
      mismatches.push({ table: 'parties', id: sp.id, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    let partyHasError = false;
    if (tp.name !== sp.name) {
      mismatches.push({ table: 'parties', id: sp.id, field: 'name', sourceValue: sp.name, targetValue: tp.name });
      partyHasError = true;
    }
    if ((tp.phone || '') !== (sp.phone || '')) {
      mismatches.push({ table: 'parties', id: sp.id, field: 'phone', sourceValue: sp.phone, targetValue: tp.phone });
      partyHasError = true;
    }
    if (tp.type !== sp.type) {
      mismatches.push({ table: 'parties', id: sp.id, field: 'type', sourceValue: sp.type, targetValue: tp.type });
      partyHasError = true;
    }
    if (Math.abs((tp.balance || 0) - (sp.balance || 0)) > 0.01) {
      mismatches.push({ table: 'parties', id: sp.id, field: 'balance', sourceValue: sp.balance, targetValue: tp.balance });
      partyHasError = true;
    }

    if (!partyHasError) {
      partiesMatched++;
    }
  }

  // --- Entity Check: Invoices ---
  let invoicesMatched = 0;
  for (const si of source.invoices) {
    const ti = targetInvoiceMap.get(si.id);
    if (!ti) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    let invoiceHasError = false;
    if (ti.type !== si.type) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'type', sourceValue: si.type, targetValue: ti.type });
      invoiceHasError = true;
    }
    if ((ti.party_id ?? null) !== (si.party_id ?? null)) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'party_id', sourceValue: si.party_id, targetValue: ti.party_id });
      invoiceHasError = true;
    }
    if (Math.abs((ti.total || 0) - (si.total || 0)) > 0.01) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'total', sourceValue: si.total, targetValue: ti.total });
      invoiceHasError = true;
    }
    if (Math.abs((ti.paid || 0) - (si.paid || 0)) > 0.01) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'paid', sourceValue: si.paid, targetValue: ti.paid });
      invoiceHasError = true;
    }
    if (Math.abs((ti.discount || 0) - (si.discount || 0)) > 0.01) {
      mismatches.push({ table: 'invoices', id: si.id, field: 'discount', sourceValue: si.discount, targetValue: ti.discount });
      invoiceHasError = true;
    }

    if (!invoiceHasError) {
      invoicesMatched++;
    }
  }

  // --- Entity Check: Invoice Items ---
  let itemsMatched = 0;
  for (const sit of source.invoice_items) {
    // If sit has an id, find by id, otherwise match by invoice_id and product_id
    const tit = sit.id ? targetItemMap.get(sit.id) : targetItems.find((it) => it.invoice_id === sit.invoice_id && it.product_id === sit.product_id);
    if (!tit) {
      mismatches.push({ table: 'invoice_items', id: sit.id || `inv_${sit.invoice_id}_prod_${sit.product_id}`, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    let itemHasError = false;
    const itemId = tit.id ?? sit.id ?? 0;
    if (tit.invoice_id !== sit.invoice_id) {
      mismatches.push({ table: 'invoice_items', id: itemId, field: 'invoice_id', sourceValue: sit.invoice_id, targetValue: tit.invoice_id });
      itemHasError = true;
    }
    if (tit.product_id !== sit.product_id) {
      mismatches.push({ table: 'invoice_items', id: itemId, field: 'product_id', sourceValue: sit.product_id, targetValue: tit.product_id });
      itemHasError = true;
    }
    if (Math.abs(tit.qty - sit.qty) > 0.001) {
      mismatches.push({ table: 'invoice_items', id: itemId, field: 'qty', sourceValue: sit.qty, targetValue: tit.qty });
      itemHasError = true;
    }
    if (Math.abs(tit.price - sit.price) > 0.01) {
      mismatches.push({ table: 'invoice_items', id: itemId, field: 'price', sourceValue: sit.price, targetValue: tit.price });
      itemHasError = true;
    }

    if (!itemHasError) {
      itemsMatched++;
    }
  }

  // --- Entity Check: Payments ---
  let paymentsMatched = 0;
  for (const sp of source.payments) {
    const tp = targetPaymentMap.get(sp.id);
    if (!tp) {
      mismatches.push({ table: 'payments', id: sp.id, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    let payHasError = false;
    if (tp.party_id !== sp.party_id) {
      mismatches.push({ table: 'payments', id: sp.id, field: 'party_id', sourceValue: sp.party_id, targetValue: tp.party_id });
      payHasError = true;
    }
    if (Math.abs(tp.amount - sp.amount) > 0.01) {
      mismatches.push({ table: 'payments', id: sp.id, field: 'amount', sourceValue: sp.amount, targetValue: tp.amount });
      payHasError = true;
    }

    if (!payHasError) {
      paymentsMatched++;
    }
  }

  // --- Entity Check: Expenses ---
  let expensesMatched = 0;
  for (const se of source.expenses) {
    const te = targetExpenseMap.get(se.id);
    if (!te) {
      mismatches.push({ table: 'expenses', id: se.id, field: 'EXISTS', sourceValue: true, targetValue: false });
      continue;
    }

    let expHasError = false;
    if (te.recipient !== se.recipient) {
      mismatches.push({ table: 'expenses', id: se.id, field: 'recipient', sourceValue: se.recipient, targetValue: te.recipient });
      expHasError = true;
    }
    if (Math.abs(te.amount - se.amount) > 0.01) {
      mismatches.push({ table: 'expenses', id: se.id, field: 'amount', sourceValue: se.amount, targetValue: te.amount });
      expHasError = true;
    }

    if (!expHasError) {
      expensesMatched++;
    }
  }

  // --- Entity Check: Held Invoices ---
  let heldInvoicesChecked = 0;
  let heldInvoicesMatched = 0;
  const targetHeldMap = new Map(targetHeld.map((h) => [h.id, h]));

  for (const group of source.heldInvoices) {
    for (const item of group.items) {
      heldInvoicesChecked++;
      const idKey = item.id || `hold_${item.time}`;
      const th = targetHeldMap.get(idKey);
      if (th) {
        heldInvoicesMatched++;
      }
    }
  }

  // --- Entity Check: Settings ---
  let settingsMatched = true;
  if (source.settings) {
    if (targetSettings.storeName !== source.settings.storeName) settingsMatched = false;
    if (targetSettings.currency !== source.settings.currency) settingsMatched = false;
    if (targetSettings.phone !== source.settings.phone) settingsMatched = false;
  }

  // --- Financial Totals Reconciliations ---
  const sourceStockCost = source.products.reduce((s, p) => s + (p.qty || 0) * (p.buy_price || 0), 0);
  const targetStockCost = targetProducts.reduce((s, p) => s + (p.qty || 0) * (p.buy_price || 0), 0);

  const sourceStockRetail = source.products.reduce((s, p) => s + (p.qty || 0) * (p.sell_price || 0), 0);
  const targetStockRetail = targetProducts.reduce((s, p) => s + (p.qty || 0) * (p.sell_price || 0), 0);

  const sourceSales = source.invoices.filter((i) => i.type === 'sale').reduce((s, i) => s + (i.total || 0), 0);
  const targetSales = targetInvoices.filter((i) => i.type === 'sale').reduce((s, i) => s + (i.total || 0), 0);

  const sourcePurchases = source.invoices.filter((i) => i.type === 'purchase').reduce((s, i) => s + (i.total || 0), 0);
  const targetPurchases = targetInvoices.filter((i) => i.type === 'purchase').reduce((s, i) => s + (i.total || 0), 0);

  const sourceReturns = source.invoices.filter((i) => i.type === 'sale_return').reduce((s, i) => s + (i.total || 0), 0);
  const targetReturns = targetInvoices.filter((i) => i.type === 'sale_return').reduce((s, i) => s + (i.total || 0), 0);

  const sourcePaid = source.invoices.reduce((s, i) => s + (i.paid || 0), 0);
  const targetPaid = targetInvoices.reduce((s, i) => s + (i.paid || 0), 0);

  const sourceRemaining = source.invoices.reduce((s, i) => s + Math.max(0, (i.total || 0) - (i.paid || 0)), 0);
  const targetRemaining = targetInvoices.reduce((s, i) => s + Math.max(0, (i.total || 0) - (i.paid || 0)), 0);

  const sourcePaymentsTotal = source.payments.reduce((s, p) => s + (p.amount || 0), 0);
  const targetPaymentsTotal = targetPayments.reduce((s, p) => s + (p.amount || 0), 0);

  const sourceExpensesTotal = source.expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const targetExpensesTotal = targetExpenses.reduce((s, e) => s + (e.amount || 0), 0);

  const totalHeldSource = source.heldInvoices.reduce((sum, g) => sum + (g.items?.length || 0), 0);

  const countsMatch =
    source.products.length === targetProducts.length &&
    source.parties.length === targetParties.length &&
    source.invoices.length === targetInvoices.length &&
    source.invoice_items.length === targetItems.length &&
    source.payments.length === targetPayments.length &&
    source.expenses.length === targetExpenses.length;

  const financialMatch =
    Math.abs(sourceStockCost - targetStockCost) < 0.01 &&
    Math.abs(sourceStockRetail - targetStockRetail) < 0.01 &&
    Math.abs(sourceSales - targetSales) < 0.01 &&
    Math.abs(sourcePurchases - targetPurchases) < 0.01 &&
    Math.abs(sourceReturns - targetReturns) < 0.01 &&
    Math.abs(sourcePaid - targetPaid) < 0.01 &&
    Math.abs(sourceRemaining - targetRemaining) < 0.01 &&
    Math.abs(sourcePaymentsTotal - targetPaymentsTotal) < 0.01 &&
    Math.abs(sourceExpensesTotal - targetExpensesTotal) < 0.01;

  const success = countsMatch && financialMatch && mismatches.length === 0;

  return {
    success,
    timestamp: now,
    counts: {
      products: { source: source.products.length, target: targetProducts.length, match: source.products.length === targetProducts.length },
      parties: { source: source.parties.length, target: targetParties.length, match: source.parties.length === targetParties.length },
      invoices: { source: source.invoices.length, target: targetInvoices.length, match: source.invoices.length === targetInvoices.length },
      invoice_items: { source: source.invoice_items.length, target: targetItems.length, match: source.invoice_items.length === targetItems.length },
      payments: { source: source.payments.length, target: targetPayments.length, match: source.payments.length === targetPayments.length },
      expenses: { source: source.expenses.length, target: targetExpenses.length, match: source.expenses.length === targetExpenses.length },
      categories: { source: source.categories.length, target: targetCategories.length, match: targetCategories.length >= source.categories.length },
      heldInvoices: { source: totalHeldSource, target: targetHeld.length, match: totalHeldSource === targetHeld.length },
    },
    individualEntityChecks: {
      productsChecked: source.products.length,
      productsMatched,
      partiesChecked: source.parties.length,
      partiesMatched,
      invoicesChecked: source.invoices.length,
      invoicesMatched,
      itemsChecked: source.invoice_items.length,
      itemsMatched,
      paymentsChecked: source.payments.length,
      paymentsMatched,
      expensesChecked: source.expenses.length,
      expensesMatched,
      heldInvoicesChecked,
      heldInvoicesMatched,
      settingsMatched,
    },
    financialTotals: {
      stockValuationCost: { source: sourceStockCost, target: targetStockCost, match: Math.abs(sourceStockCost - targetStockCost) < 0.01 },
      stockValuationRetail: { source: sourceStockRetail, target: targetStockRetail, match: Math.abs(sourceStockRetail - targetStockRetail) < 0.01 },
      invoicesTotalSales: { source: sourceSales, target: targetSales, match: Math.abs(sourceSales - targetSales) < 0.01 },
      invoicesTotalPurchases: { source: sourcePurchases, target: targetPurchases, match: Math.abs(sourcePurchases - targetPurchases) < 0.01 },
      invoicesTotalReturns: { source: sourceReturns, target: targetReturns, match: Math.abs(sourceReturns - targetReturns) < 0.01 },
      invoicesTotalPaid: { source: sourcePaid, target: targetPaid, match: Math.abs(sourcePaid - targetPaid) < 0.01 },
      invoicesTotalRemaining: { source: sourceRemaining, target: targetRemaining, match: Math.abs(sourceRemaining - targetRemaining) < 0.01 },
      paymentsTotal: { source: sourcePaymentsTotal, target: targetPaymentsTotal, match: Math.abs(sourcePaymentsTotal - targetPaymentsTotal) < 0.01 },
      expensesTotal: { source: sourceExpensesTotal, target: targetExpensesTotal, match: Math.abs(sourceExpensesTotal - targetExpensesTotal) < 0.01 },
    },
    imagesVerified: {
      sourceWithImages,
      targetWithImages,
      match: sourceWithImages === targetWithImages,
    },
    mismatches,
    errors,
  };
}
