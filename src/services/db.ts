import {
  Product,
  Party,
  Invoice,
  InvoiceItem,
  InvoiceType,
  Payment,
  Expense,
  ReportData,
  StoreSettings,
} from '../types';
import { storageCacheAdapter, StorageInitState } from './storage/cacheAdapter';

export { StorageInitState };

/**
 * Operational Source configuration:
 * After Phase 6B Cutover, 'dexie' is the sole operational Single Source of Truth.
 * 'localStorage' is retained for reading/verification of legacy data without any active writes.
 */
let operationalSource: 'localStorage' | 'dexie' = 'dexie';
let writeFrozen: boolean = false;

export function getOperationalSource(): 'localStorage' | 'dexie' {
  return operationalSource;
}

export function setOperationalSource(source: 'localStorage' | 'dexie'): void {
  operationalSource = source;
  notifyListeners();
}

export function isWriteFrozen(): boolean {
  return writeFrozen;
}

export function setWriteFrozen(frozen: boolean): void {
  writeFrozen = frozen;
}

function assertWriteNotFrozen(action: string) {
  if (writeFrozen) {
    throw new Error(`[WriteFreeze] العمليات متوقفة مؤقتاً لتنفيذ التبديل التشغيلي والتأمين (${action})`);
  }
}

const STORAGE_KEYS = {
  PRODUCTS: 'cashier_products_v1',
  PARTIES: 'cashier_parties_v1',
  INVOICES: 'cashier_invoices_v1',
  INVOICE_ITEMS: 'cashier_invoice_items_v1',
  PAYMENTS: 'cashier_payments_v1',
  EXPENSES: 'cashier_expenses_v1',
  SETTINGS: 'cashier_settings_v1',
  PERMISSIONS: 'cashier_permissions_granted_v1',
  CATEGORIES: 'cashier_categories_v1',
};

const DEFAULT_CATEGORIES: string[] = [
  'عام',
  'قطع غيار وصيانة',
  'مواد غذائية',
  'مشروبات',
  'ألبان وأجبان',
  'منظفات',
  'ورقيات',
  'إلكترونيات',
];

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Cashier - إدارة حسابات المحلات',
  phone: '0501234567',
  address: 'الفرع الرئيسي',
  currency: 'د.ع',
  exchangeRate: 1500,
  taxRate: 0,
  receiptFooter: 'شكراً لزيارتكم ونتطلع لخدمتكم دائماً',
  googleDriveLinked: false,
  driveAccountEmail: '',
  driveLastBackupAt: '',
  userEmail: '',
  firebaseLinked: false,
  firebaseAccountEmail: '',
  firebaseLastSyncAt: '',
  firebaseProjectId: '',
  fontFamily: 'Cairo',
  fontSize: 15,
  productsFontSize: 14,
  theme: 'light',
  permissionsGranted: false,
  backupCustomFolder: 'Download/Cashier/backup',
};

const INITIAL_PRODUCTS: Product[] = [
  {
    id: 1,
    name: 'Lcd iph 11 pro max',
    barcode: '628100701100',
    category: 'قطع غيار وصيانة',
    description: 'شاشة أصلية آيفون 11 برو ماكس',
    buy_price: 10000,
    sell_price: 15000,
    qty: 1,
  },
  {
    id: 2,
    name: 'حليب كامل الدسم 1 لتر',
    barcode: '628100701234',
    category: 'ألبان وأجبان',
    description: 'حليب طازج معبأ ومبستر',
    buy_price: 4.5,
    sell_price: 6.0,
    qty: 24,
  },
  {
    id: 3,
    name: 'أرز بسمتي درجة أولى 5 كجم',
    barcode: '628100705678',
    category: 'مواد غذائية',
    description: 'أرز فاخر طويل الحبة نخب ممتاز',
    buy_price: 32.0,
    sell_price: 42.0,
    qty: 15,
  },
  {
    id: 4,
    name: 'زيت دوار الشمس 1.5 لتر',
    barcode: '628100709012',
    category: 'مواد غذائية',
    description: 'زيت طهي نقي وخفيف',
    buy_price: 13.5,
    sell_price: 18.0,
    qty: 18,
  },
  {
    id: 5,
    name: 'سكر أبيض ناعم 2 كجم',
    barcode: '628100703456',
    category: 'مواد غذائية',
    description: 'سكر مكرر نقي',
    buy_price: 7.0,
    sell_price: 9.5,
    qty: 4,
  },
  {
    id: 6,
    name: 'شاي أسود فاخر 100 كيس',
    barcode: '628100707890',
    category: 'مشروبات',
    description: 'شاي سيلاني أصلي غني بالنكهة',
    buy_price: 11.0,
    sell_price: 15.0,
    qty: 12,
  },
  {
    id: 7,
    name: 'قهوة عربية مطحونة 250 جم',
    barcode: '628100701122',
    category: 'مشروبات',
    description: 'خلطة متميزة مع الهيل الفاخر',
    buy_price: 16.0,
    sell_price: 24.0,
    qty: 3,
  },
  {
    id: 8,
    name: 'صابون غسيل أطباق 1 لتر',
    barcode: '628100703344',
    category: 'منظفات',
    description: 'قاهر الدهون برائحة الليمون',
    buy_price: 8.0,
    sell_price: 12.0,
    qty: 20,
  },
  {
    id: 9,
    name: 'مناديل وجه ناعمة 500 منديل',
    barcode: '628100705566',
    category: 'ورقيات',
    description: 'مناديل ثلاثية الطبقات فائقة النعومة',
    buy_price: 5.0,
    sell_price: 7.5,
    qty: 30,
  },
];

const INITIAL_PARTIES: Party[] = [
  { id: 1, name: 'محمد عبد الله (أبو فهد)', phone: '0551122334', type: 'customer' },
  { id: 2, name: 'خالد السعيد (تموينات الأمل)', phone: '0562233445', type: 'customer' },
  { id: 3, name: 'سارة المنصور', phone: '0543344556', type: 'customer' },
  { id: 4, name: 'شركة المراعي للتوزيع', phone: '0112233445', type: 'supplier' },
  { id: 5, name: 'مؤسسة الغذاء العالمية', phone: '0119988776', type: 'supplier' },
];

type DBListener = () => void;
const listeners = new Set<DBListener>();

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('DB listener error:', err);
    }
  });
}

export const DB = {
  subscribe(listener: DBListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getStorageAdapter() {
    return storageCacheAdapter;
  },

  getStorageState(): StorageInitState {
    return storageCacheAdapter.getState();
  },

  getLastStorageError(): Error | null {
    return storageCacheAdapter.getLastError();
  },

  async initializeAsync(customDb?: any): Promise<boolean> {
    return storageCacheAdapter.initializeAsync(customDb);
  },

  getOperationalSource(): 'localStorage' | 'dexie' {
    return operationalSource;
  },

  setOperationalSource(src: 'localStorage' | 'dexie'): void {
    setOperationalSource(src);
  },

  isWriteFrozen(): boolean {
    return isWriteFrozen();
  },

  setWriteFrozen(frozen: boolean): void {
    setWriteFrozen(frozen);
  },

  init() {
    if (typeof localStorage === 'undefined') return;
    if (!localStorage.getItem(STORAGE_KEYS.PRODUCTS)) {
      this.resetToDefault();
    }
    if (!localStorage.getItem(STORAGE_KEYS.SETTINGS)) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.CATEGORIES)) {
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(DEFAULT_CATEGORIES));
    }
  },

  isPermissionsGranted(): boolean {
    const s = this.getSettings();
    return Boolean(s.permissionsGranted);
  },

  async grantPermissionsOnce(): Promise<void> {
    assertWriteNotFrozen('grantPermissionsOnce');
    await this.saveSettings({ permissionsGranted: true });
  },

  async clearGoogleDriveLink(): Promise<StoreSettings> {
    assertWriteNotFrozen('clearGoogleDriveLink');
    return this.saveSettings({
      googleDriveLinked: false,
      driveAccountEmail: '',
      driveLastBackupAt: '',
    });
  },

  async clearFirebaseLink(): Promise<StoreSettings> {
    assertWriteNotFrozen('clearFirebaseLink');
    return this.saveSettings({
      firebaseLinked: false,
      firebaseAccountEmail: '',
      firebaseLastSyncAt: '',
      firebaseProjectId: '',
    });
  },

  async clearGoogleAccount(): Promise<StoreSettings> {
    assertWriteNotFrozen('clearGoogleAccount');
    return this.saveSettings({
      googleDriveLinked: false,
      driveAccountEmail: '',
      userEmail: '',
      firebaseLinked: false,
      firebaseAccountEmail: '',
    });
  },

  // ---------- الإعدادات ----------
  getSettings(): StoreSettings {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getSettings();
    }

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.SETTINGS) : null;
    const permGranted = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PERMISSIONS) === 'true' : false;
    if (!raw) return { ...DEFAULT_SETTINGS, permissionsGranted: permGranted };
    try {
      const parsed = JSON.parse(raw);
      const isLegacyEmail = (email: unknown): boolean => {
        if (typeof email !== 'string' || !email) return false;
        const norm = email.trim().toLowerCase();
        const fnv = (seed: number) => {
          let h = seed >>> 0;
          for (let i = 0; i < norm.length; i++) {
            h ^= norm.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          return h.toString(16).padStart(8, '0');
        };
        return `${fnv(0x811c9dc5)}_${fnv(0x9e3779b9)}` === '21a02fd7_2c5a16f3';
      };
      if (isLegacyEmail(parsed.userEmail)) {
        parsed.userEmail = '';
        parsed.googleDriveLinked = false;
        parsed.permissionsGranted = false;
      }
      if (!parsed.storeName) {
        parsed.storeName = 'Cashier - إدارة حسابات المحلات';
      }
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        permissionsGranted: permGranted || Boolean(parsed.permissionsGranted),
      };
    } catch {
      return { ...DEFAULT_SETTINGS, permissionsGranted: permGranted };
    }
  },

  async saveSettings(settings: Partial<StoreSettings>): Promise<StoreSettings> {
    assertWriteNotFrozen('saveSettings');

    if (operationalSource === 'dexie') {
      const updated = await storageCacheAdapter.saveSettings(settings);
      notifyListeners();
      return updated;
    }

    // Legacy fallback
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    if (updated.permissionsGranted) {
      localStorage.setItem(STORAGE_KEYS.PERMISSIONS, 'true');
    }
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updated));
    notifyListeners();
    return updated;
  },

  // ---------- المنتجات ----------
  getProducts(q = ''): Product[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getProducts(q);
    }

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PRODUCTS) : null;
    let list: Product[] = raw ? JSON.parse(raw) : [];
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
  },

  getProductByBarcode(code: string): Product | null {
    if (!code) return null;
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getProductByBarcode(code);
    }
    const products = this.getProducts();
    const cleanCode = code.trim();
    return products.find((p) => p.barcode && p.barcode.trim() === cleanCode) || null;
  },

  getProductById(id: number): Product | null {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getProductById(id);
    }
    const products = this.getProducts();
    return products.find((p) => p.id === id) || null;
  },

  getCategories(): string[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getCategories();
    }

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.CATEGORIES) : null;
    let stored: string[] = [];
    if (raw) {
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = [...DEFAULT_CATEGORIES];
      }
    } else {
      stored = [...DEFAULT_CATEGORIES];
    }

    const set = new Set<string>(['عام', ...stored]);
    const products = this.getProducts();
    products.forEach((p) => {
      if (p.category && p.category.trim()) {
        set.add(p.category.trim());
      }
    });
    return Array.from(set);
  },

  async addCategory(name: string): Promise<string[]> {
    assertWriteNotFrozen('addCategory');
    if (operationalSource === 'dexie') {
      const updated = await storageCacheAdapter.addCategory(name);
      notifyListeners();
      return updated;
    }

    const clean = name.trim();
    if (!clean) return this.getCategories();
    const current = this.getCategories();
    if (!current.includes(clean)) {
      const updated = [...current, clean];
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(updated));
      notifyListeners();
      return updated;
    }
    return current;
  },

  async renameCategory(oldName: string, newName: string): Promise<string[]> {
    assertWriteNotFrozen('renameCategory');
    if (operationalSource === 'dexie') {
      const updated = await storageCacheAdapter.renameCategory(oldName, newName);
      notifyListeners();
      return updated;
    }

    const cleanOld = oldName.trim();
    const cleanNew = newName.trim();
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return this.getCategories();

    const current = this.getCategories();
    const updatedCats = current.map((c) => (c === cleanOld ? cleanNew : c));
    const uniqueCats = Array.from(new Set(['عام', ...updatedCats]));
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(uniqueCats));

    const rawProducts = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
    if (rawProducts) {
      try {
        const products: Product[] = JSON.parse(rawProducts);
        let changed = false;
        products.forEach((p) => {
          if ((p.category || 'عام').trim() === cleanOld) {
            p.category = cleanNew;
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
        }
      } catch {
        // ignore
      }
    }

    notifyListeners();
    return uniqueCats;
  },

  async deleteCategory(name: string): Promise<string[]> {
    assertWriteNotFrozen('deleteCategory');
    if (operationalSource === 'dexie') {
      const updated = await storageCacheAdapter.deleteCategory(name);
      notifyListeners();
      return updated;
    }

    const clean = name.trim();
    if (!clean || clean === 'عام') return this.getCategories();

    const current = this.getCategories().filter((c) => c !== clean);
    if (!current.includes('عام')) current.unshift('عام');
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(current));

    const rawProducts = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
    if (rawProducts) {
      try {
        const products: Product[] = JSON.parse(rawProducts);
        let changed = false;
        products.forEach((p) => {
          if ((p.category || '').trim() === clean) {
            p.category = 'عام';
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
        }
      } catch {
        // ignore
      }
    }

    notifyListeners();
    return current;
  },

  async saveProduct(productData: Partial<Product> & { name: string }): Promise<Product> {
    assertWriteNotFrozen('saveProduct');
    if (operationalSource === 'dexie') {
      const saved = await storageCacheAdapter.saveProduct(productData);
      notifyListeners();
      return saved;
    }

    const list = this.getProducts();
    const defaultCurrency = this.getSettings().currency || 'د.ع';
    let saved: Product;

    if (productData.id) {
      const idx = list.findIndex((p) => p.id === productData.id);
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          ...productData,
          name: productData.name.trim(),
          category: productData.category?.trim() || list[idx].category || 'عام',
          buy_price: Number(productData.buy_price) || 0,
          sell_price: Number(productData.sell_price) || 0,
          qty: Number(productData.qty) || 0,
          currency: productData.currency?.trim() || list[idx].currency || defaultCurrency,
          image: productData.image !== undefined ? productData.image : list[idx].image,
        };
        saved = list[idx];
      } else {
        throw new Error('المنتج غير موجود');
      }
    } else {
      const maxId = list.reduce((max, p) => Math.max(max, p.id), 0);
      saved = {
        id: maxId + 1,
        name: productData.name.trim(),
        barcode: productData.barcode?.trim() || '',
        category: productData.category?.trim() || 'عام',
        description: productData.description?.trim() || '',
        buy_price: Number(productData.buy_price) || 0,
        sell_price: Number(productData.sell_price) || 0,
        qty: Number(productData.qty) || 0,
        currency: productData.currency?.trim() || defaultCurrency,
        image: productData.image || undefined,
      };
      list.push(saved);
    }

    if (saved.category && saved.category.trim()) {
      const cats = this.getCategories();
      if (!cats.includes(saved.category.trim())) {
        localStorage.setItem(
          STORAGE_KEYS.CATEGORIES,
          JSON.stringify([...cats, saved.category.trim()])
        );
      }
    }

    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(list));
    notifyListeners();
    return saved;
  },

  async deleteProduct(id: number): Promise<void> {
    assertWriteNotFrozen('deleteProduct');
    if (operationalSource === 'dexie') {
      await storageCacheAdapter.deleteProduct(id);
      notifyListeners();
      return;
    }

    const list = this.getProducts().filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(list));
    notifyListeners();
  },

  async updateStockQuantity(productId: number, delta: number): Promise<void> {
    assertWriteNotFrozen('updateStockQuantity');
    if (operationalSource === 'dexie') {
      await storageCacheAdapter.updateStockQuantity(productId, delta);
      notifyListeners();
      return;
    }

    const list = this.getProducts();
    const item = list.find((p) => p.id === productId);
    if (item) {
      const nextQty = (item.qty || 0) + delta;
      if (nextQty < 0) {
        throw new Error(`الكمية المطلوبة من "${item.name}" تتجاوز الرصيد المتاح (${item.qty}).`);
      }
      item.qty = nextQty;
      localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(list));
      notifyListeners();
    }
  },

  // ---------- العملاء والموردين ----------
  getParties(type: 'customer' | 'supplier'): Party[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getParties(type);
    }

    const rawParties = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PARTIES) : null;
    const parties: Party[] = rawParties ? JSON.parse(rawParties) : [];

    const rawInvoices = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.INVOICES) : null;
    const invoices: Invoice[] = rawInvoices ? JSON.parse(rawInvoices) : [];

    const rawPayments = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PAYMENTS) : null;
    const payments: Payment[] = rawPayments ? JSON.parse(rawPayments) : [];

    return parties
      .filter((p) => p.type === type)
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
  },

  getPartyById(id: number): Party | null {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getPartyById(id);
    }
    const rawParties = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PARTIES) : null;
    const parties: Party[] = rawParties ? JSON.parse(rawParties) : [];
    return parties.find((p) => p.id === id) || null;
  },

  async addParty(name: string, phone: string, type: 'customer' | 'supplier'): Promise<Party> {
    assertWriteNotFrozen('addParty');
    if (operationalSource === 'dexie') {
      const saved = await storageCacheAdapter.addParty(name, phone, type);
      notifyListeners();
      return saved;
    }

    const raw = localStorage.getItem(STORAGE_KEYS.PARTIES);
    const list: Party[] = raw ? JSON.parse(raw) : [];
    const maxId = list.reduce((max, p) => Math.max(max, p.id), 0);
    const newParty: Party = {
      id: maxId + 1,
      name: name.trim(),
      phone: phone.trim(),
      type,
    };
    list.push(newParty);
    localStorage.setItem(STORAGE_KEYS.PARTIES, JSON.stringify(list));
    notifyListeners();
    return newParty;
  },

  async deleteParty(id: number): Promise<void> {
    assertWriteNotFrozen('deleteParty');
    if (operationalSource === 'dexie') {
      await storageCacheAdapter.deleteParty(id);
      notifyListeners();
      return;
    }

    const raw = localStorage.getItem(STORAGE_KEYS.PARTIES);
    const list: Party[] = raw ? JSON.parse(raw) : [];
    const filtered = list.filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEYS.PARTIES, JSON.stringify(filtered));
    notifyListeners();
  },

  async addPayment(partyId: number, amount: number, notes?: string, currency?: string): Promise<Payment> {
    assertWriteNotFrozen('addPayment');
    if (operationalSource === 'dexie') {
      const saved = await storageCacheAdapter.addPayment(partyId, amount, notes, currency);
      notifyListeners();
      return saved;
    }

    const raw = localStorage.getItem(STORAGE_KEYS.PAYMENTS);
    const list: Payment[] = raw ? JSON.parse(raw) : [];
    const party = this.getPartyById(partyId);

    const maxId = list.reduce((max, p) => Math.max(max, p.id), 0);
    const payment: Payment = {
      id: maxId + 1,
      party_id: partyId,
      party_name: party?.name,
      amount: Number(amount) || 0,
      date: new Date().toISOString(),
      notes: notes?.trim(),
      currency: currency?.trim() || this.getSettings().currency || 'د.ع',
    };
    list.push(payment);
    localStorage.setItem(STORAGE_KEYS.PAYMENTS, JSON.stringify(list));
    notifyListeners();
    return payment;
  },

  getPartyHistory(partyId: number): { invoices: Invoice[]; payments: Payment[] } {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getPartyHistory(partyId);
    }
    const invoices = this.getInvoices().filter((inv) => inv.party_id === partyId);
    const rawPayments = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.PAYMENTS) : null;
    const allPayments: Payment[] = rawPayments ? JSON.parse(rawPayments) : [];
    const payments = allPayments.filter((p) => p.party_id === partyId);
    return { invoices, payments };
  },

  // ---------- المصروفات ----------
  getExpenses(q = ''): Expense[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getExpenses(q);
    }

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.EXPENSES) : null;
    let list: Expense[] = raw ? JSON.parse(raw) : [];
    if (q.trim()) {
      const query = q.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.recipient.toLowerCase().includes(query) ||
          (e.notes && e.notes.toLowerCase().includes(query))
      );
    }
    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  async addExpense(recipient: string, amount: number, date?: string, notes?: string, currency?: string): Promise<Expense> {
    assertWriteNotFrozen('addExpense');
    if (operationalSource === 'dexie') {
      const saved = await storageCacheAdapter.addExpense(recipient, amount, date, notes, currency);
      notifyListeners();
      return saved;
    }

    const list = this.getExpenses();
    const maxId = list.reduce((max, e) => Math.max(max, e.id), 0);
    const expense: Expense = {
      id: maxId + 1,
      recipient: recipient.trim(),
      amount: Number(amount) || 0,
      date: date || new Date().toISOString(),
      notes: notes?.trim(),
      currency: currency?.trim() || this.getSettings().currency || 'د.ع',
    };
    list.unshift(expense);
    localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(list));
    notifyListeners();
    return expense;
  },

  async deleteExpense(id: number): Promise<void> {
    assertWriteNotFrozen('deleteExpense');
    if (operationalSource === 'dexie') {
      await storageCacheAdapter.deleteExpense(id);
      notifyListeners();
      return;
    }

    const list = this.getExpenses().filter((e) => e.id !== id);
    localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(list));
    notifyListeners();
  },

  // ---------- الفواتير ----------
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
    assertWriteNotFrozen('saveInvoice');

    if (operationalSource === 'dexie') {
      const invoice = await storageCacheAdapter.saveInvoice(params);
      notifyListeners();
      return invoice;
    }

    // Legacy fallback
    const { type, partyId, items, discount, paid, currency } = params;
    const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const total = Math.max(0, subtotal - discount);

    let partyName: string | undefined;
    if (partyId) {
      const party = this.getPartyById(partyId);
      partyName = party?.name;
    } else if (type === 'sale' || type === 'sale_return' || type === 'quote') {
      partyName = 'مفرد';
    }

    const rawInvoices = localStorage.getItem(STORAGE_KEYS.INVOICES);
    const invoices: Invoice[] = rawInvoices ? JSON.parse(rawInvoices) : [];
    const maxInvId = invoices.reduce((max, inv) => Math.max(max, inv.id), 0);
    const invoiceId = maxInvId + 1;

    const newInvoice: Invoice = {
      id: invoiceId,
      type,
      party_id: partyId || null,
      party_name: partyName,
      date: new Date().toISOString(),
      discount,
      total,
      paid,
      currency: currency?.trim() || this.getSettings().currency || 'د.ع',
    };
    invoices.push(newInvoice);
    localStorage.setItem(STORAGE_KEYS.INVOICES, JSON.stringify(invoices));

    const rawItems = localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS);
    const allItems: InvoiceItem[] = rawItems ? JSON.parse(rawItems) : [];
    let nextItemId = allItems.reduce((max, it) => Math.max(max, it.id || 0), 0) + 1;

    for (const item of items) {
      allItems.push({
        id: nextItemId++,
        invoice_id: invoiceId,
        product_id: item.product_id,
        name: item.name,
        category: item.category,
        qty: Number(item.qty),
        price: Number(item.price),
        cost: Number(item.cost),
        sell_price: item.sell_price !== undefined ? Number(item.sell_price) : undefined,
        image: item.image,
      });
    }
    localStorage.setItem(STORAGE_KEYS.INVOICE_ITEMS, JSON.stringify(allItems));

    if (type !== 'quote') {
      const products = this.getProducts();
      if (type === 'sale') {
        const reqMap = new Map<number, number>();
        for (const item of items) {
          reqMap.set(item.product_id, (reqMap.get(item.product_id) || 0) + item.qty);
        }
        for (const [pid, qty] of reqMap.entries()) {
          const prod = products.find((p) => p.id === pid);
          if (!prod) throw new Error('المنتج غير موجود');
          if (qty > prod.qty) {
            throw new Error(`الكمية المطلوبة من "${prod.name}" (${qty}) تتجاوز الرصيد المتاح (${prod.qty}).`);
          }
        }
      }
      for (const item of items) {
        const prod = products.find((p) => p.id === item.product_id);
        if (prod) {
          if (type === 'sale') {
            prod.qty = prod.qty - item.qty;
          } else if (type === 'sale_return') {
            prod.qty = prod.qty + item.qty;
          } else if (type === 'purchase') {
            if (item.stockAlreadyAdded) {
              const diff = item.qty - (item.initialAddedQty || 0);
              const nextQty = prod.qty + diff;
              if (nextQty < 0) {
                throw new Error(`الكمية المطلوبة من "${prod.name}" تتجاوز الرصيد المتاح.`);
              }
              prod.qty = nextQty;
            } else {
              prod.qty = prod.qty + item.qty;
            }
            prod.buy_price = item.price;
            if (item.sell_price !== undefined && item.sell_price > 0) {
              prod.sell_price = item.sell_price;
            }
            if (item.category) prod.category = item.category;
            if (item.image) prod.image = item.image;
          }
        }
      }
      localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    }

    notifyListeners();
    return newInvoice;
  },

  canEditCurrentUserInvoices(): boolean {
    const role = this.getSettings().userRole || 'owner';
    return role !== 'cashier';
  },

  async canEditInvoice(id: number): Promise<{ canEdit: boolean; reason?: string; invoice?: Invoice }> {
    if (!this.canEditCurrentUserInvoices()) {
      return {
        canEdit: false,
        reason: 'ليس لديك صلاحية لتعديل الفواتير المحفوظة. يرجى مراجعة مدير النظام.',
      };
    }
    if (operationalSource === 'dexie') {
      return storageCacheAdapter.canEditInvoice(id);
    }
    const inv = this.getInvoiceById(id);
    if (!inv) return { canEdit: false, reason: 'الفاتورة غير موجودة.' };
    if (inv.type !== 'sale' && inv.type !== 'purchase') {
      return { canEdit: false, reason: 'تعديل الفواتير متاح لفواتير البيع والشراء فقط.', invoice: inv };
    }
    return { canEdit: true, invoice: inv };
  },

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
    assertWriteNotFrozen('updateInvoice');
    const resolvedRole = params.actorRole || this.getSettings().userRole || 'owner';
    if (operationalSource === 'dexie') {
      const updated = await storageCacheAdapter.updateInvoice({
        ...params,
        actorRole: resolvedRole,
      });
      notifyListeners();
      return updated;
    }
    throw new Error('تعديل الفواتير مدعوم عبر محرك Dexie فقط.');
  },

  async deleteInvoice(id: number): Promise<void> {
    assertWriteNotFrozen('deleteInvoice');

    if (operationalSource === 'dexie') {
      await storageCacheAdapter.deleteInvoice(id);
      notifyListeners();
      return;
    }

    const rawInvoices = localStorage.getItem(STORAGE_KEYS.INVOICES);
    const invoices: Invoice[] = rawInvoices ? JSON.parse(rawInvoices) : [];
    const target = invoices.find((inv) => inv.id === id);
    if (!target) return;

    const rawItems = localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS);
    const allItems: InvoiceItem[] = rawItems ? JSON.parse(rawItems) : [];
    const invoiceItems = allItems.filter((it) => it.invoice_id === id);

    if (target.type !== 'quote' && invoiceItems.length > 0) {
      const products = this.getProducts();
      for (const it of invoiceItems) {
        const prod = products.find((p) => p.id === it.product_id);
        if (prod) {
          if (target.type === 'sale') {
            prod.qty = prod.qty + it.qty;
          } else if (target.type === 'purchase' || target.type === 'sale_return') {
            prod.qty = Math.max(0, prod.qty - it.qty);
          }
        }
      }
      localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    }

    localStorage.setItem(
      STORAGE_KEYS.INVOICES,
      JSON.stringify(invoices.filter((inv) => inv.id !== id))
    );
    localStorage.setItem(
      STORAGE_KEYS.INVOICE_ITEMS,
      JSON.stringify(allItems.filter((it) => it.invoice_id !== id))
    );

    notifyListeners();
  },

  getInvoices(type?: InvoiceType): Invoice[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getInvoices(type);
    }

    const rawInvoices = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.INVOICES) : null;
    let invoices: Invoice[] = rawInvoices ? JSON.parse(rawInvoices) : [];
    if (type) {
      invoices = invoices.filter((inv) => inv.type === type);
    }
    return invoices.sort((a, b) => b.id - a.id);
  },

  getInvoiceById(id: number): Invoice | null {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getInvoiceById(id);
    }
    const invoices = this.getInvoices();
    return invoices.find((inv) => inv.id === id) || null;
  },

  getInvoiceItems(invoiceId: number): InvoiceItem[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getInvoiceItems(invoiceId);
    }
    const rawItems = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS) : null;
    const allItems: InvoiceItem[] = rawItems ? JSON.parse(rawItems) : [];
    return allItems.filter((it) => it.invoice_id === invoiceId);
  },

  // ---------- الفواتير المعلقة (Held Invoices) ----------
  getHeldInvoices(typeKey: string): any[] {
    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      return storageCacheAdapter.getHeldInvoices(typeKey);
    }
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(typeKey) : null;
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async saveHeldInvoices(typeKey: string, list: any[]): Promise<void> {
    assertWriteNotFrozen('saveHeldInvoices');
    if (operationalSource === 'dexie') {
      await storageCacheAdapter.saveHeldInvoices(typeKey, list);
      notifyListeners();
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(typeKey, JSON.stringify(list));
      notifyListeners();
    }
  },

  // ---------- التقارير ----------
  getReport(from: Date, to: Date): ReportData {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const invoices = this.getInvoices().filter((inv) => inv.date >= fromIso && inv.date <= toIso);
    let allItems: InvoiceItem[] = [];

    if (operationalSource === 'dexie' && storageCacheAdapter.isReady()) {
      allItems = storageCacheAdapter.getAllInvoiceItems();
    } else {
      const rawItems = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS) : null;
      allItems = rawItems ? JSON.parse(rawItems) : [];
    }

    const saleInvoices = invoices.filter((inv) => inv.type === 'sale');
    const purchaseInvoices = invoices.filter((inv) => inv.type === 'purchase');
    const returnInvoices = invoices.filter((inv) => inv.type === 'sale_return');
    const quoteInvoices = invoices.filter((inv) => inv.type === 'quote');

    const saleInvoiceIds = new Set(saleInvoices.map((inv) => inv.id));
    const returnInvoiceIds = new Set(returnInvoices.map((inv) => inv.id));
    const saleItems = allItems.filter((it) => it.invoice_id && saleInvoiceIds.has(it.invoice_id));
    const returnItems = allItems.filter((it) => it.invoice_id && returnInvoiceIds.has(it.invoice_id));

    const grossSales = saleInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const returnsTotal = returnInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const sales = grossSales - returnsTotal;

    const grossSalesPaid = saleInvoices.reduce((sum, inv) => sum + (Number(inv.paid) || 0), 0);
    const returnsPaid = returnInvoices.reduce((sum, inv) => sum + (Number(inv.paid) || 0), 0);
    const collectedSales = grossSalesPaid - returnsPaid;
    const creditSalesRemaining = Math.max(0, sales - collectedSales);

    const purchases = purchaseInvoices.reduce((sum, inv) => sum + inv.total, 0);

    const itemsByInvoice = new Map<number, InvoiceItem[]>();
    for (const it of allItems) {
      if (!it.invoice_id) continue;
      const arr = itemsByInvoice.get(it.invoice_id);
      if (arr) {
        arr.push(it);
      } else {
        itemsByInvoice.set(it.invoice_id, [it]);
      }
    }

    let saleProfitTotal = 0;
    let collectedSaleProfit = 0;
    let deferredSaleProfit = 0;
    for (const inv of saleInvoices) {
      const invItems = itemsByInvoice.get(inv.id) || [];
      const invMargin = invItems.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0);
      const invProfit = invMargin - (inv.discount || 0);
      const ratio = inv.total > 0 ? Math.min(1, Math.max(0, (Number(inv.paid) || 0) / inv.total)) : 1;
      saleProfitTotal += invProfit;
      collectedSaleProfit += invProfit * ratio;
      deferredSaleProfit += invProfit * (1 - ratio);
    }

    let returnProfitTotal = 0;
    let collectedReturnProfit = 0;
    let deferredReturnProfit = 0;
    for (const inv of returnInvoices) {
      const invItems = itemsByInvoice.get(inv.id) || [];
      const invMargin = invItems.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0);
      const invProfit = invMargin - (inv.discount || 0);
      const ratio = inv.total > 0 ? Math.min(1, Math.max(0, (Number(inv.paid) || 0) / inv.total)) : 1;
      returnProfitTotal += invProfit;
      collectedReturnProfit += invProfit * ratio;
      deferredReturnProfit += invProfit * (1 - ratio);
    }

    const profit = saleProfitTotal - returnProfitTotal;
    const collectedProfit = collectedSaleProfit - collectedReturnProfit;
    const deferredProfit = deferredSaleProfit - deferredReturnProfit;

    const allExpenses = this.getExpenses();
    const expenses = allExpenses
      .filter((e) => e.date >= fromIso && e.date <= toIso)
      .reduce((sum, e) => sum + e.amount, 0);
    const netProfit = profit - expenses;

    const soldMap = new Map<string, number>();
    const profitMap = new Map<string, number>();

    for (const it of saleItems) {
      soldMap.set(it.name, (soldMap.get(it.name) || 0) + it.qty);
      profitMap.set(it.name, (profitMap.get(it.name) || 0) + (it.price - it.cost) * it.qty);
    }

    for (const it of returnItems) {
      soldMap.set(it.name, Math.max(0, (soldMap.get(it.name) || 0) - it.qty));
      profitMap.set(it.name, (profitMap.get(it.name) || 0) - (it.price - it.cost) * it.qty);
    }

    const topSold = Array.from(soldMap.entries())
      .filter(([, v]) => v > 0)
      .map(([name, v]) => ({ name, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);

    const topProfit = Array.from(profitMap.entries())
      .map(([name, v]) => ({ name, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);

    const allProducts = this.getProducts();
    const lowStock = allProducts.filter((p) => p.qty <= 5).slice(0, 10);
    const stockValue = allProducts.reduce((sum, p) => sum + p.qty * p.buy_price, 0);

    return {
      sales,
      purchases,
      expenses,
      profit,
      collectedProfit,
      deferredProfit,
      netProfit,
      collectedSales,
      creditSalesRemaining,
      stockValue,
      invoicesCount: saleInvoices.length + purchaseInvoices.length + returnInvoices.length,
      salesInvoicesCount: saleInvoices.length,
      purchasesInvoicesCount: purchaseInvoices.length,
      returnsInvoicesCount: returnInvoices.length,
      quotesCount: quoteInvoices.length,
      topSold,
      topProfit,
      lowStock,
    };
  },

  // ---------- النسخ الاحتياطي والاسترجاع المطور (Phase 7A Dexie Engine) ----------
  async createFullBackup(type: 'manual' | 'daily_auto' | 'pre_restore_safety' = 'manual', customLabel?: string) {
    const { createFullDexieBackup } = await import('./storage/backup/dexieBackupEngine');
    return createFullDexieBackup(undefined, type, customLabel);
  },

  async listHistoricalBackups() {
    const { listHistoricalBackups } = await import('./storage/backup/dexieBackupEngine');
    return listHistoricalBackups();
  },

  async deleteHistoricalBackup(id: string) {
    const { deleteHistoricalBackup } = await import('./storage/backup/dexieBackupEngine');
    return deleteHistoricalBackup(id);
  },

  async validateBackupInSandbox(content: string | object) {
    const { validateBackupInSandbox } = await import('./storage/backup/dexieBackupEngine');
    return validateBackupInSandbox(content);
  },

  async restoreDexieBackupSafely(content: string | object) {
    assertWriteNotFrozen('restoreDexieBackupSafely');
    const { restoreDexieBackupSafely } = await import('./storage/backup/dexieBackupEngine');
    const res = await restoreDexieBackupSafely(content);
    notifyListeners();
    return res;
  },

  async checkAndRunDailyAutoBackup() {
    const { checkAndRunDailyAutoBackup } = await import('./storage/backup/dexieBackupEngine');
    return checkAndRunDailyAutoBackup();
  },

  backupData(): string {
    const backupObj = {
      version: operationalSource === 'dexie' ? '2.0-dexie' : '1.0-legacy',
      source: operationalSource,
      timestamp: new Date().toISOString(),
      settings: this.getSettings(),
      products: this.getProducts(),
      parties: this.getParties('customer').concat(this.getParties('supplier')),
      invoices: this.getInvoices(),
      invoice_items: operationalSource === 'dexie' && storageCacheAdapter.isReady()
        ? storageCacheAdapter.getAllInvoiceItems()
        : (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS) ? JSON.parse(localStorage.getItem(STORAGE_KEYS.INVOICE_ITEMS)!) : []),
      payments: operationalSource === 'dexie' && storageCacheAdapter.isReady()
        ? storageCacheAdapter.getAllPayments()
        : (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.PAYMENTS) ? JSON.parse(localStorage.getItem(STORAGE_KEYS.PAYMENTS)!) : []),
      expenses: this.getExpenses(),
    };
    return JSON.stringify(backupObj, null, 2);
  },

  async restoreDataAsync(jsonStr: string): Promise<boolean> {
    assertWriteNotFrozen('restoreDataAsync');
    try {
      const data = JSON.parse(jsonStr);
      if (data && data.format === 'CashierProCompleteDexieBackup' && data.data) {
        if (operationalSource === 'dexie') {
          const ok = await storageCacheAdapter.restoreSnapshotAsync(data);
          notifyListeners();
          return ok;
        }
      }

      if (!data || !Array.isArray(data.products)) {
        throw new Error('ملف النسخة الاحتياطية غير صالح');
      }

      if (operationalSource === 'dexie') {
        const ok = await storageCacheAdapter.restoreSnapshotAsync(data);
        notifyListeners();
        return ok;
      }

      if (data.settings) localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(data.settings));
      if (Array.isArray(data.products)) localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(data.products));
      if (Array.isArray(data.parties)) localStorage.setItem(STORAGE_KEYS.PARTIES, JSON.stringify(data.parties));
      if (Array.isArray(data.invoices)) localStorage.setItem(STORAGE_KEYS.INVOICES, JSON.stringify(data.invoices));
      if (Array.isArray(data.invoice_items)) localStorage.setItem(STORAGE_KEYS.INVOICE_ITEMS, JSON.stringify(data.invoice_items));
      if (Array.isArray(data.payments)) localStorage.setItem(STORAGE_KEYS.PAYMENTS, JSON.stringify(data.payments));
      if (Array.isArray(data.expenses)) localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(data.expenses));

      notifyListeners();
      return true;
    } catch (e) {
      console.error('Failed to restore backup:', e);
      return false;
    }
  },

  restoreData(jsonStr: string): boolean {
    assertWriteNotFrozen('restoreData');
    try {
      const data = JSON.parse(jsonStr);
      const isCompleteBackup = Boolean(data && data.format === 'CashierProCompleteDexieBackup' && data.data);
      if (!isCompleteBackup && (!data || !Array.isArray(data.products))) {
        throw new Error('ملف النسخة الاحتياطية غير صالح');
      }

      if (operationalSource === 'dexie') {
        storageCacheAdapter
          .restoreSnapshotAsync(data)
          .then(() => notifyListeners())
          .catch((err) => {
            console.error('Background restoreData failed:', err);
          });
        return true;
      }

      if (data.settings) localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(data.settings));
      if (Array.isArray(data.products)) localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(data.products));
      if (Array.isArray(data.parties)) localStorage.setItem(STORAGE_KEYS.PARTIES, JSON.stringify(data.parties));
      if (Array.isArray(data.invoices)) localStorage.setItem(STORAGE_KEYS.INVOICES, JSON.stringify(data.invoices));
      if (Array.isArray(data.invoice_items)) localStorage.setItem(STORAGE_KEYS.INVOICE_ITEMS, JSON.stringify(data.invoice_items));
      if (Array.isArray(data.payments)) localStorage.setItem(STORAGE_KEYS.PAYMENTS, JSON.stringify(data.payments));
      if (Array.isArray(data.expenses)) localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(data.expenses));

      notifyListeners();
      return true;
    } catch (e) {
      console.error('Failed to restore backup:', e);
      return false;
    }
  },

  resetToDefault() {
    assertWriteNotFrozen('resetToDefault');
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(INITIAL_PRODUCTS));
    localStorage.setItem(STORAGE_KEYS.PARTIES, JSON.stringify(INITIAL_PARTIES));

    const initialInvoices: Invoice[] = [
      {
        id: 1,
        type: 'sale',
        party_id: null,
        party_name: 'مفرد',
        date: new Date().toISOString(),
        discount: 0,
        total: 15000.0,
        paid: 15000.0,
      },
      {
        id: 2,
        type: 'purchase',
        party_id: 4,
        party_name: 'شركة التوريدات الرئيسية',
        date: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        discount: 0,
        total: 10000.0,
        paid: 10000.0,
      },
    ];

    const initialInvoiceItems: InvoiceItem[] = [
      {
        id: 1,
        invoice_id: 1,
        product_id: 1,
        name: 'Lcd iph 11 pro max',
        qty: 1,
        price: 15000.0,
        cost: 10000.0,
      },
      {
        id: 2,
        invoice_id: 2,
        product_id: 1,
        name: 'Lcd iph 11 pro max',
        qty: 1,
        price: 10000.0,
        cost: 10000.0,
      },
    ];

    const initialPayments: Payment[] = [];
    const initialExpenses: Expense[] = [
      {
        id: 1,
        recipient: 'فاتورة كهرباء وإنترنت',
        amount: 250,
        date: new Date().toISOString(),
        notes: 'مصروف دوري للمحل',
      },
    ];

    localStorage.setItem(STORAGE_KEYS.INVOICES, JSON.stringify(initialInvoices));
    localStorage.setItem(STORAGE_KEYS.INVOICE_ITEMS, JSON.stringify(initialInvoiceItems));
    localStorage.setItem(STORAGE_KEYS.PAYMENTS, JSON.stringify(initialPayments));
    localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(initialExpenses));

    notifyListeners();
  },
};

// Forward StorageCacheAdapter updates to subscribers
storageCacheAdapter.subscribe(() => {
  notifyListeners();
});
