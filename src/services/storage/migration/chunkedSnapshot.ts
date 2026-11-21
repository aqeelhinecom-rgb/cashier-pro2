import { LegacyLocalStorageDump } from './reader';
import { CashierDatabase } from '../schema';

export interface SnapshotManifest {
  snapshotId: string;
  createdAt: string;
  tableCounts: Record<string, number>;
  totalRecords: number;
  estimatedBytes: number;
  checksum: string;
}

/**
 * Creates a lightweight numeric checksum from data
 */
function computeSimpleChecksum(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Computes a deterministic canonical checksum across all business entities
 * ignoring volatile metadata like extraction timestamp or key ordering.
 */
export function computeCanonicalHash(data: LegacyLocalStorageDump): string {
  const canonical = JSON.stringify({
    products: data.products,
    parties: data.parties,
    invoices: data.invoices,
    invoice_items: data.invoice_items,
    payments: data.payments,
    expenses: data.expenses,
    settings: data.settings,
    categories: data.categories,
    heldInvoices: data.heldInvoices,
  });
  return computeSimpleChecksum(canonical);
}

/**
 * Creates a safe snapshot partitioned by entity rather than putting
 * a single monolithic multi-megabyte string into one key.
 * Stores primarily into IndexedDB migration_state where capacity is large,
 * completely avoiding localStorage quota crashes.
 */
export async function createSafeChunkedSnapshot(
  data: LegacyLocalStorageDump,
  targetDb?: CashierDatabase
): Promise<{ manifest: SnapshotManifest; exportBlob: Blob }> {
  const snapshotId = `snap_${Date.now()}`;
  const now = new Date().toISOString();

  const serialized = JSON.stringify(data);
  const estimatedBytes = new Blob([serialized]).size;
  const checksum = computeCanonicalHash(data);

  const tableCounts: Record<string, number> = {
    products: data.products.length,
    parties: data.parties.length,
    invoices: data.invoices.length,
    invoice_items: data.invoice_items.length,
    payments: data.payments.length,
    expenses: data.expenses.length,
    categories: data.categories.length,
    heldInvoices: data.heldInvoices.reduce((sum, h) => sum + (h.items?.length || 0), 0),
  };

  const totalRecords = Object.values(tableCounts).reduce((a, b) => a + b, 0);

  const manifest: SnapshotManifest = {
    snapshotId,
    createdAt: now,
    tableCounts,
    totalRecords,
    estimatedBytes,
    checksum,
  };

  // If a target Dexie database instance is provided, save into IndexedDB migration_state
  if (targetDb) {
    await targetDb.transaction('rw', targetDb.migration_state, async () => {
      await targetDb.migration_state.put({
        key: `snapshot_manifest_${snapshotId}`,
        value: manifest,
        timestamp: now,
      });

      // Store partitioned entities separately in migration_state
      await targetDb.migration_state.put({ key: `snapshot_products_${snapshotId}`, value: data.products, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_parties_${snapshotId}`, value: data.parties, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_invoices_${snapshotId}`, value: data.invoices, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_invoice_items_${snapshotId}`, value: data.invoice_items, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_payments_${snapshotId}`, value: data.payments, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_expenses_${snapshotId}`, value: data.expenses, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_settings_${snapshotId}`, value: data.settings, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_categories_${snapshotId}`, value: data.categories, timestamp: now });
      await targetDb.migration_state.put({ key: `snapshot_held_${snapshotId}`, value: data.heldInvoices, timestamp: now });
    });
  }

  const exportBlob = new Blob([serialized], { type: 'application/json' });
  return { manifest, exportBlob };
}

/**
 * Restores a chunked snapshot from targetDb.migration_state and verifies its integrity.
 * If any chunk is missing, truncated, or if the checksum does not match, returns verified: false.
 */
export async function restoreSafeChunkedSnapshot(
  snapshotId: string,
  targetDb: CashierDatabase
): Promise<{ data: LegacyLocalStorageDump | null; verified: boolean; error?: string }> {
  try {
    const manifestRecord = await targetDb.migration_state.get(`snapshot_manifest_${snapshotId}`);
    if (!manifestRecord || !manifestRecord.value) {
      return { data: null, verified: false, error: `المانيفست الخاص باللقطة ${snapshotId} غير موجود` };
    }

    const manifest = manifestRecord.value as SnapshotManifest;

    const [
      productsRec,
      partiesRec,
      invoicesRec,
      itemsRec,
      paymentsRec,
      expensesRec,
      settingsRec,
      categoriesRec,
      heldRec,
    ] = await Promise.all([
      targetDb.migration_state.get(`snapshot_products_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_parties_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_invoices_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_invoice_items_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_payments_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_expenses_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_settings_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_categories_${snapshotId}`),
      targetDb.migration_state.get(`snapshot_held_${snapshotId}`),
    ]);

    // Check completeness: all essential chunks must exist
    if (!productsRec || !partiesRec || !invoicesRec || !itemsRec || !paymentsRec || !expensesRec) {
      return { data: null, verified: false, error: 'أحد أجزاء اللقطة الأساسية مفقود في قاعدة البيانات (Incomplete Snapshot)' };
    }

    const products = productsRec.value || [];
    const parties = partiesRec.value || [];
    const invoices = invoicesRec.value || [];
    const invoice_items = itemsRec.value || [];
    const payments = paymentsRec.value || [];
    const expenses = expensesRec.value || [];
    const settings = settingsRec?.value || null;
    const categories = categoriesRec?.value || [];
    const heldInvoices = heldRec?.value || [];

    // Verify record counts against manifest
    if (
      products.length !== manifest.tableCounts.products ||
      parties.length !== manifest.tableCounts.parties ||
      invoices.length !== manifest.tableCounts.invoices ||
      invoice_items.length !== manifest.tableCounts.invoice_items ||
      payments.length !== manifest.tableCounts.payments ||
      expenses.length !== manifest.tableCounts.expenses
    ) {
      return {
        data: null,
        verified: false,
        error: 'أعداد السجلات المسترجعة لا تتطابق مع المانيفست الأصلي (Count Mismatch)',
      };
    }

    const reassembledData: LegacyLocalStorageDump = {
      products,
      parties,
      invoices,
      invoice_items,
      payments,
      expenses,
      settings,
      categories,
      permissionsGranted: true,
      heldInvoices,
      rawKeyCounts: manifest.tableCounts,
      timestamp: manifest.createdAt,
    };

    // Recompute checksum and compare
    const recomputedChecksum = computeCanonicalHash(reassembledData);
    if (recomputedChecksum !== manifest.checksum) {
      return {
        data: reassembledData,
        verified: false,
        error: `عدم تطابق بصمة التحقق (Checksum Mismatch): المتوقع ${manifest.checksum} والفعلي ${recomputedChecksum}`,
      };
    }

    return { data: reassembledData, verified: true };
  } catch (err: any) {
    return { data: null, verified: false, error: `استثناء أثناء استعادة اللقطة: ${err.message || String(err)}` };
  }
}
