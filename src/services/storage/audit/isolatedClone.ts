import { CashierDatabase } from '../schema';
import { StorageService } from '../storageService';

/**
 * Creates an isolated test clone database populated with data from the source database.
 * Does NOT alter or delete any source records or localStorage.
 */
export async function createIsolatedTestClone(
  sourceDb: CashierDatabase,
  cloneDbName = `CashierPro_Isolated_Clone_${Date.now()}`
): Promise<{ cloneDb: CashierDatabase; cloneService: StorageService; cleanup: () => Promise<void> }> {
  const cloneDb = new CashierDatabase(cloneDbName);
  await cloneDb.open();

  // 1. Fetch all data from sourceDb OUTSIDE of cloneDb transaction to avoid cross-database premature commits
  const [
    settings,
    categories,
    products,
    parties,
    invoices,
    items,
    payments,
    expenses,
    held,
    images,
  ] = await Promise.all([
    sourceDb.settings.toArray(),
    sourceDb.categories.toArray(),
    sourceDb.products.toArray(),
    sourceDb.parties.toArray(),
    sourceDb.invoices.toArray(),
    sourceDb.invoice_items.toArray(),
    sourceDb.payments.toArray(),
    sourceDb.expenses.toArray(),
    sourceDb.held_invoices.toArray(),
    sourceDb.product_images.toArray(),
  ]);

  // 2. Insert into cloneDb in a single atomic transaction
  await cloneDb.transaction(
    'rw',
    [
      cloneDb.products,
      cloneDb.parties,
      cloneDb.invoices,
      cloneDb.invoice_items,
      cloneDb.payments,
      cloneDb.expenses,
      cloneDb.held_invoices,
      cloneDb.categories,
      cloneDb.settings,
      cloneDb.product_images,
    ],
    async () => {
      if (settings.length > 0) await cloneDb.settings.bulkPut(settings);
      if (categories.length > 0) await cloneDb.categories.bulkPut(categories);
      if (products.length > 0) await cloneDb.products.bulkPut(products);
      if (parties.length > 0) await cloneDb.parties.bulkPut(parties);
      if (invoices.length > 0) await cloneDb.invoices.bulkPut(invoices);
      if (items.length > 0) await cloneDb.invoice_items.bulkPut(items);
      if (payments.length > 0) await cloneDb.payments.bulkPut(payments);
      if (expenses.length > 0) await cloneDb.expenses.bulkPut(expenses);
      if (held.length > 0) await cloneDb.held_invoices.bulkPut(held);
      if (images.length > 0) await cloneDb.product_images.bulkPut(images);
    }
  );

  const cloneService = new StorageService(cloneDb);

  const cleanup = async () => {
    try {
      await cloneDb.close();
      await cloneDb.delete();
    } catch (e) {
      console.warn('Failed to clean up isolated test clone:', e);
    }
  };

  return { cloneDb, cloneService, cleanup };
}
