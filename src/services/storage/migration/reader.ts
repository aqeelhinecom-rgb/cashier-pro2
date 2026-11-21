import {
  Product,
  Party,
  Invoice,
  InvoiceItem,
  Payment,
  Expense,
  StoreSettings,
} from '../../../types';

export interface LegacyLocalStorageDump {
  products: Product[];
  parties: Party[];
  invoices: Invoice[];
  invoice_items: InvoiceItem[];
  payments: Payment[];
  expenses: Expense[];
  settings: StoreSettings | null;
  categories: string[];
  permissionsGranted: boolean;
  heldInvoices: {
    type: string;
    items: any[];
  }[];
  rawKeyCounts: Record<string, number>;
  timestamp: string;
}

/**
 * Pure non-mutating reader.
 * Reads legacy localStorage keys without modifying, deleting, or altering any data.
 */
export function readLegacyLocalStorage(): LegacyLocalStorageDump {
  if (typeof localStorage === 'undefined') {
    return {
      products: [],
      parties: [],
      invoices: [],
      invoice_items: [],
      payments: [],
      expenses: [],
      settings: null,
      categories: [],
      permissionsGranted: false,
      heldInvoices: [],
      rawKeyCounts: {},
      timestamp: new Date().toISOString(),
    };
  }

  const safeParse = <T>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn(`Could not parse localStorage key "${key}":`, e);
      return fallback;
    }
  };

  const products = safeParse<Product[]>('cashier_products_v1', []);
  const parties = safeParse<Party[]>('cashier_parties_v1', []);
  const invoices = safeParse<Invoice[]>('cashier_invoices_v1', []);
  const invoice_items = safeParse<InvoiceItem[]>('cashier_invoice_items_v1', []);
  const payments = safeParse<Payment[]>('cashier_payments_v1', []);
  const expenses = safeParse<Expense[]>('cashier_expenses_v1', []);
  const settings = safeParse<StoreSettings | null>('cashier_settings_v1', null);
  const categories = safeParse<string[]>('cashier_categories_v1', []);
  const permissionsGranted = localStorage.getItem('cashier_permissions_granted_v1') === 'true';

  // Discover all dynamic held invoice keys (e.g. cashier_held_sale, cashier_held_purchase)
  const heldInvoices: { type: string; items: any[] }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('cashier_held_')) {
        const type = key.replace('cashier_held_', '');
        const items = safeParse<any[]>(key, []);
        if (items.length > 0) {
          heldInvoices.push({ type, items });
        }
      }
    }
  } catch (err) {
    console.warn('Error reading held invoices keys:', err);
  }

  const rawKeyCounts: Record<string, number> = {
    products: products.length,
    parties: parties.length,
    invoices: invoices.length,
    invoice_items: invoice_items.length,
    payments: payments.length,
    expenses: expenses.length,
    categories: categories.length,
    heldInvoicesGroups: heldInvoices.length,
  };

  return {
    products,
    parties,
    invoices,
    invoice_items,
    payments,
    expenses,
    settings,
    categories,
    permissionsGranted,
    heldInvoices,
    rawKeyCounts,
    timestamp: new Date().toISOString(),
  };
}
