import { CashierDatabase } from '../schema';
import {
  StorageInvoice,
  StorageInvoiceItem,
  InvoiceType,
  InsufficientStockError,
} from '../types';
import { generateUUID } from '../uuid';

export interface CreateInvoiceParams {
  type: InvoiceType;
  partyId?: number | null;
  items: Omit<StorageInvoiceItem, 'id' | 'invoice_id' | 'uuid' | 'updatedAt'>[];
  discount: number;
  paid: number;
  currency?: string;
  notes?: string;
  date?: string;
  customInvoiceNumber?: string;
  idempotencyKey?: string;
  originalInvoiceId?: number;
}

export interface CreateInvoiceResult {
  invoice: StorageInvoice;
  items: StorageInvoiceItem[];
  deduplicated?: boolean;
  stockChanges?: { productId: number; oldQty: number; newQty: number }[];
}

export interface VoidInvoiceResult {
  voided: boolean;
  alreadyVoided?: boolean;
  stockChanges: { productId: number; oldQty: number; newQty: number }[];
  conflicts: { productId: number; conflictType: string; expectedDelta: number; actualJournalDelta: number | null }[];
}

export interface EditEligibilityResult {
  canEdit: boolean;
  reason?: string;
  invoice?: StorageInvoice;
}

export interface UpdateInvoiceParams {
  invoiceId: number;
  partyId?: number | null;
  items: Omit<StorageInvoiceItem, 'id' | 'invoice_id' | 'uuid' | 'updatedAt'>[];
  discount: number;
  paid: number;
  currency?: string;
  notes?: string;
  editIdempotencyKey?: string;
  actorRole?: 'owner' | 'admin' | 'manager' | 'cashier';
}

export interface UpdateInvoiceResult {
  invoice: StorageInvoice;
  items: StorageInvoiceItem[];
  deduplicated?: boolean;
  stockChanges: { productId: number; oldQty: number; newQty: number; delta: number }[];
}

function parseInvoiceSeqNumber(invoiceNumber?: string): number {
  if (!invoiceNumber) return 0;
  const match = String(invoiceNumber).match(/(\d+)$/);
  return match ? parseInt(match[1], 10) || 0 : 0;
}

export class InvoiceRepository {
  constructor(private db: CashierDatabase) {}

  async getAll(type?: InvoiceType): Promise<StorageInvoice[]> {
    let collection = this.db.invoices.filter((inv) => !inv.isDeleted);
    if (type) {
      collection = collection.filter((inv) => inv.type === type);
    }
    const list = await collection.toArray();
    return list.sort((a, b) => b.id - a.id);
  }

  async getById(id: number): Promise<StorageInvoice | undefined> {
    const inv = await this.db.invoices.get(id);
    return inv && !inv.isDeleted ? inv : undefined;
  }

  async getByUuid(uuid: string): Promise<StorageInvoice | undefined> {
    const inv = await this.db.invoices.where('uuid').equals(uuid).first();
    return inv && !inv.isDeleted ? inv : undefined;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<StorageInvoice | undefined> {
    const clean = idempotencyKey.trim();
    if (!clean) return undefined;
    return this.db.invoices.where('idempotencyKey').equals(clean).first();
  }

  async getItems(invoiceId: number): Promise<StorageInvoiceItem[]> {
    return this.db.invoice_items.where('invoice_id').equals(invoiceId).toArray();
  }

  /**
   * Saves an invoice atomically:
   * 1. Enforces idempotencyKey deduplication inside the rw transaction
   * 2. Validates non-empty items and available stock for sales atomically (no negative stock / no Math.max masking)
   * 3. Inserts the invoice and all invoice_items
   * 4. Updates product stock & prices atomically
   * 5. Appends immutable Change Journal records including exact stock deltas
   */
  async createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResult> {
    const {
      type,
      partyId,
      items,
      discount,
      paid,
      currency,
      notes,
      date,
      customInvoiceNumber,
      idempotencyKey,
      originalInvoiceId,
    } = params;

    const cleanIdempotencyKey = idempotencyKey?.trim() || '';
    const resolvedIdempotencyKey = cleanIdempotencyKey || generateUUID();

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('لا يمكن حفظ فاتورة فارغة بدون أصناف.');
    }

    for (const item of items) {
      const q = Number(item.qty);
      if (!Number.isFinite(q) || q <= 0) {
        throw new Error(`كمية غير صالحة للصنف "${item.name}". يجب أن تكون أكبر من صفر.`);
      }
    }

    const now = date || new Date().toISOString();
    const subtotal = items.reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const total = Math.max(0, subtotal - (Number(discount) || 0));

    return this.db.transaction(
      'rw',
      [
        this.db.invoices,
        this.db.invoice_items,
        this.db.products,
        this.db.parties,
        this.db.settings,
        this.db.change_journal,
      ],
      async () => {
        // 0. Enforce idempotencyKey inside the atomic rw transaction
        if (cleanIdempotencyKey) {
          const existingByKey = await this.db.invoices
            .where('idempotencyKey')
            .equals(cleanIdempotencyKey)
            .first();
          if (existingByKey) {
            const existingItems = await this.db.invoice_items
              .where('invoice_id')
              .equals(existingByKey.id)
              .toArray();
            return {
              invoice: existingByKey,
              items: existingItems,
              deduplicated: true,
              stockChanges: [],
            };
          }
        }

        // 1. Authoritative Stock Availability Check for Sales (aggregated per product)
        if (type === 'sale') {
          const requestedByProduct = new Map<number, { qty: number; name: string }>();
          for (const item of items) {
            const prev = requestedByProduct.get(item.product_id);
            const itemQty = Number(item.qty);
            if (prev) {
              prev.qty += itemQty;
            } else {
              requestedByProduct.set(item.product_id, { qty: itemQty, name: item.name });
            }
          }

          for (const [productId, req] of requestedByProduct.entries()) {
            const product = await this.db.products.get(productId);
            if (!product || product.isDeleted) {
              throw new Error(`المنتج "${req.name}" غير موجود في المخزن.`);
            }
            const availableQty = Number(product.qty) || 0;
            if (req.qty > availableQty) {
              throw new InsufficientStockError(product.id, product.name, req.qty, availableQty);
            }
          }
        }

        // 2. Resolve party name if partyId provided
        let partyName: string | undefined;
        if (partyId) {
          const party = await this.db.parties.get(partyId);
          partyName = party?.name;
        } else if (type === 'sale' || type === 'sale_return' || type === 'quote') {
          partyName = 'مفرد';
        }

        // 3. Determine display invoice number monotonically and collision-free
        let invoiceNumber = customInvoiceNumber;
        if (!invoiceNumber) {
          const seqKey = `seq_${type}`;
          const seqRec = await this.db.settings.get(seqKey);
          const allInvoices = await this.db.invoices.toArray();
          const maxExistingForType = allInvoices
            .filter((inv) => inv.type === type)
            .reduce((m, inv) => Math.max(m, inv.id || 0, parseInvoiceSeqNumber(inv.invoice_number)), 0);

          let nextSeq = 1;
          if (seqRec && typeof seqRec.value === 'number') {
            nextSeq = Math.max(seqRec.value, maxExistingForType) + 1;
          } else {
            const maxAnyId = allInvoices.reduce((m, inv) => Math.max(m, inv.id || 0), 0);
            nextSeq = Math.max(maxAnyId, maxExistingForType) + 1;
          }
          await this.db.settings.put({ key: seqKey, value: nextSeq });
          const prefix = type === 'purchase' ? 'PO' : type === 'sale_return' ? 'RET' : 'INV';
          invoiceNumber = `${prefix}-${nextSeq}`;
        }

        const newInvoice: StorageInvoice = {
          type,
          party_id: partyId || null,
          party_name: partyName,
          date: now,
          discount: Number(discount) || 0,
          total,
          paid: Number(paid) || 0,
          currency: currency?.trim() || 'د.ع',
          invoice_number: invoiceNumber,
          idempotencyKey: resolvedIdempotencyKey,
          uuid: generateUUID(),
          notes: notes?.trim(),
          original_invoice_id: originalInvoiceId,
          updatedAt: now,
          isDeleted: false,
        } as StorageInvoice;

        const invoiceId = await this.db.invoices.add(newInvoice);
        newInvoice.id = invoiceId;

        // 4. Insert items
        const createdItems: StorageInvoiceItem[] = [];
        for (const item of items) {
          const storageItem: StorageInvoiceItem = {
            invoice_id: invoiceId,
            product_id: item.product_id,
            name: item.name,
            category: item.category,
            qty: Number(item.qty),
            price: Number(item.price),
            cost: Number(item.cost),
            sell_price: item.sell_price !== undefined ? Number(item.sell_price) : undefined,
            image: item.image,
            stockAlreadyAdded: item.stockAlreadyAdded,
            initialAddedQty: item.initialAddedQty,
            uuid: generateUUID(),
            updatedAt: now,
          };

          const itemId = await this.db.invoice_items.add(storageItem);
          storageItem.id = itemId;
          createdItems.push(storageItem);
        }

        // 5. Update Stock atomically (no Math.max masking for sale)
        const stockChanges: { productId: number; productUuid: string; oldQty: number; newQty: number }[] = [];
        if (type !== 'quote') {
          for (const item of items) {
            const product = await this.db.products.get(item.product_id);
            if (!product) continue;

            const oldQty = Number(product.qty) || 0;
            let newQty = oldQty;
            let newBuyPrice = product.buy_price;
            let newSellPrice = product.sell_price;
            const itemQty = Number(item.qty);

            if (type === 'sale') {
              newQty = oldQty - itemQty;
              if (newQty < 0) {
                throw new InsufficientStockError(product.id, product.name, itemQty, oldQty);
              }
            } else if (type === 'sale_return') {
              newQty = oldQty + itemQty;
            } else if (type === 'purchase') {
              if (item.stockAlreadyAdded) {
                const diff = itemQty - (Number(item.initialAddedQty) || 0);
                newQty = oldQty + diff;
                if (newQty < 0) {
                  throw new InsufficientStockError(product.id, product.name, Math.abs(diff), oldQty);
                }
              } else {
                newQty = oldQty + itemQty;
              }
              newBuyPrice = Number(item.price);
              if (item.sell_price !== undefined && Number(item.sell_price) > 0) {
                newSellPrice = Number(item.sell_price);
              }
            }

            await this.db.products.update(product.id, {
              qty: newQty,
              buy_price: newBuyPrice,
              sell_price: newSellPrice,
              version: (product.version || 1) + 1,
              updatedAt: now,
            });

            stockChanges.push({
              productId: product.id,
              productUuid: product.uuid,
              oldQty,
              newQty,
            });
          }
        }

        // 6. Atomic Change Journal Recording
        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: newInvoice.uuid,
            table: 'invoices',
            action: 'create',
            recordId: invoiceId,
            recordUuid: newInvoice.uuid,
            timestamp: now,
            afterState: newInvoice,
          });

          for (const it of createdItems) {
            await this.db.change_journal.add({
              operationId: it.uuid,
              table: 'invoice_items',
              action: 'create',
              recordId: it.id!,
              recordUuid: it.uuid,
              timestamp: now,
              afterState: it,
            });
          }

          for (const sc of stockChanges) {
            await this.db.change_journal.add({
              operationId: generateUUID(),
              table: 'products',
              action: 'stock_change',
              recordId: sc.productId,
              recordUuid: sc.productUuid,
              timestamp: now,
              diff: {
                oldQty: sc.oldQty,
                newQty: sc.newQty,
                delta: sc.newQty - sc.oldQty,
                invoiceId,
                invoiceUuid: newInvoice.uuid,
                invoiceType: type,
                reason: 'invoice_create',
              },
            });
          }
        }

        return {
          invoice: newInvoice,
          items: createdItems,
          deduplicated: false,
          stockChanges: stockChanges.map(({ productId, oldQty, newQty }) => ({
            productId,
            oldQty,
            newQty,
          })),
        };
      }
    );
  }

  /**
   * Voids/deletes an invoice atomically:
   * - Idempotent: refuses duplicate void / stock reversal if already voided
   * - Reverses ONLY actual stock movements recorded in Change Journal (never blindly adds item.qty)
   * - Preserves all historical Change Journal records and logs inconsistencies in audit_logs without creating phantom stock
   */
  async deleteInvoice(id: number, soft = true): Promise<VoidInvoiceResult> {
    return this.db.transaction(
      'rw',
      [
        this.db.invoices,
        this.db.invoice_items,
        this.db.products,
        this.db.change_journal,
        this.db.audit_logs,
      ],
      async () => {
        const invoice = await this.db.invoices.get(id);
        if (!invoice || invoice.isDeleted) {
          return {
            voided: false,
            alreadyVoided: Boolean(invoice?.isDeleted),
            stockChanges: [],
            conflicts: [],
          };
        }

        // Prevent duplicate reversal via Change Journal check as well
        if (this.db.change_journal) {
          const priorVoid = await this.db.change_journal
            .where('recordId')
            .equals(id)
            .filter((e) => e.table === 'invoices' && e.action === 'void')
            .first();
          if (priorVoid) {
            return {
              voided: false,
              alreadyVoided: true,
              stockChanges: [],
              conflicts: [],
            };
          }
        }

        const items = await this.db.invoice_items.where('invoice_id').equals(id).toArray();
        const now = new Date().toISOString();

        const stockRollbacks: {
          productId: number;
          productUuid: string;
          oldQty: number;
          newQty: number;
          reverseDelta: number;
        }[] = [];
        const conflicts: VoidInvoiceResult['conflicts'] = [];

        if (invoice.type !== 'quote' && items.length > 0) {
          // Calculate expected movement per product from invoice items
          const expectedDeltaByProduct = new Map<number, number>();
          for (const item of items) {
            const itemQty = Number(item.qty) || 0;
            let delta = 0;
            if (invoice.type === 'sale') {
              delta = -itemQty;
            } else if (invoice.type === 'sale_return') {
              delta = itemQty;
            } else if (invoice.type === 'purchase') {
              delta = item.stockAlreadyAdded
                ? itemQty - (Number(item.initialAddedQty) || 0)
                : itemQty;
            }
            expectedDeltaByProduct.set(
              item.product_id,
              (expectedDeltaByProduct.get(item.product_id) || 0) + delta
            );
          }

          // Lookup actual recorded stock movements in Change Journal
          const recordedDeltaByProduct = new Map<number, number>();
          if (this.db.change_journal) {
            const allProductStockEntries = await this.db.change_journal
              .where('table')
              .equals('products')
              .filter((e) => e.action === 'stock_change' && e.diff?.reason !== 'invoice_void')
              .toArray();

            // 1. Direct match via invoiceId / invoiceUuid
            let matchedEntries = allProductStockEntries.filter(
              (e) =>
                e.diff?.invoiceId === id ||
                (invoice.uuid && e.diff?.invoiceUuid === invoice.uuid)
            );

            // 2. Fallback match for pre-Phase-22 historical invoices using exact timestamp + productId
            if (matchedEntries.length === 0 && invoice.updatedAt) {
              matchedEntries = allProductStockEntries.filter(
                (e) =>
                  e.diff?.invoiceId === undefined &&
                  e.diff?.invoiceUuid === undefined &&
                  e.timestamp === invoice.updatedAt &&
                  expectedDeltaByProduct.has(Number(e.recordId))
              );
            }

            for (const entry of matchedEntries) {
              const pid = Number(entry.recordId);
              const entryDelta =
                typeof entry.diff?.delta === 'number'
                  ? entry.diff.delta
                  : Number(entry.diff?.newQty) - Number(entry.diff?.oldQty);
              if (Number.isFinite(entryDelta)) {
                recordedDeltaByProduct.set(
                  pid,
                  (recordedDeltaByProduct.get(pid) || 0) + entryDelta
                );
              }
            }
          }

          for (const [productId, expectedDelta] of expectedDeltaByProduct.entries()) {
            const recordedDelta = recordedDeltaByProduct.get(productId);

            if (recordedDelta === undefined) {
              // Historical/untracked invoice with no journal movement -> log conflict & do NOT create phantom stock
              conflicts.push({
                productId,
                conflictType: 'missing_journal_stock_movement',
                expectedDelta,
                actualJournalDelta: null,
              });
              if (this.db.audit_logs) {
                await this.db.audit_logs.add({
                  uuid: generateUUID(),
                  action: 'void',
                  entity: 'invoice',
                  entityId: id,
                  timestamp: now,
                  details: {
                    conflictType: 'missing_journal_stock_movement',
                    productId,
                    expectedDelta,
                    actualJournalDelta: null,
                    invoiceType: invoice.type,
                    invoiceNumber: invoice.invoice_number,
                    note: 'لم يتم تعديل المخزون لعدم وجود حركة مسجلة في سجل التغييرات',
                  },
                });
              }
              continue;
            }

            if (Math.abs(recordedDelta - expectedDelta) > 1e-6) {
              // Inconsistent historical invoice (e.g. Phase 21 zero-stock oversell where expected=-5, recorded=0)
              conflicts.push({
                productId,
                conflictType: 'journal_qty_mismatch',
                expectedDelta,
                actualJournalDelta: recordedDelta,
              });
              if (this.db.audit_logs) {
                await this.db.audit_logs.add({
                  uuid: generateUUID(),
                  action: 'void',
                  entity: 'invoice',
                  entityId: id,
                  timestamp: now,
                  details: {
                    conflictType: 'journal_qty_mismatch',
                    productId,
                    expectedDelta,
                    actualJournalDelta: recordedDelta,
                    reverseApplied: -recordedDelta,
                    invoiceType: invoice.type,
                    invoiceNumber: invoice.invoice_number,
                    note: 'تم عكس الحركة الفعلية المسجلة فقط ومنع تصنيع مخزون وهمي',
                  },
                });
              }
            }

            const reverseDelta = -recordedDelta;
            if (reverseDelta !== 0) {
              const product = await this.db.products.get(productId);
              if (product) {
                const oldQty = Number(product.qty) || 0;
                const newQty = oldQty + reverseDelta;
                if (newQty < 0) {
                  throw new InsufficientStockError(
                    product.id,
                    product.name,
                    Math.abs(reverseDelta),
                    oldQty
                  );
                }

                await this.db.products.update(product.id, {
                  qty: newQty,
                  version: (product.version || 1) + 1,
                  updatedAt: now,
                });

                stockRollbacks.push({
                  productId: product.id,
                  productUuid: product.uuid,
                  oldQty,
                  newQty,
                  reverseDelta,
                });
              }
            }
          }
        }

        if (soft) {
          await this.db.invoices.update(id, {
            isDeleted: true,
            updatedAt: now,
          });
        } else {
          await this.db.invoices.delete(id);
          await this.db.invoice_items.where('invoice_id').equals(id).delete();
        }

        // Preserve all prior Change Journal entries; only append new void & rollback entries
        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: generateUUID(),
            table: 'invoices',
            action: 'void',
            recordId: id,
            recordUuid: invoice.uuid,
            timestamp: now,
            beforeState: invoice,
            afterState: soft ? { ...invoice, isDeleted: true, updatedAt: now } : undefined,
            diff: conflicts.length > 0 ? { conflicts } : undefined,
          });

          for (const sr of stockRollbacks) {
            await this.db.change_journal.add({
              operationId: generateUUID(),
              table: 'products',
              action: 'stock_change',
              recordId: sr.productId,
              recordUuid: sr.productUuid,
              timestamp: now,
              diff: {
                oldQty: sr.oldQty,
                newQty: sr.newQty,
                delta: sr.reverseDelta,
                invoiceId: id,
                invoiceUuid: invoice.uuid,
                reason: 'invoice_void',
              },
            });
          }
        }

        return {
          voided: true,
          stockChanges: stockRollbacks.map(({ productId, oldQty, newQty }) => ({
            productId,
            oldQty,
            newQty,
          })),
          conflicts,
        };
      }
    );
  }

  private async evaluateEditEligibility(invoiceId: number): Promise<EditEligibilityResult> {
    const invoice = await this.db.invoices.get(invoiceId);
    if (!invoice) {
      return { canEdit: false, reason: 'الفاتورة غير موجودة.' };
    }
    if (invoice.isDeleted) {
      return { canEdit: false, reason: 'لا يمكن تعديل فاتورة ملغاة.', invoice };
    }
    if (invoice.type !== 'sale' && invoice.type !== 'purchase') {
      return {
        canEdit: false,
        reason: 'تعديل الفواتير المحفوظة متاح لفواتير البيع والشراء فقط.',
        invoice,
      };
    }

    const escapeRegex = (val: string) => val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const idRegex = new RegExp(`#${invoiceId}(?!\\d)`);
    const numRegex = invoice.invoice_number
      ? new RegExp(`(^|[^\\w\\u0600-\\u06FF])${escapeRegex(invoice.invoice_number)}([^\\w\\u0600-\\u06FF]|$)`)
      : null;

    // 1. Block if any active sale_return references this invoice
    const returns = await this.db.invoices
      .filter((inv) => !inv.isDeleted && inv.type === 'sale_return')
      .toArray();
    const linkedReturn = returns.find((ret) => {
      if (ret.original_invoice_id === invoiceId) return true;
      const notes = ret.notes || '';
      if (idRegex.test(notes)) return true;
      if (numRegex && numRegex.test(notes)) return true;
      return false;
    });
    if (linkedReturn) {
      return {
        canEdit: false,
        reason: `لا يمكن تعديل هذه الفاتورة لوجود فاتورة مرتجع مرتبطة بها (${linkedReturn.invoice_number || `#${linkedReturn.id}`}).`,
        invoice,
      };
    }

    // 2. Block if standalone settlement payments were recorded for this party after the invoice or referencing it
    if (invoice.party_id != null && this.db.payments) {
      const partyPayments = await this.db.payments
        .filter((p) => !p.isDeleted && p.party_id === invoice.party_id)
        .toArray();
      const blockingPayment = partyPayments.find((p) => {
        const notes = p.notes || '';
        if (idRegex.test(notes) || (numRegex && numRegex.test(notes))) {
          return true;
        }
        return Boolean(p.date && invoice.date && p.date > invoice.date);
      });
      if (blockingPayment) {
        return {
          canEdit: false,
          reason:
            'لا يمكن تعديل هذه الفاتورة لوجود سندات قبض/صرف مستقلة مسجلة على حساب الطرف بعد تاريخ الفاتورة.',
          invoice,
        };
      }
    }

    return { canEdit: true, invoice };
  }

  async canEditInvoice(invoiceId: number): Promise<EditEligibilityResult> {
    return this.evaluateEditEligibility(invoiceId);
  }

  /**
   * Atomically updates a saved sale or purchase invoice inside a single Dexie 'rw' transaction:
   * - Preserves invoice id, uuid, invoice_number, date, and type
   * - Enforces role permission, eligibility guards (voided / linked return / post-invoice settlements), and retry idempotency
   * - Computes exact product stock deltas and aborts before mutating anything if stock would drop below 0
   * - Appends Change Journal (update + stock_change) and full before/after audit snapshot
   */
  async updateInvoice(params: UpdateInvoiceParams): Promise<UpdateInvoiceResult> {
    const {
      invoiceId,
      partyId,
      items,
      discount,
      paid,
      currency,
      notes,
      editIdempotencyKey,
      actorRole = 'owner',
    } = params;

    if (actorRole === 'cashier') {
      throw new Error('ليس لديك صلاحية لتعديل الفواتير المحفوظة. يرجى مراجعة مدير النظام.');
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('لا يمكن حفظ فاتورة فارغة بدون أصناف.');
    }

    for (const item of items) {
      const q = Number(item.qty);
      const p = Number(item.price);
      if (!Number.isFinite(q) || q <= 0) {
        throw new Error(`كمية غير صالحة للصنف "${item.name}". يجب أن تكون أكبر من صفر.`);
      }
      if (!Number.isFinite(p) || p < 0) {
        throw new Error(`سعر غير صالح للصنف "${item.name}".`);
      }
    }

    const cleanDiscount = Math.max(0, Number(discount) || 0);
    const cleanPaid = Math.max(0, Number(paid) || 0);
    const cleanEditKey = editIdempotencyKey?.trim() || '';
    const subtotal = items.reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const total = Math.max(0, subtotal - cleanDiscount);
    const resolvedPartyId = partyId ?? null;

    return this.db.transaction(
      'rw',
      [
        this.db.invoices,
        this.db.invoice_items,
        this.db.products,
        this.db.parties,
        this.db.payments,
        this.db.settings,
        this.db.change_journal,
        this.db.audit_logs,
      ],
      async () => {
        // 0. Retry idempotency check
        if (cleanEditKey && this.db.change_journal) {
          const priorEdit = await this.db.change_journal
            .where('operationId')
            .equals(cleanEditKey)
            .first();
          if (priorEdit && priorEdit.table === 'invoices' && priorEdit.action === 'update') {
            const currentInv = await this.db.invoices.get(invoiceId);
            const currentItems = await this.db.invoice_items
              .where('invoice_id')
              .equals(invoiceId)
              .toArray();
            if (currentInv) {
              return {
                invoice: currentInv,
                items: currentItems,
                deduplicated: true,
                stockChanges: [],
              };
            }
          }
        }

        // 1. Validate edit eligibility inside the rw transaction
        const eligibility = await this.evaluateEditEligibility(invoiceId);
        if (!eligibility.canEdit || !eligibility.invoice) {
          throw new Error(eligibility.reason || 'تعذر تعديل هذه الفاتورة.');
        }
        const existingInvoice = eligibility.invoice;

        // 2. Validate credit party requirement
        if (cleanPaid < total && !resolvedPartyId) {
          throw new Error(
            existingInvoice.type === 'sale'
              ? 'اختر العميل لتسجيل المبلغ المتبقي عليه كدين'
              : 'اختر المورد لتسجيل المبلغ المتبقي له كمستحق'
          );
        }

        let partyName: string | undefined;
        if (resolvedPartyId) {
          const party = await this.db.parties.get(resolvedPartyId);
          if (!party || party.isDeleted) {
            throw new Error('جهة التعامل المحددة غير موجودة.');
          }
          partyName = party.name;
        } else if (existingInvoice.type === 'sale') {
          partyName = 'مفرد';
        }

        const oldItems = await this.db.invoice_items
          .where('invoice_id')
          .equals(invoiceId)
          .toArray();

        // 3. Aggregate old vs new quantities per product
        const oldQtyByProduct = new Map<number, number>();
        for (const oldIt of oldItems) {
          oldQtyByProduct.set(
            oldIt.product_id,
            (oldQtyByProduct.get(oldIt.product_id) || 0) + (Number(oldIt.qty) || 0)
          );
        }

        const oldItemIds = new Set(oldItems.map((it) => it.id).filter(Boolean));
        const newEffectiveQtyByProduct = new Map<number, { effectiveQty: number; name: string }>();
        const newItemPricesByProduct = new Map<number, { price: number; sell_price?: number }>();

        for (const newIt of items) {
          const rawQty = Number(newIt.qty);
          const isPreExistingRow = Boolean((newIt as any).id && oldItemIds.has((newIt as any).id));
          const alreadyAddedQty =
            existingInvoice.type === 'purchase' &&
            !isPreExistingRow &&
            newIt.stockAlreadyAdded
              ? Number(newIt.initialAddedQty) || 0
              : 0;
          const effectiveQty = rawQty - alreadyAddedQty;
          const prev = newEffectiveQtyByProduct.get(newIt.product_id);
          if (prev) {
            prev.effectiveQty += effectiveQty;
          } else {
            newEffectiveQtyByProduct.set(newIt.product_id, {
              effectiveQty,
              name: newIt.name,
            });
          }
          newItemPricesByProduct.set(newIt.product_id, {
            price: Number(newIt.price),
            sell_price:
              newIt.sell_price !== undefined && Number(newIt.sell_price) > 0
                ? Number(newIt.sell_price)
                : undefined,
          });
        }

        // 4. Compute and validate all stock deltas BEFORE mutating any table
        const allProductIds = new Set<number>([
          ...oldQtyByProduct.keys(),
          ...newEffectiveQtyByProduct.keys(),
        ]);

        const pendingProductUpdates: {
          productId: number;
          productUuid: string;
          oldQty: number;
          newQty: number;
          delta: number;
          newBuyPrice: number;
          newSellPrice: number;
          currentVersion: number;
        }[] = [];

        for (const productId of allProductIds) {
          const oldQtyInInv = oldQtyByProduct.get(productId) || 0;
          const newEntry = newEffectiveQtyByProduct.get(productId);
          const newQtyInInv = newEntry ? newEntry.effectiveQty : 0;

          const stockDelta =
            existingInvoice.type === 'sale'
              ? oldQtyInInv - newQtyInInv
              : newQtyInInv - oldQtyInInv;

          const product = await this.db.products.get(productId);
          if (!product) {
            throw new Error(
              `المنتج "${newEntry?.name || productId}" غير موجود في المخزن.`
            );
          }
          if (newEntry && product.isDeleted) {
            throw new Error(`المنتج "${product.name}" محذوف ولا يمكن تضمينه في الفاتورة.`);
          }

          const currentStock = Number(product.qty) || 0;
          const nextStock = currentStock + stockDelta;
          if (nextStock < 0) {
            throw new InsufficientStockError(
              product.id,
              product.name,
              Math.abs(stockDelta),
              currentStock
            );
          }

          let nextBuyPrice = product.buy_price;
          let nextSellPrice = product.sell_price;
          if (existingInvoice.type === 'purchase' && newItemPricesByProduct.has(productId)) {
            const pInfo = newItemPricesByProduct.get(productId)!;
            nextBuyPrice = pInfo.price;
            if (pInfo.sell_price !== undefined) {
              nextSellPrice = pInfo.sell_price;
            }
          }

          const priceChanged =
            nextBuyPrice !== product.buy_price || nextSellPrice !== product.sell_price;
          if (stockDelta !== 0 || priceChanged) {
            pendingProductUpdates.push({
              productId: product.id,
              productUuid: product.uuid,
              oldQty: currentStock,
              newQty: nextStock,
              delta: stockDelta,
              newBuyPrice: nextBuyPrice,
              newSellPrice: nextSellPrice,
              currentVersion: product.version || 1,
            });
          }
        }

        const now = new Date().toISOString();

        // 5. Apply atomic product updates
        for (const pu of pendingProductUpdates) {
          await this.db.products.update(pu.productId, {
            qty: pu.newQty,
            buy_price: pu.newBuyPrice,
            sell_price: pu.newSellPrice,
            version: pu.currentVersion + 1,
            updatedAt: now,
          });
        }

        // 6. Replace invoice_items for this invoice atomically
        await this.db.invoice_items.where('invoice_id').equals(invoiceId).delete();
        const updatedItems: StorageInvoiceItem[] = [];
        for (const item of items) {
          const storageItem: StorageInvoiceItem = {
            invoice_id: invoiceId,
            product_id: item.product_id,
            name: item.name,
            category: item.category,
            qty: Number(item.qty),
            price: Number(item.price),
            cost: Number(item.cost),
            sell_price: item.sell_price !== undefined ? Number(item.sell_price) : undefined,
            image: item.image,
            stockAlreadyAdded: false,
            initialAddedQty: 0,
            uuid: generateUUID(),
            updatedAt: now,
          };
          const itemId = await this.db.invoice_items.add(storageItem);
          storageItem.id = itemId;
          updatedItems.push(storageItem);
        }

        // 7. Update invoice preserving id, uuid, invoice_number, date, type, and idempotencyKey
        const updatedInvoice: StorageInvoice = {
          ...existingInvoice,
          party_id: resolvedPartyId,
          party_name: partyName,
          discount: cleanDiscount,
          total,
          paid: cleanPaid,
          currency: currency?.trim() || existingInvoice.currency || 'د.ع',
          notes: notes !== undefined ? notes.trim() : existingInvoice.notes,
          updatedAt: now,
        };

        await this.db.invoices.put(updatedInvoice);

        // 8. Atomic Change Journal & Audit Log
        const stockChanges = pendingProductUpdates
          .filter((pu) => pu.delta !== 0)
          .map((pu) => ({
            productId: pu.productId,
            oldQty: pu.oldQty,
            newQty: pu.newQty,
            delta: pu.delta,
          }));

        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: cleanEditKey || generateUUID(),
            table: 'invoices',
            action: 'update',
            recordId: invoiceId,
            recordUuid: existingInvoice.uuid,
            timestamp: now,
            beforeState: existingInvoice,
            afterState: updatedInvoice,
          });

          for (const pu of pendingProductUpdates) {
            if (pu.delta === 0) continue;
            await this.db.change_journal.add({
              operationId: generateUUID(),
              table: 'products',
              action: 'stock_change',
              recordId: pu.productId,
              recordUuid: pu.productUuid,
              timestamp: now,
              diff: {
                oldQty: pu.oldQty,
                newQty: pu.newQty,
                delta: pu.delta,
                invoiceId,
                invoiceUuid: existingInvoice.uuid,
                invoiceType: existingInvoice.type,
                reason: 'invoice_edit',
                editOperationId: cleanEditKey || undefined,
              },
            });
          }
        }

        if (this.db.audit_logs) {
          await this.db.audit_logs.add({
            uuid: generateUUID(),
            action: 'update',
            entity: 'invoice',
            entityId: invoiceId,
            timestamp: now,
            details: {
              editOperationId: cleanEditKey || undefined,
              invoiceNumber: existingInvoice.invoice_number,
              invoiceType: existingInvoice.type,
              actorRole,
              previousInvoice: existingInvoice,
              previousItems: oldItems,
              updatedInvoice,
              updatedItems,
              stockChanges,
            },
          });
        }

        return {
          invoice: updatedInvoice,
          items: updatedItems,
          deduplicated: false,
          stockChanges,
        };
      }
    );
  }
}
