import {
  Product,
  Party,
  Invoice,
  InvoiceItem,
  Payment,
  Expense,
  StoreSettings,
  InvoiceType,
  PartyType,
} from '../../types';

export type { InvoiceType, PartyType };

export class ConcurrencyConflictError extends Error {
  constructor(
    public entity: string,
    public id: number | string,
    public expectedVersion: number,
    public currentVersion: number,
    public currentState: any
  ) {
    super(
      `تعارض في تعديل ${entity} (المعرف: ${id}): الإصدار الحالي هو ${currentVersion} بينما الإصدار المتوقع هو ${expectedVersion}. تم تعديل السجل بواسطة مستخدم أو نافذة أخرى.`
    );
    this.name = 'ConcurrencyConflictError';
  }
}

export class InsufficientStockError extends Error {
  constructor(
    public productId: number,
    public productName: string,
    public requestedQty: number,
    public availableQty: number
  ) {
    super(
      `الكمية المطلوبة من "${productName}" (${requestedQty}) تتجاوز الرصيد المتاح في المخزن (${availableQty}).`
    );
    this.name = 'InsufficientStockError';
  }
}

export interface StorageProduct extends Product {
  uuid: string;
  version?: number;
  updatedAt: string;
  isDeleted?: boolean;
}

export interface StorageParty extends Party {
  uuid: string;
  version?: number;
  updatedAt: string;
  isDeleted?: boolean;
}

export interface StorageInvoice extends Invoice {
  uuid: string;
  idempotencyKey?: string;
  invoice_number: string; // Separate user-facing invoice identifier (e.g. "INV-1" or "1")
  updatedAt: string;
  isDeleted?: boolean;
  notes?: string;
  original_invoice_id?: number;
}

export interface StorageInvoiceItem extends InvoiceItem {
  uuid: string;
  updatedAt: string;
}

export interface StoragePayment extends Payment {
  uuid: string;
  updatedAt: string;
  isDeleted?: boolean;
}

export interface StorageExpense extends Expense {
  uuid: string;
  updatedAt: string;
  isDeleted?: boolean;
}

export interface StorageHeldInvoice {
  id: string; // Key e.g. "hold_1731165000"
  uuid: string;
  type: InvoiceType;
  time: string;
  partyId: number | null;
  partyName: string;
  items: InvoiceItem[];
  discount: number;
  updatedAt: string;
}

export interface StorageProductImage {
  id?: number;
  uuid: string;
  productId: number;
  blob?: Blob;
  base64?: string;
  mimeType: string;
  updatedAt: string;
  // Multi-tier storage fields (Phase 16)
  originalImage?: string;
  optimizedImage?: string;
  thumbnail?: string;
  originalWidth?: number;
  originalHeight?: number;
  optimizedWidth?: number;
  optimizedHeight?: number;
  originalSizeBytes?: number;
  optimizedSizeBytes?: number;
  thumbnailSizeBytes?: number;
  checksum?: string;
  isDeleted?: boolean;
}


export interface StorageAuditLog {
  id?: number;
  uuid: string;
  action: 'create' | 'update' | 'delete' | 'void' | 'restore';
  entity: 'product' | 'invoice' | 'party' | 'payment' | 'expense' | 'setting';
  entityId: string | number;
  timestamp: string;
  details?: Record<string, any>;
}

export interface StorageMigrationState {
  key: string;
  value: any;
  timestamp: string;
}

export interface StorageQuotaInfo {
  supported: boolean;
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
  persisted: boolean;
}

export interface ChangeJournalEntry {
  seq?: number; // Monotonically increasing sequence number
  operationId: string; // Unique UUID of the operation
  table: string; // Target table e.g. 'products', 'invoices', 'payments', etc.
  action: 'create' | 'update' | 'delete' | 'void' | 'stock_change';
  recordId: number | string;
  recordUuid?: string;
  timestamp: string;
  beforeState?: any;
  afterState?: any;
  diff?: any;
}

export interface StorageBackupRecord {
  id: string; // Unique identifier e.g. bkp_1731360000000_abc
  createdAt: string; // ISO timestamp
  type: 'manual' | 'daily_auto' | 'pre_restore_safety';
  label: string;
  fileName: string;
  checksum: string;
  totalRecords: number;
  tableCounts: Record<string, number>;
  sizeBytes: number;
  payloadJson: string; // Serialized snapshot including all tables, images, and change journal
}

