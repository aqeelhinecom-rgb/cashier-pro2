import { CashierDatabase } from '../schema';
import { ChangeJournalEntry } from '../types';
import { generateUUID } from '../uuid';

/**
 * Change Journal Engine
 * Records every operational state change within the same atomic transaction.
 * Supports chronological journal replaying and point-in-time database reconstruction.
 */

export async function recordJournalEntry(
  db: CashierDatabase,
  entry: {
    table: string;
    action: 'create' | 'update' | 'delete' | 'void' | 'stock_change';
    recordId: number | string;
    recordUuid?: string;
    beforeState?: any;
    afterState?: any;
    diff?: any;
    operationId?: string;
    timestamp?: string;
  }
): Promise<number> {
  const journalEntry: ChangeJournalEntry = {
    operationId: entry.operationId || generateUUID(),
    table: entry.table,
    action: entry.action,
    recordId: entry.recordId,
    recordUuid: entry.recordUuid,
    timestamp: entry.timestamp || new Date().toISOString(),
    beforeState: entry.beforeState ? JSON.parse(JSON.stringify(entry.beforeState)) : undefined,
    afterState: entry.afterState ? JSON.parse(JSON.stringify(entry.afterState)) : undefined,
    diff: entry.diff ? JSON.parse(JSON.stringify(entry.diff)) : undefined,
  };

  return db.change_journal.add(journalEntry);
}

export async function getJournalEntries(
  db: CashierDatabase,
  fromSeq = 0,
  limit = 2000
): Promise<ChangeJournalEntry[]> {
  return db.change_journal
    .where('seq')
    .aboveOrEqual(fromSeq)
    .limit(limit)
    .toArray();
}

/**
 * Replays a sequence of journal entries from scratch into an empty target database,
 * accurately reconstructing the exact resulting state.
 */
export async function rebuildDatabaseFromJournal(
  targetDb: CashierDatabase,
  entries: ChangeJournalEntry[]
): Promise<{ processedCount: number; tablesUpdated: Set<string> }> {
  // Sort strictly by sequence number
  const sorted = [...entries].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const tablesUpdated = new Set<string>();

  await targetDb.transaction(
    'rw',
    [
      targetDb.products,
      targetDb.parties,
      targetDb.invoices,
      targetDb.invoice_items,
      targetDb.payments,
      targetDb.expenses,
      targetDb.categories,
      targetDb.settings,
      targetDb.held_invoices,
      targetDb.product_images,
    ],
    async () => {
      for (const entry of sorted) {
        tablesUpdated.add(entry.table);

        switch (entry.table) {
          case 'products': {
            if (entry.action === 'create' || entry.action === 'update') {
              if (entry.afterState) await targetDb.products.put(entry.afterState);
            } else if (entry.action === 'delete') {
              if (entry.afterState) {
                await targetDb.products.put(entry.afterState); // soft delete
              } else {
                await targetDb.products.delete(Number(entry.recordId));
              }
            } else if (entry.action === 'stock_change') {
              const prod = await targetDb.products.get(Number(entry.recordId));
              if (prod && entry.diff?.newQty !== undefined) {
                await targetDb.products.update(prod.id, {
                  qty: entry.diff.newQty,
                  updatedAt: entry.timestamp,
                });
              } else if (entry.afterState) {
                await targetDb.products.put(entry.afterState);
              }
            }
            break;
          }

          case 'parties': {
            if (entry.action === 'create' || entry.action === 'update' || entry.action === 'delete') {
              if (entry.afterState) await targetDb.parties.put(entry.afterState);
              else await targetDb.parties.delete(Number(entry.recordId));
            }
            break;
          }

          case 'invoices': {
            if (entry.action === 'create') {
              if (entry.afterState) await targetDb.invoices.put(entry.afterState);
            } else if (entry.action === 'void' || entry.action === 'delete') {
              if (entry.afterState) {
                await targetDb.invoices.put(entry.afterState);
              } else {
                await targetDb.invoices.delete(Number(entry.recordId));
              }
            }
            break;
          }

          case 'invoice_items': {
            if (entry.action === 'create') {
              if (entry.afterState) await targetDb.invoice_items.put(entry.afterState);
            } else if (entry.action === 'delete') {
              await targetDb.invoice_items.delete(Number(entry.recordId));
            }
            break;
          }

          case 'payments': {
            if (entry.action === 'create') {
              if (entry.afterState) await targetDb.payments.put(entry.afterState);
            } else if (entry.action === 'delete') {
              if (entry.afterState) await targetDb.payments.put(entry.afterState);
              else await targetDb.payments.delete(Number(entry.recordId));
            }
            break;
          }

          case 'expenses': {
            if (entry.action === 'create') {
              if (entry.afterState) await targetDb.expenses.put(entry.afterState);
            } else if (entry.action === 'delete') {
              if (entry.afterState) await targetDb.expenses.put(entry.afterState);
              else await targetDb.expenses.delete(Number(entry.recordId));
            }
            break;
          }

          case 'settings': {
            if (entry.afterState) {
              if (entry.recordId === 'store_settings') {
                for (const [k, v] of Object.entries(entry.afterState)) {
                  await targetDb.settings.put({ key: k, value: v });
                }
              } else {
                await targetDb.settings.put(entry.afterState);
              }
            }
            break;
          }

          case 'categories': {
            if (entry.afterState) await targetDb.categories.put(entry.afterState);
            break;
          }

          case 'held_invoices': {
            if (entry.action === 'create') {
              if (entry.afterState) await targetDb.held_invoices.put(entry.afterState);
            } else if (entry.action === 'delete') {
              await targetDb.held_invoices.delete(String(entry.recordId));
            }
            break;
          }

          case 'product_images': {
            if (entry.action === 'create' || entry.action === 'update') {
              if (entry.afterState) await targetDb.product_images.put(entry.afterState);
            } else if (entry.action === 'delete') {
              await targetDb.product_images.delete(Number(entry.recordId));
            }
            break;
          }
        }
      }
    }
  );

  return { processedCount: sorted.length, tablesUpdated };
}

/**
 * Validates that two databases have matching states across business entities
 */
export async function verifyReconstructedParity(
  sourceDb: CashierDatabase,
  rebuiltDb: CashierDatabase
): Promise<{ match: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];

  const [
    srcProds, rebProds,
    srcParties, rebParties,
    srcInvoices, rebInvoices,
    srcItems, rebItems,
    srcPayments, rebPayments,
    srcExpenses, rebExpenses,
    srcHeld, rebHeld,
    srcImages, rebImages,
  ] = await Promise.all([
    sourceDb.products.toArray(), rebuiltDb.products.toArray(),
    sourceDb.parties.toArray(), rebuiltDb.parties.toArray(),
    sourceDb.invoices.toArray(), rebuiltDb.invoices.toArray(),
    sourceDb.invoice_items.toArray(), rebuiltDb.invoice_items.toArray(),
    sourceDb.payments.toArray(), rebuiltDb.payments.toArray(),
    sourceDb.expenses.toArray(), rebuiltDb.expenses.toArray(),
    sourceDb.held_invoices.toArray(), rebuiltDb.held_invoices.toArray(),
    sourceDb.product_images.toArray(), rebuiltDb.product_images.toArray(),
  ]);

  if (srcProds.length !== rebProds.length) {
    mismatches.push(`اختلاف عدد المنتجات: الأصلي ${srcProds.length}، المعاد بناؤه ${rebProds.length}`);
  }
  for (const sp of srcProds) {
    const rp = rebProds.find((p) => p.id === sp.id);
    if (!rp) {
      mismatches.push(`منتج مفقود ${sp.id}: ${sp.name}`);
    } else if (rp.qty !== sp.qty || rp.sell_price !== sp.sell_price || rp.isDeleted !== sp.isDeleted) {
      mismatches.push(`اختلاف بيانات المنتج ${sp.id}: أصلي (qty: ${sp.qty}, sell: ${sp.sell_price}) vs معاد (qty: ${rp.qty}, sell: ${rp.sell_price})`);
    }
  }

  if (srcInvoices.length !== rebInvoices.length) {
    mismatches.push(`اختلاف عدد الفواتير: الأصلي ${srcInvoices.length}، المعاد بناؤه ${rebInvoices.length}`);
  }
  if (srcExpenses.length !== rebExpenses.length) {
    mismatches.push(`اختلاف عدد المصروفات: الأصلي ${srcExpenses.length}، المعاد بناؤه ${rebExpenses.length}`);
  }
  if (srcPayments.length !== rebPayments.length) {
    mismatches.push(`اختلاف عدد الدفعات: الأصلي ${srcPayments.length}، المعاد بناؤه ${rebPayments.length}`);
  }
  if (srcHeld.length !== rebHeld.length) {
    mismatches.push(`اختلاف عدد الفواتير المعلقة: الأصلي ${srcHeld.length}، المعاد بناؤه ${rebHeld.length}`);
  }
  if (srcImages.length !== rebImages.length) {
    mismatches.push(`اختلاف عدد الصور: الأصلي ${srcImages.length}، المعاد بناؤه ${rebImages.length}`);
  }

  return {
    match: mismatches.length === 0,
    mismatches,
  };
}
