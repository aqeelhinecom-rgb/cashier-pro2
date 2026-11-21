import { CashierDatabase } from '../schema';
import { StorageExpense } from '../types';
import { generateUUID } from '../uuid';

export class ExpenseRepository {
  constructor(private db: CashierDatabase) {}

  async getAll(query = ''): Promise<StorageExpense[]> {
    let collection = this.db.expenses.filter((e) => !e.isDeleted);
    let list = await collection.toArray();

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.recipient.toLowerCase().includes(q) ||
          (e.notes && e.notes.toLowerCase().includes(q))
      );
    }

    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  async getById(id: number): Promise<StorageExpense | undefined> {
    return this.db.expenses.get(id);
  }

  async add(data: {
    recipient: string;
    amount: number;
    date?: string;
    notes?: string;
    currency?: string;
  }): Promise<StorageExpense> {
    const now = new Date().toISOString();

    return this.db.transaction('rw', [this.db.expenses, this.db.change_journal], async () => {
      const expense: StorageExpense = {
        recipient: data.recipient.trim(),
        amount: Number(data.amount) || 0,
        date: data.date || now,
        notes: data.notes?.trim(),
        currency: data.currency?.trim() || 'د.ع',
        uuid: generateUUID(),
        updatedAt: now,
        isDeleted: false,
      } as StorageExpense;

      const id = await this.db.expenses.add(expense);
      expense.id = id;

      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: expense.uuid,
          table: 'expenses',
          action: 'create',
          recordId: id,
          recordUuid: expense.uuid,
          timestamp: now,
          afterState: expense,
        });
      }

      return expense;
    });
  }

  async delete(id: number, soft = true): Promise<void> {
    await this.db.transaction('rw', [this.db.expenses, this.db.change_journal], async () => {
      const existing = await this.db.expenses.get(id);
      const now = new Date().toISOString();

      if (soft) {
        await this.db.expenses.update(id, {
          isDeleted: true,
          updatedAt: now,
        });
      } else {
        await this.db.expenses.delete(id);
      }

      if (this.db.change_journal && existing) {
        await this.db.change_journal.add({
          operationId: generateUUID(),
          table: 'expenses',
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
