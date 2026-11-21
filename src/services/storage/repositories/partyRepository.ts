import { CashierDatabase } from '../schema';
import { StorageParty, StorageInvoice, StoragePayment } from '../types';
import { generateUUID } from '../uuid';

export class PartyRepository {
  constructor(private db: CashierDatabase) {}

  async getAll(type: 'customer' | 'supplier'): Promise<StorageParty[]> {
    const parties = await this.db.parties
      .filter((p) => p.type === type && !p.isDeleted)
      .toArray();

    const invoices = await this.db.invoices.filter((inv) => !inv.isDeleted).toArray();
    const payments = await this.db.payments.filter((pay) => !pay.isDeleted).toArray();

    return parties
      .map((p) => {
        const invoiceDebt = invoices
          .filter((inv) => inv.party_id === p.id && inv.type !== 'quote')
          .reduce((sum, inv) => {
            const diff = (Number(inv.total) || 0) - (Number(inv.paid) || 0);
            if (p.type === 'customer' && inv.type === 'sale_return') {
              return sum - diff;
            }
            return sum + diff;
          }, 0);

        const totalPayments = payments
          .filter((pay) => pay.party_id === p.id)
          .reduce((sum, pay) => sum + (Number(pay.amount) || 0), 0);

        return {
          ...p,
          balance: invoiceDebt - totalPayments,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  async getById(id: number): Promise<StorageParty | undefined> {
    return this.db.parties.get(id);
  }

  async getByUuid(uuid: string): Promise<StorageParty | undefined> {
    return this.db.parties.where('uuid').equals(uuid).first();
  }

  async save(data: Partial<StorageParty> & { name: string; type: 'customer' | 'supplier' }): Promise<StorageParty> {
    const tables: any[] = [this.db.parties];
    if (this.db.change_journal) tables.push(this.db.change_journal);

    return this.db.transaction('rw', tables, async () => {
      const now = new Date().toISOString();
      let saved: StorageParty;

      if (data.id) {
        const existing = await this.db.parties.get(data.id);
        if (!existing) {
          throw new Error('الطرف المطلوب تعديله غير موجود');
        }

        saved = {
          ...existing,
          ...data,
          name: data.name ? data.name.trim() : existing.name,
          phone: data.phone !== undefined ? data.phone.trim() : existing.phone,
          type: data.type || existing.type,
          version: (existing.version || 1) + 1,
          updatedAt: now,
        };

        await this.db.parties.put(saved);

        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: saved.uuid,
            table: 'parties',
            action: 'update',
            recordId: saved.id,
            recordUuid: saved.uuid,
            timestamp: now,
            beforeState: existing,
            afterState: saved,
          });
        }
      } else {
        saved = {
          name: data.name.trim(),
          phone: data.phone?.trim() || '',
          type: data.type,
          balance: 0,
          version: 1,
          uuid: data.uuid || generateUUID(),
          updatedAt: now,
          isDeleted: false,
        } as StorageParty;

        const newId = await this.db.parties.add(saved);
        saved.id = newId;

        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: saved.uuid,
            table: 'parties',
            action: 'create',
            recordId: newId,
            recordUuid: saved.uuid,
            timestamp: now,
            afterState: saved,
          });
        }
      }

      return saved;
    });
  }

  async delete(id: number, soft = true): Promise<void> {
    const tables: any[] = [this.db.parties];
    if (this.db.change_journal) tables.push(this.db.change_journal);

    await this.db.transaction('rw', tables, async () => {
      const existing = await this.db.parties.get(id);
      const now = new Date().toISOString();

      if (soft) {
        await this.db.parties.update(id, {
          isDeleted: true,
          version: existing ? (existing.version || 1) + 1 : 2,
          updatedAt: now,
        });
      } else {
        await this.db.parties.delete(id);
      }

      if (this.db.change_journal && existing) {
        await this.db.change_journal.add({
          operationId: generateUUID(),
          table: 'parties',
          action: 'delete',
          recordId: id,
          recordUuid: existing.uuid,
          timestamp: now,
          beforeState: existing,
          afterState: soft ? { ...existing, isDeleted: true, updatedAt: now } : undefined,
        });
      }
    });
  }

  async getHistory(partyId: number): Promise<{ invoices: StorageInvoice[]; payments: StoragePayment[] }> {
    const invoices = await this.db.invoices
      .filter((inv) => inv.party_id === partyId && !inv.isDeleted)
      .reverse()
      .sortBy('id');

    const payments = await this.db.payments
      .filter((pay) => pay.party_id === partyId && !pay.isDeleted)
      .reverse()
      .sortBy('id');

    return { invoices, payments };
  }
}
