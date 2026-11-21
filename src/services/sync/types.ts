/**
 * Cashier Pro — Multi-Device & Cloud Sync Architecture Types
 * Phase 8A / Phase 9 Architecture
 */

export type SyncStatus = 'pending' | 'synced' | 'failed' | 'conflict';

export type SyncAction = 'create' | 'update' | 'delete' | 'stock_change' | 'void';

export type SyncTable =
  | 'products'
  | 'parties'
  | 'invoices'
  | 'invoice_items'
  | 'payments'
  | 'expenses'
  | 'categories'
  | 'settings';

export type UserRole = 'owner' | 'manager' | 'cashier';

export interface DeviceMetadata {
  deviceId: string;
  storeId: string;
  label: string;
  platform: 'android' | 'windows' | 'web' | 'ios';
  status: 'active' | 'revoked' | 'pending';
  registeredAt: string;
  lastSyncAt?: string;
  lastIp?: string;
}

export interface SyncQueueItem {
  idempotencyKey: string;     // Unique cryptographic hash of (deviceId + clientSeq + recordUuid + action)
  deviceId: string;
  storeId: string;
  seq: number;
  table: SyncTable;
  action: SyncAction;
  recordUuid: string;
  status: SyncStatus;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  clientTimestamp: string;
  serverTimestamp?: string;
  dataPayload: Record<string, any>;
  version: number;             // OCC Version number
}

export interface ConflictRecord {
  id: string;
  table: SyncTable;
  recordUuid: string;
  localVersion: number;
  remoteVersion: number;
  localData: Record<string, any>;
  remoteData: Record<string, any>;
  resolvedData?: Record<string, any>;
  resolutionStrategy: 'last_write_wins' | 'field_merge' | 'manual_owner_override';
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface SyncEngineMetrics {
  totalQueued: number;
  totalSynced: number;
  totalFailed: number;
  totalConflicts: number;
  isOnline: boolean;
  isSyncing: boolean;
  lastSuccessfulSync?: string;
}

export interface InventoryBalance {
  productId: number;
  productUuid: string;
  physicalStock: number;      // الرصيد الفعلي المتواجد في المخزن
  availableStock: number;     // الكمية المتاحة للبيع فورياً
  reservedStock: number;      // الكمية المحجوزة في فواتير معلقة
  conflictDeficit: number;    // العجز الفعلي الناتج عن بيع تعارضي دون رصيد
  version: number;
  updatedAt: string;
}

export type ReconciliationStatus =
  | 'pending_review'
  | 'resolved_by_restock'
  | 'resolved_by_adjustment'
  | 'resolved_by_return'
  | 'resolved_by_void';

export interface ReconciliationRecord {
  id: string;                 // e.g. rec_1731400000_abc
  storeId: string;
  productId: number;
  productUuid: string;
  productName: string;
  invoiceId: number | string;
  invoiceUuid: string;
  invoiceNumber: string;
  deviceId: string;
  requestedQty: number;       // الكمية المطلوبة والمباعة في الفاتورة
  availableQtyAtSync: number; // الكمية المتاحة في السحابة وقت المزامنة
  deficitQty: number;         // مقدار العجز (requestedQty - availableQtyAtSync)
  detectedAt: string;         // تاريخ ووقت الاكتشاف
  status: ReconciliationStatus;
  resolvedBy?: string;        // هوية المسؤول عن التسوية (مدير/مالك)
  resolvedAt?: string;
  resolutionNotes?: string;
  resolutionAction?: string;
}

