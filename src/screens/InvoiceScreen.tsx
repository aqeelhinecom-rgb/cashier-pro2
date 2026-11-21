import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  Check,
  UserPlus,
  Minus,
  Edit2,
  ChevronDown,
  ShoppingBag,
  PackagePlus,
  Image as ImageIcon,
  X,
  Tag,
  MoreVertical,
  Search,
  FileSpreadsheet,
} from 'lucide-react';
import { DB } from '../services/db';
import { Invoice, InvoiceItem, InvoiceType, Party, Product, ScreenId } from '../types';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { ExcelImportModal, ImportedExcelProductResult } from '../components/ExcelImportModal';
import { ReceiptModal } from '../components/ReceiptModal';
import { playScannerBeep, playSuccessChime } from '../services/audio';
import { compressImageFile } from '../utils/image';
import { useBackHandler } from '../services/navigation';
import { generateUUID } from '../services/storage/uuid';
import {
  clearInvoiceDraft,
  getInvoiceDraft,
  initializeEditInvoiceDraft,
  saveInvoiceDraft,
} from '../utils/invoiceDraftStore';

interface InvoiceScreenProps {
  type: InvoiceType;
  onBack: () => void;
  onNavigate?: (screen: ScreenId) => void;
  editingInvoice?: Invoice | null;
  onCancelEdit?: () => void;
}

export const InvoiceScreen: React.FC<InvoiceScreenProps> = ({
  type,
  onNavigate,
  editingInvoice = null,
  onCancelEdit,
}) => {
  const isSale = type === 'sale' || type === 'sale_return' || type === 'quote';
  const isEditMode = Boolean(
    editingInvoice &&
      (editingInvoice.type === 'sale' || editingInvoice.type === 'purchase') &&
      editingInvoice.type === type
  );
  const settings = DB.getSettings();
  const [productsFontSize, setProductsFontSize] = useState<number>(
    settings.productsFontSize || 15
  );

  const draftMode: 'new' | 'edit' = isEditMode ? 'edit' : 'new';
  const initialDraftRef = useRef<ReturnType<typeof getInvoiceDraft> | null | undefined>(undefined);
  if (initialDraftRef.current === undefined) {
    if (isEditMode && editingInvoice) {
      const existingEdit = getInvoiceDraft(type, 'edit');
      if (existingEdit && existingEdit.editingInvoice?.id === editingInvoice.id) {
        initialDraftRef.current = existingEdit;
      } else {
        const existingItems = DB.getInvoiceItems(editingInvoice.id);
        initialDraftRef.current = initializeEditInvoiceDraft(
          editingInvoice,
          existingItems,
          settings.currency || 'د.ع'
        ).draft;
      }
    } else {
      initialDraftRef.current = getInvoiceDraft(type, 'new');
    }
  }
  const initialDraft = initialDraftRef.current;

  const [items, setItems] = useState<InvoiceItem[]>(() => initialDraft?.items ?? []);
  const [parties, setParties] = useState<Party[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(
    () => initialDraft?.selectedPartyId ?? null
  );
  const [discount, setDiscount] = useState<number>(() => Number(initialDraft?.discount) || 0);
  const [paid, setPaid] = useState<string>(() => initialDraft?.paid ?? '');
  const [invoiceCurrency, setInvoiceCurrency] = useState<string>(
    () => initialDraft?.invoiceCurrency || settings.currency || 'د.ع'
  );

  // Search / Add bar state matching screenshot
  const [searchQuery, setSearchQuery] = useState<string>(() => initialDraft?.searchQuery ?? '');
  const [suggestions, setSuggestions] = useState<Product[]>([]);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [optionsMenuOpen, setOptionsMenuOpen] = useState<boolean>(false);
  const [bottomOptionsOpen, setBottomOptionsOpen] = useState<boolean>(false);

  const [scannerOpen, setScannerOpen] = useState<boolean>(false);
  const [pickModalOpen, setPickModalOpen] = useState<boolean>(false);
  const [newPartyModalOpen, setNewPartyModalOpen] = useState<boolean>(false);
  const [newPartyName, setNewPartyName] = useState<string>('');
  const [newPartyPhone, setNewPartyPhone] = useState<string>('');

  // New Product / Type Modal state (for Purchases)
  const [newProductModalOpen, setNewProductModalOpen] = useState<boolean>(false);
  const [excelImportOpen, setExcelImportOpen] = useState<boolean>(false);
  const [newProdCategory, setNewProdCategory] = useState<string>('عام');
  const [customCategoryInput, setCustomCategoryInput] = useState<string>('');
  const [isWritingCustomCategory, setIsWritingCustomCategory] = useState<boolean>(false);
  const [newProdName, setNewProdName] = useState<string>('');
  const [newProdQty, setNewProdQty] = useState<string>('1');
  const [newProdBuyPrice, setNewProdBuyPrice] = useState<string>('');
  const [newProdSellPrice, setNewProdSellPrice] = useState<string>('');
  const [newProdBarcode, setNewProdBarcode] = useState<string>('');
  const [newProdImage, setNewProdImage] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const saveLockRef = useRef<boolean>(false);
  const draftIdempotencyKeyRef = useRef<string | null>(initialDraft?.idempotencyKey ?? null);

  // Editing single item modal state
  const [editingItem, setEditingItem] = useState<{
    index: number;
    name: string;
    category: string;
    isCustomCategory?: boolean;
    qty: number;
    price: number;
    sell_price?: number;
  } | null>(null);

  // Saved receipt modal state
  const [savedInvoice, setSavedInvoice] = useState<Invoice | null>(null);
  const [savedItems, setSavedItems] = useState<InvoiceItem[]>([]);
  const [receiptOpen, setReceiptOpen] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [originalSaleQtyMap, setOriginalSaleQtyMap] = useState<Record<number, number>>(
    () => initialDraft?.originalSaleQtyMap ?? {}
  );
  const hydratedSlotKeyRef = useRef<string>(
    `${draftMode}:${type}:${editingInvoice?.id ?? 'new'}`
  );
  const skipFirstIdempotencyResetRef = useRef<boolean>(true);
  const editSavedPendingCloseRef = useRef<boolean>(false);

  // Parked / Held invoices state for busy cashiers
  const [heldInvoices, setHeldInvoices] = useState<
    {
      id: string;
      time: string;
      partyId: number | null;
      partyName: string;
      items: InvoiceItem[];
      discount: number;
    }[]
  >(() => {
    try {
      return DB.getHeldInvoices(`cashier_held_${type}`);
    } catch {
      return [];
    }
  });

  const saveHeldInvoicesList = (
    list: {
      id: string;
      time: string;
      partyId: number | null;
      partyName: string;
      items: InvoiceItem[];
      discount: number;
    }[]
  ) => {
    setHeldInvoices(list);
    DB.saveHeldInvoices(`cashier_held_${type}`, list);
  };

  const handleHoldCurrentInvoice = () => {
    if (items.length === 0) return;
    const chosenParty = parties.find((p) => p.id === selectedPartyId);
    const newHeld = {
      id: `hold_${Date.now()}`,
      time: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
      partyId: selectedPartyId,
      partyName: chosenParty?.name || (isSale ? 'عميل نقدي' : 'مورد نقدي'),
      items: [...items],
      discount,
    };
    saveHeldInvoicesList([newHeld, ...heldInvoices]);
    draftIdempotencyKeyRef.current = null;
    clearInvoiceDraft(type, 'new');
    setItems([]);
    setDiscount(0);
    setPaid('');
    setSelectedPartyId(null);
  };

  const handleRestoreHeldInvoice = (holdId: string) => {
    const found = heldInvoices.find((h) => h.id === holdId);
    if (!found) return;
    draftIdempotencyKeyRef.current = null;
    setItems(found.items);
    setSelectedPartyId(found.partyId);
    setDiscount(found.discount);
    setPaid('');
    saveHeldInvoicesList(heldInvoices.filter((h) => h.id !== holdId));
  };

  const handleCloseReceipt = () => {
    setReceiptOpen(false);
    if (editSavedPendingCloseRef.current) {
      editSavedPendingCloseRef.current = false;
      onCancelEdit?.();
    }
  };

  // Step-by-step phone Back button handlers
  useBackHandler(scannerOpen, () => setScannerOpen(false));
  useBackHandler(pickModalOpen, () => setPickModalOpen(false));
  useBackHandler(newPartyModalOpen, () => setNewPartyModalOpen(false));
  useBackHandler(newProductModalOpen, () => setNewProductModalOpen(false));
  useBackHandler(editingItem !== null, () => setEditingItem(null));
  useBackHandler(receiptOpen, handleCloseReceipt);
  useBackHandler(optionsMenuOpen, () => setOptionsMenuOpen(false));
  useBackHandler(bottomOptionsOpen, () => setBottomOptionsOpen(false));

  const loadParties = () => {
    setParties(DB.getParties(isSale ? 'customer' : 'supplier'));
    setCategories(DB.getCategories());
    const s = DB.getSettings();
    if (!isEditMode) {
      setInvoiceCurrency((prev) => prev || s.currency || 'د.ع');
    }
    setProductsFontSize(s.productsFontSize || 15);
  };

  useEffect(() => {
    loadParties();
    return DB.subscribe(loadParties);
  }, [type, isEditMode]);

  useEffect(() => {
    const nextSlotKey = `${draftMode}:${type}:${editingInvoice?.id ?? 'new'}`;
    if (hydratedSlotKeyRef.current === nextSlotKey) {
      return;
    }
    hydratedSlotKeyRef.current = nextSlotKey;
    editSavedPendingCloseRef.current = false;

    if (isEditMode && editingInvoice) {
      const existingEdit = getInvoiceDraft(type, 'edit');
      const resolved =
        existingEdit && existingEdit.editingInvoice?.id === editingInvoice.id
          ? existingEdit
          : initializeEditInvoiceDraft(
              editingInvoice,
              DB.getInvoiceItems(editingInvoice.id),
              DB.getSettings().currency || 'د.ع'
            ).draft;
      setOriginalSaleQtyMap(resolved.originalSaleQtyMap);
      setItems(resolved.items);
      setSelectedPartyId(resolved.selectedPartyId);
      setDiscount(resolved.discount);
      setPaid(resolved.paid);
      setInvoiceCurrency(resolved.invoiceCurrency);
      setSearchQuery(resolved.searchQuery);
      setErrorMessage(null);
      draftIdempotencyKeyRef.current = resolved.idempotencyKey;
      skipFirstIdempotencyResetRef.current = true;
    } else {
      const savedNew = getInvoiceDraft(type, 'new');
      setOriginalSaleQtyMap({});
      setItems(savedNew?.items ?? []);
      setSelectedPartyId(savedNew?.selectedPartyId ?? null);
      setDiscount(savedNew?.discount ?? 0);
      setPaid(savedNew?.paid ?? '');
      setInvoiceCurrency(savedNew?.invoiceCurrency || DB.getSettings().currency || 'د.ع');
      setSearchQuery(savedNew?.searchQuery ?? '');
      setErrorMessage(null);
      draftIdempotencyKeyRef.current = savedNew?.idempotencyKey ?? null;
      skipFirstIdempotencyResetRef.current = true;
    }
  }, [draftMode, isEditMode, editingInvoice?.id, type]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    setSuggestions(DB.getProducts(q).slice(0, 8));
  }, [searchQuery]);

  useEffect(() => {
    if (skipFirstIdempotencyResetRef.current) {
      skipFirstIdempotencyResetRef.current = false;
      return;
    }
    draftIdempotencyKeyRef.current = null;
  }, [items, discount, paid, selectedPartyId, type, draftMode]);

  useEffect(() => {
    if (editSavedPendingCloseRef.current) return;
    if (
      draftMode === 'new' &&
      items.length === 0 &&
      selectedPartyId === null &&
      Number(discount) === 0 &&
      paid === '' &&
      searchQuery === ''
    ) {
      clearInvoiceDraft(type, 'new');
      return;
    }
    saveInvoiceDraft({
      type,
      mode: draftMode,
      items,
      selectedPartyId,
      discount,
      paid,
      invoiceCurrency,
      searchQuery,
      editingInvoice: isEditMode ? editingInvoice : null,
      originalSaleQtyMap: isEditMode ? originalSaleQtyMap : {},
      idempotencyKey: draftIdempotencyKeyRef.current,
    });
  }, [
    type,
    draftMode,
    isEditMode,
    editingInvoice,
    items,
    selectedPartyId,
    discount,
    paid,
    invoiceCurrency,
    searchQuery,
    originalSaleQtyMap,
  ]);

  const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0));
  const paidNumber = paid === '' ? total : Number(paid) || 0;
  const remaining = Math.max(0, total - paidNumber);

  const getEffectiveSaleAvailableQty = (productId: number, currentWarehouseQty: number): number => {
    const current = Number(currentWarehouseQty) || 0;
    if (!isEditMode || type !== 'sale') return current;
    return current + (Number(originalSaleQtyMap[productId]) || 0);
  };

  const addProductToInvoice = (product: Product) => {
    const existingIndex = items.findIndex((i) => i.product_id === product.id);
    const currentCartQty = items
      .filter((i) => i.product_id === product.id)
      .reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
    const nextQty = currentCartQty + 1;

    if (type === 'sale') {
      const available = getEffectiveSaleAvailableQty(product.id, Number(product.qty) || 0);
      if (available <= 0 || nextQty > available) {
        setErrorMessage(
          `لا يمكن بيع "${product.name}" — الكمية المطلوبة (${nextQty}) تتجاوز الرصيد المتاح في المخزن (${available}).`
        );
        playScannerBeep(false);
        return;
      }
    }

    if (existingIndex >= 0) {
      const updated = [...items];
      updated[existingIndex] = {
        ...updated[existingIndex],
        qty: updated[existingIndex].qty + 1,
      };
      setItems(updated);
    } else {
      const newItem: InvoiceItem = {
        product_id: product.id,
        name: product.name,
        category: product.category,
        qty: 1,
        price: isSale ? product.sell_price : product.buy_price,
        cost: product.buy_price,
        sell_price: product.sell_price,
        image: product.image,
      };
      setItems([...items, newItem]);
    }
    playScannerBeep(true);
    setSearchQuery('');
    setShowSuggestions(false);
    setErrorMessage(null);
  };

  const handleAddButtonClick = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = searchQuery.trim();

    if (q) {
      // Check exact barcode match first
      const byBarcode = DB.getProductByBarcode(q);
      if (byBarcode) {
        addProductToInvoice(byBarcode);
        return;
      }

      // Check exact name match
      const matches = DB.getProducts(q);
      const exactMatch = matches.find((p) => p.name.toLowerCase() === q.toLowerCase());
      if (exactMatch) {
        addProductToInvoice(exactMatch);
        return;
      }

      // If in Purchases and typed a new name -> open New Product modal with name pre-filled
      if (!isSale) {
        setNewProdName(q);
        setNewProductModalOpen(true);
        setShowSuggestions(false);
        return;
      }

      // If in Sales and there is a partial match -> add first match
      if (matches.length > 0) {
        addProductToInvoice(matches[0]);
        return;
      }

      setErrorMessage(`لم يتم العثور على "${q}" في المخزن`);
      playScannerBeep(false);
      return;
    }

    // When input is empty and user clicks "اضف":
    if (!isSale) {
      // In Purchases: open modal to write a new product/type or pick from warehouse
      setNewProdName('');
      setNewProductModalOpen(true);
    } else {
      // In Sales: open product picker modal
      setPickModalOpen(true);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setNewProdImage(compressed);
    } catch {
      setErrorMessage('تعذر رفع الصورة، يرجى اختيار صورة صالحة');
    }
  };

  const handleCreateNewProductInPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!newProdName.trim()) {
      setErrorMessage('يرجى كتابة اسم المنتج / النوع الجديد');
      return;
    }

    setIsSubmitting(true);
    try {
      const finalCategory = isWritingCustomCategory
        ? customCategoryInput.trim() || 'عام'
        : newProdCategory.trim() || 'عام';
      await DB.addCategory(finalCategory);
      const qtyVal = Math.max(0.01, parseFloat(newProdQty) || 1);
      const buyVal = Math.max(0, parseFloat(newProdBuyPrice) || 0);
      const sellVal = Math.max(0, parseFloat(newProdSellPrice) || buyVal);

      const createdProduct = await DB.saveProduct({
        name: newProdName.trim(),
        category: finalCategory,
        barcode: newProdBarcode.trim() || undefined,
        buy_price: buyVal,
        sell_price: sellVal,
        qty: isSale ? 0 : qtyVal,
        currency: invoiceCurrency,
        image: newProdImage || undefined,
      });

      const newItem: InvoiceItem = {
        product_id: createdProduct.id,
        name: createdProduct.name,
        category: createdProduct.category,
        qty: qtyVal,
        price: isSale ? sellVal : buyVal,
        cost: buyVal,
        sell_price: sellVal,
        image: createdProduct.image,
        stockAlreadyAdded: !isSale,
        initialAddedQty: !isSale ? qtyVal : 0,
      };

      setItems((prev) => [...prev, newItem]);
      playSuccessChime();

      setNewProdName('');
      setNewProdQty('1');
      setNewProdBuyPrice('');
      setNewProdSellPrice('');
      setNewProdBarcode('');
      setNewProdImage('');
      setCustomCategoryInput('');
      setIsWritingCustomCategory(false);
      setNewProductModalOpen(false);
      setSearchQuery('');
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err?.message || 'حدث خطأ أثناء إضافة الصنف الجديد');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleScannerDetected = (code: string) => {
    const prod = DB.getProductByBarcode(code);
    if (prod) {
      addProductToInvoice(prod);
    } else if (!isSale) {
      // In purchases, allow creating a new product with this scanned barcode
      setNewProdBarcode(code);
      setNewProductModalOpen(true);
    } else {
      setErrorMessage(`لا يوجد منتج مسجل بالباركود: ${code}`);
      playScannerBeep(false);
    }
  };

  const updateItemQty = (index: number, newQty: number) => {
    if (newQty <= 0) {
      removeItem(index);
      return;
    }
    const roundedQty = Math.round(newQty * 100) / 100;
    const targetItem = items[index];
    if (type === 'sale' && targetItem) {
      const prod = DB.getProductById(targetItem.product_id);
      const otherQty = items
        .filter((_, idx) => idx !== index && items[idx].product_id === targetItem.product_id)
        .reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
      const available = getEffectiveSaleAvailableQty(targetItem.product_id, Number(prod?.qty) || 0);
      if (otherQty + roundedQty > available) {
        setErrorMessage(
          `الكمية المطلوبة من "${targetItem.name}" (${otherQty + roundedQty}) تتجاوز الرصيد المتاح (${available}).`
        );
        playScannerBeep(false);
        return;
      }
    }
    const updated = [...items];
    updated[index] = {
      ...updated[index],
      qty: roundedQty,
    };
    setItems(updated);
    setErrorMessage(null);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const handleSaveItemEdit = async () => {
    if (!editingItem || isSubmitting) return;
    const desiredQty = Math.max(0.01, Number(editingItem.qty) || 1);
    const targetItem = items[editingItem.index];
    if (type === 'sale' && targetItem) {
      const existingProd = DB.getProductById(targetItem.product_id);
      const otherQty = items
        .filter((_, idx) => idx !== editingItem.index && items[idx].product_id === targetItem.product_id)
        .reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
      const available = getEffectiveSaleAvailableQty(
        targetItem.product_id,
        Number(existingProd?.qty) || 0
      );
      if (otherQty + desiredQty > available) {
        setErrorMessage(
          `الكمية المطلوبة من "${editingItem.name}" (${otherQty + desiredQty}) تتجاوز الرصيد المتاح (${available}).`
        );
        return;
      }
    }
    setIsSubmitting(true);
    try {
      const updated = [...items];
      const finalName = editingItem.name.trim() || targetItem.name;
      const finalCategory = editingItem.category.trim() || targetItem.category || 'عام';
      await DB.addCategory(finalCategory);

      updated[editingItem.index] = {
        ...targetItem,
        name: finalName,
        category: finalCategory,
        qty: desiredQty,
        price: Math.max(0, Number(editingItem.price) || 0),
        sell_price:
          editingItem.sell_price !== undefined
            ? Math.max(0, Number(editingItem.sell_price) || 0)
            : targetItem.sell_price,
      };

      // In edit invoice mode, defer warehouse price mutation to the atomic DB.updateInvoice transaction on save
      if (!isEditMode) {
        const existingProd = DB.getProducts().find((p) => p.id === targetItem.product_id);
        if (existingProd) {
          await DB.saveProduct({
            ...existingProd,
            name: finalName,
            category: finalCategory,
            sell_price: isSale
              ? Math.max(0, Number(editingItem.price) || existingProd.sell_price)
              : editingItem.sell_price !== undefined
              ? Math.max(0, Number(editingItem.sell_price) || existingProd.sell_price)
              : existingProd.sell_price,
          });
        }
      }

      setItems(updated);
      setEditingItem(null);
      setErrorMessage(null);
      playSuccessChime();
    } catch (err: any) {
      setErrorMessage(err?.message || 'حدث خطأ أثناء تعديل بيانات البند');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPartyName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const created = await DB.addParty(
        newPartyName.trim(),
        newPartyPhone.trim(),
        isSale ? 'customer' : 'supplier'
      );
      setSelectedPartyId(created.id);
      setNewPartyName('');
      setNewPartyPhone('');
      setNewPartyModalOpen(false);
      playSuccessChime();
    } catch (err: any) {
      setErrorMessage(err?.message || 'حدث خطأ أثناء إضافة الطرف الجديد');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveInvoice = async () => {
    if (saveLockRef.current || isSubmitting) return;

    if (items.length === 0) {
      setErrorMessage('الرجاء إضافة منتج واحد على الأقل للفاتورة');
      return;
    }

    if (type === 'sale') {
      const requestedMap = new Map<number, { qty: number; name: string }>();
      for (const item of items) {
        const prev = requestedMap.get(item.product_id);
        const q = Number(item.qty) || 0;
        if (prev) {
          prev.qty += q;
        } else {
          requestedMap.set(item.product_id, { qty: q, name: item.name });
        }
      }
      for (const [productId, req] of requestedMap.entries()) {
        const prod = DB.getProductById(productId);
        const available = getEffectiveSaleAvailableQty(productId, Number(prod?.qty) || 0);
        if (!prod || req.qty > available) {
          setErrorMessage(
            `الكمية المطلوبة من "${req.name}" (${req.qty}) تتجاوز الرصيد المتاح في المخزن (${available}).`
          );
          playScannerBeep(false);
          return;
        }
      }
    }

    if (paidNumber < total && !selectedPartyId) {
      setErrorMessage(
        isSale
          ? 'اختر العميل لتسجيل المبلغ المتبقي عليه كدين'
          : 'اختر المورد لتسجيل المبلغ المتبقي له كمستحق'
      );
      return;
    }

    saveLockRef.current = true;
    setIsSubmitting(true);
    const idempotencyKey = draftIdempotencyKeyRef.current || generateUUID();
    draftIdempotencyKeyRef.current = idempotencyKey;
    saveInvoiceDraft({
      type,
      mode: draftMode,
      items,
      selectedPartyId,
      discount,
      paid,
      invoiceCurrency,
      searchQuery,
      editingInvoice: isEditMode ? editingInvoice : null,
      originalSaleQtyMap: isEditMode ? originalSaleQtyMap : {},
      idempotencyKey,
    });

    try {
      if (isEditMode && editingInvoice) {
        const updatedInvoice = await DB.updateInvoice({
          invoiceId: editingInvoice.id,
          partyId: selectedPartyId,
          items,
          discount: Number(discount) || 0,
          paid: paidNumber,
          currency: invoiceCurrency,
          editIdempotencyKey: idempotencyKey,
        });
        draftIdempotencyKeyRef.current = null;
        editSavedPendingCloseRef.current = true;
        clearInvoiceDraft(type, 'edit');
        playSuccessChime();
        setSavedInvoice(updatedInvoice);
        setSavedItems([...items]);
        setReceiptOpen(true);
        setErrorMessage(null);
      } else {
        const invoice = await DB.saveInvoice({
          type,
          partyId: selectedPartyId,
          items,
          discount: Number(discount) || 0,
          paid: paidNumber,
          currency: invoiceCurrency,
          idempotencyKey,
        });

        draftIdempotencyKeyRef.current = null;
        clearInvoiceDraft(type, 'new');
        playSuccessChime();
        setSavedInvoice(invoice);
        setSavedItems([...items]);
        setReceiptOpen(true);

        setItems([]);
        setDiscount(0);
        setPaid('');
        setSelectedPartyId(null);
        setSearchQuery('');
        setErrorMessage(null);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'حدث خطأ أثناء حفظ الفاتورة');
    } finally {
      saveLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div dir="rtl" className="relative space-y-4 pb-2">
      {/* Top Section */}
      <div className="space-y-3">
        {isEditMode && editingInvoice && (
          <div className="rounded-2xl border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-3 flex flex-wrap items-center justify-between gap-2.5 text-[14px]">
            <div className="font-bold text-[var(--color-warning)]">
              وضع تعديل الفاتورة <span className="app-num">{editingInvoice.invoice_number || `#${editingInvoice.id}`}</span> — سيتم تحديث المخزن والرصيد وسجل التدقيق ذرياً عند الحفظ
            </div>
            {onCancelEdit && (
              <button
                type="button"
                onClick={onCancelEdit}
                className="app-btn-secondary shrink-0 px-3.5 py-2 text-[14px]"
              >
                إلغاء التعديل
              </button>
            )}
          </div>
        )}

        {/* Row 1: Right "اضف منتج" | Left "استخدم الباركود" + Options ⋮ */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
          <h1 className="app-section-title">اضف منتج</h1>

          <div className="flex items-center gap-2">
            {!isSale && (
              <button
                type="button"
                onClick={() => setExcelImportOpen(true)}
                className="inline-flex items-center gap-1.5 min-h-[44px] rounded-xl border border-[var(--color-success-border)] bg-[var(--color-success-bg)] px-3.5 py-2 text-[14px] font-bold text-[var(--color-success)] transition cursor-pointer hover:opacity-90"
                title="استيراد منتجات من إكسل وتسعير البيع"
              >
                <FileSpreadsheet className="h-4 w-4" />
                <span>من إكسل</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-soft)] px-3.5 py-2 text-[14px] font-bold text-[var(--brand-soft-text)] hover:opacity-85 transition cursor-pointer"
            >
              استخدم الباركود
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setOptionsMenuOpen(!optionsMenuOpen)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
                title="خيارات"
              >
                <MoreVertical className="h-5 w-5" />
              </button>

              {optionsMenuOpen && (
                <>
                  <div
                    onClick={() => setOptionsMenuOpen(false)}
                    className="fixed inset-0 z-30"
                  />
                  {isSale ? (
                    <div className="absolute left-0 mt-1.5 w-72 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl p-3.5 z-40 space-y-2.5">
                      {/* Row 1: فواتير البيع | 🔍 */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-bold text-[var(--text-primary)]">
                          فواتير البيع
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsMenuOpen(false);
                              onNavigate?.('invoices_sale');
                            }}
                            className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center justify-center transition cursor-pointer"
                            title="بحث في فواتير البيع"
                          >
                            <Search className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* Row 2: فواتير المرتجع | 🔍 | + */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-bold text-[var(--text-primary)]">
                          فواتير المرتجع
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsMenuOpen(false);
                              onNavigate?.('invoices_return');
                            }}
                            className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center justify-center transition cursor-pointer"
                            title="بحث في فواتير المرتجع"
                          >
                            <Search className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsMenuOpen(false);
                              onNavigate?.('sale_return');
                            }}
                            className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center justify-center transition cursor-pointer"
                            title="إضافة فاتورة مرتجع"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* Row 3: عروض الاسعار | 🔍 | + */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-bold text-[var(--text-primary)]">
                          عروض الاسعار
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsMenuOpen(false);
                              onNavigate?.('invoices_quote');
                            }}
                            className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center justify-center transition cursor-pointer"
                            title="بحث في عروض الأسعار"
                          >
                            <Search className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsMenuOpen(false);
                              onNavigate?.('quote');
                            }}
                            className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] flex items-center justify-center transition cursor-pointer"
                            title="إضافة عرض سعر"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Purchase options menu */
                    <div className="absolute left-0 mt-1.5 w-64 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl py-2 z-40 text-[14px] font-bold">
                      <button
                        type="button"
                        onClick={() => {
                          setOptionsMenuOpen(false);
                          onNavigate?.('invoices_purchase');
                        }}
                        className="w-full min-h-[44px] text-right px-4 py-2.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-between cursor-pointer"
                      >
                        <span>فواتير الشراء</span>
                        <Search className="h-4 w-4 text-[var(--text-muted)]" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOptionsMenuOpen(false);
                          setPickModalOpen(true);
                        }}
                        className="w-full min-h-[44px] text-right px-4 py-2.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 cursor-pointer"
                      >
                        <ShoppingBag className="h-4 w-4 text-[var(--brand-primary)]" />
                        <span>اختيار من مخزن المنتجات</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOptionsMenuOpen(false);
                          setNewProductModalOpen(true);
                        }}
                        className="w-full min-h-[44px] text-right px-4 py-2.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 cursor-pointer"
                      >
                        <PackagePlus className="h-4 w-4 text-[var(--color-warning)]" />
                        <span>كتابة نوع / منتج جديد</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOptionsMenuOpen(false);
                          setExcelImportOpen(true);
                        }}
                        className="w-full min-h-[44px] text-right px-4 py-2.5 text-[var(--color-success)] hover:bg-[var(--color-success-bg)] flex items-center gap-2 cursor-pointer"
                      >
                        <FileSpreadsheet className="h-4 w-4" />
                        <span>استيراد منتجات من ملف إكسل</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOptionsMenuOpen(false);
                          setNewPartyModalOpen(true);
                        }}
                        className="w-full min-h-[44px] text-right px-4 py-2.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 cursor-pointer"
                      >
                        <UserPlus className="h-4 w-4 text-[var(--brand-primary)]" />
                        <span>إضافة مورد جديد</span>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Row 2: Unified Bar -> Right button "اضف" + Left input */}
        <div className="relative">
          <form
            onSubmit={handleAddButtonClick}
            className="flex items-stretch rounded-2xl overflow-hidden shadow-xs border border-[var(--border-strong)] bg-[var(--bg-surface)]"
          >
            <button
              type="submit"
              className="bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] text-white font-bold px-5 sm:px-7 min-h-[48px] text-[15px] transition shrink-0 cursor-pointer active:scale-98"
            >
              اضف
            </button>

            <input
              type="text"
              value={searchQuery}
              onFocus={() => setShowSuggestions(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSuggestions(true);
              }}
              placeholder={isSale ? 'ادخل اسم منتج بالفاتورة' : 'ادخل اسم منتج او صنف بالفاتورة'}
              className="w-full bg-[var(--bg-surface)] px-3.5 sm:px-4 min-h-[48px] text-[16px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-hidden text-right"
            />
          </form>

          {/* Instant Autocomplete Dropdown when typing */}
          {showSuggestions && searchQuery.trim() !== '' && (
            <div className="absolute inset-x-0 top-full mt-1.5 z-30 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl overflow-hidden divide-y divide-[var(--border-default)] max-h-72 overflow-y-auto">
              {suggestions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addProductToInvoice(p)}
                  style={{ fontSize: `${productsFontSize}px` }}
                  className="w-full min-h-[48px] flex items-center justify-between px-4 py-3 text-right hover:bg-[var(--bg-hover)] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    {p.image ? (
                      <img
                        src={p.image}
                        alt={p.name}
                        className="h-10 w-10 rounded-xl object-cover border border-[var(--border-default)] shrink-0"
                      />
                    ) : null}
                    <div>
                      <span className="font-bold text-[var(--text-primary)] block">{p.name}</span>
                      <span className="text-[13px] text-[var(--text-muted)] app-num">
                        {p.category || 'عام'} • المخزن: {p.qty}
                      </span>
                    </div>
                  </div>
                  <span className="app-num font-bold text-[var(--color-success)] text-[15px]">
                    {(isSale ? p.sell_price : p.buy_price).toFixed(0)} {invoiceCurrency}
                  </span>
                </button>
              ))}

              {!isSale && (
                <button
                  type="button"
                  onClick={() => {
                    setNewProdName(searchQuery.trim());
                    setShowSuggestions(false);
                    setNewProductModalOpen(true);
                  }}
                  className="w-full min-h-[48px] flex items-center justify-between px-4 py-3 bg-[var(--color-warning-bg)] hover:opacity-90 text-[var(--color-warning)] text-[14px] font-bold transition cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <PackagePlus className="h-4 w-4" />
                    كتابة نوع جديد باسم: &quot;{searchQuery.trim()}&quot;
                  </span>
                  <span>+ إضافة للمخزن</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error alert if any */}
        {errorMessage && (
          <div className="p-3.5 bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger)] text-[14px] font-bold rounded-xl flex items-center justify-between">
            <span>{errorMessage}</span>
            <button
              onClick={() => setErrorMessage(null)}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] font-bold cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {/* Held / Parked Invoices Strip */}
        {heldInvoices.length > 0 && (
          <div className="bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] rounded-2xl p-3 space-y-2">
            <div className="text-[13px] font-bold text-[var(--color-warning)]">
              فواتير معلقة مؤقتاً (<span className="app-num">{heldInvoices.length}</span>) — اضغط لاسترجاع الفاتورة:
            </div>
            <div className="flex flex-wrap gap-2">
              {heldInvoices.map((h) => (
                <div
                  key={h.id}
                  className="inline-flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--color-warning-border)] rounded-xl px-3 py-1.5 text-[14px] font-bold text-[var(--text-primary)] shadow-2xs"
                >
                  <button
                    type="button"
                    onClick={() => handleRestoreHeldInvoice(h.id)}
                    className="hover:text-[var(--brand-primary)] cursor-pointer min-h-[36px] inline-flex items-center"
                  >
                    <span>{h.partyName}</span>
                    <span className="text-[var(--text-muted)] mx-1.5">·</span>
                    <span className="text-[var(--color-success)] app-num">{h.items.length} أصناف</span>
                    <span className="text-[var(--text-muted)] mr-1.5 text-[12px] app-num">({h.time})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      saveHeldInvoicesList(heldInvoices.filter((item) => item.id !== h.id))
                    }
                    className="text-[var(--text-muted)] hover:text-[var(--color-danger)] px-1.5 min-h-[36px] cursor-pointer"
                    title="إلغاء الفاتورة المعلقة"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Added Invoice Items List */}
        {items.length > 0 && (
          <div className="app-card overflow-hidden mt-3">
            <div className="border-b border-[var(--border-default)] px-4 py-3 flex items-center justify-between bg-[var(--bg-surface-subtle)]">
              <span className="font-bold text-[var(--text-primary)] text-[15px]">
                الأصناف المضافة (<span className="app-num">{items.length}</span>)
              </span>
              <button
                type="button"
                onClick={() => setItems([])}
                className="min-h-[38px] px-2.5 rounded-lg text-[14px] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] font-bold flex items-center gap-1.5 cursor-pointer transition"
              >
                <Trash2 className="h-4 w-4" /> تفريغ
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-[14px] sm:text-[15px]">
                <thead className="app-table-head text-[13px] sm:text-[14px]">
                  <tr>
                    <th className="px-3 py-3">المنتج</th>
                    <th className="px-2 py-3 text-center">العدد</th>
                    <th className="px-2 py-3 text-center">السعر</th>
                    <th className="px-3 py-3 text-left">الإجمالي</th>
                    <th className="px-2 py-3 text-center w-24">إجراء</th>
                  </tr>
                </thead>
                <tbody
                  style={{ fontSize: `${productsFontSize}px` }}
                  className="divide-y divide-[var(--border-default)]"
                >
                  {items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-[var(--bg-hover)] transition">
                      <td className="px-3 py-2.5 font-semibold text-[var(--text-primary)] max-w-[140px] sm:max-w-none">
                        <div className="flex items-center gap-2">
                          {item.image ? (
                            <img
                              src={item.image}
                              alt={item.name}
                              className="h-9 w-9 rounded-lg object-cover border border-[var(--border-default)] shrink-0"
                            />
                          ) : null}
                          <div className="min-w-0">
                            <div
                              style={{ fontSize: `${productsFontSize}px` }}
                              className="font-bold text-[var(--text-primary)] truncate"
                            >
                              {item.name}
                            </div>
                            {item.category && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--brand-soft-text)] bg-[var(--brand-soft)] px-1.5 py-0.5 rounded mt-0.5">
                                <Tag className="h-2.5 w-2.5" />
                                {item.category}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-1.5 py-2.5 text-center">
                        <div className="inline-flex items-center rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface-subtle)] p-0.5">
                          <button
                            type="button"
                            onClick={() => updateItemQty(idx, item.qty - 1)}
                            className="h-9 w-8 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-lg cursor-pointer"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <input
                            type="number"
                            step="any"
                            value={item.qty}
                            onChange={(e) => updateItemQty(idx, parseFloat(e.target.value) || 0)}
                            className="w-10 text-center text-[14px] font-bold app-num bg-transparent text-[var(--text-primary)] focus:outline-hidden"
                          />
                          <button
                            type="button"
                            onClick={() => updateItemQty(idx, item.qty + 1)}
                            className="h-9 w-8 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-lg cursor-pointer"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-center app-num font-bold text-[var(--text-secondary)]">
                        {item.price.toFixed(0)}
                      </td>
                      <td className="px-3 py-2.5 text-left app-num font-extrabold text-[var(--text-primary)]">
                        {(item.qty * item.price).toFixed(0)}
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setEditingItem({
                                index: idx,
                                name: item.name,
                                category: item.category || 'عام',
                                isCustomCategory: false,
                                qty: item.qty,
                                price: item.price,
                                sell_price: item.sell_price,
                              })
                            }
                            className="h-9 w-9 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-soft)] transition cursor-pointer"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="h-9 w-9 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Compact Checkout Panel (Shown when items are added) */}
      {items.length > 0 && (
        <div className="app-card p-4 sm:p-5 space-y-4">
          {/* Quick 1-Tap Payment Type Selector: Cash vs Credit/Debt */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-default)]">
            <div className="flex items-center gap-1.5 p-1 bg-[var(--bg-surface-subtle)] rounded-xl border border-[var(--border-default)]">
              <button
                type="button"
                onClick={() => setPaid('')}
                className={`px-3.5 min-h-[40px] rounded-lg text-[14px] font-bold transition cursor-pointer ${
                  paid === '' || Number(paid) === total
                    ? 'bg-[var(--color-success)] text-white shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                نقدي بالكامل
              </button>
              <button
                type="button"
                onClick={() => setPaid('0')}
                className={`px-3.5 min-h-[40px] rounded-lg text-[14px] font-bold transition cursor-pointer ${
                  paid === '0'
                    ? 'bg-[var(--color-danger)] text-white shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                آجل (دين بالكامل)
              </button>
            </div>

            {!isEditMode && (
              <button
                type="button"
                onClick={handleHoldCurrentInvoice}
                className="min-h-[44px] rounded-xl border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] hover:opacity-90 text-[var(--color-warning)] px-4 py-2 text-[14px] font-bold transition cursor-pointer"
                title="تعليق الفاتورة مؤقتاً لخدمة عميل آخر"
              >
                تعليق الفاتورة مؤقتاً
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Party selector */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select
                  value={selectedPartyId || ''}
                  onChange={(e) => setSelectedPartyId(e.target.value ? Number(e.target.value) : null)}
                  className="app-input appearance-none font-bold"
                >
                  <option value="">{isSale ? 'عميل نقدي' : 'مورد نقدي'}</option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.balance?.toFixed(0) || 0})
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              </div>
              <button
                type="button"
                onClick={() => setNewPartyModalOpen(true)}
                className="app-btn-secondary h-[44px] w-[44px] px-0 shrink-0"
                title={isSale ? 'عميل جديد' : 'مورد جديد'}
              >
                <UserPlus className="h-4 w-4" />
              </button>
            </div>

            {/* Discount */}
            <div className="flex items-center gap-2 bg-[var(--bg-surface-subtle)] px-3.5 min-h-[44px] rounded-xl border border-[var(--border-strong)]">
              <span className="text-[14px] font-bold text-[var(--text-secondary)] shrink-0">الخصم:</span>
              <input
                type="number"
                min="0"
                step="any"
                value={discount || ''}
                onChange={(e) => setDiscount(Math.max(0, parseFloat(e.target.value) || 0))}
                placeholder="0"
                className="w-full bg-transparent text-[16px] app-num font-bold text-[var(--text-primary)] focus:outline-hidden"
              />
            </div>

            {/* Paid */}
            <div className="flex items-center gap-2 bg-[var(--bg-surface-subtle)] px-3.5 min-h-[44px] rounded-xl border border-[var(--border-strong)]">
              <span className="text-[14px] font-bold text-[var(--text-secondary)] shrink-0">المدفوع:</span>
              <input
                type="number"
                min="0"
                step="any"
                value={paid}
                onChange={(e) => setPaid(e.target.value)}
                placeholder={total.toFixed(0)}
                className="w-full bg-transparent text-[16px] app-num font-bold text-[var(--text-primary)] focus:outline-hidden"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between pt-3 border-t border-[var(--border-default)] gap-3">
            <div>
              <span className="text-[13px] text-[var(--text-secondary)] block">الإجمالي المطلوب:</span>
              <span className="text-2xl font-extrabold app-num text-[var(--brand-primary)]">
                {total.toFixed(0)} <span className="text-[14px] font-bold">{invoiceCurrency}</span>
              </span>
              {remaining > 0 && (
                <span className="text-[14px] font-bold text-[var(--color-danger)] mr-3 app-num">
                  (متبقي دين: {remaining.toFixed(0)})
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isSale && (
                <button
                  type="button"
                  onClick={() => setBottomOptionsOpen(true)}
                  className="h-12 w-12 rounded-xl bg-[var(--bg-surface-subtle)] border border-[var(--border-strong)] text-[var(--brand-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition active:scale-95 cursor-pointer shrink-0"
                  title="خيارات"
                  aria-label="خيارات"
                >
                  <MoreVertical className="h-5 w-5 stroke-[2.4]" />
                </button>
              )}

              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleSaveInvoice}
                className="app-btn-primary px-6 py-3 min-h-[48px] text-[15px] shadow-md"
              >
                <Check className="h-5 w-5" />
                <span>
                  {isSubmitting
                    ? 'جاري الحفظ...'
                    : isEditMode
                    ? 'حفظ تعديل الفاتورة'
                    : 'حفظ الفاتورة'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Non-overlapping In-Flow ⋮ Options Button when sale cart is empty */}
      {isSale && items.length === 0 && (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => setBottomOptionsOpen(true)}
            className="h-11 px-3.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--brand-primary)] hover:bg-[var(--bg-hover)] shadow-2xs flex items-center gap-1.5 text-[14px] font-bold transition active:scale-95 cursor-pointer"
            title="خيارات"
            aria-label="خيارات"
          >
            <MoreVertical className="h-4 w-4 stroke-[2.4]" />
            <span>خيارات</span>
          </button>
        </div>
      )}

      {/* Bottom-Sheet "خيارات" Modal */}
      {bottomOptionsOpen && (
        <div
          onClick={() => setBottomOptionsOpen(false)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[1px] overflow-y-auto overscroll-contain"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-t-3xl bg-[var(--bg-surface)] border-t border-[var(--border-default)] shadow-2xl pb-6"
          >
            <div className="py-4 text-center border-b border-[var(--border-default)]">
              <h3 className="app-section-title">خيارات</h3>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Row 1: فواتير البيع | [بحث] */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[17px] font-bold text-[var(--text-primary)]">فواتير البيع</span>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setBottomOptionsOpen(false);
                      onNavigate?.('invoices_sale');
                    }}
                    className="app-btn-secondary min-w-[100px] px-5"
                  >
                    بحث
                  </button>
                </div>
              </div>

              {/* Row 2: فواتير المرتجع | [بحث] [اضف] */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[17px] font-bold text-[var(--text-primary)]">فواتير المرتجع</span>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setBottomOptionsOpen(false);
                      onNavigate?.('invoices_return');
                    }}
                    className="app-btn-secondary min-w-[100px] px-5"
                  >
                    بحث
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBottomOptionsOpen(false);
                      onNavigate?.('sale_return');
                    }}
                    className="app-btn-primary min-w-[100px] px-5"
                  >
                    اضف
                  </button>
                </div>
              </div>

              {/* Row 3: عروض الاسعار | [بحث] [اضف] */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[17px] font-bold text-[var(--text-primary)]">عروض الاسعار</span>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setBottomOptionsOpen(false);
                      onNavigate?.('invoices_quote');
                    }}
                    className="app-btn-secondary min-w-[100px] px-5"
                  >
                    بحث
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBottomOptionsOpen(false);
                      onNavigate?.('quote');
                    }}
                    className="app-btn-primary min-w-[100px] px-5"
                  >
                    اضف
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add New Product / Type Modal (in Purchases) */}
      {newProductModalOpen && (
        <div className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto overscroll-contain">
          <div className="relative m-auto w-full max-w-md rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 sm:p-6 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-default)] mb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-10 w-10 rounded-xl bg-[var(--color-warning-bg)] text-[var(--color-warning)] flex items-center justify-center">
                  <PackagePlus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="app-section-title text-[17px]">
                    إضافة نوع / منتج جديد للمشتريات
                  </h3>
                  <p className="app-meta-text">
                    سيتم إضافته للفاتورة الحالية وتسجيله في المخزن تلقائياً
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewProductModalOpen(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-2 rounded-lg cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateNewProductInPurchase} className="space-y-4">
              {/* 1. Category */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[14px] font-bold text-[var(--text-secondary)]">الصنف (التصنيف):</label>
                  <button
                    type="button"
                    onClick={() => setIsWritingCustomCategory(!isWritingCustomCategory)}
                    className="text-[13px] font-bold text-[var(--brand-primary)] hover:underline cursor-pointer"
                  >
                    {isWritingCustomCategory ? 'اختيار من الأصناف الموجودة' : '+ كتابة صنف جديد'}
                  </button>
                </div>

                {isWritingCustomCategory ? (
                  <input
                    type="text"
                    required
                    value={customCategoryInput}
                    onChange={(e) => setCustomCategoryInput(e.target.value)}
                    placeholder="اكتب اسم الصنف الجديد (مثال: شاشات، إكسسوارات...)"
                    className="app-input"
                  />
                ) : (
                  <div className="relative">
                    <select
                      value={newProdCategory}
                      onChange={(e) => setNewProdCategory(e.target.value)}
                      className="app-input appearance-none font-semibold"
                    >
                      {categories.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                  </div>
                )}
              </div>

              {/* 2. Product Name */}
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                  اسم المنتج / النوع الجديد:
                </label>
                <input
                  type="text"
                  required
                  value={newProdName}
                  onChange={(e) => setNewProdName(e.target.value)}
                  placeholder="اكتب اسم المنتج أو النوع..."
                  className="app-input"
                />
              </div>

              {/* 3. Quantity & Barcode */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                    العدد (الكمية):
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    value={newProdQty}
                    onChange={(e) => setNewProdQty(e.target.value)}
                    placeholder="1"
                    className="app-input app-num font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                    الباركود (اختياري):
                  </label>
                  <input
                    type="text"
                    value={newProdBarcode}
                    onChange={(e) => setNewProdBarcode(e.target.value)}
                    placeholder="اختياري"
                    dir="ltr"
                    className="app-input app-num"
                  />
                </div>
              </div>

              {/* 4. Purchase Price & Selling Price */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                    سعر الشراء ({invoiceCurrency}):
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={newProdBuyPrice}
                    onChange={(e) => setNewProdBuyPrice(e.target.value)}
                    placeholder="0.00"
                    className="app-input app-num font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                    سعر البيع ({invoiceCurrency}):
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={newProdSellPrice}
                    onChange={(e) => setNewProdSellPrice(e.target.value)}
                    placeholder="0.00"
                    className="app-input app-num font-bold text-[var(--color-success)]"
                  />
                </div>
              </div>

              {/* 5. Optional Product Image */}
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                  صورة المنتج (اختياري):
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                />

                {newProdImage ? (
                  <div className="relative flex items-center gap-3 p-2.5 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)]">
                    <img
                      src={newProdImage}
                      alt="معاينة المنتج"
                      className="h-16 w-16 rounded-xl object-cover border border-[var(--border-default)]"
                    />
                    <div className="flex-1 text-[14px]">
                      <p className="font-bold text-[var(--text-primary)]">تم إرفاق صورة المنتج</p>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[var(--brand-primary)] font-bold hover:underline mt-1 block cursor-pointer"
                      >
                        تغيير الصورة
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNewProdImage('')}
                      className="p-2 rounded-lg bg-[var(--color-danger-bg)] text-[var(--color-danger)] hover:opacity-85 cursor-pointer"
                      title="حذف الصورة"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--bg-surface-subtle)] py-3.5 px-4 text-[14px] font-bold text-[var(--text-secondary)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition cursor-pointer"
                  >
                    <ImageIcon className="h-4 w-4" />
                    <span>اضغط لاختيار صورة للمنتج (اختياري)</span>
                  </button>
                )}
              </div>

              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setNewProductModalOpen(false)}
                  className="app-btn-secondary flex-1"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="app-btn-primary flex-1"
                >
                  إضافة للفاتورة والمخزن
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Barcode Scanner Modal */}
      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScannerDetected}
        title={isSale ? 'مسح باركود منتج للبيع' : 'مسح باركود منتج للتوريد'}
      />

      {/* Pick Product Modal */}
      {pickModalOpen && (
        <ProductPickModal
          isOpen={pickModalOpen}
          onClose={() => setPickModalOpen(false)}
          onSelect={(p) => {
            addProductToInvoice(p);
            setPickModalOpen(false);
          }}
          onOpenCreateNew={() => {
            setPickModalOpen(false);
            setNewProductModalOpen(true);
          }}
        />
      )}

      {/* Add New Party Modal */}
      {newPartyModalOpen && (
        <div className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto overscroll-contain">
          <div className="m-auto w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 sm:p-6 shadow-2xl">
            <h3 className="app-section-title mb-4">
              {isSale ? 'إضافة عميل جديد' : 'إضافة مورد جديد'}
            </h3>
            <form onSubmit={handleCreateParty} className="space-y-4">
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">الاسم</label>
                <input
                  type="text"
                  required
                  value={newPartyName}
                  onChange={(e) => setNewPartyName(e.target.value)}
                  placeholder="مثال: أحمد محمد"
                  className="app-input"
                />
              </div>
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">رقم الهاتف</label>
                <input
                  type="tel"
                  value={newPartyPhone}
                  onChange={(e) => setNewPartyPhone(e.target.value)}
                  placeholder="مثال: 07701234567"
                  className="app-input app-num"
                  dir="ltr"
                />
              </div>
              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setNewPartyModalOpen(false)}
                  className="app-btn-secondary flex-1"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="app-btn-primary flex-1"
                >
                  حفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Single Item Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto overscroll-contain">
          <div className="m-auto w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 sm:p-6 shadow-2xl space-y-3.5">
            <h3 className="app-section-title text-center">تعديل بيانات الصنف والمنتج</h3>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[14px] font-bold text-[var(--text-secondary)]">الصنف (التصنيف)</label>
                <button
                  type="button"
                  onClick={() =>
                    setEditingItem({
                      ...editingItem,
                      isCustomCategory: !editingItem.isCustomCategory,
                    })
                  }
                  className="text-[13px] font-bold text-[var(--brand-primary)] hover:underline cursor-pointer"
                >
                  {editingItem.isCustomCategory ? 'اختيار من الأصناف' : '+ كتابة أو تعديل الصنف'}
                </button>
              </div>
              {editingItem.isCustomCategory ? (
                <input
                  type="text"
                  value={editingItem.category}
                  onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                  placeholder="اكتب اسم الصنف..."
                  className="app-input"
                />
              ) : (
                <select
                  value={editingItem.category}
                  onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                  className="app-input font-bold"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">اسم المنتج</label>
              <input
                type="text"
                value={editingItem.name}
                onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                className="app-input font-bold"
              />
            </div>

            <div>
              <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">العدد / الكمية</label>
              <input
                type="number"
                step="any"
                min="0.1"
                value={editingItem.qty}
                onChange={(e) =>
                  setEditingItem({ ...editingItem, qty: parseFloat(e.target.value) || 0 })
                }
                className="app-input app-num font-bold"
              />
            </div>
            <div>
              <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                {isSale ? `سعر البيع (${invoiceCurrency})` : `سعر الشراء (${invoiceCurrency})`}
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={editingItem.price}
                onChange={(e) =>
                  setEditingItem({ ...editingItem, price: parseFloat(e.target.value) || 0 })
                }
                className="app-input app-num font-bold"
              />
            </div>
            {!isSale && (
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">
                  سعر البيع للمستهلك ({invoiceCurrency})
                </label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={editingItem.sell_price ?? ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      sell_price: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="app-input app-num font-bold"
                />
              </div>
            )}
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="app-btn-secondary flex-1"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleSaveItemEdit}
                className="app-btn-primary flex-1"
              >
                حفظ التعديل
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excel Import & Pricing Modal (for Purchases) */}
      <ExcelImportModal
        isOpen={excelImportOpen}
        onClose={() => setExcelImportOpen(false)}
        mode="purchase_invoice"
        onImportComplete={(importedList: ImportedExcelProductResult[]) => {
          setItems((prev) => {
            const next = [...prev];
            importedList.forEach(({ product, importedQty, importedBuyPrice, chosenSellPrice }) => {
              const existingIdx = next.findIndex((i) => i.product_id === product.id);
              if (existingIdx >= 0) {
                next[existingIdx] = {
                  ...next[existingIdx],
                  qty: next[existingIdx].qty + importedQty,
                  price: isSale ? chosenSellPrice : importedBuyPrice,
                  sell_price: chosenSellPrice,
                  cost: importedBuyPrice,
                  initialAddedQty: (next[existingIdx].initialAddedQty || 0) + importedQty,
                };
              } else {
                next.push({
                  product_id: product.id,
                  name: product.name,
                  category: product.category,
                  qty: importedQty,
                  price: isSale ? chosenSellPrice : importedBuyPrice,
                  cost: importedBuyPrice,
                  sell_price: chosenSellPrice,
                  image: product.image,
                  stockAlreadyAdded: true,
                  initialAddedQty: importedQty,
                });
              }
            });
            return next;
          });
        }}
      />

      {/* Receipt Preview Modal */}
      <ReceiptModal
        isOpen={receiptOpen}
        onClose={handleCloseReceipt}
        invoice={savedInvoice}
        items={savedItems}
      />
    </div>
  );
};

// Subcomponent: Pick Product Modal
interface ProductPickModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (product: Product) => void;
  onOpenCreateNew: () => void;
}

const ProductPickModal: React.FC<ProductPickModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  onOpenCreateNew,
}) => {
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const settings = DB.getSettings();

  useEffect(() => {
    if (isOpen) {
      setProducts(DB.getProducts(search));
    }
  }, [isOpen, search]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto overscroll-contain">
      <div className="relative m-auto w-full max-w-lg rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-4 py-3.5">
          <h3 className="app-section-title text-[17px]">اختر منتج من المخزن</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenCreateNew}
              className="app-btn-primary px-3 py-1.5 min-h-[40px] text-[13px]"
            >
              + كتابة نوع جديد
            </button>
            <button
              onClick={onClose}
              className="rounded-lg h-10 w-10 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-[var(--border-default)]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو الباركود أو الصنف..."
            className="app-input"
          />
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-default)] p-2">
          {products.length === 0 ? (
            <div className="py-8 text-center space-y-3">
              <p className="text-[15px] text-[var(--text-muted)]">لا توجد منتجات مطابقة</p>
              <button
                type="button"
                onClick={onOpenCreateNew}
                className="inline-flex items-center gap-1.5 min-h-[44px] rounded-xl bg-[var(--color-warning-bg)] px-4 py-2 text-[14px] font-bold text-[var(--color-warning)] border border-[var(--color-warning-border)] cursor-pointer"
              >
                <PackagePlus className="h-4 w-4" /> إضافة نوع جديد
              </button>
            </div>
          ) : (
            products.map((p) => {
              const isOut = p.qty <= 0;
              return (
                <div
                  key={p.id}
                  onClick={() => onSelect(p)}
                  className="flex items-center justify-between p-3 hover:bg-[var(--bg-hover)] rounded-xl cursor-pointer transition"
                >
                  <div className="flex items-center gap-3">
                    {p.image ? (
                      <img
                        src={p.image}
                        alt={p.name}
                        className="h-11 w-11 rounded-xl object-cover border border-[var(--border-default)] shrink-0"
                      />
                    ) : (
                      <div className="h-11 w-11 rounded-xl bg-[var(--bg-surface-subtle)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
                        <ShoppingBag className="h-5 w-5" />
                      </div>
                    )}
                    <div>
                      <h4
                        style={{ fontSize: `${settings.productsFontSize || 15}px` }}
                        className="font-bold text-[var(--text-primary)]"
                      >
                        {p.name}
                      </h4>
                      <div className="text-[13px] text-[var(--text-secondary)] flex flex-wrap items-center gap-2 mt-0.5 app-num">
                        <span>بيع: {p.sell_price.toFixed(0)} {settings.currency}</span>
                        <span>•</span>
                        <span>شراء: {p.buy_price.toFixed(0)} {settings.currency}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[13px] px-3 py-1 rounded-full font-bold app-num ${
                        isOut
                          ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
                          : 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                      }`}
                    >
                      {p.qty}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
