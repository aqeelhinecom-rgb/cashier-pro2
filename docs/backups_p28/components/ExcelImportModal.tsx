import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  FileSpreadsheet,
  Upload,
  Check,
  X,
  Download,
  AlertCircle,
  Tag,
  ArrowLeftRight,
  CheckSquare,
  Square,
} from 'lucide-react';
import { DB } from '../services/db';
import { Product } from '../types';
import { playSuccessChime } from '../services/audio';
import { useBackHandler } from '../services/navigation';

export interface ImportedExcelProductResult {
  product: Product;
  importedQty: number;
  importedBuyPrice: number;
  chosenSellPrice: number;
}

interface ExcelPreviewRow {
  id: string;
  selected: boolean;
  name: string;
  category: string;
  barcode: string;
  excelQty: number;
  excelBuyPrice: number;
  excelSellPrice: number;
  existingProduct: Product | null;
  oldBuyPrice: number | null;
  oldSellPrice: number | null;
  oldQty: number | null;
  priceChoice: 'new' | 'old' | 'custom';
  finalSellPrice: number;
  finalBuyPrice: number;
}

interface ExcelImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: (results: ImportedExcelProductResult[]) => void;
  mode?: 'warehouse' | 'purchase_invoice';
}

export const ExcelImportModal: React.FC<ExcelImportModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  mode = 'warehouse',
}) => {
  const [rows, setRows] = useState<ExcelPreviewRow[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [qtyMode, setQtyMode] = useState<'add' | 'replace'>('add');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useBackHandler(isOpen, onClose);

  if (!isOpen) return null;

  const settings = DB.getSettings();
  const currency = settings.currency || 'د.ع';
  const categories = DB.getCategories();

  const parseNumber = (val: unknown, fallback = 0): number => {
    if (typeof val === 'number' && !isNaN(val)) return val;
    if (typeof val === 'string') {
      // Convert Arabic-Indic digits if present and strip non-numeric chars except . and -
      const normalized = val
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[^\d.-]/g, '');
      const num = parseFloat(normalized);
      return isNaN(num) ? fallback : num;
    }
    return fallback;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        setErrorMsg('ملف الإكسل فارغ أو لا يحتوي على أي ورقة عمل');
        return;
      }

      const worksheet = workbook.Sheets[firstSheetName];
      const rawJson = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        defval: '',
      });

      if (!rawJson || rawJson.length === 0) {
        setErrorMsg('لم يتم العثور على صفوف منتجات داخل ملف الإكسل');
        return;
      }

      const existingProducts = DB.getProducts();
      const parsedRows: ExcelPreviewRow[] = [];

      rawJson.forEach((record, idx) => {
        const keys = Object.keys(record);
        const findVal = (patterns: string[]): unknown => {
          for (const k of keys) {
            const cleanK = k.trim().toLowerCase();
            if (patterns.some((p) => cleanK === p || cleanK.includes(p))) {
              return record[k];
            }
          }
          return undefined;
        };

        const rawName =
          findVal(['اسم المنتج', 'المنتج', 'الاسم', 'اسم المادة', 'المادة', 'البيان', 'name', 'product', 'item', 'title']) ??
          (keys[0] ? record[keys[0]] : '');

        const name = String(rawName || '').trim();
        if (!name) return;

        const rawCategory =
          findVal(['الصنف', 'التصنيف', 'الفئة', 'القسم', 'النوع', 'category', 'cat', 'group', 'type']) ?? 'عام';
        const category = String(rawCategory || 'عام').trim() || 'عام';

        const rawBarcode =
          findVal(['الباركود', 'باركود', 'الكود', 'الرمز', 'barcode', 'code', 'sku']) ?? '';
        const barcode = String(rawBarcode || '').trim();

        const rawQty =
          findVal(['الكمية', 'العدد', 'الرصيد', 'كمية', 'عدد', 'qty', 'quantity', 'count', 'stock']) ?? 1;
        const excelQty = Math.max(0, parseNumber(rawQty, 1));

        const rawBuy =
          findVal(['سعر الشراء', 'شراء', 'التكلفة', 'سعر التكلفة', 'الجملة', 'سعر الجملة', 'buy_price', 'buy', 'cost']) ?? 0;
        const excelBuyPrice = Math.max(0, parseNumber(rawBuy, 0));

        const rawSell =
          findVal(['سعر البيع', 'بيع', 'المفرد', 'سعر المفرد', 'السعر', 'sell_price', 'sell', 'price']) ??
          excelBuyPrice;
        const excelSellPrice = Math.max(0, parseNumber(rawSell, excelBuyPrice));

        // Match with existing warehouse product by barcode or name
        const matched =
          (barcode
            ? existingProducts.find((p) => p.barcode && p.barcode.trim() === barcode)
            : null) ||
          existingProducts.find((p) => p.name.trim().toLowerCase() === name.toLowerCase()) ||
          null;

        const oldSellPrice = matched ? matched.sell_price : null;
        const oldBuyPrice = matched ? matched.buy_price : null;
        const oldQty = matched ? matched.qty : null;

        // Default to 'new' price if Excel has a positive sell price, otherwise fallback to 'old' if available
        const hasNewSell = excelSellPrice > 0;
        const defaultChoice: 'new' | 'old' =
          hasNewSell ? 'new' : oldSellPrice !== null ? 'old' : 'new';
        const finalSellPrice =
          defaultChoice === 'old' && oldSellPrice !== null
            ? oldSellPrice
            : excelSellPrice > 0
            ? excelSellPrice
            : oldSellPrice ?? excelBuyPrice;

        parsedRows.push({
          id: `excel_row_${idx}_${Date.now()}`,
          selected: true,
          name,
          category: category || matched?.category || 'عام',
          barcode: barcode || matched?.barcode || '',
          excelQty,
          excelBuyPrice: excelBuyPrice > 0 ? excelBuyPrice : oldBuyPrice ?? 0,
          excelSellPrice: excelSellPrice > 0 ? excelSellPrice : oldSellPrice ?? 0,
          existingProduct: matched,
          oldBuyPrice,
          oldSellPrice,
          oldQty,
          priceChoice: defaultChoice,
          finalSellPrice,
          finalBuyPrice: excelBuyPrice > 0 ? excelBuyPrice : oldBuyPrice ?? 0,
        });
      });

      if (parsedRows.length === 0) {
        setErrorMsg('لم يتم العثور على أسماء منتجات صالحة في ملف الإكسل');
        return;
      }

      setRows(parsedRows);
    } catch (err) {
      console.error('Excel parse error:', err);
      setErrorMsg('تعذر قراءة ملف الإكسل، تأكد من أن الملف بصيغة .xlsx أو .xls أو .csv');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDownloadSampleTemplate = () => {
    const sampleData = [
      {
        'اسم المنتج': 'Lcd iph 11 pro max',
        'الصنف': 'قطع غيار وصيانة',
        'الباركود': '628100701100',
        'الكمية': 5,
        'سعر الشراء': 11000,
        'سعر البيع': 16500,
      },
      {
        'اسم المنتج': 'حليب كامل الدسم 1 لتر',
        'الصنف': 'ألبان وأجبان',
        'الباركود': '628100701234',
        'الكمية': 12,
        'سعر الشراء': 5,
        'سعر البيع': 7.5,
      },
      {
        'اسم المنتج': 'شاحن سريع أصلي 20W',
        'الصنف': 'إلكترونيات',
        'الباركود': '628100709999',
        'الكمية': 10,
        'سعر الشراء': 8000,
        'سعر البيع': 12000,
      },
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'المنتجات');
    XLSX.writeFile(wb, 'نموذج_استيراد_المنتجات_Cashier.xlsx');
  };

  const applyPriceChoiceToRow = (rowId: string, choice: 'new' | 'old') => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        if (choice === 'old' && r.oldSellPrice !== null) {
          return {
            ...r,
            priceChoice: 'old',
            finalSellPrice: r.oldSellPrice,
          };
        }
        return {
          ...r,
          priceChoice: 'new',
          finalSellPrice: r.excelSellPrice,
        };
      })
    );
  };

  const applyBulkPriceChoice = (choice: 'new' | 'old') => {
    setRows((prev) =>
      prev.map((r) => {
        if (choice === 'old' && r.oldSellPrice !== null) {
          return {
            ...r,
            priceChoice: 'old',
            finalSellPrice: r.oldSellPrice,
          };
        }
        return {
          ...r,
          priceChoice: 'new',
          finalSellPrice: r.excelSellPrice,
        };
      })
    );
  };

  const updateRowField = (rowId: string, updates: Partial<ExcelPreviewRow>) => {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...updates } : r)));
  };

  const handleConfirmImport = async () => {
    if (isImporting) return;
    const selectedRows = rows.filter((r) => r.selected && r.name.trim() !== '');
    if (selectedRows.length === 0) {
      setErrorMsg('يرجى تحديد منتج واحد على الأقل للاستيراد');
      return;
    }

    try {
      setIsImporting(true);
      const importedResults: ImportedExcelProductResult[] = [];

      for (const r of selectedRows) {
        const cleanCat = r.category.trim() || 'عام';
        await DB.addCategory(cleanCat);

        const newQtyValue =
          r.existingProduct && qtyMode === 'add'
            ? (r.existingProduct.qty || 0) + r.excelQty
            : r.excelQty;

        const saved = await DB.saveProduct({
          id: r.existingProduct?.id,
          name: r.name.trim(),
          category: cleanCat,
          barcode: r.barcode.trim() || r.existingProduct?.barcode || '',
          buy_price: r.finalBuyPrice,
          sell_price: r.finalSellPrice,
          qty: newQtyValue,
          image: r.existingProduct?.image,
        });

        importedResults.push({
          product: saved,
          importedQty: r.excelQty,
          importedBuyPrice: r.finalBuyPrice,
          chosenSellPrice: r.finalSellPrice,
        });
      }

      playSuccessChime();
      onImportComplete?.(importedResults);
      setRows([]);
      setFileName('');
      onClose();
    } catch (err) {
      console.error('Failed to import excel items:', err);
      setErrorMsg('حدث خطأ أثناء حفظ المنتجات المستوردة');
    } finally {
      setIsImporting(false);
    }
  };

  const selectedCount = rows.filter((r) => r.selected).length;
  const existingMatchCount = rows.filter((r) => r.existingProduct !== null).length;

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-2.5 sm:p-4 backdrop-blur-xs"
    >
      <div className="relative w-full max-w-2xl rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-2xl flex flex-col max-h-[88dvh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 bg-[var(--brand-primary)] text-white">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[16px] sm:text-[17px] font-extrabold truncate">
                استيراد المنتجات من إكسل وتسعير البيع
              </h3>
              <p className="text-[12px] text-white/80 truncate">
                اختر السعر الجديد أو القديم لكل منتج قبل إضافته للمخزن
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-10 w-10 rounded-xl text-white/85 hover:bg-white/15 hover:text-white transition shrink-0 flex items-center justify-center cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 sm:p-4 space-y-3.5">
          {/* File Upload & Template Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-subtle)] p-3 rounded-2xl border border-[var(--border-default)]">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="app-btn-primary text-[14px]"
              >
                <Upload className="h-4 w-4" />
                <span>{rows.length > 0 ? 'اختيار ملف إكسل آخر' : 'اختر ملف إكسل (.xlsx / .csv)'}</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadSampleTemplate}
                className="app-btn-secondary text-[14px]"
              >
                <Download className="h-4 w-4 text-[var(--brand-primary)]" />
                <span>تحميل نموذج إكسل جاهز</span>
              </button>
            </div>

            {fileName && (
              <span className="text-[13px] font-bold text-[var(--text-secondary)] truncate max-w-[200px]">
                الملف: {fileName}
              </span>
            )}
          </div>

          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger)] text-[14px] font-bold flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <button onClick={() => setErrorMsg(null)} className="font-bold px-2 min-h-[36px] cursor-pointer">
                ✕
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="py-10 px-4 text-center space-y-3 border-2 border-dashed border-[var(--border-strong)] rounded-2xl bg-[var(--bg-surface-subtle)]">
              <FileSpreadsheet className="mx-auto h-12 w-12 text-[var(--brand-primary)] stroke-1" />
              <div className="space-y-1.5">
                <p className="text-[16px] font-bold text-[var(--text-primary)]">
                  ارفع ملف الإكسل لعرض المنتجات ومقارنة الأسعار قبل الحفظ
                </p>
                <p className="text-[14px] text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
                  يدعم الأعمدة: <strong>اسم المنتج</strong>، <strong>الصنف</strong>، <strong>الباركود</strong>، <strong>الكمية</strong>، <strong>سعر الشراء</strong>، و<strong>سعر البيع</strong>. سيظهر لك كل منتج لاختيار بيعه بالسعر الجديد أو السعر القديم.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="app-btn-primary px-6"
              >
                <Upload className="h-4 w-4" />
                <span>اختيار ملف إكسل من الجهاز</span>
              </button>
            </div>
          ) : (
            <>
              {/* Global Pricing & Stock Mode Controls */}
              <div className="bg-[var(--brand-soft)] border border-[var(--border-default)] rounded-2xl p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[14px] font-bold text-[var(--text-primary)] flex items-center gap-2">
                    <ArrowLeftRight className="h-4 w-4 text-[var(--brand-primary)]" />
                    <span className="app-num">
                      معاينة وتسعير المنتجات ({rows.length} منتج • {existingMatchCount} موجود سابقاً بالمخزن)
                    </span>
                  </div>

                  {/* Quick Bulk Price Switcher */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => applyBulkPriceChoice('new')}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--color-success)] text-white text-[13px] font-bold transition cursor-pointer hover:opacity-90"
                    >
                      السعر الجديد للكل
                    </button>
                    {existingMatchCount > 0 && (
                      <button
                        type="button"
                        onClick={() => applyBulkPriceChoice('old')}
                        className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] text-white text-[13px] font-bold transition cursor-pointer"
                      >
                        السعر القديم للكل
                      </button>
                    )}
                  </div>
                </div>

                {/* Quantity Mode Switcher */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[var(--border-default)] text-[13px]">
                  <span className="font-bold text-[var(--text-secondary)]">طريقة التعامل مع كمية المنتجات الموجودة:</span>
                  <div className="flex items-center gap-1 bg-[var(--bg-surface)] p-1 rounded-xl border border-[var(--border-default)]">
                    <button
                      type="button"
                      onClick={() => setQtyMode('add')}
                      className={`px-3 min-h-[36px] rounded-lg text-[13px] font-bold transition cursor-pointer ${
                        qtyMode === 'add'
                          ? 'bg-[var(--brand-primary)] text-white'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      إضافة فوق الرصيد الحالي
                    </button>
                    <button
                      type="button"
                      onClick={() => setQtyMode('replace')}
                      className={`px-3 min-h-[36px] rounded-lg text-[13px] font-bold transition cursor-pointer ${
                        qtyMode === 'replace'
                          ? 'bg-[var(--brand-primary)] text-white'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      استبدال الرصيد بالكمية الجديدة
                    </button>
                  </div>
                </div>
              </div>

              {/* Product Cards List for Individual Price Selection */}
              <div className="space-y-3">
                {rows.map((row, idx) => {
                  const hasOld = row.oldSellPrice !== null;
                  const priceDiff =
                    hasOld && row.oldSellPrice !== null
                      ? row.excelSellPrice - row.oldSellPrice
                      : 0;

                  return (
                    <div
                      key={row.id}
                      className={`rounded-2xl border p-3.5 transition ${
                        row.selected
                          ? 'bg-[var(--bg-surface)] border-[var(--border-default)] shadow-2xs'
                          : 'bg-[var(--bg-surface-subtle)] border-[var(--border-default)] opacity-60'
                      }`}
                    >
                      {/* Top Row */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[var(--border-default)]">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => updateRowField(row.id, { selected: !row.selected })}
                            className="text-[var(--brand-primary)] hover:opacity-80 shrink-0 cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center"
                          >
                            {row.selected ? (
                              <CheckSquare className="h-5 w-5 text-[var(--color-success)]" />
                            ) : (
                              <Square className="h-5 w-5 text-[var(--text-muted)]" />
                            )}
                          </button>

                          <span className="text-[13px] app-num font-bold text-[var(--text-muted)] shrink-0">
                            #{idx + 1}
                          </span>

                          <input
                            type="text"
                            value={row.name}
                            onChange={(e) => updateRowField(row.id, { name: e.target.value })}
                            className="font-bold text-[var(--text-primary)] text-[15px] bg-transparent border-b border-transparent focus:border-[var(--brand-primary)] focus:outline-hidden min-w-0 flex-1"
                          />
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {hasOld ? (
                            <span className="text-[12px] font-bold text-[var(--color-warning)] bg-[var(--color-warning-bg)] px-2.5 py-1 rounded-lg border border-[var(--color-warning-border)] app-num">
                              موجود بالمخزن (رصيد: {row.oldQty})
                            </span>
                          ) : (
                            <span className="text-[12px] font-bold text-[var(--color-success)] bg-[var(--color-success-bg)] px-2.5 py-1 rounded-lg border border-[var(--color-success-border)]">
                              منتج جديد
                            </span>
                          )}

                          <div className="flex items-center gap-1 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] rounded-lg px-2.5 py-1">
                            <Tag className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                            <input
                              type="text"
                              list={`cats_${row.id}`}
                              value={row.category}
                              onChange={(e) => updateRowField(row.id, { category: e.target.value })}
                              className="text-[12px] font-bold text-[var(--text-primary)] bg-transparent w-24 focus:outline-hidden"
                              placeholder="الصنف"
                            />
                            <datalist id={`cats_${row.id}`}>
                              {categories.map((c) => (
                                <option key={c} value={c} />
                              ))}
                            </datalist>
                          </div>
                        </div>
                      </div>

                      {/* Middle Row: Old vs New Selling Price Choice Buttons */}
                      <div className="pt-3 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                        <div className="sm:col-span-7 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => applyPriceChoiceToRow(row.id, 'new')}
                            className={`p-2.5 rounded-xl border text-right transition cursor-pointer flex flex-col justify-between ${
                              row.priceChoice === 'new'
                                ? 'border-[var(--color-success)] bg-[var(--color-success-bg)]'
                                : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)]'
                            }`}
                          >
                            <div className="flex items-center justify-between w-full">
                              <span className="text-[12px] font-bold text-[var(--color-success)]">
                                السعر الجديد (إكسل)
                              </span>
                              {row.priceChoice === 'new' && (
                                <Check className="h-4 w-4 text-[var(--color-success)]" />
                              )}
                            </div>
                            <div className="mt-1 flex items-baseline justify-between">
                              <span className="app-num font-extrabold text-[15px] text-[var(--color-success)]">
                                {row.excelSellPrice.toFixed(0)} {currency}
                              </span>
                              {hasOld && priceDiff !== 0 && (
                                <span
                                  className={`text-[12px] app-num font-bold ${
                                    priceDiff > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--brand-primary)]'
                                  }`}
                                >
                                  {priceDiff > 0 ? `+${priceDiff.toFixed(0)}` : priceDiff.toFixed(0)}
                                </span>
                              )}
                            </div>
                          </button>

                          <button
                            type="button"
                            disabled={!hasOld}
                            onClick={() => hasOld && applyPriceChoiceToRow(row.id, 'old')}
                            className={`p-2.5 rounded-xl border text-right transition flex flex-col justify-between ${
                              !hasOld
                                ? 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] opacity-50 cursor-not-allowed'
                                : row.priceChoice === 'old'
                                ? 'border-[var(--brand-primary)] bg-[var(--brand-soft)] cursor-pointer'
                                : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer'
                            }`}
                          >
                            <div className="flex items-center justify-between w-full">
                              <span className="text-[12px] font-bold text-[var(--text-secondary)]">
                                السعر القديم (بالمخزن)
                              </span>
                              {row.priceChoice === 'old' && (
                                <Check className="h-4 w-4 text-[var(--brand-primary)]" />
                              )}
                            </div>
                            <div className="mt-1">
                              {hasOld && row.oldSellPrice !== null ? (
                                <span className="app-num font-extrabold text-[15px] text-[var(--brand-primary)]">
                                  {row.oldSellPrice.toFixed(0)} {currency}
                                </span>
                              ) : (
                                <span className="text-[12px] font-semibold text-[var(--text-muted)]">
                                  لا يوجد سعر قديم
                                </span>
                              )}
                            </div>
                          </button>
                        </div>

                        {/* Editable Final Sell Price, Buy Price & Qty */}
                        <div className="sm:col-span-5 grid grid-cols-3 gap-1.5">
                          <div className="bg-[var(--bg-surface-subtle)] p-2 rounded-xl border border-[var(--border-default)]">
                            <label className="block text-[11px] font-bold text-[var(--text-muted)]">
                              الكمية المضافة
                            </label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={row.excelQty}
                              onChange={(e) =>
                                updateRowField(row.id, {
                                  excelQty: Math.max(0, parseFloat(e.target.value) || 0),
                                })
                              }
                              className="w-full app-num font-extrabold text-[14px] text-[var(--text-primary)] bg-transparent focus:outline-hidden text-center mt-0.5"
                            />
                          </div>

                          <div className="bg-[var(--bg-surface-subtle)] p-2 rounded-xl border border-[var(--border-default)]">
                            <label className="block text-[11px] font-bold text-[var(--text-muted)]">
                              سعر الشراء
                            </label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={row.finalBuyPrice}
                              onChange={(e) =>
                                updateRowField(row.id, {
                                  finalBuyPrice: Math.max(0, parseFloat(e.target.value) || 0),
                                })
                              }
                              className="w-full app-num font-bold text-[14px] text-[var(--text-secondary)] bg-transparent focus:outline-hidden text-center mt-0.5"
                            />
                          </div>

                          <div className="bg-[var(--color-success-bg)] p-2 rounded-xl border border-[var(--color-success-border)]">
                            <label className="block text-[11px] font-bold text-[var(--color-success)]">
                              سعر البيع المعتمد
                            </label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={row.finalSellPrice}
                              onChange={(e) =>
                                updateRowField(row.id, {
                                  priceChoice: 'custom',
                                  finalSellPrice: Math.max(0, parseFloat(e.target.value) || 0),
                                })
                              }
                              className="w-full app-num font-extrabold text-[14px] text-[var(--color-success)] bg-transparent focus:outline-hidden text-center mt-0.5"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-4 py-3.5 bg-[var(--bg-surface-subtle)] border-t border-[var(--border-default)] flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="app-btn-secondary px-4"
          >
            إلغاء
          </button>

          {rows.length > 0 && (
            <button
              type="button"
              disabled={isImporting}
              onClick={handleConfirmImport}
              className="app-btn-primary flex-1 sm:flex-initial px-5"
            >
              <Check className="h-4 w-4" />
              <span>
                {isImporting
                  ? 'جاري حفظ المنتجات...'
                  : mode === 'purchase_invoice'
                  ? `اعتماد وإضافة (${selectedCount}) منتج للفاتورة والمخزن`
                  : `اعتماد وحفظ (${selectedCount}) منتج بالأسعار المختارة`}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
