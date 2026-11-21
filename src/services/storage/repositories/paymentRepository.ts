import { CashierDatabase } from '../schema';
import { StoragePayment } from '../types';
import { generateUUID } from '../uuid';

export class PaymentRepository {
  constructor(private db: CashierDatabase) {}

  async getAll(): Promise<StoragePayment[]> {
    const list = await this.db.payments.filter((p) => !p.isDeleted).toArray();
    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  async getByPartyId(partyId: number): Promise<StoragePayment[]> {
    return this.db.payments
      .filter((p) => p.party_id === partyId && !p.isDeleted)
      .toArray();
  }

  async add(data: {
    partyId: number;
    amount: number;
    notes?: string;
    currency?: string;
    date?: string;
  }): Promise<StoragePayment> {
    const now = data.date || new Date().toISOString();

    return this.db.transaction('rw', [this.db.payments, this.db.parties, this.db.change_journal], async () => {
      const party = await this.db.parties.get(data.partyId);

      const payment: StoragePayment = {
        party_id: data.partyId,
        party_name: party?.name,
        amount: Number(data.amount) || 0,
        date: now,
        notes: data.notes?.trim(),
        currency: data.currency?.trim() || 'د.ع',
        uuid: generateUUID(),
        updatedAt: now,
        isDeleted: false,
      } as StoragePayment;

      const id = await this.db.payments.add(payment);
      payment.id = id;

      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: payment.uuid,
          table: 'payments',
          action: 'create',
          recordId: id,
          recordUuid: payment.uuid,
          timestamp: now,
          afterState: payment,
        });
      }

      return payment;
    });
  }

  async delete(id: number, soft = true): Promise<void> {
    await this.db.transaction('rw', [this.db.payments, this.db.change_journal], async () => {
      const existing = await this.db.payments.get(id);
      const now = new Date().toISOString();

      if (soft) {
        await this.db.payments.update(id, {
          isDeleted: true,
          updatedAt: now,
        });
      } else {
        await this.db.payments.delete(id);
      }

      if (this.db.change_journal && existing) {
        await this.db.change_journal.add({
          operationId: generateUUID(),
          table: 'payments',
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
}
