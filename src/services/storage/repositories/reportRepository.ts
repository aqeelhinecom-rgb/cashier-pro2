import { CashierDatabase } from '../schema';
import { ReportData } from '../../../types';

export class ReportRepository {
  constructor(private db: CashierDatabase) {}

  async getReport(from: Date, to: Date): Promise<ReportData> {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const invoices = await this.db.invoices
      .filter((inv) => !inv.isDeleted && inv.date >= fromIso && inv.date <= toIso)
      .toArray();

    const allItems = await this.db.invoice_items.toArray();

    const saleInvoices = invoices.filter((inv) => inv.type === 'sale');
    const purchaseInvoices = invoices.filter((inv) => inv.type === 'purchase');
    const returnInvoices = invoices.filter((inv) => inv.type === 'sale_return');
    const quoteInvoices = invoices.filter((inv) => inv.type === 'quote');

    const saleInvoiceIds = new Set(saleInvoices.map((inv) => inv.id));
    const returnInvoiceIds = new Set(returnInvoices.map((inv) => inv.id));
    const saleItems = allItems.filter(
      (it) => it.invoice_id && saleInvoiceIds.has(it.invoice_id)
    );
    const returnItems = allItems.filter(
      (it) => it.invoice_id && returnInvoiceIds.has(it.invoice_id)
    );

    const grossSales = saleInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const returnsTotal = returnInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const sales = grossSales - returnsTotal;

    const grossSalesPaid = saleInvoices.reduce((sum, inv) => sum + (Number(inv.paid) || 0), 0);
    const returnsPaid = returnInvoices.reduce((sum, inv) => sum + (Number(inv.paid) || 0), 0);
    const collectedSales = grossSalesPaid - returnsPaid;
    const creditSalesRemaining = Math.max(0, sales - collectedSales);

    const purchases = purchaseInvoices.reduce((sum, inv) => sum + inv.total, 0);

    const itemsByInvoice = new Map<number, typeof allItems>();
    for (const it of allItems) {
      if (!it.invoice_id) continue;
      const arr = itemsByInvoice.get(it.invoice_id);
      if (arr) {
        arr.push(it);
      } else {
        itemsByInvoice.set(it.invoice_id, [it]);
      }
    }

    let saleProfitTotal = 0;
    let collectedSaleProfit = 0;
    let deferredSaleProfit = 0;
    for (const inv of saleInvoices) {
      const invItems = itemsByInvoice.get(inv.id) || [];
      const invMargin = invItems.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0);
      const invProfit = invMargin - (inv.discount || 0);
      const ratio = inv.total > 0 ? Math.min(1, Math.max(0, (Number(inv.paid) || 0) / inv.total)) : 1;
      saleProfitTotal += invProfit;
      collectedSaleProfit += invProfit * ratio;
      deferredSaleProfit += invProfit * (1 - ratio);
    }

    let returnProfitTotal = 0;
    let collectedReturnProfit = 0;
    let deferredReturnProfit = 0;
    for (const inv of returnInvoices) {
      const invItems = itemsByInvoice.get(inv.id) || [];
      const invMargin = invItems.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0);
      const invProfit = invMargin - (inv.discount || 0);
      const ratio = inv.total > 0 ? Math.min(1, Math.max(0, (Number(inv.paid) || 0) / inv.total)) : 1;
      returnProfitTotal += invProfit;
      collectedReturnProfit += invProfit * ratio;
      deferredReturnProfit += invProfit * (1 - ratio);
    }

    const profit = saleProfitTotal - returnProfitTotal;
    const collectedProfit = collectedSaleProfit - collectedReturnProfit;
    const deferredProfit = deferredSaleProfit - deferredReturnProfit;

    const allExpenses = await this.db.expenses
      .filter((e) => !e.isDeleted && e.date >= fromIso && e.date <= toIso)
      .toArray();

    const expenses = allExpenses.reduce((sum, e) => sum + e.amount, 0);
    const netProfit = profit - expenses;

    const soldMap = new Map<string, number>();
    const profitMap = new Map<string, number>();

    for (const it of saleItems) {
      soldMap.set(it.name, (soldMap.get(it.name) || 0) + it.qty);
      profitMap.set(
        it.name,
        (profitMap.get(it.name) || 0) + (it.price - it.cost) * it.qty
      );
    }

    for (const it of returnItems) {
      soldMap.set(it.name, Math.max(0, (soldMap.get(it.name) || 0) - it.qty));
      profitMap.set(
        it.name,
        (profitMap.get(it.name) || 0) - (it.price - it.cost) * it.qty
      );
    }

    const topSold = Array.from(soldMap.entries())
      .filter(([, v]) => v > 0)
      .map(([name, v]) => ({ name, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);

    const topProfit = Array.from(profitMap.entries())
      .map(([name, v]) => ({ name, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);

    const allProducts = await this.db.products
      .filter((p) => !p.isDeleted)
      .toArray();

    const lowStock = allProducts.filter((p) => p.qty <= 5).slice(0, 10);
    const stockValue = allProducts.reduce(
      (sum, p) => sum + p.qty * p.buy_price,
      0
    );

    return {
      sales,
      purchases,
      expenses,
      profit,
      collectedProfit,
      deferredProfit,
      netProfit,
      collectedSales,
      creditSalesRemaining,
      stockValue,
      invoicesCount: saleInvoices.length + purchaseInvoices.length + returnInvoices.length,
      salesInvoicesCount: saleInvoices.length,
      purchasesInvoicesCount: purchaseInvoices.length,
      returnsInvoicesCount: returnInvoices.length,
      quotesCount: quoteInvoices.length,
      topSold,
      topProfit,
      lowStock,
    };
  }
}
