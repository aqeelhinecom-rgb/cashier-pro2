import React, { useState, useEffect } from 'react';
import { CreditCard, Plus, Search, Trash2, Check, FileText } from 'lucide-react';
import { DB } from '../services/db';
import { Expense } from '../types';
import { playSuccessChime } from '../services/audio';
import { useBackHandler } from '../services/navigation';

const QUICK_EXPENSE_TYPES = [
  'إيجار المحل',
  'كهرباء ومولد',
  'رواتب وأجور',
  'نقل وتحميل بضاعة',
  'ضيافة ومستلزمات',
];

export const ExpensesScreen: React.FC = () => {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [activeTab, setActiveTab] = useState<'list' | 'add'>('add');
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [successMsg, setSuccessMsg] = useState(false);
  const [confirmDeleteExpense, setConfirmDeleteExpense] = useState<Expense | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useBackHandler(activeTab === 'list', () => setActiveTab('add'));
  useBackHandler(confirmDeleteExpense !== null, () => setConfirmDeleteExpense(null));

  const settings = DB.getSettings();

  const loadExpenses = () => {
    setExpenses(DB.getExpenses(search));
  };

  useEffect(() => {
    loadExpenses();
    return DB.subscribe(loadExpenses);
  }, [search]);

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipient.trim() || !amount || isSubmitting) return;

    try {
      setIsSubmitting(true);
      await DB.addExpense(
        recipient.trim(),
        parseFloat(amount) || 0,
        new Date(date).toISOString(),
        notes
      );
      playSuccessChime();
      setSuccessMsg(true);
      setRecipient('');
      setAmount('');
      setNotes('');
      setTimeout(() => {
        setSuccessMsg(false);
        setActiveTab('list');
      }, 1000);
    } catch (err) {
      console.error('Failed to add expense:', err);
      alert('حدث خطأ أثناء حفظ المصروف');
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

  return (
    <div dir="rtl" className="space-y-4">
      {/* Top Action Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('add')}
            className={`min-h-[42px] flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[14px] font-bold transition-colors cursor-pointer ${
              activeTab === 'add'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Plus className="h-4 w-4" />
            <span>تسجيل مصروف</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('list')}
            className={`min-h-[42px] flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[14px] font-bold transition-colors cursor-pointer ${
              activeTab === 'list'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <FileText className="h-4 w-4" />
            <span>سجل المصروفات ({expenses.length})</span>
          </button>
        </div>

        <div className="text-left">
          <span className="text-[13px] font-semibold text-[var(--text-secondary)] block">
            إجمالي المصروفات
          </span>
          <span className="text-[18px] font-extrabold app-num text-[var(--color-danger)]">
            {totalExpenses.toFixed(0)} {settings.currency}
          </span>
        </div>
      </div>

      {activeTab === 'add' ? (
        <div className="app-card p-5 sm:p-6 space-y-4">
          <p className="app-meta-text font-semibold">
            * اختر بند الصرف السريع أو اكتب جهة الصرف يدوياً:
          </p>

          {/* Quick Expense Category Presets */}
          <div className="flex flex-wrap gap-2">
            {QUICK_EXPENSE_TYPES.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRecipient(preset)}
                className={`min-h-[40px] px-3.5 py-1.5 rounded-xl text-[14px] font-bold transition-colors cursor-pointer border ${
                  recipient === preset
                    ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)] text-white'
                    : 'bg-[var(--bg-surface-subtle)] border-[var(--border-default)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          {successMsg && (
            <div className="p-3.5 bg-[var(--color-success-bg)] border border-[var(--color-success-border)] text-[var(--color-success)] text-[15px] rounded-xl flex items-center gap-2 font-bold">
              <Check className="h-5 w-5" />
              <span>تم حفظ المصروف بنجاح</span>
            </div>
          )}

          <form onSubmit={handleAddExpense} className="space-y-4 pt-1">
            <div>
              <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5 text-right">
                جهة الصرف / البند
              </label>
              <input
                type="text"
                required
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="ادخل جهة الصرف"
                className="app-input"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5 text-right">
                  المبلغ ({settings.currency})
                </label>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="المبلغ"
                  className="app-input app-num font-bold"
                />
              </div>

              <div>
                <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5 text-right">
                  التاريخ
                </label>
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="app-input app-num text-center"
                />
              </div>
            </div>

            <div>
              <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5 text-right">
                ملاحظات إضافية (اختياري)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ملاحظات حول سبب الصرف..."
                className="app-input"
              />
            </div>

            <div className="pt-2">
              <button type="submit" disabled={isSubmitting} className="app-btn-primary w-full">
                حفظ المصروف
              </button>
            </div>
          </form>
        </div>
      ) : (
        /* Expenses List view */
        <div className="space-y-3">
          <div className="app-card p-3.5">
            <div className="relative w-full">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث بجهة الصرف أو الملاحظات..."
                className="app-input pl-10"
              />
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            </div>
          </div>

          <div className="app-card overflow-hidden">
            {expenses.length === 0 ? (
              <div className="py-16 text-center text-[var(--text-muted)]">
                <CreditCard className="mx-auto h-12 w-12 opacity-40 stroke-1" />
                <p className="mt-2.5 text-[16px] font-semibold text-[var(--text-secondary)]">
                  لا توجد مصروفات مسجلة
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('add')}
                  className="mt-3 text-[15px] font-bold text-[var(--brand-soft-text)] hover:underline cursor-pointer"
                >
                  + تسجيل أول مصروف
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-default)]">
                {expenses.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between p-4 hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div>
                      <h4 className="font-bold text-[var(--text-primary)] text-[16px]">
                        {e.recipient}
                      </h4>
                      <div className="text-[13px] text-[var(--text-muted)] flex items-center gap-2 mt-0.5">
                        <span>{new Date(e.date).toLocaleDateString('ar-SA')}</span>
                        {e.notes && <span>· {e.notes}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="font-extrabold app-num text-[17px] text-[var(--color-danger)]">
                        -{e.amount.toFixed(0)} {settings.currency}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteExpense(e)}
                        className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] transition cursor-pointer"
                        aria-label="حذف المصروف"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* In-App Delete Expense Confirmation Modal */}
      {confirmDeleteExpense && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex bg-black/60 p-3 sm:p-4 backdrop-blur-[2px] overflow-y-auto overscroll-contain"
        >
          <div className="m-auto w-full max-w-xs max-h-[90dvh] overflow-y-auto app-card p-5 shadow-2xl text-center space-y-4">
            <h3 className="app-section-title">تأكيد حذف المصروف</h3>
            <p className="app-meta-text">
              هل أنت متأكد من حذف مصروف &quot;{confirmDeleteExpense.recipient}&quot;؟
            </p>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmDeleteExpense(null)}
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
                    await DB.deleteExpense(confirmDeleteExpense.id);
                    playSuccessChime();
                    setConfirmDeleteExpense(null);
                  } catch (err) {
                    console.error('Failed to delete expense:', err);
                    alert('حدث خطأ أثناء حذف المصروف');
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
