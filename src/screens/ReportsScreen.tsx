import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Package,
  AlertTriangle,
  Award,
} from 'lucide-react';
import { DB } from '../services/db';
import { ReportData } from '../types';

type PresetPeriod = 'day' | 'week' | 'month' | 'year' | 'custom';

export const ReportsScreen: React.FC = () => {
  const [period, setPeriod] = useState<PresetPeriod>('day');
  const [report, setReport] = useState<ReportData | null>(null);
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const settings = DB.getSettings();

  const calculateDates = (p: PresetPeriod): { from: Date; to: Date } => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    switch (p) {
      case 'day':
        return { from: today, to: endOfDay };
      case 'week': {
        const dayOfWeek = (now.getDay() + 1) % 7;
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - dayOfWeek);
        return { from: startOfWeek, to: endOfDay };
      }
      case 'month': {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        return { from: startOfMonth, to: endOfDay };
      }
      case 'year': {
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        return { from: startOfYear, to: endOfDay };
      }
      case 'custom': {
        const f = customFrom ? new Date(customFrom) : today;
        const t = customTo ? new Date(`${customTo}T23:59:59`) : endOfDay;
        return { from: f, to: t };
      }
    }
  };

  const loadReport = () => {
    const { from, to } = calculateDates(period);
    const data = DB.getReport(from, to);
    setReport(data);
  };

  useEffect(() => {
    loadReport();
    return DB.subscribe(loadReport);
  }, [period, customFrom, customTo]);

  const presets: { id: PresetPeriod; label: string }[] = [
    { id: 'day', label: 'اليوم' },
    { id: 'week', label: 'الأسبوع' },
    { id: 'month', label: 'الشهر' },
    { id: 'year', label: 'السنة' },
    { id: 'custom', label: 'فترة مخصصة' },
  ];

  const maxSoldQty = report?.topSold.reduce((max, x) => Math.max(max, x.v), 1) || 1;
  const maxProfitVal = report?.topProfit.reduce((max, x) => Math.max(max, x.v), 1) || 1;

  return (
    <div dir="rtl" className="space-y-4">
      {/* Top Header Card */}
      <div className="flex flex-wrap items-center justify-between gap-3 app-card p-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-[var(--brand-soft)] text-[var(--brand-soft-text)] flex items-center justify-center shrink-0">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="app-section-title">التقارير المالية والأرباح</h2>
            <p className="app-meta-text">
              تحليل شامل لحركة المبيعات والمشتريات وحساب صافي الأرباح
            </p>
          </div>
        </div>

        {/* Period Filter Buttons */}
        <div className="flex flex-wrap items-center gap-1 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] p-1 rounded-xl">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-[13px] sm:text-[14px] font-bold transition cursor-pointer ${
                period === p.id
                  ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom Date Range Picker inputs if active */}
      {period === 'custom' && (
        <div className="app-card p-3.5 flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold text-[var(--text-secondary)]">من تاريخ:</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="app-input min-h-[40px] w-auto py-1.5 text-[14px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold text-[var(--text-secondary)]">إلى تاريخ:</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="app-input min-h-[40px] w-auto py-1.5 text-[14px]"
            />
          </div>
        </div>
      )}

      {/* Main 4 Metric Cards */}
      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Sales */}
            <div className="app-card p-4 border-[var(--color-success-border)]">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-[var(--color-success)]">
                  إجمالي المبيعات
                </span>
                <div className="rounded-lg bg-[var(--color-success-bg)] p-2 text-[var(--color-success)]">
                  <TrendingUp className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[22px] font-extrabold app-num text-[var(--color-success)]">
                  {report.sales.toFixed(0)}
                </span>
                <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                  {settings.currency}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-[var(--text-secondary)] font-semibold">
                {report.salesInvoicesCount ?? 0} فاتورة بيع
                {(report.returnsInvoicesCount ?? 0) > 0
                  ? ` · ${report.returnsInvoicesCount} مرتجع`
                  : ''}
              </p>
            </div>

            {/* Purchases */}
            <div className="app-card p-4 border-[var(--color-warning-border)]">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-[var(--color-warning)]">
                  إجمالي المشتريات
                </span>
                <div className="rounded-lg bg-[var(--color-warning-bg)] p-2 text-[var(--color-warning)]">
                  <TrendingDown className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[22px] font-extrabold app-num text-[var(--color-warning)]">
                  {report.purchases.toFixed(0)}
                </span>
                <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                  {settings.currency}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-[var(--text-secondary)] font-semibold">
                {report.purchasesInvoicesCount ?? 0} فاتورة شراء
              </p>
            </div>

            {/* Profit (Accrual vs Collected vs Net) */}
            <div className="app-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-[var(--brand-soft-text)]">
                  الربح المحاسبي الاستحقاقي
                </span>
                <div className="rounded-lg bg-[var(--brand-soft)] p-2 text-[var(--brand-soft-text)]">
                  <DollarSign className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[22px] font-extrabold app-num text-[var(--brand-soft-text)]">
                  {report.profit.toFixed(0)}
                </span>
                <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                  {settings.currency}
                </span>
              </div>
              <div className="mt-1.5 space-y-0.5 text-[12px] font-bold text-[var(--text-secondary)]">
                <p className="text-[var(--color-success)] app-num">
                  محصل: {(report.collectedProfit ?? 0).toFixed(0)} · آجل:{' '}
                  {(report.deferredProfit ?? 0).toFixed(0)}
                </p>
                <p className="app-num">
                  الصافي بعد المصروفات:{' '}
                  {(report.netProfit ?? report.profit - report.expenses).toFixed(0)}{' '}
                  {settings.currency}
                </p>
              </div>
            </div>

            {/* Stock Value */}
            <div className="app-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                  قيمة بضاعة المخزن
                </span>
                <div className="rounded-lg bg-[var(--bg-surface-subtle)] p-2 text-[var(--brand-primary)]">
                  <Package className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[22px] font-extrabold app-num text-[var(--text-primary)]">
                  {report.stockValue.toFixed(0)}
                </span>
                <span className="text-[13px] font-bold text-[var(--text-secondary)]">
                  {settings.currency}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-[var(--text-muted)] font-semibold">
                بسعر التكلفة (سعر الشراء)
              </p>
            </div>
          </div>

          {/* Breakdown Section: Top Sold, Top Profit, Low Stock */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Top Sold by Quantity */}
            <div className="app-card p-4">
              <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-default)]">
                <Award className="h-5 w-5 text-[var(--color-success)]" />
                <h3 className="font-bold text-[var(--text-primary)] text-[16px]">
                  الأكثر مبيعًا (بالكمية)
                </h3>
              </div>
              <div className="mt-3.5 space-y-3">
                {report.topSold.length === 0 ? (
                  <p className="text-center text-[14px] text-[var(--text-muted)] py-6">
                    لا توجد مبيعات في هذه الفترة
                  </p>
                ) : (
                  report.topSold.map((it, idx) => {
                    const pct = Math.min(100, (it.v / maxSoldQty) * 100);
                    return (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex justify-between text-[14px] font-semibold text-[var(--text-primary)]">
                          <span className="truncate max-w-[70%]">{it.name}</span>
                          <span className="app-num text-[var(--color-success)] font-bold">
                            {it.v} قطعة
                          </span>
                        </div>
                        <div className="h-2 w-full bg-[var(--bg-surface-subtle)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[var(--color-success)] rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Top Profit Items */}
            <div className="app-card p-4">
              <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-default)]">
                <TrendingUp className="h-5 w-5 text-[var(--brand-primary)]" />
                <h3 className="font-bold text-[var(--text-primary)] text-[16px]">
                  الأكثر تحقيقًا للأرباح
                </h3>
              </div>
              <div className="mt-3.5 space-y-3">
                {report.topProfit.length === 0 ? (
                  <p className="text-center text-[14px] text-[var(--text-muted)] py-6">
                    لا توجد أرباح مسجلة في هذه الفترة
                  </p>
                ) : (
                  report.topProfit.map((it, idx) => {
                    const pct = Math.min(100, (it.v / maxProfitVal) * 100);
                    return (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex justify-between text-[14px] font-semibold text-[var(--text-primary)]">
                          <span className="truncate max-w-[70%]">{it.name}</span>
                          <span className="app-num text-[var(--brand-soft-text)] font-bold">
                            {it.v.toFixed(0)} {settings.currency}
                          </span>
                        </div>
                        <div className="h-2 w-full bg-[var(--bg-surface-subtle)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[var(--brand-primary)] rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Low Stock Warning */}
            <div className="app-card p-4">
              <div className="flex items-center gap-2 pb-3 border-b border-[var(--border-default)]">
                <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
                <h3 className="font-bold text-[var(--text-primary)] text-[16px]">
                  أصناف قاربت على النفاد (≤ 5)
                </h3>
              </div>
              <div className="mt-3 divide-y divide-[var(--border-default)]">
                {report.lowStock.length === 0 ? (
                  <p className="text-center text-[14px] text-[var(--color-success)] py-6 font-semibold">
                    جميع الأصناف متوفرة بكميات كافية
                  </p>
                ) : (
                  report.lowStock.map((p) => (
                    <div key={p.id} className="py-2.5 flex items-center justify-between text-[14px]">
                      <div>
                        <span className="font-bold text-[var(--text-primary)] block">
                          {p.name}
                        </span>
                        <span className="text-[12px] text-[var(--text-muted)]">{p.category}</span>
                      </div>
                      <span className="rounded-lg bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-2.5 py-1 font-bold app-num text-[var(--color-danger)]">
                        {p.qty} قطعة
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
