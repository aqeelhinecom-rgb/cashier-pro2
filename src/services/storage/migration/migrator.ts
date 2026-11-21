import { CashierDatabase } from '../schema';
import { LegacyLocalStorageDump } from './reader';
import { generateUUID } from '../uuid';
import {
  StorageProduct,
  StorageParty,
  StorageInvoice,
  StorageInvoiceItem,
  StoragePayment,
  StorageExpense,
  StorageHeldInvoice,
  InvoiceType,
} from '../types';

export interface MigrationIntegrityReport {
  success: boolean;
  timestamp: string;
  counts: {
    products: { original: number; migrated: number; matches: boolean };
    parties: { original: number; migrated: number; matches: boolean };
    invoices: { original: number; migrated: number; matches: boolean };
    invoice_items: { original: number; migrated: number; matches: boolean };
    payments: { original: number; migrated: number; matches: boolean };
    expenses: { original: number; migrated: number; matches: boolean };
    categories: { original: number; migrated: number; matches: boolean };
    heldInvoices: { original: number; migrated: number; matches: boolean };
  };
  financials: {
    originalInvoicesTotal: number;
    migratedInvoicesTotal: number;
    matches: boolean;
    originalExpensesTotal: number;
    migratedExpensesTotal: number;
    expensesMatch: boolean;
    originalPaymentsTotal: number;
    migratedPaymentsTotal: number;
    paymentsMatch: boolean;
  };
  errors: string[];
}

/**
 * Migrates legacy data into a target Dexie database instance.
 * Does NOT delete old data.
 * Preserves legacy numeric IDs and adds UUIDs.
 * Performs strict validation and returns an integrity report.
 */
export async function migrateLegacyDataToDexie(
  legacyData: LegacyLocalStorageDump,
  targetDb: CashierDatabase
): Promise<MigrationIntegrityReport> {
  const errors: string[] = [];
  const now = new Date().toISOString();

  try {
    await targetDb.transaction(
      'rw',
      [
        targetDb.products,
        targetDb.parties,
        targetDb.invoices,
        targetDb.invoice_items,
        targetDb.payments,
        targetDb.expenses,
        targetDb.held_invoices,
        targetDb.categories,
        targetDb.settings,
        targetDb.migration_state,
      ],
      async () => {
        // 1. Migrate Settings
        if (legacyData.settings) {
          for (const [key, val] of Object.entries(legacyData.settings)) {
            await targetDb.settings.put({ key, value: val });
          }
        }
        if (legacyData.permissionsGranted) {
          await targetDb.settings.put({ key: 'permissionsGranted', value: true });
        }

        // 2. Migrate Categories
        const catSet = new Set<string>(['عام', ...legacyData.categories]);
        legacyData.products.forEach((p) => {
          if (p.category && p.category.trim()) catSet.add(p.category.trim());
        });
        for (const catName of catSet) {
          await targetDb.categories.put({ name: catName });
        }

        // 3. Migrate Products (preserving numeric IDs and Base64 images)
        for (const p of legacyData.products) {
          const storageProduct: StorageProduct = {
            id: p.id,
            name: p.name,
            barcode: p.barcode || '',
            category: p.category || 'عام',
            description: p.description || '',
            buy_price: Number(p.buy_price) || 0,
            sell_price: Number(p.sell_price) || 0,
            qty: Number(p.qty) || 0,
            currency: p.currency || 'د.ع',
            image: p.image, // Untouched, fully preserved
            uuid: generateUUID(),
            updatedAt: now,
            isDeleted: false,
          };
          await targetDb.products.put(storageProduct);
        }

        // 4. Migrate Parties
        for (const pt of legacyData.parties) {
          const storageParty: StorageParty = {
            id: pt.id,
            name: pt.name,
            phone: pt.phone || '',
            type: pt.type,
            balance: pt.balance || 0,
            uuid: generateUUID(),
            updatedAt: now,
            isDeleted: false,
          };
          await targetDb.parties.put(storageParty);
        }

        // 5. Migrate Invoices
        for (const inv of legacyData.invoices) {
          const storageInvoice: StorageInvoice = {
            id: inv.id,
            type: inv.type,
            party_id: inv.party_id ?? null,
            party_name: inv.party_name,
            date: inv.date,
            discount: Number(inv.discount) || 0,
            total: Number(inv.total) || 0,
            paid: Number(inv.paid) || 0,
            currency: inv.currency || 'د.ع',
            invoice_number: String(inv.id), // Preserves legacy ID as visible number
            uuid: generateUUID(),
            updatedAt: inv.date || now,
            isDeleted: false,
          };
          await targetDb.invoices.put(storageInvoice);
        }

        // 6. Migrate Invoice Items
        for (const it of legacyData.invoice_items) {
          const storageItem: StorageInvoiceItem = {
            id: it.id,
            invoice_id: it.invoice_id,
            product_id: it.product_id,
            name: it.name,
            category: it.category,
            qty: Number(it.qty) || 1,
            price: Number(it.price) || 0,
            cost: Number(it.cost) || 0,
            sell_price: it.sell_price !== undefined ? Number(it.sell_price) : undefined,
            image: it.image, // Preserved
            stockAlreadyAdded: it.stockAlreadyAdded,
            initialAddedQty: it.initialAddedQty,
            uuid: generateUUID(),
            updatedAt: now,
          };
          await targetDb.invoice_items.put(storageItem);
        }

        // 7. Migrate Payments
        for (const pay of legacyData.payments) {
          const storagePay: StoragePayment = {
            id: pay.id,
            party_id: pay.party_id,
            party_name: pay.party_name,
            amount: Number(pay.amount) || 0,
            date: pay.date,
            notes: pay.notes,
            currency: pay.currency || 'د.ع',
            uuid: generateUUID(),
            updatedAt: pay.date || now,
            isDeleted: false,
          };
          await targetDb.payments.put(storagePay);
        }

        // 8. Migrate Expenses
        for (const exp of legacyData.expenses) {
          const storageExp: StorageExpense = {
            id: exp.id,
            recipient: exp.recipient,
            amount: Number(exp.amount) || 0,
            date: exp.date,
            notes: exp.notes,
            currency: exp.currency || 'د.ع',
            uuid: generateUUID(),
            updatedAt: exp.date || now,
            isDeleted: false,
          };
          await targetDb.expenses.put(storageExp);
        }

        // 9. Migrate Held Invoices
        for (const group of legacyData.heldInvoices) {
          for (const item of group.items) {
            const heldRecord: StorageHeldInvoice = {
              id: item.id || `hold_${Date.now()}_${Math.random()}`,
              uuid: generateUUID(),
              type: (group.type || 'sale') as InvoiceType,
              time: item.time || '',
              partyId: item.partyId ?? null,
              partyName: item.partyName || '',
              items: item.items || [],
              discount: Number(item.discount) || 0,
              updatedAt: now,
            };
            await targetDb.held_invoices.put(heldRecord);
          }
        }

        // Record migration timestamp in migration_state
        await targetDb.migration_state.put({
          key: 'migration_completed_at',
          value: { completed: true, timestamp: now },
          timestamp: now,
        });
      }
    );
  } catch (err: any) {
    errors.push(`Transaction error: ${err.message || String(err)}`);
  }

  // Verification step (Counting and Financial integrity check)
  const migratedProductsCount = await targetDb.products.count();
  const migratedPartiesCount = await targetDb.parties.count();
  const migratedInvoicesCount = await targetDb.invoices.count();
  const migratedItemsCount = await targetDb.invoice_items.count();
  const migratedPaymentsCount = await targetDb.payments.count();
  const migratedExpensesCount = await targetDb.expenses.count();
  const migratedCategoriesCount = await targetDb.categories.count();
  const migratedHeldCount = await targetDb.held_invoices.count();

  const migratedInvoices = await targetDb.invoices.toArray();
  const migratedInvoicesTotal = migratedInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
  const originalInvoicesTotal = legacyData.invoices.reduce((sum, inv) => sum + (inv.total || 0), 0);

  const migratedExpenses = await targetDb.expenses.toArray();
  const migratedExpensesTotal = migratedExpenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
  const originalExpensesTotal = legacyData.expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

  const migratedPayments = await targetDb.payments.toArray();
  const migratedPaymentsTotal = migratedPayments.reduce((sum, pay) => sum + (pay.amount || 0), 0);
  const originalPaymentsTotal = legacyData.payments.reduce((sum, pay) => sum + (pay.amount || 0), 0);

  const totalHeldOriginal = legacyData.heldInvoices.reduce((sum, g) => sum + (g.items?.length || 0), 0);

  const countsMatch =
    legacyData.products.length === migratedProductsCount &&
    legacyData.parties.length === migratedPartiesCount &&
    legacyData.invoices.length === migratedInvoicesCount &&
    legacyData.invoice_items.length === migratedItemsCount &&
    legacyData.payments.length === migratedPaymentsCount &&
    legacyData.expenses.length === migratedExpensesCount;

  const financialsMatch =
    Math.abs(originalInvoicesTotal - migratedInvoicesTotal) < 0.01 &&
    Math.abs(originalExpensesTotal - migratedExpensesTotal) < 0.01 &&
    Math.abs(originalPaymentsTotal - migratedPaymentsTotal) < 0.01;

  const success = errors.length === 0 && countsMatch && financialsMatch;

  return {
    success,
    timestamp: now,
    counts: {
      products: { original: legacyData.products.length, migrated: migratedProductsCount, matches: legacyData.products.length === migratedProductsCount },
      parties: { original: legacyData.parties.length, migrated: migratedPartiesCount, matches: legacyData.parties.length === migratedPartiesCount },
      invoices: { original: legacyData.invoices.length, migrated: migratedInvoicesCount, matches: legacyData.invoices.length === migratedInvoicesCount },
      invoice_items: { original: legacyData.invoice_items.length, migrated: migratedItemsCount, matches: legacyData.invoice_items.length === migratedItemsCount },
      payments: { original: legacyData.payments.length, migrated: migratedPaymentsCount, matches: legacyData.payments.length === migratedPaymentsCount },
      expenses: { original: legacyData.expenses.length, migrated: migratedExpensesCount, matches: legacyData.expenses.length === migratedExpensesCount },
      categories: { original: legacyData.categories.length, migrated: migratedCategoriesCount, matches: migratedCategoriesCount >= legacyData.categories.length },
      heldInvoices: { original: totalHeldOriginal, migrated: migratedHeldCount, matches: totalHeldOriginal === migratedHeldCount },
    },
    financials: {
      originalInvoicesTotal,
      migratedInvoicesTotal,
      matches: Math.abs(originalInvoicesTotal - migratedInvoicesTotal) < 0.01,
      originalExpensesTotal,
      migratedExpensesTotal,
      expensesMatch: Math.abs(originalExpensesTotal - migratedExpensesTotal) < 0.01,
      originalPaymentsTotal,
      migratedPaymentsTotal,
      paymentsMatch: Math.abs(originalPaymentsTotal - migratedPaymentsTotal) < 0.01,
    },
    errors,
  };
}
