export interface Product {
  id: number;
  name: string;
  barcode: string;
  category: string;
  description: string;
  buy_price: number;
  sell_price: number;
  qty: number;
  currency?: string;
  image?: string; // Base64 compressed image or URL
}

export type PartyType = 'customer' | 'supplier';

export interface Party {
  id: number;
  name: string;
  phone: string;
  type: PartyType;
  balance?: number; // Calculated: debts - payments
}

export type InvoiceType = 'sale' | 'purchase' | 'sale_return' | 'quote';

export interface InvoiceItem {
  id?: number;
  invoice_id?: number;
  product_id: number;
  name: string;
  category?: string;
  image?: string;
  qty: number;
  price: number;
  sell_price?: number;
  cost: number;
  stockAlreadyAdded?: boolean;
  initialAddedQty?: number;
}

export interface Invoice {
  id: number;
  type: InvoiceType;
  party_id?: number | null;
  party_name?: string;
  date: string;
  discount: number;
  total: number;
  paid: number;
  currency?: string;
  invoice_number?: string;
  idempotencyKey?: string;
  notes?: string;
  original_invoice_id?: number;
}

export interface Payment {
  id: number;
  party_id: number;
  party_name?: string;
  amount: number;
  date: string;
  notes?: string;
  currency?: string;
}

export interface Expense {
  id: number;
  recipient: string; // جهة الصرف
  amount: number;
  date: string;
  notes?: string;
  currency?: string;
}

export interface ReportData {
  sales: number;
  purchases: number;
  expenses: number;
  profit: number; // الربح المحاسبي الاستحقاقي (هامش المبيعات - الخصومات - هامش المرتجعات)
  collectedProfit?: number; // الربح المحصل نقداً بناءً على المبالغ المقبوضة فعلياً في الفواتير
  deferredProfit?: number; // أرباح آجلة غير محصلة ضمن ذمم العملاء
  netProfit?: number; // صافي الربح المحاسبي بعد خصم المصروفات
  collectedSales?: number; // النقد المحصل من المبيعات
  creditSalesRemaining?: number; // المتبقي الآجل على المبيعات
  stockValue: number;
  invoicesCount: number;
  salesInvoicesCount?: number;
  purchasesInvoicesCount?: number;
  returnsInvoicesCount?: number;
  quotesCount?: number;
  topSold: { name: string; v: number }[];
  topProfit: { name: string; v: number }[];
  lowStock: Product[];
}

export interface StoreSettings {
  storeName: string;
  phone: string;
  address: string;
  currency: string;
  exchangeRate?: number; // سعر صرف الدولار مقابل الدينار العراقي (مثال: 1500)
  taxRate: number; // percentage, e.g. 0 or 15
  receiptFooter: string;
  googleDriveLinked?: boolean;
  driveAccountEmail?: string;
  driveLastBackupAt?: string;
  userEmail?: string;
  firebaseLinked?: boolean;
  firebaseAccountEmail?: string;
  firebaseLastSyncAt?: string;
  firebaseProjectId?: string;
  fontFamily?: string;
  fontSize?: number; // root font size in px (default 16)
  productsFontSize?: number; // products list font size in px (default 15)
  theme?: 'light' | 'dark';
  permissionsGranted?: boolean;
  backupCustomFolder?: string;
  userRole?: 'owner' | 'admin' | 'manager' | 'cashier';
}

export type ScreenId =
  | 'home'
  | 'sale'
  | 'purchase'
  | 'sale_return'
  | 'quote'
  | 'products'
  | 'customers'
  | 'suppliers'
  | 'invoices_sale'
  | 'invoices_purchase'
  | 'invoices_return'
  | 'invoices_quote'
  | 'accounts'
  | 'expenses'
  | 'settings'
  | 'backup';
