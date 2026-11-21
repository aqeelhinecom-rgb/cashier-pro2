import { Invoice, InvoiceItem, InvoiceType } from '../types';

export type InvoiceDraftMode = 'new' | 'edit';

export interface InvoiceDraftRecord {
  type: InvoiceType;
  mode: InvoiceDraftMode;
  items: InvoiceItem[];
  selectedPartyId: number | null;
  discount: number;
  paid: string;
  invoiceCurrency: string;
  searchQuery: string;
  editingInvoice: Invoice | null;
  originalSaleQtyMap: Record<number, number>;
  idempotencyKey: string | null;
  updatedAt: number;
}

const STORAGE_KEY = 'cashier_pro_invoice_drafts_v1';
const memoryStore = new Map<string, InvoiceDraftRecord>();
let hydratedFromSession = false;

export function getDraftSlotKey(type: InvoiceType, mode: InvoiceDraftMode = 'new'): string {
  return `${mode}:${type}`;
}

function cloneItems(items: InvoiceItem[]): InvoiceItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneDraft(draft: InvoiceDraftRecord): InvoiceDraftRecord {
  return {
    ...draft,
    items: cloneItems(draft.items),
    editingInvoice: draft.editingInvoice ? { ...draft.editingInvoice } : null,
    originalSaleQtyMap: { ...(draft.originalSaleQtyMap || {}) },
  };
}

function getSafeSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

function hydrateOnce(): void {
  if (hydratedFromSession) return;
  hydratedFromSession = true;
  const storage = getSafeSessionStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [slotKey, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && Array.isArray((value as any).items)) {
        memoryStore.set(slotKey, cloneDraft(value as InvoiceDraftRecord));
      }
    }
  } catch {
    // Corrupted session draft data should never crash UI
  }
}

function syncToSession(): void {
  const storage = getSafeSessionStorage();
  if (!storage) return;
  try {
    const payload: Record<string, InvoiceDraftRecord> = {};
    for (const [slotKey, value] of memoryStore.entries()) {
      payload[slotKey] = value;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / private browsing errors
  }
}

export function hasNonEmptyDraft(draft: InvoiceDraftRecord | null): boolean {
  if (!draft) return false;
  return (
    draft.items.length > 0 ||
    draft.selectedPartyId !== null ||
    Number(draft.discount) > 0 ||
    draft.paid !== '' ||
    draft.searchQuery.trim() !== '' ||
    draft.mode === 'edit'
  );
}

export function getInvoiceDraft(
  type: InvoiceType,
  mode: InvoiceDraftMode = 'new'
): InvoiceDraftRecord | null {
  hydrateOnce();
  const found = memoryStore.get(getDraftSlotKey(type, mode));
  return found ? cloneDraft(found) : null;
}

export function saveInvoiceDraft(
  draft: Omit<InvoiceDraftRecord, 'updatedAt'> & { updatedAt?: number }
): InvoiceDraftRecord {
  hydrateOnce();
  const slotKey = getDraftSlotKey(draft.type, draft.mode);
  const normalized: InvoiceDraftRecord = {
    type: draft.type,
    mode: draft.mode,
    items: cloneItems(draft.items),
    selectedPartyId: draft.selectedPartyId ?? null,
    discount: Number(draft.discount) || 0,
    paid: typeof draft.paid === 'string' ? draft.paid : String(draft.paid ?? ''),
    invoiceCurrency: draft.invoiceCurrency || 'د.ع',
    searchQuery: draft.searchQuery || '',
    editingInvoice: draft.editingInvoice ? { ...draft.editingInvoice } : null,
    originalSaleQtyMap: { ...(draft.originalSaleQtyMap || {}) },
    idempotencyKey: draft.idempotencyKey ?? null,
    updatedAt: draft.updatedAt ?? Date.now(),
  };
  memoryStore.set(slotKey, normalized);
  syncToSession();
  return cloneDraft(normalized);
}

export function clearInvoiceDraft(type: InvoiceType, mode: InvoiceDraftMode = 'new'): void {
  hydrateOnce();
  const slotKey = getDraftSlotKey(type, mode);
  if (memoryStore.delete(slotKey)) {
    syncToSession();
  }
}

export function getActiveEditInvoice(type: InvoiceType): Invoice | null {
  const editDraft = getInvoiceDraft(type, 'edit');
  return editDraft?.editingInvoice ? { ...editDraft.editingInvoice } : null;
}

export function initializeEditInvoiceDraft(
  invoice: Invoice,
  existingItems: InvoiceItem[],
  defaultCurrency: string
): { draft: InvoiceDraftRecord; reusedExisting: boolean } {
  hydrateOnce();
  const existing = getInvoiceDraft(invoice.type, 'edit');
  if (existing && existing.editingInvoice?.id === invoice.id) {
    return { draft: existing, reusedExisting: true };
  }

  const normalizedItems = existingItems.map((it) => ({
    ...it,
    stockAlreadyAdded: false,
    initialAddedQty: 0,
  }));

  const qtyMap: Record<number, number> = {};
  if (invoice.type === 'sale') {
    for (const it of normalizedItems) {
      qtyMap[it.product_id] = (qtyMap[it.product_id] || 0) + (Number(it.qty) || 0);
    }
  }

  const freshDraft = saveInvoiceDraft({
    type: invoice.type,
    mode: 'edit',
    items: normalizedItems,
    selectedPartyId: invoice.party_id ?? null,
    discount: Number(invoice.discount) || 0,
    paid: String(Number(invoice.paid) || 0),
    invoiceCurrency: invoice.currency || defaultCurrency || 'د.ع',
    searchQuery: '',
    editingInvoice: { ...invoice },
    originalSaleQtyMap: qtyMap,
    idempotencyKey: null,
  });

  return { draft: freshDraft, reusedExisting: false };
}

export function clearAllInvoiceDrafts(): void {
  memoryStore.clear();
  hydratedFromSession = true;
  const storage = getSafeSessionStorage();
  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

export function resetAllInvoiceDraftsForTest(): void {
  clearAllInvoiceDrafts();
}
