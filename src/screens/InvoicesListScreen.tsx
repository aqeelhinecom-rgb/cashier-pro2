import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, X } from 'lucide-react';
import { DB } from '../services/db';
import { Invoice, InvoiceItem, InvoiceType } from '../types';
import { ReceiptModal } from '../components/ReceiptModal';
import { useBackHandler } from '../services/navigation';
import { exportInvoiceToPdf } from '../utils/pdfExport';
import { playSuccessChime } from '../services/audio';

interface InvoicesListScreenProps {
  type: InvoiceType;
  onEditInvoice?: (invoice: Invoice) => void;
}

export const InvoicesListScreen: React.FC<InvoicesListScreenProps> = ({ type, onEditInvoice }) => {
  const settings = DB.getSettings();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [activeMenuInvoice, setActiveMenuInvoice] = useState<Invoice | null>(null);

  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [selectedItems, setSelectedItems] = useState<InvoiceItem[]>([]);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [exportingPdfId, setExportingPdfId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState<number | null>(null);
  const [checkingEditId, setCheckingEditId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useBackHandler(activeMenuInvoice !== null, () => setActiveMenuInvoice(null));
  useBackHandler(receiptOpen, () => setReceiptOpen(false));
  useBackHandler(searchExpanded && search !== '', () => {
    setSearch('');
    setSearchExpanded(false);
  });

  const loadInvoices = () => {
    const list = DB.getInvoices(type);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      setInvoices(
        list.filter(
          (inv) =>
            inv.id.toString().includes(q) ||
            (inv.invoice_number || '').toLowerCase().includes(q) ||
            (inv.party_name || 'مفرد').toLowerCase().includes(q) ||
            inv.date.slice(0, 10).includes(q)
        )
      );
    } else {
      setInvoices(list);
    }
  };

  useEffect(() => {
    loadInvoices();
    return DB.subscribe(loadInvoices);
  }, [type, search]);

  const formatDateYMD = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    } catch {
      return isoStr.slice(0, 10);
    }
  };

  const handleViewInvoice = (inv: Invoice) => {
    const items = DB.getInvoiceItems(inv.id);
    setSelectedInvoice(inv);
    setSelectedItems(items);
    setActiveMenuInvoice(null);
    setReceiptOpen(true);
  };

  const handleDeleteInvoice = async (inv: Invoice) => {
    if (isDeleting === inv.id) return;
    setActionError(null);
    try {
      setIsDeleting(inv.id);
      await DB.deleteInvoice(inv.id);
      playSuccessChime();
      setActiveMenuInvoice(null);
    } catch (err: any) {
      console.error('Failed to delete invoice:', err);
      setActionError(err?.message || 'حدث خطأ أثناء إلغاء الفاتورة');
    } finally {
      setIsDeleting(null);
    }
  };

  const handleStartEditInvoice = async (inv: Invoice) => {
    if (checkingEditId === inv.id) return;
    setActionError(null);
    setCheckingEditId(inv.id);
    try {
      const eligibility = await DB.canEditInvoice(inv.id);
      setActiveMenuInvoice(null);
      if (!eligibility.canEdit) {
        setActionError(eligibility.reason || 'لا يمكن تعديل هذه الفاتورة');
        return;
      }
      onEditInvoice?.(inv);
    } catch (err: any) {
      setActiveMenuInvoice(null);
      setActionError(err?.message || 'تعذر التحقق من أهلية تعديل الفاتورة');
    } finally {
      setCheckingEditId(null);
    }
  };

  const handlePrintInvoice = (inv: Invoice) => {
    const items = DB.getInvoiceItems(inv.id);
    setSelectedInvoice(inv);
    setSelectedItems(items);
    setActiveMenuInvoice(null);
    setReceiptOpen(true);
    setTimeout(() => {
      window.print();
    }, 300);
  };

  const handlePdfInvoice = async (inv: Invoice) => {
    const items = DB.getInvoiceItems(inv.id);
    setActionError(null);
    setActiveMenuInvoice(null);
    setExportingPdfId(inv.id);
    try {
      const res = await exportInvoiceToPdf(inv, items, settings);
      if (!res.success) {
        setActionError(res.error || 'تعذر تصدير الفاتورة إلى ملف PDF');
      }
    } catch (err: any) {
      setActionError(err?.message || 'حدث خطأ أثناء تصدير الفاتورة PDF');
    } finally {
      setExportingPdfId(null);
    }
  };

  return (
    <div dir="rtl" className="space-y-3">
      {actionError && (
        <div className="p-3.5 bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger)] text-[14px] font-bold rounded-xl flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="font-bold px-2 py-1 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Search Bar */}
      <div className="flex items-center justify-between">
        {!searchExpanded ? (
          <button
            type="button"
            onClick={() => {
              setSearchExpanded(true);
              setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            className="app-btn-secondary min-h-[44px] px-4"
          >
            <Search className="h-4 w-4 text-[var(--brand-primary)]" />
            <span>بحث في الفواتير</span>
          </button>
        ) : (
          <div className="flex items-center gap-2 w-full app-card px-3.5 py-1.5">
            <Search className="h-4 w-4 text-[var(--text-muted)] shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث برقم الفاتورة أو اسم العميل أو التاريخ..."
              className="w-full min-h-[38px] text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-hidden text-right bg-transparent"
            />
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setSearchExpanded(false);
              }}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Main Table Container */}
      <div className="app-card overflow-visible">
        <div className="app-table-head rounded-t-2xl px-4 py-3 flex items-center justify-between text-[15px]">
          <span>تفاصيل الفاتورة</span>
          <span>إجمالي الفاتورة</span>
        </div>

        {invoices.length === 0 ? (
          <div className="py-16 text-center text-[var(--text-muted)]">
            <FileText className="mx-auto h-12 w-12 opacity-40 stroke-1" />
            <p className="mt-2.5 text-[16px] font-bold text-[var(--text-secondary)]">
              لا توجد فواتير مسجلة
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-default)]">
            {invoices.map((inv) => {
              const isMenuOpen = activeMenuInvoice?.id === inv.id;
              const isExporting = exportingPdfId === inv.id;

              return (
                <div
                  key={inv.id}
                  onClick={() => setActiveMenuInvoice(isMenuOpen ? null : inv)}
                  className="relative bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] transition-colors px-4 py-3.5 flex items-center justify-between cursor-pointer select-none first:rounded-none last:rounded-b-2xl"
                >
                  <div className="space-y-0.5 text-right">
                    <div className="text-[16px] sm:text-[17px] font-extrabold text-[var(--text-primary)] leading-snug">
                      {inv.party_name || 'مفرد'}
                    </div>
                    <div className="text-[14px] font-semibold text-[var(--text-secondary)] leading-snug">
                      فاتورة رقم: {inv.invoice_number || inv.id}
                    </div>
                    <div className="text-[13px] app-num font-semibold text-[var(--text-muted)] leading-snug">
                      {formatDateYMD(inv.date)}
                    </div>
                  </div>

                  <div className="text-left pl-1">
                    <span className="text-[17px] sm:text-[18px] font-extrabold app-num text-[var(--color-danger)]">
                      {isExporting ? 'جاري PDF...' : inv.total.toFixed(0)}
                    </span>
                  </div>

                  {isMenuOpen && (
                    <>
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenuInvoice(null);
                        }}
                        className="fixed inset-0 z-40"
                      />

                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-4 top-3 z-50 w-56 app-card shadow-2xl p-2 flex flex-col space-y-1 text-right"
                      >
                        <button
                          type="button"
                          onClick={() => handleViewInvoice(inv)}
                          className="w-full min-h-[42px] text-right px-3 text-[15px] font-bold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-xl transition cursor-pointer"
                        >
                          عرض الفاتورة
                        </button>
                        {(type === 'sale' || type === 'purchase') && onEditInvoice && (
                          <button
                            type="button"
                            disabled={checkingEditId === inv.id}
                            onClick={() => handleStartEditInvoice(inv)}
                            className="w-full min-h-[42px] text-right px-3 text-[15px] font-bold text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)] rounded-xl transition cursor-pointer disabled:opacity-50"
                          >
                            {checkingEditId === inv.id ? 'جاري الفحص...' : 'تعديل الفاتورة'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteInvoice(inv)}
                          className="w-full min-h-[42px] text-right px-3 text-[15px] font-bold text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded-xl transition cursor-pointer"
                        >
                          حذف الفاتورة
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePrintInvoice(inv)}
                          className="w-full min-h-[42px] text-right px-3 text-[15px] font-bold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-xl transition cursor-pointer"
                        >
                          طباعة الفاتورة
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePdfInvoice(inv)}
                          className="w-full min-h-[42px] text-right px-3 text-[15px] font-bold font-mono text-[var(--brand-soft-text)] hover:bg-[var(--brand-soft)] rounded-xl transition cursor-pointer"
                        >
                          تصدير PDF
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Receipt Preview Modal */}
      <ReceiptModal
        isOpen={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        invoice={selectedInvoice}
        items={selectedItems}
      />
    </div>
  );
};
