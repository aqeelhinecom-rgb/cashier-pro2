import React, { useState, useEffect } from 'react';
import {
  Users,
  Truck,
  Plus,
  Phone,
  Search,
  DollarSign,
  History,
  Trash2,
  Receipt,
  FileDown,
  Share2,
  PlusCircle,
  X,
} from 'lucide-react';
import { DB } from '../services/db';
import { Party, PartyType, Invoice, Payment } from '../types';
import { playSuccessChime } from '../services/audio';
import { useBackHandler } from '../services/navigation';
import { exportReportToPdf } from '../utils/pdfExport';

interface PartiesScreenProps {
  type: PartyType;
}

export const PartiesScreen: React.FC<PartiesScreenProps> = ({ type }) => {
  const isCustomer = type === 'customer';
  const settings = DB.getSettings();

  const [parties, setParties] = useState<Party[]>([]);
  const [search, setSearch] = useState('');
  const [balanceFilter, setBalanceFilter] = useState<'all' | 'debt'>('all');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');

  // Payment / Debt adjustment modal state
  const [paymentParty, setPaymentParty] = useState<Party | null>(null);
  const [transactionMode, setTransactionMode] = useState<'payment' | 'add_debt'>('payment');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  // Statement History modal state
  const [historyParty, setHistoryParty] = useState<Party | null>(null);
  const [historyData, setHistoryData] = useState<{ invoices: Invoice[]; payments: Payment[] }>({
    invoices: [],
    payments: [],
  });
  const [exportingStatement, setExportingStatement] = useState(false);
  const [statementPdfError, setStatementPdfError] = useState<string | null>(null);

  // In-app delete confirmation state
  const [confirmDeleteParty, setConfirmDeleteParty] = useState<Party | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useBackHandler(addModalOpen, () => setAddModalOpen(false));
  useBackHandler(paymentParty !== null, () => setPaymentParty(null));
  useBackHandler(historyParty !== null, () => setHistoryParty(null));
  useBackHandler(confirmDeleteParty !== null, () => setConfirmDeleteParty(null));

  const loadParties = () => {
    let list = DB.getParties(type);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.phone && p.phone.includes(q))
      );
    }
    if (balanceFilter === 'debt') {
      list = list.filter((p) => (p.balance || 0) > 0);
    }
    setParties(list);
  };

  useEffect(() => {
    loadParties();
    return DB.subscribe(loadParties);
  }, [type, search, balanceFilter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || isSubmitting) return;

    try {
      setIsSubmitting(true);
      const created = await DB.addParty(newName.trim(), newPhone.trim(), type);
      const initialDebtNum = parseFloat(openingDebt);
      if (initialDebtNum && initialDebtNum > 0) {
        await DB.addPayment(created.id, -initialDebtNum, 'رصيد افتتاحي / دين سابق');
      }
      playSuccessChime();
      setNewName('');
      setNewPhone('');
      setOpeningDebt('');
      setAddModalOpen(false);
    } catch (err) {
      console.error('Failed to create party:', err);
      alert('حدث خطأ أثناء حفظ جهة التعامل');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentParty || isSubmitting) return;
    const amount = parseFloat(paymentAmount);
    if (!amount || amount <= 0) return;

    try {
      setIsSubmitting(true);
      if (transactionMode === 'add_debt') {
        await DB.addPayment(
          paymentParty.id,
          -amount,
          paymentNotes.trim() || (isCustomer ? 'دين إضافي مسجل' : 'مستحق إضافي للمورد')
        );
      } else {
        await DB.addPayment(paymentParty.id, amount, paymentNotes);
      }
      playSuccessChime();
      setPaymentParty(null);
      setPaymentAmount('');
      setPaymentNotes('');
    } catch (err) {
      console.error('Failed to record payment:', err);
      alert('حدث خطأ أثناء تسجيل الدفعة');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenHistory = (p: Party) => {
    setStatementPdfError(null);
    setHistoryParty(p);
    setHistoryData(DB.getPartyHistory(p.id));
  };

  const handleExportStatementPdf = async (share = false) => {
    if (!historyParty) return;
    setStatementPdfError(null);
    setExportingStatement(true);
    try {
      const formatInvoiceLabel = (inv: Invoice) => {
        const ref = inv.invoice_number || `#${inv.id}`;
        if (inv.type === 'sale_return') return `مرتجع بيع ${ref}`;
        if (inv.type === 'purchase') return `فاتورة شراء ${ref}`;
        if (inv.type === 'quote') return `عرض سعر ${ref}`;
        return `فاتورة بيع ${ref}`;
      };

      const formatInvoiceBalanceEffect = (inv: Invoice) => {
        if (inv.type === 'quote') return '0 (عرض سعر)';
        const diff = Math.max(0, inv.total - inv.paid);
        if (diff === 0) return '0';
        if (inv.type === 'sale_return') return `-${diff.toFixed(0)} (خصم من الدين)`;
        return `+${diff.toFixed(0)}`;
      };

      const rows: (string | number)[][] = [
        ...historyData.invoices.map((inv) => [
          new Date(inv.date).toISOString().split('T')[0],
          formatInvoiceLabel(inv),
          inv.type === 'sale_return' ? `-${inv.total.toFixed(0)}` : inv.total.toFixed(0),
          inv.paid.toFixed(0),
          formatInvoiceBalanceEffect(inv),
        ]),
        ...historyData.payments.map((pay) => [
          new Date(pay.date).toISOString().split('T')[0],
          pay.amount < 0
            ? `دين مسجل (${pay.notes || 'رصيد إضافي'})`
            : `دفعة مسددة (${pay.notes || 'نقدي'})`,
          pay.amount < 0 ? Math.abs(pay.amount).toFixed(0) : '0',
          pay.amount > 0 ? pay.amount.toFixed(0) : '0',
          pay.amount < 0 ? `+${Math.abs(pay.amount).toFixed(0)}` : `-${pay.amount.toFixed(0)}`,
        ]),
      ];

      const res = await exportReportToPdf({
        reportTitle: `كشف حساب ${isCustomer ? 'العميل' : 'المورد'}: ${historyParty.name}`,
        reportDate: new Date().toISOString().split('T')[0],
        columns: [
          'التاريخ',
          'البيان / الحركة',
          `إجمالي الحركة (${settings.currency})`,
          `المدفوع (${settings.currency})`,
          `الأثر على الرصيد (${settings.currency})`,
        ],
        rows,
        summaryCards: [
          { label: isCustomer ? 'اسم العميل' : 'اسم المورد', value: historyParty.name },
          {
            label: isCustomer ? 'إجمالي الدين المتبقي عليه' : 'إجمالي المستحق له',
            value: `${(historyParty.balance || 0).toFixed(0)} ${settings.currency}`,
          },
          {
            label: 'عدد الحركات المسجلة',
            value: `${rows.length} حركة`,
          },
        ],
        supplierName: !isCustomer ? historyParty.name : undefined,
        supplierPhone: !isCustomer ? historyParty.phone : undefined,
        settings,
        options: {
          share,
          shareTitle: `كشف حساب ${historyParty.name}`,
          shareText: `كشف حساب ${historyParty.name} - الرصيد الصافي: ${(
            historyParty.balance || 0
          ).toFixed(0)} ${settings.currency}`,
        },
      });
      if (!res.success) {
        setStatementPdfError(res.error || 'تعذر تصدير كشف الحساب إلى PDF');
      }
    } catch (err: any) {
      setStatementPdfError(err?.message || 'حدث خطأ أثناء تصدير كشف الحساب PDF');
    } finally {
      setExportingStatement(false);
    }
  };

  const allPartiesOfType = DB.getParties(type);
  const totalBalance = allPartiesOfType.reduce((acc, p) => acc + Math.max(0, p.balance || 0), 0);
  const debtPartiesCount = allPartiesOfType.filter((p) => (p.balance || 0) > 0).length;

  return (
    <div dir="rtl" className="space-y-4">
      {/* Top Action Bar: Filter + Add New Party */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl">
          <button
            type="button"
            onClick={() => setBalanceFilter('all')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-[14px] font-bold transition-colors cursor-pointer ${
              balanceFilter === 'all'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            الكل ({allPartiesOfType.length})
          </button>
          <button
            type="button"
            onClick={() => setBalanceFilter('debt')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-[14px] font-bold transition-colors cursor-pointer ${
              balanceFilter === 'debt'
                ? 'bg-[var(--color-danger)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {isCustomer ? `عليهم ديون (${debtPartiesCount})` : `لهم مستحقات (${debtPartiesCount})`}
          </button>
        </div>

        <button type="button" onClick={() => setAddModalOpen(true)} className="app-btn-primary">
          <Plus className="h-5 w-5" />
          <span>{isCustomer ? 'إضافة عميل جديد' : 'إضافة مورد جديد'}</span>
        </button>
      </div>

      {/* Summary Balance Card & Search */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="app-card p-4 md:col-span-1">
          <span className="app-meta-text font-semibold block">
            {isCustomer ? 'إجمالي المتبقي على العملاء (الديون):' : 'إجمالي المستحق للموردين:'}
          </span>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span
              className={`text-[24px] font-extrabold app-num ${
                totalBalance > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
              }`}
            >
              {totalBalance.toFixed(0)}
            </span>
            <span className="text-[13px] font-bold text-[var(--text-secondary)]">
              {settings.currency}
            </span>
          </div>
        </div>

        <div className="app-card p-4 md:col-span-2 flex items-center">
          <div className="relative w-full">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`بحث بالاسم أو رقم هاتف ${isCustomer ? 'العميل' : 'المورد'}...`}
              className="app-input pl-10"
            />
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          </div>
        </div>
      </div>

      {/* Parties List */}
      <div className="app-card overflow-hidden">
        {parties.length === 0 ? (
          <div className="py-16 text-center text-[var(--text-muted)]">
            {isCustomer ? (
              <Users className="mx-auto h-12 w-12 opacity-40 stroke-1" />
            ) : (
              <Truck className="mx-auto h-12 w-12 opacity-40 stroke-1" />
            )}
            <p className="mt-2.5 text-[16px] font-semibold text-[var(--text-secondary)]">
              لا يوجد {isCustomer ? 'عملاء' : 'موردين'} مطابقين للعرض
            </p>
            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              className="mt-3 text-[15px] font-bold text-[var(--brand-soft-text)] hover:underline cursor-pointer"
            >
              + إضافة {isCustomer ? 'عميل جديد' : 'مورد جديد'}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-default)]">
            {parties.map((p) => {
              const bal = p.balance || 0;
              const hasDebt = bal > 0;

              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-11 w-11 rounded-xl bg-[var(--brand-soft)] text-[var(--brand-soft-text)] flex items-center justify-center font-extrabold text-[17px] shrink-0">
                      {p.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-[var(--text-primary)] text-[16px] truncate">
                        {p.name}
                      </h3>
                      {p.phone ? (
                        <a
                          href={`tel:${p.phone}`}
                          className="flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--brand-primary)] mt-0.5 app-num"
                          dir="ltr"
                        >
                          <Phone className="h-3.5 w-3.5" />
                          <span>{p.phone}</span>
                        </a>
                      ) : (
                        <span className="text-[13px] text-[var(--text-muted)]">بدون هاتف</span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                    {/* Balance */}
                    <div className="text-left">
                      <span className="text-[12px] text-[var(--text-muted)] block">
                        {isCustomer ? (hasDebt ? 'عليه (دين مستحق)' : 'لا يوجد دين') : 'المستحق له'}
                      </span>
                      <div className="flex items-baseline gap-1">
                        <span
                          className={`text-[18px] font-extrabold app-num ${
                            hasDebt ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
                          }`}
                        >
                          {bal.toFixed(0)}
                        </span>
                        <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                          {settings.currency}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setTransactionMode('payment');
                          setPaymentParty(p);
                          setPaymentAmount(Math.max(0, bal).toString());
                        }}
                        className="min-h-[42px] flex items-center gap-1.5 rounded-xl bg-[var(--color-success)] hover:opacity-90 px-3.5 py-2 text-[14px] font-bold text-white transition cursor-pointer"
                        title={isCustomer ? 'تحصيل دفعة نقدية' : 'سداد دفعة للمورد'}
                      >
                        <DollarSign className="h-4 w-4" />
                        <span>{isCustomer ? 'تحصيل' : 'سداد'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setTransactionMode('add_debt');
                          setPaymentParty(p);
                          setPaymentAmount('');
                        }}
                        className="app-btn-secondary min-h-[42px] px-3 py-2 text-[14px]"
                        title={isCustomer ? 'تسجيل دين جديد على العميل' : 'تسجيل مستحق جديد للمورد'}
                      >
                        <PlusCircle className="h-4 w-4 text-[var(--color-danger)]" />
                        <span>+ دين</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenHistory(p)}
                        className="min-h-[42px] min-w-[42px] flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-surface-subtle)] hover:text-[var(--brand-primary)] rounded-xl transition cursor-pointer"
                        title="كشف الحساب وتصدير PDF"
                      >
                        <History className="h-5 w-5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => setConfirmDeleteParty(p)}
                        className="min-h-[42px] min-w-[42px] flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] rounded-xl transition cursor-pointer"
                        title="حذف"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Modal (With optional opening balance / previous debt) */}
      {addModalOpen && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-sm max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="app-section-title">
                {isCustomer ? 'تسجيل عميل جديد' : 'تسجيل مورد جديد'}
              </h3>
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3.5">
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  الاسم <span className="text-[var(--color-danger)]">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مثال: عبد الله أحمد"
                  className="app-input"
                />
              </div>
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  رقم الهاتف
                </label>
                <input
                  type="tel"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="07xxxxxxxxx"
                  className="app-input"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  {isCustomer
                    ? `رصيد دين سابق على العميل (${settings.currency}) - اختياري`
                    : `رصيد مستحق سابق للمورد (${settings.currency}) - اختياري`}
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={openingDebt}
                  onChange={(e) => setOpeningDebt(e.target.value)}
                  placeholder="0"
                  className="app-input app-num font-bold"
                />
              </div>
              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="app-btn-secondary flex-1"
                >
                  إلغاء
                </button>
                <button type="submit" className="app-btn-primary flex-1">
                  حفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payment / Add Debt Modal */}
      {paymentParty && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-sm max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface-subtle)] rounded-xl border border-[var(--border-default)]">
              <button
                type="button"
                onClick={() => setTransactionMode('payment')}
                className={`flex-1 min-h-[40px] py-1.5 rounded-lg text-[14px] font-bold transition cursor-pointer ${
                  transactionMode === 'payment'
                    ? 'bg-[var(--color-success)] text-white shadow-xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                {isCustomer ? 'تحصيل دفعة (-)' : 'سداد دفعة (-)'}
              </button>
              <button
                type="button"
                onClick={() => setTransactionMode('add_debt')}
                className={`flex-1 min-h-[40px] py-1.5 rounded-lg text-[14px] font-bold transition cursor-pointer ${
                  transactionMode === 'add_debt'
                    ? 'bg-[var(--color-danger)] text-white shadow-xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                {isCustomer ? 'تسجيل دين جديد (+)' : 'إضافة مستحق (+)'}
              </button>
            </div>

            <div>
              <h3 className="app-section-title">
                {transactionMode === 'payment'
                  ? isCustomer
                    ? `تحصيل دفعة من ${paymentParty.name}`
                    : `سداد دفعة إلى ${paymentParty.name}`
                  : isCustomer
                  ? `تسجيل دين على ${paymentParty.name}`
                  : `تسجيل مستحق لـ ${paymentParty.name}`}
              </h3>
              <p className="app-meta-text mt-1">
                الرصيد الحالي:{' '}
                <span className="font-bold app-num text-[var(--text-primary)]">
                  {(paymentParty.balance || 0).toFixed(0)}
                </span>{' '}
                {settings.currency}
              </p>
            </div>

            <form onSubmit={handleRecordPayment} className="space-y-3.5">
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  المبلغ ({settings.currency}) <span className="text-[var(--color-danger)]">*</span>
                </label>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  placeholder="0"
                  className="app-input app-num font-bold text-[18px]"
                />
              </div>
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1">
                  ملاحظات وبيان العملية
                </label>
                <input
                  type="text"
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  placeholder={
                    transactionMode === 'payment'
                      ? 'مثال: دفعة نقدية / زين كاش...'
                      : 'مثال: بضاعة على الحساب / دين سابق...'
                  }
                  className="app-input"
                />
              </div>
              <div className="flex gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setPaymentParty(null)}
                  className="app-btn-secondary flex-1"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className={`flex-1 min-h-[44px] rounded-xl py-2.5 text-[15px] font-bold text-white cursor-pointer ${
                    transactionMode === 'payment'
                      ? 'bg-[var(--color-success)] hover:opacity-90'
                      : 'bg-[var(--color-danger)] hover:bg-[var(--color-danger-hover)]'
                  }`}
                >
                  تأكيد وحفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Account Statement / Ledger History Modal with PDF Export & Share */}
      {historyParty && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="relative m-auto w-full max-w-lg app-card shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--brand-primary)] text-white px-4 py-3.5 shrink-0">
              <div>
                <h3 className="font-bold text-[17px]">كشف حساب: {historyParty.name}</h3>
                <span className="text-[13px] text-white/90 app-num">
                  الرصيد الصافي: {(historyParty.balance || 0).toFixed(0)} {settings.currency}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setHistoryParty(null)}
                className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl text-white/85 hover:bg-white/15 cursor-pointer"
                aria-label="إغلاق"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="app-scroll-region flex-1 min-h-0 p-4 space-y-4">
              {/* Invoices section */}
              <div>
                <h4 className="font-bold text-[15px] text-[var(--text-primary)] mb-2 flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-[var(--brand-primary)]" />
                  الفواتير المسجلة ({historyData.invoices.length})
                </h4>
                {historyData.invoices.length === 0 ? (
                  <p className="app-meta-text bg-[var(--bg-surface-subtle)] p-3 rounded-xl text-center">
                    لا توجد فواتير
                  </p>
                ) : (
                  <div className="space-y-2">
                    {historyData.invoices.map((inv) => {
                      const isReturn = inv.type === 'sale_return';
                      const isQuote = inv.type === 'quote';
                      const diff = Math.max(0, inv.total - inv.paid);
                      const typeLabel = isReturn
                        ? 'مرتجع بيع'
                        : inv.type === 'purchase'
                        ? 'فاتورة شراء'
                        : isQuote
                        ? 'عرض سعر'
                        : 'فاتورة بيع';
                      const displayRef = inv.invoice_number || `#${inv.id}`;
                      return (
                        <div
                          key={inv.id}
                          className={`flex items-center justify-between text-[14px] p-3 rounded-xl border ${
                            isReturn
                              ? 'border-teal-200 bg-teal-50/50'
                              : isQuote
                              ? 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)]'
                              : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)]'
                          }`}
                        >
                          <div>
                            <span className="font-bold text-[var(--text-primary)]">
                              {typeLabel} {displayRef}
                            </span>
                            <span className="text-[13px] text-[var(--text-muted)] mr-2">
                              {new Date(inv.date).toLocaleDateString('ar-SA')}
                            </span>
                          </div>
                          <div className="text-left app-num">
                            <span className="font-bold text-[var(--text-primary)]">
                              {isReturn ? `-${inv.total.toFixed(0)}` : inv.total.toFixed(0)}
                            </span>
                            {isQuote ? (
                              <span className="text-[var(--text-muted)] text-[12px] font-semibold block">
                                غير مرحّل
                              </span>
                            ) : isReturn && diff > 0 ? (
                              <span className="text-[var(--color-success)] text-[12px] font-bold block">
                                خصم من الدين {diff.toFixed(0)}
                              </span>
                            ) : diff > 0 ? (
                              <span className="text-[var(--color-danger)] text-[12px] font-bold block">
                                متبقي {diff.toFixed(0)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Payments & Adjustments section */}
              <div>
                <h4 className="font-bold text-[15px] text-[var(--text-primary)] mb-2 flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-[var(--color-success)]" />
                  سجل الدفعات والديون المسجلة ({historyData.payments.length})
                </h4>
                {historyData.payments.length === 0 ? (
                  <p className="app-meta-text bg-[var(--bg-surface-subtle)] p-3 rounded-xl text-center">
                    لا توجد دفعات مسجلة
                  </p>
                ) : (
                  <div className="space-y-2">
                    {historyData.payments.map((pay) => {
                      const isAddedDebt = pay.amount < 0;
                      return (
                        <div
                          key={pay.id}
                          className={`flex items-center justify-between text-[14px] p-3 rounded-xl border ${
                            isAddedDebt
                              ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
                              : 'border-[var(--color-success-border)] bg-[var(--color-success-bg)]'
                          }`}
                        >
                          <div>
                            <span
                              className={`font-bold ${
                                isAddedDebt
                                  ? 'text-[var(--color-danger)]'
                                  : 'text-[var(--color-success)]'
                              }`}
                            >
                              {isAddedDebt ? 'دين إضافي مسجل' : 'دفعة نقدية مسددة'}
                            </span>
                            <span className="text-[13px] text-[var(--text-muted)] mr-2">
                              {new Date(pay.date).toLocaleDateString('ar-SA')}
                            </span>
                            {pay.notes && (
                              <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
                                {pay.notes}
                              </p>
                            )}
                          </div>
                          <span
                            className={`font-extrabold app-num ${
                              isAddedDebt
                                ? 'text-[var(--color-danger)]'
                                : 'text-[var(--color-success)]'
                            }`}
                          >
                            {isAddedDebt
                              ? `+${Math.abs(pay.amount).toFixed(0)}`
                              : `-${pay.amount.toFixed(0)}`}{' '}
                            {settings.currency}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Statement PDF Error Banner */}
            {statementPdfError && (
              <div className="mx-4 mt-2 rounded-xl border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3.5 py-2.5 text-[13px] font-bold text-[var(--color-danger)] flex items-center justify-between gap-2">
                <span>{statementPdfError}</span>
                <button
                  type="button"
                  onClick={() => setStatementPdfError(null)}
                  className="px-1 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Statement Footer Actions: PDF & Share */}
            <div className="p-3.5 border-t border-[var(--border-default)] bg-[var(--bg-surface-subtle)] flex flex-wrap items-center justify-end gap-2 shrink-0">
              <button
                type="button"
                disabled={exportingStatement}
                onClick={() => handleExportStatementPdf(true)}
                className="app-btn-secondary flex-1 sm:flex-none"
              >
                <Share2 className="h-4 w-4" />
                <span>مشاركة كشف الحساب PDF</span>
              </button>
              <button
                type="button"
                disabled={exportingStatement}
                onClick={() => handleExportStatementPdf(false)}
                className="app-btn-primary flex-1 sm:flex-none"
              >
                <FileDown className="h-4 w-4" />
                <span>تحميل كشف حساب PDF</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Delete Confirmation Modal */}
      {confirmDeleteParty && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-xs max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl text-center space-y-4">
            <h3 className="app-section-title">تأكيد حذف {isCustomer ? 'العميل' : 'المورد'}</h3>
            <p className="app-meta-text">
              هل أنت متأكد من حذف &quot;{confirmDeleteParty.name}&quot;؟
            </p>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmDeleteParty(null)}
                className="app-btn-secondary flex-1"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={async () => {
                  if (isSubmitting) return;
                  try {
                    setIsSubmitting(true);
                    await DB.deleteParty(confirmDeleteParty.id);
                    playSuccessChime();
                    setConfirmDeleteParty(null);
                  } catch (err) {
                    console.error('Failed to delete party:', err);
                    alert('حدث خطأ أثناء حذف جهة التعامل');
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                className="app-btn-danger flex-1"
              >
                {isSubmitting ? 'جاري الحذف...' : 'حذف'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
