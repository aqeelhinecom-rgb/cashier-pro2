import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Edit2,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Barcode,
  Image as ImageIcon,
  Check,
  Tag,
  FileSpreadsheet,
} from 'lucide-react';
import { DB } from '../services/db';
import { Product } from '../types';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { ExcelImportModal } from '../components/ExcelImportModal';
import { playSuccessChime } from '../services/audio';
import { compressImageFile } from '../utils/image';
import { useBackHandler } from '../services/navigation';

type SortField = 'name' | 'qty' | 'price';
type SortDirection = 'asc' | 'desc';

export const ProductsScreen: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [productsFontSize, setProductsFontSize] = useState<number>(
    DB.getSettings().productsFontSize || 15
  );

  // In-app Quick Add Qty & Delete Confirmation modals
  const [quickAddModalOpen, setQuickAddModalOpen] = useState(false);
  const [quickAddAmount, setQuickAddAmount] = useState('5');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Category Manager Modal state (إدارة الأصناف: إضافة وتعديل وحذف)
  const [categoriesModalOpen, setCategoriesModalOpen] = useState(false);
  const [excelModalOpen, setExcelModalOpen] = useState(false);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [editingCategoryName, setEditingCategoryName] = useState<string | null>(null);
  const [editingCategoryValue, setEditingCategoryValue] = useState('');

  // Step-by-step phone Back button handlers
  useBackHandler(selectedProduct !== null, () => setSelectedProduct(null));
  useBackHandler(editModalOpen, () => setEditModalOpen(false));
  useBackHandler(addModalOpen, () => setAddModalOpen(false));
  useBackHandler(scannerOpen, () => setScannerOpen(false));
  useBackHandler(quickAddModalOpen, () => setQuickAddModalOpen(false));
  useBackHandler(confirmDeleteOpen, () => setConfirmDeleteOpen(false));
  useBackHandler(categoriesModalOpen, () => setCategoriesModalOpen(false));

  // Edit fields
  const [editName, setEditName] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editBuyPrice, setEditBuyPrice] = useState('');
  const [editSellPrice, setEditSellPrice] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [isEditCustomCategory, setIsEditCustomCategory] = useState(false);
  const [editImage, setEditImage] = useState<string | undefined>(undefined);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  // Add Product fields
  const [newName, setNewName] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [newCategory, setNewCategory] = useState('عام');
  const [customCategory, setCustomCategory] = useState('');
  const [isCustomCategory, setIsCustomCategory] = useState(false);
  const [newBuyPrice, setNewBuyPrice] = useState('');
  const [newSellPrice, setNewSellPrice] = useState('');
  const [newQty, setNewQty] = useState('1');
  const [newImage, setNewImage] = useState<string>('');
  const addFileInputRef = useRef<HTMLInputElement>(null);

  const settings = DB.getSettings();
  const currency = settings.currency || 'د.ع';

  const loadProducts = () => {
    setProducts(DB.getProducts(search));
    setCategories(DB.getCategories());
    setProductsFontSize(DB.getSettings().productsFontSize || 15);
  };

  useEffect(() => {
    loadProducts();
    return DB.subscribe(loadProducts);
  }, [search]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
    }
  };

  const filteredProducts = products.filter((p) => {
    if (stockFilter === 'out' && p.qty > 0) return false;
    if (stockFilter === 'low' && (p.qty <= 0 || p.qty > 5)) return false;
    if (categoryFilter !== 'all' && (p.category || 'عام') !== categoryFilter) return false;
    return true;
  });

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    let comparison = 0;
    if (sortField === 'name') {
      comparison = a.name.localeCompare(b.name, 'ar');
    } else if (sortField === 'qty') {
      comparison = a.qty - b.qty;
    } else if (sortField === 'price') {
      comparison = a.sell_price - b.sell_price;
    }
    return sortDir === 'asc' ? comparison : -comparison;
  });

  const allWarehouseProducts = DB.getProducts();
  const totalBuyVal = allWarehouseProducts.reduce((s, p) => s + p.qty * p.buy_price, 0);
  const totalSellVal = allWarehouseProducts.reduce((s, p) => s + p.qty * p.sell_price, 0);
  const outCount = allWarehouseProducts.filter((p) => p.qty <= 0).length;
  const lowCount = allWarehouseProducts.filter((p) => p.qty > 0 && p.qty <= 5).length;

  const handleSelectProduct = (p: Product) => {
    setSelectedProduct(p);
    setEditName(p.name);
    setEditBarcode(p.barcode || '');
    setEditQty(p.qty.toString());
    setEditBuyPrice(p.buy_price.toString());
    setEditSellPrice(p.sell_price.toString());
    setEditCategory(p.category || 'عام');
    setIsEditCustomCategory(false);
    setEditImage(p.image);
    document.querySelector('.app-scroll-region')?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  const handleOpenEditModal = (p: Product) => {
    setSelectedProduct(p);
    setEditName(p.name);
    setEditBarcode(p.barcode || '');
    setEditQty(p.qty.toString());
    setEditBuyPrice(p.buy_price.toString());
    setEditSellPrice(p.sell_price.toString());
    setEditCategory(p.category || 'عام');
    setIsEditCustomCategory(false);
    setEditImage(p.image);
    setEditModalOpen(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || isSubmitting) return;

    try {
      setIsSubmitting(true);
      const finalCat = editCategory.trim() || 'عام';
      await DB.addCategory(finalCat);

      const updated = await DB.saveProduct({
        ...selectedProduct,
        name: editName.trim() || selectedProduct.name,
        barcode: editBarcode.trim(),
        category: finalCat,
        qty: parseFloat(editQty) || 0,
        buy_price: parseFloat(editBuyPrice) || 0,
        sell_price: parseFloat(editSellPrice) || 0,
        image: editImage,
      });

      playSuccessChime();
      setSelectedProduct(updated);
      setEditModalOpen(false);
    } catch (err) {
      console.error('Failed to save product edit:', err);
      alert('حدث خطأ أثناء حفظ تعديلات المنتج');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddNewCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newCategoryInput.trim();
    if (!clean || isSubmitting) return;
    try {
      setIsSubmitting(true);
      await DB.addCategory(clean);
      setNewCategory(clean);
      setEditCategory(clean);
      setNewCategoryInput('');
      playSuccessChime();
    } catch (err) {
      console.error('Failed to add category:', err);
      alert('حدث خطأ أثناء إضافة الصنف');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveRenamedCategory = async (oldName: string) => {
    const cleanNew = editingCategoryValue.trim();
    if (cleanNew && cleanNew !== oldName && !isSubmitting) {
      try {
        setIsSubmitting(true);
        await DB.renameCategory(oldName, cleanNew);
        if (categoryFilter === oldName) setCategoryFilter(cleanNew);
        if (newCategory === oldName) setNewCategory(cleanNew);
        if (editCategory === oldName) setEditCategory(cleanNew);
        if (selectedProduct && selectedProduct.category === oldName) {
          setSelectedProduct({ ...selectedProduct, category: cleanNew });
        }
        playSuccessChime();
      } catch (err) {
        console.error('Failed to rename category:', err);
        alert('حدث خطأ أثناء تعديل اسم الصنف');
      } finally {
        setIsSubmitting(false);
      }
    }
    setEditingCategoryName(null);
    setEditingCategoryValue('');
  };

  const handleConfirmQuickAddQty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || isSubmitting) return;
    const delta = parseFloat(quickAddAmount);
    if (!isNaN(delta) && delta > 0) {
      try {
        setIsSubmitting(true);
        await DB.updateStockQuantity(selectedProduct.id, delta);
        playSuccessChime();
        setSelectedProduct({ ...selectedProduct, qty: selectedProduct.qty + delta });
        setQuickAddModalOpen(false);
      } catch (err) {
        console.error('Failed to update stock qty:', err);
        alert('حدث خطأ أثناء تحديث الكمية');
      } finally {
        setIsSubmitting(false);
      }
    } else {
      setQuickAddModalOpen(false);
    }
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || isSubmitting) return;

    try {
      setIsSubmitting(true);
      const finalCat = isCustomCategory
        ? customCategory.trim() || 'عام'
        : newCategory.trim() || 'عام';

      await DB.saveProduct({
        name: newName.trim(),
        barcode: newBarcode.trim() || undefined,
        category: finalCat,
        buy_price: parseFloat(newBuyPrice) || 0,
        sell_price: parseFloat(newSellPrice) || 0,
        qty: parseFloat(newQty) || 0,
        image: newImage || undefined,
      });

      playSuccessChime();
      setNewName('');
      setNewBarcode('');
      setNewCategory('عام');
      setCustomCategory('');
      setIsCustomCategory(false);
      setNewBuyPrice('');
      setNewSellPrice('');
      setNewQty('1');
      setNewImage('');
      setAddModalOpen(false);
    } catch (err) {
      console.error('Failed to create product:', err);
      alert('حدث خطأ أثناء حفظ المنتج الجديد');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteProduct = async () => {
    if (!selectedProduct || isSubmitting) return;
    try {
      setIsSubmitting(true);
      await DB.deleteProduct(selectedProduct.id);
      playSuccessChime();
      setConfirmDeleteOpen(false);
      setSelectedProduct(null);
    } catch (err) {
      console.error('Failed to delete product:', err);
      alert('حدث خطأ أثناء حذف المنتج');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCategory = async (cat: string) => {
    if (isSubmitting) return;
    try {
      setIsSubmitting(true);
      await DB.deleteCategory(cat);
      if (categoryFilter === cat) setCategoryFilter('all');
      playSuccessChime();
    } catch (err) {
      console.error('Failed to delete category:', err);
      alert('حدث خطأ أثناء حذف الصنف');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div dir="rtl" className="space-y-4">
      {/* If a product is selected for detail view */}
      {selectedProduct ? (
        <div className="app-card overflow-hidden space-y-4 p-5">
          {/* Header */}
          <div className="flex items-center justify-between pb-3 border-b border-[var(--border-default)]">
            <button
              type="button"
              onClick={() => setSelectedProduct(null)}
              className="min-h-[40px] px-2 text-[14px] font-bold text-[var(--text-secondary)] hover:text-[var(--brand-primary)] flex items-center gap-1 cursor-pointer"
            >
              ← العودة للمخزن
            </button>
            <h2 className="app-section-title text-[var(--brand-soft-text)]">تفاصيل المنتج</h2>
          </div>

          <div className="text-center pt-1">
            {selectedProduct.image && (
              <div className="mb-3 flex justify-center">
                <img
                  src={selectedProduct.image}
                  alt={selectedProduct.name}
                  className="h-24 w-24 rounded-2xl object-cover border border-[var(--border-default)] shadow-xs"
                />
              </div>
            )}
            <h3 className="app-page-title">{selectedProduct.name}</h3>
            {selectedProduct.category && (
              <p className="mt-1 text-[14px] font-bold text-[var(--brand-soft-text)]">
                الصنف: {selectedProduct.category}
              </p>
            )}

            <button
              type="button"
              onClick={() => setShowMoreDetails(!showMoreDetails)}
              className="mt-2.5 min-h-[38px] px-3 text-[14px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center gap-1 mx-auto cursor-pointer"
            >
              <span>عرض المزيد</span>
              {showMoreDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showMoreDetails && (
              <div className="mt-3 p-3.5 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] rounded-xl text-[14px] text-[var(--text-secondary)] space-y-1.5 text-right">
                <p>
                  الباركود:{' '}
                  <span className="font-mono text-[var(--text-primary)]">
                    {selectedProduct.barcode || 'بدون باركود'}
                  </span>
                </p>
                <p>الصنف: {selectedProduct.category || 'عام'}</p>
                <p>
                  ربح القطعة الواحدة:{' '}
                  <span className="app-num font-bold text-[var(--color-success)]">
                    {Math.max(0, selectedProduct.sell_price - selectedProduct.buy_price).toFixed(0)}{' '}
                    {currency}
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* Harmonized Metric Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-[var(--brand-primary)] text-white rounded-xl text-center py-3.5 px-2 font-bold">
            <div>
              <span className="text-white/80 block text-[12px]">رصيد المخزن</span>
              <span
                className={`text-[18px] app-num font-extrabold ${
                  selectedProduct.qty <= 0 ? 'text-red-200' : ''
                }`}
              >
                {selectedProduct.qty}
              </span>
            </div>
            <div>
              <span className="text-white/80 block text-[12px]">سعر الشراء</span>
              <span className="text-[18px] app-num font-extrabold">
                {selectedProduct.buy_price.toFixed(0)}
              </span>
            </div>
            <div>
              <span className="text-white/80 block text-[12px]">سعر البيع</span>
              <span className="text-[18px] app-num font-extrabold">
                {selectedProduct.sell_price.toFixed(0)}
              </span>
            </div>
            <div>
              <span className="text-white/80 block text-[12px]">ربح المفرد</span>
              <span className="text-[18px] app-num font-extrabold text-emerald-200">
                {(selectedProduct.sell_price - selectedProduct.buy_price).toFixed(0)}
              </span>
            </div>
          </div>

          {/* Total quantity & purchase value in warehouse */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3.5 bg-[var(--bg-surface-subtle)] rounded-xl border border-[var(--border-default)]">
              <span className="font-bold text-[var(--text-secondary)] text-[14px]">
                الكمية الإجمالية بالمخزن
              </span>
              <span
                className={`font-extrabold app-num text-[17px] px-3 py-0.5 rounded-lg border ${
                  selectedProduct.qty <= 0
                    ? 'text-[var(--color-danger)] bg-[var(--color-danger-bg)] border-[var(--color-danger-border)]'
                    : 'text-[var(--brand-soft-text)] bg-[var(--bg-surface)] border-[var(--border-default)]'
                }`}
              >
                {selectedProduct.qty}
              </span>
            </div>

            <div className="flex items-center justify-between p-3.5 bg-[var(--bg-surface-subtle)] rounded-xl border border-[var(--border-default)]">
              <span className="font-bold text-[var(--text-secondary)] text-[14px]">
                قيمة الموجود (بسعر الشراء)
              </span>
              <span className="font-extrabold app-num text-[17px] text-[var(--color-success)]">
                {(selectedProduct.qty * selectedProduct.buy_price).toFixed(0)} {currency}
              </span>
            </div>
          </div>

          {/* Action buttons at bottom */}
          <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-[var(--border-default)] text-center">
            <button
              type="button"
              onClick={() => handleOpenEditModal(selectedProduct)}
              className="min-h-[54px] flex flex-col items-center justify-center p-3 rounded-xl bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--brand-soft-text)] transition cursor-pointer"
            >
              <Edit2 className="h-5 w-5 mb-1" />
              <span className="text-[13px] font-bold">تعديل المنتج</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setQuickAddAmount('5');
                setQuickAddModalOpen(true);
              }}
              className="min-h-[54px] flex flex-col items-center justify-center p-3 rounded-xl bg-[var(--color-success-bg)] hover:opacity-90 text-[var(--color-success)] transition cursor-pointer"
            >
              <Plus className="h-5 w-5 mb-1" />
              <span className="text-[13px] font-bold">إضافة كمية</span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmDeleteOpen(true)}
              className="min-h-[54px] flex flex-col items-center justify-center p-3 rounded-xl bg-[var(--color-danger-bg)] hover:opacity-90 text-[var(--color-danger)] transition cursor-pointer"
            >
              <Trash2 className="h-5 w-5 mb-1" />
              <span className="text-[13px] font-bold">حذف المنتج</span>
            </button>
          </div>
        </div>
      ) : (
        /* Products List view */
        <div className="space-y-3">
          {/* Warehouse Valuation Strip */}
          <div className="grid grid-cols-3 gap-2.5 text-right">
            <div className="app-card p-3 min-w-0">
              <span className="text-[13px] font-semibold text-[var(--text-secondary)] block truncate">
                عدد الأصناف
              </span>
              <span className="text-[16px] sm:text-[18px] font-extrabold app-num text-[var(--brand-soft-text)] block truncate mt-0.5">
                {allWarehouseProducts.length} صنف
              </span>
            </div>
            <div className="app-card p-3 min-w-0">
              <span className="text-[13px] font-semibold text-[var(--text-secondary)] block truncate">
                قيمة المخزن (شراء)
              </span>
              <span className="text-[16px] sm:text-[18px] font-extrabold app-num text-[var(--color-success)] block truncate mt-0.5">
                {totalBuyVal.toFixed(0)} {currency}
              </span>
            </div>
            <div className="app-card p-3 min-w-0">
              <span className="text-[13px] font-semibold text-[var(--text-secondary)] block truncate">
                قيمة المخزن (بيع)
              </span>
              <span className="text-[16px] sm:text-[18px] font-extrabold app-num text-[var(--text-primary)] block truncate mt-0.5">
                {totalSellVal.toFixed(0)} {currency}
              </span>
            </div>
          </div>

          {/* Search Bar, Stock Filter Tabs & Add New Product Button */}
          <div className="app-card p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] rounded-xl">
                <button
                  type="button"
                  onClick={() => setStockFilter('all')}
                  className={`min-h-[38px] px-3 py-1 rounded-lg text-[13px] sm:text-[14px] font-bold transition cursor-pointer ${
                    stockFilter === 'all'
                      ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  الكل ({allWarehouseProducts.length})
                </button>
                <button
                  type="button"
                  onClick={() => setStockFilter('low')}
                  className={`min-h-[38px] px-3 py-1 rounded-lg text-[13px] sm:text-[14px] font-bold transition cursor-pointer ${
                    stockFilter === 'low'
                      ? 'bg-[var(--color-warning)] text-white shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  نواقص ({lowCount})
                </button>
                <button
                  type="button"
                  onClick={() => setStockFilter('out')}
                  className={`min-h-[38px] px-3 py-1 rounded-lg text-[13px] sm:text-[14px] font-bold transition cursor-pointer ${
                    stockFilter === 'out'
                      ? 'bg-[var(--color-danger)] text-white shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  منتهي ({outCount})
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExcelModalOpen(true)}
                  className="app-btn-secondary min-h-[42px] px-3 py-2 text-[14px] text-[var(--color-success)]"
                  title="استيراد منتجات من ملف إكسل وتسعير البيع"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  <span>من إكسل</span>
                </button>

                <button
                  type="button"
                  onClick={() => setCategoriesModalOpen(true)}
                  className="app-btn-secondary min-h-[42px] px-3 py-2 text-[14px]"
                  title="إضافة أو تعديل الأصناف"
                >
                  <Tag className="h-4 w-4" />
                  <span>الأصناف</span>
                </button>

                <button
                  type="button"
                  onClick={() => setAddModalOpen(true)}
                  className="app-btn-primary min-h-[42px] px-3.5 py-2 text-[14px]"
                >
                  <Plus className="h-4 w-4" />
                  <span>إضافة منتج</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="relative sm:col-span-2">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ادخل اسم المنتج أو الباركود..."
                  className="app-input pr-11"
                />
                <Filter className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="app-input flex-1 font-bold"
                >
                  <option value="all">جميع الأصناف ({categories.length})</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setCategoriesModalOpen(true)}
                  className="app-btn-secondary min-h-[44px] min-w-[44px] px-2.5"
                  title="إضافة أو تعديل الأصناف"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Unified Table Header */}
          <div className="app-card overflow-hidden">
            <div className="grid grid-cols-12 app-table-head text-[14px] py-2.5 px-3.5 text-center select-none">
              <button
                type="button"
                onClick={() => handleSort('name')}
                className="col-span-6 text-right flex items-center gap-1.5 hover:opacity-85 transition cursor-pointer"
              >
                {sortField === 'name' ? (
                  sortDir === 'desc' ? (
                    <ArrowDown className="h-4 w-4" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )
                ) : (
                  <ArrowUpDown className="h-3.5 w-3.5 opacity-75" />
                )}
                <span>المنتج</span>
              </button>
              <button
                type="button"
                onClick={() => handleSort('qty')}
                className="col-span-3 flex items-center justify-center gap-1.5 hover:opacity-85 transition cursor-pointer"
              >
                {sortField === 'qty' ? (
                  sortDir === 'desc' ? (
                    <ArrowDown className="h-4 w-4" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )
                ) : (
                  <ArrowUpDown className="h-3.5 w-3.5 opacity-75" />
                )}
                <span>الكمية</span>
              </button>
              <button
                type="button"
                onClick={() => handleSort('price')}
                className="col-span-3 flex items-center justify-center gap-1.5 hover:opacity-85 transition cursor-pointer"
              >
                {sortField === 'price' ? (
                  sortDir === 'desc' ? (
                    <ArrowDown className="h-4 w-4" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )
                ) : (
                  <ArrowUpDown className="h-3.5 w-3.5 opacity-75" />
                )}
                <span>السعر</span>
              </button>
            </div>

            {/* Rows */}
            {sortedProducts.length === 0 ? (
              <div className="py-12 text-center text-[15px] text-[var(--text-muted)] font-semibold">
                لا توجد منتجات مطابقة
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-default)]">
                {sortedProducts.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => handleSelectProduct(p)}
                    style={{ fontSize: `${productsFontSize}px` }}
                    className="grid grid-cols-12 py-3 px-3.5 font-semibold hover:bg-[var(--bg-hover)] transition-colors cursor-pointer items-center text-center"
                  >
                    <div className="col-span-6 text-right flex items-center gap-2.5 truncate">
                      {p.image ? (
                        <img
                          src={p.image}
                          alt={p.name}
                          className="h-9 w-9 rounded-lg object-cover border border-[var(--border-default)] shrink-0"
                        />
                      ) : null}
                      <div className="truncate">
                        <div className="font-bold text-[var(--text-primary)] truncate">
                          {p.name}
                        </div>
                        {p.category && (
                          <span className="text-[12px] text-[var(--text-muted)] block truncate">
                            {p.category}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className={`col-span-3 app-num ${
                        p.qty <= 0
                          ? 'text-[var(--color-danger)] font-extrabold'
                          : p.qty <= 5
                          ? 'text-[var(--color-warning)] font-bold'
                          : 'text-[var(--text-primary)] font-bold'
                      }`}
                    >
                      {p.qty}
                    </div>
                    <div className="col-span-3 app-num font-bold text-[var(--brand-soft-text)]">
                      {p.sell_price.toFixed(0)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Add Quantity Modal */}
      {quickAddModalOpen && selectedProduct && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-xs max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl space-y-4">
            <h3 className="app-section-title text-center">إضافة كمية سريعة للمخزن</h3>
            <p className="app-meta-text text-center">{selectedProduct.name}</p>
            <form onSubmit={handleConfirmQuickAddQty} className="space-y-3.5">
              <input
                type="number"
                step="any"
                min="0.01"
                required
                value={quickAddAmount}
                onChange={(e) => setQuickAddAmount(e.target.value)}
                className="app-input text-center app-num text-[20px] font-extrabold"
              />
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setQuickAddModalOpen(false)}
                  className="app-btn-secondary flex-1"
                >
                  إلغاء
                </button>
                <button type="submit" className="app-btn-primary flex-1">
                  إضافة للمخزن
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* In-App Delete Product Confirmation Modal */}
      {confirmDeleteOpen && selectedProduct && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-xs max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl text-center space-y-4">
            <h3 className="app-section-title">تأكيد حذف المنتج</h3>
            <p className="app-meta-text">
              هل أنت متأكد من حذف &quot;{selectedProduct.name}&quot; من المخزن؟
            </p>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmDeleteOpen(false)}
                className="app-btn-secondary flex-1"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleDeleteProduct}
                className="app-btn-danger flex-1"
              >
                {isSubmitting ? 'جاري الحذف...' : 'حذف'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editModalOpen && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="relative m-auto w-full max-w-sm app-card p-5 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setEditModalOpen(false)}
              className="absolute top-3.5 left-3.5 min-h-[38px] min-w-[38px] flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-hover)] rounded-xl cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <h3 className="app-section-title text-center mb-4">تعديل المنتج والصنف</h3>

            <form onSubmit={handleSaveEdit} className="space-y-3.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[14px] font-bold text-[var(--text-secondary)]">
                    الصنف (التصنيف)
                  </label>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setIsEditCustomCategory(!isEditCustomCategory)}
                      className="text-[13px] font-bold text-[var(--brand-soft-text)] hover:underline cursor-pointer"
                    >
                      {isEditCustomCategory ? 'اختيار من القائمة' : '+ كتابة صنف'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCategoriesModalOpen(true)}
                      className="text-[13px] font-bold text-[var(--text-secondary)] hover:underline cursor-pointer"
                    >
                      إدارة الأصناف
                    </button>
                  </div>
                </div>
                {isEditCustomCategory ? (
                  <input
                    type="text"
                    required
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="اكتب اسم الصنف الجديد أو المعدل..."
                    className="app-input"
                  />
                ) : (
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="app-input font-semibold"
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
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                  اسم المنتج
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="app-input font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                    الكمية
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={editQty}
                    onChange={(e) => setEditQty(e.target.value)}
                    className="app-input text-center font-bold app-num"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                    الباركود
                  </label>
                  <input
                    type="text"
                    value={editBarcode}
                    onChange={(e) => setEditBarcode(e.target.value)}
                    placeholder="اختياري"
                    dir="ltr"
                    className="app-input text-center font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                    سعر الشراء
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={editBuyPrice}
                    onChange={(e) => setEditBuyPrice(e.target.value)}
                    className="app-input text-center font-bold app-num"
                  />
                </div>

                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                    سعر البيع
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={editSellPrice}
                    onChange={(e) => setEditSellPrice(e.target.value)}
                    className="app-input text-center font-bold app-num"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1 text-right">
                  صورة المنتج (اختياري)
                </label>
                <input
                  ref={editFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const compressed = await compressImageFile(file);
                      setEditImage(compressed);
                    }
                  }}
                  className="hidden"
                />
                {editImage ? (
                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)]">
                    <img
                      src={editImage}
                      alt=""
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => editFileInputRef.current?.click()}
                        className="text-[13px] font-bold text-[var(--brand-soft-text)] px-2.5 py-1.5 cursor-pointer"
                      >
                        تغيير
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditImage('')}
                        className="text-[13px] font-bold text-[var(--color-danger)] px-2.5 py-1.5 cursor-pointer"
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => editFileInputRef.current?.click()}
                    className="app-btn-secondary w-full border-dashed"
                  >
                    <ImageIcon className="h-4 w-4" />
                    <span>إرفاق صورة للمنتج</span>
                  </button>
                )}
              </div>

              <div className="pt-1">
                <button type="submit" className="app-btn-primary w-full">
                  حفظ التعديلات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Product Modal */}
      {addModalOpen && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="relative m-auto w-full max-w-sm app-card p-5 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <button
              type="button"
              onClick={() => setAddModalOpen(false)}
              className="absolute top-3.5 left-3.5 min-h-[38px] min-w-[38px] flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-hover)] rounded-xl cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <h3 className="app-section-title text-center mb-4">إضافة منتج / صنف للمخزن</h3>

            <form onSubmit={handleCreateProduct} className="space-y-3.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[14px] font-bold text-[var(--text-secondary)]">
                    الصنف (التصنيف)
                  </label>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setIsCustomCategory(!isCustomCategory)}
                      className="text-[13px] font-bold text-[var(--brand-soft-text)] hover:underline cursor-pointer"
                    >
                      {isCustomCategory ? 'اختيار من الأصناف' : '+ صنف جديد'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCategoriesModalOpen(true)}
                      className="text-[13px] font-bold text-[var(--text-secondary)] hover:underline cursor-pointer"
                    >
                      تعديل الأصناف
                    </button>
                  </div>
                </div>
                {isCustomCategory ? (
                  <input
                    type="text"
                    required
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    placeholder="اكتب اسم الصنف الجديد..."
                    className="app-input"
                  />
                ) : (
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="app-input font-semibold"
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
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  اسم المنتج
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مثال: Lcd iph 11 pro max"
                  className="app-input"
                />
              </div>

              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  الباركود
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newBarcode}
                    onChange={(e) => setNewBarcode(e.target.value)}
                    placeholder="رقم الباركود (اختياري)"
                    className="app-input flex-1 font-mono"
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
                    className="app-btn-secondary min-w-[44px] px-3"
                    aria-label="مسح الباركود"
                  >
                    <Barcode className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                    سعر الشراء
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newBuyPrice}
                    onChange={(e) => setNewBuyPrice(e.target.value)}
                    placeholder="0"
                    className="app-input app-num"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                    سعر البيع
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={newSellPrice}
                    onChange={(e) => setNewSellPrice(e.target.value)}
                    placeholder="0"
                    className="app-input app-num font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  العدد / الكمية الأولية
                </label>
                <input
                  type="number"
                  step="any"
                  value={newQty}
                  onChange={(e) => setNewQty(e.target.value)}
                  placeholder="1"
                  className="app-input app-num"
                />
              </div>

              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  صورة المنتج (اختياري)
                </label>
                <input
                  ref={addFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const compressed = await compressImageFile(file);
                      setNewImage(compressed);
                    }
                  }}
                  className="hidden"
                />
                {newImage ? (
                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)]">
                    <img
                      src={newImage}
                      alt=""
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => addFileInputRef.current?.click()}
                        className="text-[13px] font-bold text-[var(--brand-soft-text)] px-2.5 py-1.5 cursor-pointer"
                      >
                        تغيير
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewImage('')}
                        className="text-[13px] font-bold text-[var(--color-danger)] px-2.5 py-1.5 cursor-pointer"
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => addFileInputRef.current?.click()}
                    className="app-btn-secondary w-full border-dashed"
                  >
                    <ImageIcon className="h-4 w-4" />
                    <span>اختيار صورة للمنتج (اختياري)</span>
                  </button>
                )}
              </div>

              <div className="pt-2">
                <button type="submit" className="app-btn-primary w-full">
                  حفظ الصنف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Categories Management Modal */}
      {categoriesModalOpen && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="relative m-auto w-full max-w-sm app-card p-5 shadow-2xl flex flex-col max-h-[90dvh]">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-default)] shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-[var(--brand-soft)] text-[var(--brand-soft-text)] flex items-center justify-center">
                  <Tag className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="app-section-title">إدارة الأصناف</h3>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    إضافة صنف جديد أو تعديل وحذف الأصناف
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCategoriesModalOpen(false)}
                className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Add new category form */}
            <form
              onSubmit={handleAddNewCategory}
              className="flex items-center gap-2 py-3 border-b border-[var(--border-default)] shrink-0"
            >
              <input
                type="text"
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                placeholder="اكتب اسم صنف جديد..."
                className="app-input flex-1"
              />
              <button type="submit" className="app-btn-primary px-3.5">
                <Plus className="h-4 w-4" />
                <span>إضافة</span>
              </button>
            </form>

            {/* List of existing categories with inline Edit & Delete */}
            <div className="app-scroll-region flex-1 min-h-0 divide-y divide-[var(--border-default)] py-1">
              {categories.map((cat) => {
                const isEditingThis = editingCategoryName === cat;
                const count = allWarehouseProducts.filter((p) => (p.category || 'عام') === cat).length;

                return (
                  <div key={cat} className="py-2.5 px-1 flex items-center justify-between gap-2">
                    {isEditingThis ? (
                      <div className="flex items-center gap-1.5 flex-1">
                        <input
                          type="text"
                          value={editingCategoryValue}
                          onChange={(e) => setEditingCategoryValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRenamedCategory(cat);
                            if (e.key === 'Escape') setEditingCategoryName(null);
                          }}
                          autoFocus
                          className="app-input flex-1 min-h-[38px] py-1"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveRenamedCategory(cat)}
                          className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl bg-[var(--color-success)] text-white cursor-pointer"
                          title="حفظ التعديل"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingCategoryName(null)}
                          className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] cursor-pointer"
                          title="إلغاء"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-bold text-[var(--text-primary)] text-[15px] truncate">
                            {cat}
                          </span>
                          <span className="text-[12px] text-[var(--text-muted)] font-semibold shrink-0 app-num">
                            ({count} منتج)
                          </span>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCategoryName(cat);
                              setEditingCategoryValue(cat);
                            }}
                            className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:text-[var(--brand-primary)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
                            title="تعديل اسم الصنف"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          {cat !== 'عام' && (
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => handleDeleteCategory(cat)}
                              className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition cursor-pointer disabled:opacity-50"
                              title="حذف الصنف"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-[var(--border-default)] shrink-0">
              <button
                type="button"
                onClick={() => setCategoriesModalOpen(false)}
                className="app-btn-secondary w-full"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excel Import & Pricing Modal */}
      <ExcelImportModal
        isOpen={excelModalOpen}
        onClose={() => setExcelModalOpen(false)}
        mode="warehouse"
      />

      {/* Barcode Scanner */}
      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(code) => {
          if (editModalOpen) {
            setEditBarcode(code);
          } else {
            setNewBarcode(code);
          }
        }}
      />
    </div>
  );
};
