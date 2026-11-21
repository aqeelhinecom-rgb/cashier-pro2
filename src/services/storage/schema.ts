import Dexie, { type Table } from 'dexie';
import {
  StorageProduct,
  StorageParty,
  StorageInvoice,
  StorageInvoiceItem,
  StoragePayment,
  StorageExpense,
  StorageHeldInvoice,
  StorageProductImage,
  StorageAuditLog,
  StorageMigrationState,
} from './types';

export class CashierDatabase extends Dexie {
  products!: Table<StorageProduct, number>;
  parties!: Table<StorageParty, number>;
  invoices!: Table<StorageInvoice, number>;
  invoice_items!: Table<StorageInvoiceItem, number>;
  payments!: Table<StoragePayment, number>;
  expenses!: Table<StorageExpense, number>;
  held_invoices!: Table<StorageHeldInvoice, string>;
  categories!: Table<{ name: string }, string>;
  settings!: Table<{ key: string; value: any }, string>;
  product_images!: Table<StorageProductImage, number>;
  audit_logs!: Table<StorageAuditLog, number>;
  migration_state!: Table<StorageMigrationState, string>;
  change_journal!: Table<import('./types').ChangeJournalEntry, number>;
  backup_history!: Table<import('./types').StorageBackupRecord, string>;

  constructor(databaseName = 'CashierPro_DB') {
    super(databaseName);

    // Version 1 Schema
    this.version(1).stores({
      products: '++id, &uuid, barcode, name, category, buy_price, sell_price, qty, updatedAt, isDeleted',
      parties: '++id, &uuid, name, phone, type, balance, updatedAt, isDeleted',
      invoices: '++id, &uuid, invoice_number, type, party_id, date, total, paid, [type+date], updatedAt, isDeleted',
      invoice_items: '++id, &uuid, invoice_id, product_id, name, updatedAt',
      payments: '++id, &uuid, party_id, date, amount, updatedAt, isDeleted',
      expenses: '++id, &uuid, recipient, date, amount, updatedAt, isDeleted',
      held_invoices: 'id, &uuid, type, partyId, updatedAt',
      categories: '&name',
      settings: '&key',
      product_images: '++id, &uuid, productId, updatedAt',
      audit_logs: '++id, &uuid, action, entity, entityId, timestamp',
      migration_state: '&key',
    });

    // Version 2 Schema: Adds reliable Change Journal for point-in-time recovery and audit
    this.version(2).stores({
      change_journal: '++seq, operationId, table, action, recordId, recordUuid, timestamp',
    });

    // Version 3 Schema: Adds historical backups store for Phase 7A
    this.version(3).stores({
      backup_history: 'id, createdAt, type, checksum, totalRecords',
    });

    // Version 4 Schema: Adds non-destructive idempotencyKey index on invoices (Phase 22 P0-02)
    this.version(4).stores({
      invoices: '++id, &uuid, idempotencyKey, invoice_number, type, party_id, date, total, paid, [type+date], updatedAt, isDeleted',
    });
  }
}

// Default singleton instance (for production storage when activated)
export const cashierStorageDb = new CashierDatabase();
