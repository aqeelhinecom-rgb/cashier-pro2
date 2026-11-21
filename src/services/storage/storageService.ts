import { CashierDatabase, cashierStorageDb } from './schema';
import { ProductRepository } from './repositories/productRepository';
import { PartyRepository } from './repositories/partyRepository';
import { InvoiceRepository } from './repositories/invoiceRepository';
import { ExpenseRepository } from './repositories/expenseRepository';
import { PaymentRepository } from './repositories/paymentRepository';
import { SettingsRepository } from './repositories/settingsRepository';
import { HeldInvoiceRepository } from './repositories/heldInvoiceRepository';
import { ImageRepository } from './repositories/imageRepository';
import { ReportRepository } from './repositories/reportRepository';
import { checkStorageQuota, requestStoragePersistence } from './storageQuota';
import { generateUUID } from './uuid';

export class StorageService {
  public products: ProductRepository;
  public parties: PartyRepository;
  public invoices: InvoiceRepository;
  public expenses: ExpenseRepository;
  public payments: PaymentRepository;
  public settings: SettingsRepository;
  public heldInvoices: HeldInvoiceRepository;
  public images: ImageRepository;
  public reports: ReportRepository;

  constructor(public db: CashierDatabase = cashierStorageDb) {
    this.products = new ProductRepository(db);
    this.parties = new PartyRepository(db);
    this.invoices = new InvoiceRepository(db);
    this.expenses = new ExpenseRepository(db);
    this.payments = new PaymentRepository(db);
    this.settings = new SettingsRepository(db);
    this.heldInvoices = new HeldInvoiceRepository(db);
    this.images = new ImageRepository(db);
    this.reports = new ReportRepository(db);
  }

  async checkQuota() {
    return checkStorageQuota();
  }

  async requestPersistence() {
    return requestStoragePersistence();
  }

  async getAuditLogs(limit = 100) {
    return this.db.audit_logs.reverse().limit(limit).toArray();
  }

  async addAuditLog(action: 'create' | 'update' | 'delete' | 'void' | 'restore', entity: 'product' | 'invoice' | 'party' | 'payment' | 'expense' | 'setting', entityId: string | number, details?: Record<string, any>) {
    return this.db.audit_logs.add({
      action,
      entity,
      entityId,
      timestamp: new Date().toISOString(),
      details,
      uuid: generateUUID(),
    });
  }
}

// Standalone singleton instance (isolated, not linked to existing UI or db.ts yet)
export const storageService = new StorageService();
