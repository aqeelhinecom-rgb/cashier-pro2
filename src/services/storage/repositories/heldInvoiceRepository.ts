import { CashierDatabase } from '../schema';
import { StorageHeldInvoice, InvoiceType } from '../types';

export class HeldInvoiceRepository {
  constructor(private db: CashierDatabase) {}

  async getByType(type: InvoiceType): Promise<StorageHeldInvoice[]> {
    return this.db.held_invoices
      .filter((h) => h.type === type)
      .reverse()
      .sortBy('updatedAt');
  }

  async getAll(): Promise<StorageHeldInvoice[]> {
    return this.db.held_invoices.toArray();
  }

  async save(held: StorageHeldInvoice): Promise<void> {
    await this.db.transaction('rw', [this.db.held_invoices, this.db.change_journal], async () => {
      await this.db.held_invoices.put(held);
      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: held.uuid,
          table: 'held_invoices',
          action: 'create',
          recordId: held.id,
          recordUuid: held.uuid,
          timestamp: held.updatedAt || new Date().toISOString(),
          afterState: held,
        });
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.held_invoices, this.db.change_journal], async () => {
      const existing = await this.db.held_invoices.get(id);
      await this.db.held_invoices.delete(id);
      if (this.db.change_journal && existing) {
        await this.db.change_journal.add({
          operationId: existing.uuid,
          table: 'held_invoices',
          action: 'delete',
          recordId: id,
          recordUuid: existing.uuid,
          timestamp: new Date().toISOString(),
          beforeState: existing,
        });
      }
    });
  }

  async clearByType(type: InvoiceType): Promise<void> {
    await this.db.transaction('rw', [this.db.held_invoices, this.db.change_journal], async () => {
      const list = await this.db.held_invoices.filter((h) => h.type === type).toArray();
      const now = new Date().toISOString();
      for (const h of list) {
        await this.db.held_invoices.delete(h.id);
        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: h.uuid,
            table: 'held_invoices',
            action: 'delete',
            recordId: h.id,
            recordUuid: h.uuid,
            timestamp: now,
            beforeState: h,
          });
        }
      }
    });
  }
}
