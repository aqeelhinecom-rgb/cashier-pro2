import { CashierDatabase, cashierStorageDb } from './schema';
import { StorageService } from './storageService';
import { MultiWindowSyncManager, SyncMessage } from './sync/multiWindowSync';
import {
  Product,
  Party,
  Invoice,
  InvoiceItem,
  Payment,
  Expense,
  StoreSettings,
  InvoiceType,
} from '../../types';
import { DEFAULT_STORAGE_SETTINGS } from './repositories/settingsRepository';
import { generateUUID } from './uuid';

export enum StorageInitState {
  UNINITIALIZED = 'UNINITIALIZED',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export interface InMemoryCacheData {
  products: Product[];
  parties: Party[];
  invoices: Invoice[];
  invoice_items: InvoiceItem[];
  payments: Payment[];
  expenses: Expense[];
  settings: StoreSettings;
  categories: string[];
  heldInvoices: Map<string, any[]>;
}

export class StorageCacheAdapter {
  private state: StorageInitState = StorageInitState.UNINITIALIZED;
  private lastError: Error | null = null;
  private cache: InMemoryCacheData = {
    products: [],
    parties: [],
    invoices: [],
    invoice_items: [],
    payments: [],
    expenses: [],
    settings: { ...DEFAULT_STORAGE_SETTINGS },
    categories: ['عام'],
    heldInvoices: new Map(),
  };

  private listeners = new Set<() => void>();
  private writeQueue: Promise<any> = Promise.resolve();
  private initPromise: Promise<boolean> | null = null;
  private storageService: StorageService;
  private syncManager: MultiWindowSyncManager | null = null;

  constructor(private db: CashierDatabase = cashierStorageDb) {
    this.storageService = new StorageService(db);
    try {
      this.syncManager = new MultiWindowSyncManager();
      this.syncManager.onInvalidate((msg) => {
        this.handleCrossTabSync(msg);
      });
    } catch {
      this.syncManager = null;
    }
  }

  getDatabase(): CashierDatabase {
    return this.db;
  }

  dispose(): void {
    try {
      this.syncManager?.close();
    } catch {
      // ignore
    }
    this.syncManager = null;
    this.listeners.clear();
  }

  private broadcastChange(
    table: string,
    action: 'create' | 'update' | 'delete' | 'void' | 'stock_change',
    recordId?: number | string
  ): void {
    try {
      this.syncManager?.broadcastMutation(table, action, recordId);
    } catch {
      // Ignore broadcast errors in restricted environments
    }
  }

  private async handleCrossTabSync(_msg: SyncMessage): Promise<void> {
    if (this.state !== StorageInitState.READY || !this.db.isOpen()) return;
    try {
      await this.refreshCacheFromDb();
      this.notifyListeners();
    } catch (err: any) {
      if (err?.name === 'DatabaseClosedError' || !this.db.isOpen()) return;
      console.warn('Cross-tab sync error:', err);
    }
  }

  public async refreshCacheFromDb(): Promise<void> {
    const [
      products,
      parties,
      invoices,
      invoiceItems,
      payments,
      expenses,
      settings,
      categories,
      heldInvoicesList,
    ] = await Promise.all([
      this.storageService.products.getAll(),
      this.db.parties.filter((p) => !p.isDeleted).toArray(),
      this.storageService.invoices.getAll(),
      this.db.invoice_items.toArray(),
      this.storageService.payments.getAll(),
      this.storageService.expenses.getAll(),
      this.storageService.settings.getSettings(),
      this.storageService.products.getCategories(),
      this.storageService.heldInvoices.getAll(),
    ]);

    const heldMap = new Map<string, any[]>();
    heldInvoicesList.forEach((h) => {
      const typeKey = `cashier_held_${h.type}`;
      const existing = heldMap.get(typeKey) || [];
      existing.push(h);
      heldMap.set(typeKey, existing);
    });

    this.cache = {
      products,
      parties,
      invoices,
      invoice_items: invoiceItems,
      payments,
      expenses,
      settings,
      categories: categories.length > 0 ? categories : ['عام'],
      heldInvoices: heldMap,
    };
  }

  // State inspection
  getState(): StorageInitState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === StorageInitState.READY;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  getStorageService(): StorageService {
    return this.storageService;
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyListeners(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error('StorageCacheAdapter listener error:', err);
      }
    });
  }

  /**
   * Enqueues a write task sequentially.
   * If a previous task fails, subsequent tasks are NOT stalled,
   * while the caller of the failed task still receives its error rejection.
   */
  async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .catch(() => {
          // Swallow previous error to allow the queue to progress
        })
        .then(async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  /**
   * Initializes the database connection and loads records into In-Memory Cache.
   * Transition: UNINITIALIZED -> INITIALIZING -> READY (or FAILED).
   */
  async initializeAsync(customDb?: CashierDatabase): Promise<boolean> {
    if (this.state === StorageInitState.INITIALIZING && this.initPromise && (!customDb || customDb === this.db)) {
      return this.initPromise;
    }

    if (customDb && customDb !== this.db) {
      if (this.initPromise && this.state === StorageInitState.INITIALIZING) {
        await this.initPromise.catch(() => false);
      }
      this.db = customDb;
      this.storageService = new StorageService(customDb);
    }

    this.state = StorageInitState.INITIALIZING;
    this.lastError = null;

    const runInit = async (): Promise<boolean> => {
      try {
        await this.db.open();
        await this.refreshCacheFromDb();
        this.state = StorageInitState.READY;
        this.notifyListeners();
        return true;
      } catch (err: any) {
        this.state = StorageInitState.FAILED;
        this.lastError = err instanceof Error ? err : new Error(String(err));
        console.error('StorageCacheAdapter initialization failed:', this.lastError);
        return false;
      } finally {
        this.initPromise = null;
      }
    };

    this.initPromise = runInit();
    return this.initPromise;
  }

  /**
   * Guard to prevent reading operational data from Cache before READY state.
   */
  private assertReady(operation: string): void {
    if (this.state !== StorageInitState.READY) {
      throw new Error(
        `[StorageCacheAdapter] لا يمكن قراءة البيانات للعملية "${operation}" قبل اكتمال التهيئة (الحالة: ${this.state})`
      );
    }
  }

  // -------------------------------------------------------------
  // Synchronous In-Memory Read Operations (Guarded by assertReady)
  // -------------------------------------------------------------

  getProducts(q = ''): Product[] {
    this.assertReady('getProducts');
    let list = [...this.cache.products];
    const query = q.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.barcode.toLowerCase().includes(query) ||
          (p.category && p.category.toLowerCase().includes(query)) ||
          (p.description && p.description.toLowerCase().includes(query))
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  getProductByBarcode(code: string): Product | null {
    this.assertReady('getProductByBarcode');
    if (!code) return null;
    const clean = code.trim();
    return this.cache.products.find((p) => p.barcode && p.barcode.trim() === clean) || null;
  }

  getProductById(id: number): Product | null {
    this.assertReady('getProductById');
    return this.cache.products.find((p) => p.id === id) || null;
  }

  getCategories(): string[] {
    this.assertReady('getCategories');
    const set = new Set<string>(['عام', ...this.cache.categories]);
    this.cache.products.forEach((p) => {
      if (p.category && p.category.trim()) set.add(p.category.trim());
    });
    return Array.from(set);
  }

  getParties(type: 'customer' | 'supplier'): Party[] {
    this.assertReady('getParties');
    const parties = this.cache.parties.filter((p) => p.type === type);
    const invoices = this.cache.invoices;
    const payments = this.cache.payments;

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

  getPartyById(id: number): Party | null {
    this.assertReady('getPartyById');
    return this.cache.parties.find((p) => p.id === id) || null;
  }

  getPartyHistory(partyId: number): { invoices: Invoice[]; payments: Payment[] } {
    this.assertReady('getPartyHistory');
    const invoices = this.cache.invoices.filter((inv) => inv.party_id === partyId);
    const payments = this.cache.payments.filter((p) => p.party_id === partyId);
    return { invoices, payments };
  }

  getInvoices(type?: InvoiceType): Invoice[] {
    this.assertReady('getInvoices');
    let list = [...this.cache.invoices];
    if (type) {
      list = list.filter((inv) => inv.type === type);
    }
    return list.sort((a, b) => b.id - a.id);
  }

  getInvoiceById(id: number): Invoice | null {
    this.assertReady('getInvoiceById');
    return this.cache.invoices.find((inv) => inv.id === id) || null;
  }

  getInvoiceItems(invoiceId: number): InvoiceItem[] {
    this.assertReady('getInvoiceItems');
    return this.cache.invoice_items.filter((it) => it.invoice_id === invoiceId);
  }

  getExpenses(q = ''): Expense[] {
    this.assertReady('getExpenses');
    let list = [...this.cache.expenses];
    const query = q.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (e) =>
          e.recipient.toLowerCase().includes(query) ||
          (e.notes && e.notes.toLowerCase().includes(query))
      );
    }
    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  getSettings(): StoreSettings {
    this.assertReady('getSettings');
    return { ...this.cache.settings };
  }

  getAllInvoiceItems(): InvoiceItem[] {
    this.assertReady('getAllInvoiceItems');
    return [...this.cache.invoice_items];
  }

  getAllPayments(): Payment[] {
    this.assertReady('getAllPayments');
    return [...this.cache.payments];
  }

  getHeldInvoices(typeKey: string): any[] {
    this.assertReady('getHeldInvoices');
    return this.cache.heldInvoices.get(typeKey) || [];
  }

  // -------------------------------------------------------------
  // Commit-First Write Operations (Enqueued, IndexedDB first, then Cache)
  // -------------------------------------------------------------

  async saveProduct(productData: Partial<Product> & { name: string }): Promise<Product> {
    return this.enqueueWrite(async () => {
      const saved = await this.storageService.products.save(productData as any);

      const idx = this.cache.products.findIndex((p) => p.id === saved.id);
      if (idx >= 0) {
        this.cache.products[idx] = { ...saved };
      } else {
        this.cache.products.push({ ...saved });
      }

      if (saved.category && !this.cache.categories.includes(saved.category.trim())) {
        this.cache.categories.push(saved.category.trim());
      }

      this.notifyListeners();
      this.broadcastChange('products', productData.id ? 'update' : 'create', saved.id);
      return saved;
    });
  }

  async deleteProduct(id: number): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.storageService.products.delete(id);
      this.cache.products = this.cache.products.filter((p) => p.id !== id);
      this.notifyListeners();
      this.broadcastChange('products', 'delete', id);
    });
  }

  async updateStockQuantity(productId: number, delta: number): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.storageService.products.updateStock(productId, delta);
      const prod = this.cache.products.find((p) => p.id === productId);
      if (prod) {
        prod.qty = (Number(prod.qty) || 0) + delta;
      }
      this.notifyListeners();
      this.broadcastChange('products', 'stock_change', productId);
    });
  }

  async saveInvoice(params: {
    type: InvoiceType;
    partyId?: number | null;
    items: Omit<InvoiceItem, 'id' | 'invoice_id'>[];
    discount: number;
    paid: number;
    currency?: string;
    idempotencyKey?: string;
    notes?: string;
    date?: string;
    customInvoiceNumber?: string;
    originalInvoiceId?: number;
  }): Promise<Invoice> {
    return this.enqueueWrite(async () => {
      const {
        invoice,
        items: createdItems,
        deduplicated,
        stockChanges,
      } = await this.storageService.invoices.createInvoice(params as any);

      if (deduplicated) {
        if (!this.cache.invoices.some((i) => i.id === invoice.id)) {
          this.cache.invoices.push(invoice);
        }
        for (const it of createdItems) {
          if (!this.cache.invoice_items.some((existing) => existing.id === it.id)) {
            this.cache.invoice_items.push(it);
          }
        }
        return invoice;
      }

      this.cache.invoices.push(invoice);
      this.cache.invoice_items.push(...createdItems);

      if (stockChanges && stockChanges.length > 0) {
        for (const sc of stockChanges) {
          const prod = this.cache.products.find((p) => p.id === sc.productId);
          if (prod) {
            prod.qty = sc.newQty;
          }
        }
      }

      if (invoice.type === 'purchase') {
        for (const item of params.items) {
          const prod = this.cache.products.find((p) => p.id === item.product_id);
          if (prod) {
            prod.buy_price = item.price;
            if (item.sell_price !== undefined && item.sell_price > 0) {
              prod.sell_price = item.sell_price;
            }
          }
        }
      }

      this.notifyListeners();
      this.broadcastChange('invoices', 'create', invoice.id);
      return invoice;
    });
  }

  async canEditInvoice(id: number): Promise<{ canEdit: boolean; reason?: string; invoice?: Invoice }> {
    this.assertReady('canEditInvoice');
    return this.storageService.invoices.canEditInvoice(id);
  }

  async updateInvoice(params: {
    invoiceId: number;
    partyId?: number | null;
    items: Omit<InvoiceItem, 'id' | 'invoice_id'>[];
    discount: number;
    paid: number;
    currency?: string;
    notes?: string;
    editIdempotencyKey?: string;
    actorRole?: 'owner' | 'admin' | 'manager' | 'cashier';
  }): Promise<Invoice> {
    return this.enqueueWrite(async () => {
      const {
        invoice,
        items: updatedItems,
        deduplicated,
        stockChanges,
      } = await this.storageService.invoices.updateInvoice(params as any);

      if (deduplicated) {
        const invIdx = this.cache.invoices.findIndex((i) => i.id === invoice.id);
        if (invIdx >= 0) {
          this.cache.invoices[invIdx] = invoice;
        }
        this.cache.invoice_items = [
          ...this.cache.invoice_items.filter((it) => it.invoice_id !== invoice.id),
          ...updatedItems,
        ];
        return invoice;
      }

      const invIdx = this.cache.invoices.findIndex((i) => i.id === invoice.id);
      if (invIdx >= 0) {
        this.cache.invoices[invIdx] = invoice;
      } else {
        this.cache.invoices.push(invoice);
      }

      this.cache.invoice_items = [
        ...this.cache.invoice_items.filter((it) => it.invoice_id !== invoice.id),
        ...updatedItems,
      ];

      if (stockChanges && stockChanges.length > 0) {
        for (const sc of stockChanges) {
          const prod = this.cache.products.find((p) => p.id === sc.productId);
          if (prod) {
            prod.qty = sc.newQty;
          }
        }
      }

      if (invoice.type === 'purchase') {
        for (const item of params.items) {
          const prod = this.cache.products.find((p) => p.id === item.product_id);
          if (prod) {
            prod.buy_price = item.price;
            if (item.sell_price !== undefined && item.sell_price > 0) {
              prod.sell_price = item.sell_price;
            }
          }
        }
      }

      this.notifyListeners();
      this.broadcastChange('invoices', 'update', invoice.id);
      return invoice;
    });
  }

  async deleteInvoice(id: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const res = await this.storageService.invoices.deleteInvoice(id);
      if (!res.voided) {
        if (this.cache.invoices.some((i) => i.id === id)) {
          this.cache.invoices = this.cache.invoices.filter((i) => i.id !== id);
          this.cache.invoice_items = this.cache.invoice_items.filter((it) => it.invoice_id !== id);
          this.notifyListeners();
        }
        return;
      }

      if (res.stockChanges && res.stockChanges.length > 0) {
        for (const sc of res.stockChanges) {
          const prod = this.cache.products.find((p) => p.id === sc.productId);
          if (prod) {
            prod.qty = sc.newQty;
          }
        }
      }

      this.cache.invoices = this.cache.invoices.filter((i) => i.id !== id);
      this.cache.invoice_items = this.cache.invoice_items.filter((it) => it.invoice_id !== id);

      this.notifyListeners();
      this.broadcastChange('invoices', 'void', id);
    });
  }

  async addParty(name: string, phone: string, type: 'customer' | 'supplier'): Promise<Party> {
    return this.enqueueWrite(async () => {
      const saved = await this.storageService.parties.save({ name, phone, type });
      this.cache.parties.push(saved);
      this.notifyListeners();
      this.broadcastChange('parties', 'create', saved.id);
      return saved;
    });
  }

  async deleteParty(id: number): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.storageService.parties.delete(id);
      this.cache.parties = this.cache.parties.filter((p) => p.id !== id);
      this.notifyListeners();
      this.broadcastChange('parties', 'delete', id);
    });
  }

  async addPayment(partyId: number, amount: number, notes?: string, currency?: string): Promise<Payment> {
    return this.enqueueWrite(async () => {
      const saved = await this.storageService.payments.add({ partyId, amount, notes, currency });
      this.cache.payments.push(saved);
      this.notifyListeners();
      this.broadcastChange('payments', 'create', saved.id);
      return saved;
    });
  }

  async addExpense(recipient: string, amount: number, date?: string, notes?: string, currency?: string): Promise<Expense> {
    return this.enqueueWrite(async () => {
      const saved = await this.storageService.expenses.add({ recipient, amount, date, notes, currency });
      this.cache.expenses.unshift(saved);
      this.notifyListeners();
      this.broadcastChange('expenses', 'create', saved.id);
      return saved;
    });
  }

  async deleteExpense(id: number): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.storageService.expenses.delete(id);
      this.cache.expenses = this.cache.expenses.filter((e) => e.id !== id);
      this.notifyListeners();
      this.broadcastChange('expenses', 'delete', id);
    });
  }

  async saveSettings(partial: Partial<StoreSettings>): Promise<StoreSettings> {
    return this.enqueueWrite(async () => {
      const updated = await this.storageService.settings.saveSettings(partial);
      this.cache.settings = { ...updated };
      this.notifyListeners();
      this.broadcastChange('settings', 'update', 'settings');
      return updated;
    });
  }

  async addCategory(name: string): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const updated = await this.storageService.products.addCategory(name);
      this.cache.categories = updated;
      this.notifyListeners();
      this.broadcastChange('categories', 'create', name);
      return updated;
    });
  }

  async renameCategory(oldName: string, newName: string): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const updated = await this.storageService.products.renameCategory(oldName, newName);
      this.cache.categories = updated;
      this.cache.products.forEach((p) => {
        if ((p.category || 'عام').trim() === oldName.trim()) {
          p.category = newName.trim();
        }
      });
      this.notifyListeners();
      this.broadcastChange('categories', 'update', newName);
      return updated;
    });
  }

  async deleteCategory(name: string): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const updated = await this.storageService.products.deleteCategory(name);
      this.cache.categories = updated;
      this.cache.products.forEach((p) => {
        if ((p.category || '').trim() === name.trim()) {
          p.category = 'عام';
        }
      });
      this.notifyListeners();
      this.broadcastChange('categories', 'delete', name);
      return updated;
    });
  }

  async saveHeldInvoices(typeKey: string, list: any[]): Promise<void> {
    return this.enqueueWrite(async () => {
      const invoiceType = typeKey.replace('cashier_held_', '') as InvoiceType;
      await this.storageService.heldInvoices.clearByType(invoiceType);
      for (const item of list) {
        await this.storageService.heldInvoices.save({
          id: item.id || `hold_${Date.now()}_${Math.random()}`,
          uuid: generateUUID(),
          type: invoiceType,
          time: item.time || '',
          partyId: item.partyId ?? null,
          partyName: item.partyName || '',
          items: item.items || [],
          discount: item.discount || 0,
          updatedAt: new Date().toISOString(),
        });
      }
      this.cache.heldInvoices.set(typeKey, list);
      this.notifyListeners();
      this.broadcastChange('held_invoices', 'update', typeKey);
    });
  }

  /**
   * Atomically restores either a CompleteDexieBackupFile (v2.0) or a Legacy/SQLite snapshot
   * into the active Dexie database, preserving invoices, invoice_items, parties, payments,
   * expenses, products, categories, and settings with zero data loss (FIND-P17-01).
   */
  async restoreSnapshotAsync(rawData: any): Promise<boolean> {
    return this.enqueueWrite(async () => {
      await this.db.open();

      // 1. Handle Phase 7A CompleteDexieBackup format cleanly via atomic backup engine
      if (rawData && rawData.format === 'CashierProCompleteDexieBackup' && rawData.data) {
        const { restoreDexieBackupSafely } = await import('./backup/dexieBackupEngine');
        await restoreDexieBackupSafely(rawData, this.db);
        if (this.db !== cashierStorageDb) {
          await this.refreshCacheFromDb();
          this.notifyListeners();
        }
        this.broadcastChange('products', 'update', 'restore_dexie_backup');
        return true;
      }

      if (!rawData || !Array.isArray(rawData.products)) {
        throw new Error('ملف النسخة الاحتياطية غير صالح أو يفتقد مصفوفة المنتجات');
      }

      // 2. Take a best-effort pre-restore safety backup before clearing tables
      try {
        const { createFullDexieBackup } = await import('./backup/dexieBackupEngine');
        await createFullDexieBackup(this.db, 'pre_restore_safety', 'نسخة أمان قبل الاستعادة التوافقية');
      } catch (e) {
        console.warn('Pre-restore safety snapshot skipped:', e);
      }

      const now = new Date().toISOString();
      const restoredProducts = (rawData.products || []).map((p: any, idx: number) => ({
        id: Number(p.id) || idx + 1,
        uuid: p.uuid || generateUUID(),
        name: String(p.name || `منتج ${idx + 1}`).trim(),
        barcode: p.barcode ? String(p.barcode).trim() : '',
        category: p.category ? String(p.category).trim() : 'عام',
        description: p.description ? String(p.description).trim() : '',
        buy_price: Number(p.buy_price) || 0,
        sell_price: Number(p.sell_price) || 0,
        qty: Number(p.qty) || 0,
        currency: p.currency || rawData.settings?.currency || 'د.ع',
        image: p.image || undefined,
        version: Number(p.version) || 1,
        updatedAt: p.updatedAt || now,
        isDeleted: false,
      }));

      const restoredParties = (rawData.parties || []).map((pt: any, idx: number) => ({
        id: Number(pt.id) || idx + 1,
        uuid: pt.uuid || generateUUID(),
        name: String(pt.name || `جهة ${idx + 1}`).trim(),
        phone: pt.phone ? String(pt.phone).trim() : '',
        type: pt.type === 'supplier' ? 'supplier' : 'customer',
        balance: Number(pt.balance) || 0,
        version: Number(pt.version) || 1,
        updatedAt: pt.updatedAt || now,
        isDeleted: false,
      }));

      const parseSeqSuffix = (num?: string): number => {
        if (!num) return 0;
        const m = String(num).match(/(\d+)$/);
        return m ? parseInt(m[1], 10) || 0 : 0;
      };

      const restoredInvoices = (rawData.invoices || []).map((inv: any, idx: number) => ({
        id: Number(inv.id) || idx + 1,
        uuid: inv.uuid || generateUUID(),
        idempotencyKey: inv.idempotencyKey || undefined,
        invoice_number: inv.invoice_number || undefined,
        type: inv.type || 'sale',
        party_id: inv.party_id ?? null,
        party_name: inv.party_name || '',
        date: inv.date || now,
        discount: Number(inv.discount) || 0,
        total: Number(inv.total) || 0,
        paid: Number(inv.paid) || 0,
        currency: inv.currency || rawData.settings?.currency || 'د.ع',
        version: Number(inv.version) || 1,
        updatedAt: inv.updatedAt || now,
        isDeleted: Boolean(inv.isDeleted),
      }));

      const restoredItems = (rawData.invoice_items || []).map((it: any, idx: number) => ({
        id: Number(it.id) || idx + 1,
        uuid: it.uuid || generateUUID(),
        invoice_id: Number(it.invoice_id) || 0,
        product_id: Number(it.product_id) || 0,
        name: String(it.name || `بند ${idx + 1}`),
        category: it.category || undefined,
        image: it.image || undefined,
        qty: Number(it.qty) || 0,
        price: Number(it.price) || 0,
        sell_price: it.sell_price !== undefined ? Number(it.sell_price) : undefined,
        cost: Number(it.cost) || 0,
        updatedAt: it.updatedAt || now,
      }));

      const restoredPayments = (rawData.payments || []).map((pay: any, idx: number) => ({
        id: Number(pay.id) || idx + 1,
        uuid: pay.uuid || generateUUID(),
        party_id: Number(pay.party_id) || 0,
        party_name: pay.party_name || undefined,
        amount: Number(pay.amount) || 0,
        date: pay.date || now,
        notes: pay.notes || undefined,
        currency: pay.currency || rawData.settings?.currency || 'د.ع',
        updatedAt: pay.updatedAt || now,
        isDeleted: false,
      }));

      const restoredExpenses = (rawData.expenses || []).map((exp: any, idx: number) => ({
        id: Number(exp.id) || idx + 1,
        uuid: exp.uuid || generateUUID(),
        recipient: String(exp.recipient || 'مصروف'),
        amount: Number(exp.amount) || 0,
        date: exp.date || now,
        notes: exp.notes || undefined,
        currency: exp.currency || rawData.settings?.currency || 'د.ع',
        updatedAt: exp.updatedAt || now,
        isDeleted: false,
      }));

      const categorySet = new Set<string>(['عام']);
      if (Array.isArray(rawData.categories)) {
        rawData.categories.forEach((c: any) => {
          const val = typeof c === 'string' ? c.trim() : String(c?.name || '').trim();
          if (val) categorySet.add(val);
        });
      }
      restoredProducts.forEach((p: any) => {
        if (p.category) categorySet.add(p.category);
      });
      const restoredCategories = Array.from(categorySet).map((name) => ({ name }));

      const mergedSettings = {
        ...DEFAULT_STORAGE_SETTINGS,
        ...(rawData.settings || {}),
      };
      const maxInvSeq = restoredInvoices.reduce((m: number, i: any) => Math.max(m, Number(i.id) || 0), 0);
      const calcTypeSeq = (t: InvoiceType): number => {
        const typeMax = restoredInvoices
          .filter((i: any) => i.type === t)
          .reduce((m: number, i: any) => Math.max(m, Number(i.id) || 0, parseSeqSuffix(i.invoice_number)), 0);
        return Math.max(maxInvSeq, typeMax);
      };
      const maxProdSeq = restoredProducts.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0);
      const maxPartySeq = restoredParties.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0);
      const maxItemSeq = restoredItems.reduce((m: number, it: any) => Math.max(m, Number(it.id) || 0), 0);
      const maxPaySeq = restoredPayments.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0);
      const maxExpSeq = restoredExpenses.reduce((m: number, e: any) => Math.max(m, Number(e.id) || 0), 0);

      const settingEntries = [
        ...Object.entries(mergedSettings).map(([key, value]) => ({ key, value })),
        { key: 'seq_invoices', value: maxInvSeq },
        { key: 'seq_sale', value: calcTypeSeq('sale') },
        { key: 'seq_purchase', value: calcTypeSeq('purchase') },
        { key: 'seq_sale_return', value: calcTypeSeq('sale_return') },
        { key: 'seq_quote', value: calcTypeSeq('quote') },
        { key: 'seq_products', value: maxProdSeq },
        { key: 'seq_parties', value: maxPartySeq },
        { key: 'seq_invoice_items', value: maxItemSeq },
        { key: 'seq_payments', value: maxPaySeq },
        { key: 'seq_expenses', value: maxExpSeq },
      ];

      await this.db.transaction(
        'rw',
        [
          this.db.products,
          this.db.parties,
          this.db.invoices,
          this.db.invoice_items,
          this.db.payments,
          this.db.expenses,
          this.db.categories,
          this.db.settings,
          this.db.change_journal,
        ],
        async () => {
          await Promise.all([
            this.db.products.clear(),
            this.db.parties.clear(),
            this.db.invoices.clear(),
            this.db.invoice_items.clear(),
            this.db.payments.clear(),
            this.db.expenses.clear(),
            this.db.categories.clear(),
          ]);

          if (restoredProducts.length) await this.db.products.bulkPut(restoredProducts);
          if (restoredParties.length) await this.db.parties.bulkPut(restoredParties as any);
          if (restoredInvoices.length) await this.db.invoices.bulkPut(restoredInvoices as any);
          if (restoredItems.length) await this.db.invoice_items.bulkPut(restoredItems);
          if (restoredPayments.length) await this.db.payments.bulkPut(restoredPayments);
          if (restoredExpenses.length) await this.db.expenses.bulkPut(restoredExpenses);
          if (restoredCategories.length) await this.db.categories.bulkPut(restoredCategories);
          if (settingEntries.length) await this.db.settings.bulkPut(settingEntries);

          if (this.db.change_journal) {
            await this.db.change_journal.add({
              operationId: generateUUID(),
              table: 'settings',
              action: 'update',
              recordId: 'restore_snapshot',
              recordUuid: generateUUID(),
              timestamp: now,
              afterState: {
                restoredAt: now,
                products: restoredProducts.length,
                parties: restoredParties.length,
                invoices: restoredInvoices.length,
                invoice_items: restoredItems.length,
                payments: restoredPayments.length,
                expenses: restoredExpenses.length,
              },
            });
          }
        }
      );

      await this.refreshCacheFromDb();
      this.notifyListeners();
      this.broadcastChange('products', 'update', 'restore_snapshot');
      return true;
    });
  }
}

// Default singleton adapter instance
export const storageCacheAdapter = new StorageCacheAdapter();
