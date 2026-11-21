/**
 * Cashier Pro — Phase 14: Multi-Device Inventory Conflict & Reconciliation Engine
 *
 * محرك معالجة تعارض المخزون في المبيعات غير المتصلة (Offline)،
 * الفصل بين الرصيد الفعلي والمتاح والمحجوز والعجز،
 * وسجل التسوية الإدارية المستقل مع حماية Idempotency.
 */

import {
  InventoryBalance,
  ReconciliationRecord,
  ReconciliationStatus,
  SyncQueueItem,
  SyncTable,
  DeviceMetadata,
} from './types';
import { generateUUID } from '../storage/uuid';

export interface ProcessedSyncResult {
  success: boolean;
  duplicateIgnored?: boolean;
  reconciliationRequired: boolean;
  reconciliationRecord?: ReconciliationRecord;
  updatedBalance?: InventoryBalance;
  message: string;
}

export class InventoryConflictEngine {
  private storeId: string;
  // Product balances: productId -> InventoryBalance
  private inventoryBalances = new Map<number, InventoryBalance>();
  // Processed Idempotency Keys to prevent duplicate execution
  private processedIdempotencyKeys = new Map<string, { timestamp: string; result: ProcessedSyncResult }>();
  // Independent Administrative Reconciliation Ledger
  private reconciliationLedger: ReconciliationRecord[] = [];
  // Central Invoices Store (Preserves original invoices without silent mutations)
  private invoicesStore = new Map<string, Record<string, any>>();
  // Change Journal for mathematical audit and reconstruction
  private journal: Array<{
    seq: number;
    operationId: string;
    action: string;
    productId: number;
    qtyDelta: number;
    beforeBalance: InventoryBalance;
    afterBalance: InventoryBalance;
    timestamp: string;
    deviceId: string;
    invoiceNumber?: string;
  }> = [];
  private journalSeq = 0;

  constructor(storeId = 'store_main') {
    this.storeId = storeId;
  }

  /**
   * تهيئة أو إدخال رصيد صنف مبدئي
   */
  initializeProductStock(productId: number, productUuid: string, initialQty: number): InventoryBalance {
    const balance: InventoryBalance = {
      productId,
      productUuid,
      physicalStock: Math.max(0, initialQty),
      availableStock: Math.max(0, initialQty),
      reservedStock: 0,
      conflictDeficit: 0,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    this.inventoryBalances.set(productId, balance);
    return { ...balance };
  }

  getProductBalance(productId: number): InventoryBalance | undefined {
    const b = this.inventoryBalances.get(productId);
    return b ? { ...b } : undefined;
  }

  /**
   * معالجة عملية بيع قادمة من جهاز (مزامنة أو محلية)
   * تمنع المخزون السالب الصامت وتوثق العجز بشفافية
   */
  processSaleOperation(params: {
    idempotencyKey: string;
    deviceId: string;
    invoiceUuid: string;
    invoiceNumber: string;
    productId: number;
    productUuid: string;
    productName: string;
    requestedQty: number;
    invoicePayload: Record<string, any>;
  }): ProcessedSyncResult {
    // 1. فحص منع التكرار (Idempotency Guard)
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      const prev = this.processedIdempotencyKeys.get(params.idempotencyKey)!;
      return {
        ...prev.result,
        duplicateIgnored: true,
        message: 'تم تجاهل العملية لتكرار مفتاح Idempotency وحماية الحسابات من التكرار',
      };
    }

    let balance = this.inventoryBalances.get(params.productId);
    if (!balance) {
      // صنف غير معرف مسبقاً، يُنشأ برصيد 0
      balance = this.initializeProductStock(params.productId, params.productUuid, 0);
    }

    const beforeState: InventoryBalance = { ...balance };
    let reconciliationRequired = false;
    let recRecord: ReconciliationRecord | undefined;

    // 2. فحص الكمية المتاحة والكشف عن تعارض المخزون
    if (balance.availableStock >= params.requestedQty) {
      // توفر كامل للكمية المطلوبة (بيع طبيعي دون تعارض)
      balance.physicalStock -= params.requestedQty;
      balance.availableStock -= params.requestedQty;
      balance.version++;
      balance.updatedAt = new Date().toISOString();

      // حفظ الفاتورة الأصلية كما هي
      const storedInvoice = {
        ...params.invoicePayload,
        reconciliation_required: false,
        reconciliation_status: 'none',
        syncedAt: new Date().toISOString(),
      };
      this.invoicesStore.set(params.invoiceUuid, storedInvoice);
    } else {
      // ⚠️ حدوث تعارض وعجز مخزني ناتج عن بيع متزامن Offline!
      // لا نخفي العجز بتثبيت الرصيد عند الصفر، ولا نتركه سالباً مبهماً.
      reconciliationRequired = true;

      const availableAtSync = Math.max(0, balance.availableStock);
      const deficitQty = params.requestedQty - availableAtSync;

      // تحديث الأرصدة: نفاد المتاح، واحتساب العجز الفعلي
      balance.physicalStock = Math.max(0, balance.physicalStock - availableAtSync);
      balance.availableStock = 0;
      balance.conflictDeficit += deficitQty; // إبقاء العجز ظاهراً ومحسوباً بدقة
      balance.version++;
      balance.updatedAt = new Date().toISOString();

      // إنشاء سجل التسوية الإداري المستقل
      recRecord = {
        id: `rec_${Date.now()}_${generateUUID().substring(0, 6)}`,
        storeId: this.storeId,
        productId: params.productId,
        productUuid: params.productUuid,
        productName: params.productName,
        invoiceId: params.invoicePayload.id || params.invoiceUuid,
        invoiceUuid: params.invoiceUuid,
        invoiceNumber: params.invoiceNumber,
        deviceId: params.deviceId,
        requestedQty: params.requestedQty,
        availableQtyAtSync: availableAtSync,
        deficitQty,
        detectedAt: new Date().toISOString(),
        status: 'pending_review',
        resolutionNotes: 'تم بيع كمية تتجاوز الرصيد المتاح أثناء انقطاع اتصال أجهزة متعددة',
      };
      this.reconciliationLedger.push(recRecord);

      // حفظ الفاتورة الأصلية مع وسم الحاجة للتسوية الإدارية دون تعديل مبالغها المالية
      const storedInvoice = {
        ...params.invoicePayload,
        reconciliation_required: true,
        reconciliation_status: 'pending_review',
        reconciliation_id: recRecord.id,
        deficit_qty: deficitQty,
        syncedAt: new Date().toISOString(),
      };
      this.invoicesStore.set(params.invoiceUuid, storedInvoice);
    }

    // 3. توثيق العملية في سجل الحركات (Change Journal)
    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: reconciliationRequired ? 'sale_with_conflict_deficit' : 'sale',
      productId: params.productId,
      qtyDelta: -params.requestedQty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: params.deviceId,
      invoiceNumber: params.invoiceNumber,
    });

    const result: ProcessedSyncResult = {
      success: true,
      reconciliationRequired,
      reconciliationRecord: recRecord,
      updatedBalance: { ...balance },
      message: reconciliationRequired
        ? `تم رصد عجز مقداره ${recRecord?.deficitQty} قطعة وإنشاء سجل تسوية إداري`
        : 'تم خصم المخزون بنجاح ومزامنة الفاتورة',
    };

    // حفظ نتيجة العملية لمنع التكرار
    this.processedIdempotencyKeys.set(params.idempotencyKey, {
      timestamp: new Date().toISOString(),
      result,
    });

    return result;
  }

  /**
   * معالجة مشتريات أو إدخال بضاعة جديدة (Restock) وتسوية العجز تلقائياً
   */
  processPurchaseOrRestock(params: {
    idempotencyKey: string;
    productId: number;
    addedQty: number;
    supplierInvoiceNum?: string;
  }): ProcessedSyncResult {
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      return {
        success: true,
        duplicateIgnored: true,
        reconciliationRequired: false,
        message: 'تم تجاهل عملية الشراء لتكرار المفتاح',
      };
    }

    const balance = this.inventoryBalances.get(params.productId);
    if (!balance) {
      throw new Error(`المنتج ${params.productId} غير موجود`);
    }

    const beforeState: InventoryBalance = { ...balance };
    let remainingAdded = params.addedQty;

    // تسوية العجز المتراكم تلقائياً إن وجد
    if (balance.conflictDeficit > 0) {
      const deficitToCover = Math.min(balance.conflictDeficit, remainingAdded);
      balance.conflictDeficit -= deficitToCover;
      remainingAdded -= deficitToCover;

      // تحديث سجلات التسوية المعلقة للصنف
      for (const rec of this.reconciliationLedger) {
        if (rec.productId === params.productId && rec.status === 'pending_review') {
          rec.status = 'resolved_by_restock';
          rec.resolvedAt = new Date().toISOString();
          rec.resolvedBy = 'auto_restock_sync';
          rec.resolutionAction = `تمت تغطية العجز بتوريد شحنة جديدة (فاتورة: ${params.supplierInvoiceNum || 'توريد عام'})`;
        }
      }
    }

    balance.physicalStock += params.addedQty;
    balance.availableStock += remainingAdded;
    balance.version++;
    balance.updatedAt = new Date().toISOString();

    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: 'restock_purchase',
      productId: params.productId,
      qtyDelta: params.addedQty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: 'warehouse_manager',
    });

    const result: ProcessedSyncResult = {
      success: true,
      reconciliationRequired: false,
      updatedBalance: { ...balance },
      message: `تم توريد ${params.addedQty} قطعة وتسوية العجز المتراكم بنجاح`,
    };

    this.processedIdempotencyKeys.set(params.idempotencyKey, {
      timestamp: new Date().toISOString(),
      result,
    });

    return result;
  }

  /**
   * معالجة مرتجع مبيعات (Return / Refund)
   */
  processSaleReturn(params: {
    idempotencyKey: string;
    invoiceUuid: string;
    productId: number;
    returnedQty: number;
  }): ProcessedSyncResult {
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      return { success: true, duplicateIgnored: true, reconciliationRequired: false, message: 'مكرر' };
    }

    const balance = this.inventoryBalances.get(params.productId);
    if (!balance) throw new Error('المنتج غير موجود');

    const beforeState = { ...balance };

    // إذا كانت هناك تسوية معلقة لنفس الفاتورة، يُحل العجز بالمرتجع أولاً ثم الفائض يعود للمخزون
    const pendingRec = this.reconciliationLedger.find(
      (r) => r.invoiceUuid === params.invoiceUuid && r.status === 'pending_review'
    );

    if (pendingRec && balance.conflictDeficit > 0) {
      const coveredDeficit = Math.min(balance.conflictDeficit, params.returnedQty);
      const excessToStock = params.returnedQty - coveredDeficit;
      pendingRec.status = 'resolved_by_return';
      pendingRec.resolvedAt = new Date().toISOString();
      pendingRec.resolvedBy = 'cashier_return_sync';
      pendingRec.resolutionAction = `تم إرجاع البضاعة من العميل وإلغاء العجز بمقدار ${coveredDeficit}`;
      balance.conflictDeficit -= coveredDeficit;
      balance.physicalStock += excessToStock;
      balance.availableStock += excessToStock;
    } else {
      balance.physicalStock += params.returnedQty;
      balance.availableStock += params.returnedQty;
    }

    balance.version++;
    balance.updatedAt = new Date().toISOString();

    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: 'sale_return',
      productId: params.productId,
      qtyDelta: params.returnedQty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: 'cashier_desk',
    });

    const result = {
      success: true,
      reconciliationRequired: false,
      updatedBalance: { ...balance },
      message: 'تم إرجاع الصنف بنجاح',
    };

    this.processedIdempotencyKeys.set(params.idempotencyKey, {
      timestamp: new Date().toISOString(),
      result,
    });

    return result;
  }

  /**
   * حجز كمية مؤقتاً لفاتورة معلقة (Held Invoice Reservation)
   * ينقل الكمية من availableStock إلى reservedStock مع بقاء physicalStock ثابتاً
   */
  reserveStockForHeldInvoice(params: {
    idempotencyKey: string;
    productId: number;
    qty: number;
    deviceId: string;
  }): ProcessedSyncResult {
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      return { success: true, duplicateIgnored: true, reconciliationRequired: false, message: 'مكرر' };
    }

    const balance = this.inventoryBalances.get(params.productId);
    if (!balance) throw new Error('المنتج غير موجود');
    if (balance.availableStock < params.qty) {
      return {
        success: false,
        reconciliationRequired: false,
        updatedBalance: { ...balance },
        message: 'الكمية المتاحة لا تكفي للحجز المعلق',
      };
    }

    const beforeState = { ...balance };
    balance.availableStock -= params.qty;
    balance.reservedStock += params.qty;
    balance.version++;
    balance.updatedAt = new Date().toISOString();

    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: 'reserve_hold',
      productId: params.productId,
      qtyDelta: params.qty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: params.deviceId,
    });

    const result: ProcessedSyncResult = {
      success: true,
      reconciliationRequired: false,
      updatedBalance: { ...balance },
      message: `تم حجز ${params.qty} قطعة للفاتورة المعلقة`,
    };
    this.processedIdempotencyKeys.set(params.idempotencyKey, { timestamp: new Date().toISOString(), result });
    return result;
  }

  /**
   * فك حجز الكمية عند إلغاء الفاتورة المعلقة
   */
  releaseReservedStock(params: {
    idempotencyKey: string;
    productId: number;
    qty: number;
    deviceId: string;
  }): ProcessedSyncResult {
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      return { success: true, duplicateIgnored: true, reconciliationRequired: false, message: 'مكرر' };
    }

    const balance = this.inventoryBalances.get(params.productId);
    if (!balance) throw new Error('المنتج غير موجود');

    const releaseQty = Math.min(balance.reservedStock, params.qty);
    const beforeState = { ...balance };
    balance.reservedStock -= releaseQty;
    balance.availableStock += releaseQty;
    balance.version++;
    balance.updatedAt = new Date().toISOString();

    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: 'release_hold',
      productId: params.productId,
      qtyDelta: releaseQty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: params.deviceId,
    });

    const result: ProcessedSyncResult = {
      success: true,
      reconciliationRequired: false,
      updatedBalance: { ...balance },
      message: `تم فك حجز ${releaseQty} قطعة وإعادتها للمتاح للبيع`,
    };
    this.processedIdempotencyKeys.set(params.idempotencyKey, { timestamp: new Date().toISOString(), result });
    return result;
  }

  /**
   * إلغاء فاتورة بيع معتمدة (Void Invoice) مع حفظ الفاتورة الأصلية موثقة بـ isDeleted: true
   * وعكس أثرها على العجز أو المخزون المتاح ومنع الإلغاء المتكرر
   */
  voidSaleInvoice(params: {
    idempotencyKey: string;
    invoiceUuid: string;
    productId: number;
    voidedBy: string;
    reason: string;
  }): ProcessedSyncResult {
    if (this.processedIdempotencyKeys.has(params.idempotencyKey)) {
      return { success: true, duplicateIgnored: true, reconciliationRequired: false, message: 'تم تجاهل تكرار الإلغاء' };
    }

    const inv = this.invoicesStore.get(params.invoiceUuid);
    if (!inv) {
      throw new Error(`الفاتورة ${params.invoiceUuid} غير موجودة`);
    }
    if (inv.isDeleted === true) {
      return { success: true, duplicateIgnored: true, reconciliationRequired: false, message: 'الفاتورة ملغاة مسبقاً' };
    }

    const balance = this.inventoryBalances.get(params.productId);
    if (!balance) throw new Error('المنتج غير موجود');

    const beforeState = { ...balance };
    const origQty = Number(inv.qty || 0) || (this.journal.find(j => j.invoiceNumber === inv.invoice_number)?.qtyDelta ? Math.abs(this.journal.find(j => j.invoiceNumber === inv.invoice_number)!.qtyDelta) : 0);

    // وسم الفاتورة الأصلية كملغاة دون حذفها من الدفاتر المالية
    inv.isDeleted = true;
    inv.voidReason = params.reason;
    inv.voidedBy = params.voidedBy;
    inv.voidedAt = new Date().toISOString();

    const pendingRec = this.reconciliationLedger.find(
      (r) => r.invoiceUuid === params.invoiceUuid && r.status === 'pending_review'
    );

    if (pendingRec && balance.conflictDeficit > 0) {
      const coveredDeficit = Math.min(balance.conflictDeficit, pendingRec.deficitQty);
      const returnToPhysical = Math.max(0, pendingRec.requestedQty - coveredDeficit);
      pendingRec.status = 'resolved_by_void';
      pendingRec.resolvedBy = params.voidedBy;
      pendingRec.resolvedAt = new Date().toISOString();
      pendingRec.resolutionNotes = params.reason;
      inv.reconciliation_status = 'resolved_by_void';

      balance.conflictDeficit -= coveredDeficit;
      balance.physicalStock += returnToPhysical;
      balance.availableStock += returnToPhysical;
    } else if (origQty > 0) {
      balance.physicalStock += origQty;
      balance.availableStock += origQty;
    }

    balance.version++;
    balance.updatedAt = new Date().toISOString();

    this.journalSeq++;
    this.journal.push({
      seq: this.journalSeq,
      operationId: params.idempotencyKey,
      action: 'void_sale',
      productId: params.productId,
      qtyDelta: origQty,
      beforeBalance: beforeState,
      afterBalance: { ...balance },
      timestamp: new Date().toISOString(),
      deviceId: params.voidedBy,
      invoiceNumber: inv.invoice_number,
    });

    const result: ProcessedSyncResult = {
      success: true,
      reconciliationRequired: false,
      updatedBalance: { ...balance },
      message: `تم إلغاء الفاتورة ${inv.invoice_number} رسمياً وتحديث الرصيد`,
    };
    this.processedIdempotencyKeys.set(params.idempotencyKey, { timestamp: new Date().toISOString(), result });
    return result;
  }

  /**
   * تسوية إدارية يدوية من قبل المدير أو المالك (Administrative Adjustment)
   */
  resolveReconciliationManually(params: {
    reconciliationId: string;
    action: 'resolved_by_adjustment' | 'resolved_by_void';
    managerName: string;
    notes: string;
  }): boolean {
    const rec = this.reconciliationLedger.find((r) => r.id === params.reconciliationId);
    if (!rec || rec.status !== 'pending_review') {
      return false; // يمنع تكرار التسوية
    }

    const balance = this.inventoryBalances.get(rec.productId);
    if (balance) {
      const beforeState = { ...balance };
      balance.conflictDeficit = Math.max(0, balance.conflictDeficit - rec.deficitQty);
      balance.version++;
      balance.updatedAt = new Date().toISOString();

      this.journalSeq++;
      this.journal.push({
        seq: this.journalSeq,
        operationId: `manual_adj_${rec.id}`,
        action: 'manual_reconciliation',
        productId: rec.productId,
        qtyDelta: rec.deficitQty,
        beforeBalance: beforeState,
        afterBalance: { ...balance },
        timestamp: new Date().toISOString(),
        deviceId: params.managerName,
        invoiceNumber: rec.invoiceNumber,
      });
    }

    rec.status = params.action;
    rec.resolvedBy = params.managerName;
    rec.resolvedAt = new Date().toISOString();
    rec.resolutionNotes = params.notes;

    // تحديث الفاتورة المرتبطة
    const inv = this.invoicesStore.get(rec.invoiceUuid);
    if (inv) {
      inv.reconciliation_status = 'resolved';
      inv.reconciliation_resolved_by = params.managerName;
    }

    return true;
  }

  /**
   * الحصول على سجلات التسوية الإدارية
   */
  getReconciliationLedger(filterStatus?: ReconciliationStatus): ReconciliationRecord[] {
    if (!filterStatus) return [...this.reconciliationLedger];
    return this.reconciliationLedger.filter((r) => r.status === filterStatus);
  }

  /**
   * التحقق من إعادة بناء رصيد المخزون رياضياً من واقع سجل الحركات والتسويات
   */
  reconstructStockFromJournal(productId: number, initialQty: number): {
    calculatedPhysicalStock: number;
    calculatedAvailableStock: number;
    calculatedReservedStock: number;
    calculatedDeficit: number;
    isMatched: boolean;
    currentBalance: InventoryBalance;
  } {
    const current = this.inventoryBalances.get(productId)!;
    let runningPhysical = initialQty;
    let runningAvailable = initialQty;
    let runningReserved = 0;
    let runningDeficit = 0;

    for (const j of this.journal) {
      if (j.productId === productId) {
        if (j.action === 'sale') {
          runningPhysical += j.qtyDelta;
          runningAvailable += j.qtyDelta;
        } else if (j.action === 'sale_with_conflict_deficit') {
          const availBefore = Math.max(0, runningAvailable);
          const deficit = Math.abs(j.qtyDelta) - availBefore;
          runningPhysical = Math.max(0, runningPhysical - availBefore);
          runningAvailable = 0;
          runningDeficit += deficit;
        } else if (j.action === 'restock_purchase') {
          runningPhysical += j.qtyDelta;
          if (runningDeficit > 0) {
            const covered = Math.min(runningDeficit, j.qtyDelta);
            runningDeficit -= covered;
            runningAvailable += j.qtyDelta - covered;
          } else {
            runningAvailable += j.qtyDelta;
          }
        } else if (j.action === 'sale_return' || j.action === 'void_sale') {
          if (runningDeficit > 0 && j.beforeBalance.conflictDeficit > j.afterBalance.conflictDeficit) {
            const covered = j.beforeBalance.conflictDeficit - j.afterBalance.conflictDeficit;
            const excess = Math.max(0, j.qtyDelta - covered);
            runningDeficit -= covered;
            runningPhysical += excess;
            runningAvailable += excess;
          } else {
            runningPhysical += j.qtyDelta;
            runningAvailable += j.qtyDelta;
          }
        } else if (j.action === 'reserve_hold') {
          runningAvailable -= j.qtyDelta;
          runningReserved += j.qtyDelta;
        } else if (j.action === 'release_hold') {
          const rel = Math.min(runningReserved, j.qtyDelta);
          runningReserved -= rel;
          runningAvailable += rel;
        } else if (j.action === 'manual_reconciliation') {
          runningDeficit = Math.max(0, runningDeficit - j.qtyDelta);
        }
      }
    }

    const isMatched =
      current.physicalStock === runningPhysical &&
      current.availableStock === runningAvailable &&
      current.reservedStock === runningReserved &&
      current.conflictDeficit === runningDeficit;

    return {
      calculatedPhysicalStock: runningPhysical,
      calculatedAvailableStock: runningAvailable,
      calculatedReservedStock: runningReserved,
      calculatedDeficit: runningDeficit,
      isMatched,
      currentBalance: { ...current },
    };
  }

  getJournalEntriesCount(): number {
    return this.journal.length;
  }

  getStoredInvoices(): Record<string, any>[] {
    return Array.from(this.invoicesStore.values());
  }
}
