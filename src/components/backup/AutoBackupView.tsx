import React from 'react';
import {
  ChevronRight,
  Check,
  Receipt,
  Package,
  Users,
  Wallet,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import type { StorageBackupRecord } from '../../services/storage/types';

interface AutoBackupViewProps {
  autoBackups: StorageBackupRecord[];
  loading: boolean;
  onBack: () => void;
  onRunAutoBackupNow: () => void;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export const AutoBackupView: React.FC<AutoBackupViewProps> = ({
  autoBackups,
  loading,
  onBack,
  onRunAutoBackupNow,
}) => {
  const latestAuto = autoBackups[0] || null;
  const isRecent =
    latestAuto !== null &&
    Date.now() - new Date(latestAuto.createdAt).getTime() < TWENTY_FOUR_HOURS_MS;

  const backedUpCategories = [
    {
      id: 'sales',
      label: 'الفواتير والمبيعات',
      icon: Receipt,
    },
    {
      id: 'inventory',
      label: 'المنتجات والمخزن',
      icon: Package,
    },
    {
      id: 'parties',
      label: 'العملاء والموردين والديون',
      icon: Users,
    },
    {
      id: 'expenses',
      label: 'المصروفات وإعدادات المتجر',
      icon: Wallet,
    },
  ];

  return (
    <div
      dir="rtl"
      className="app-card px-5 py-6 sm:px-8 sm:py-8 space-y-8"
    >
      <div className="space-y-8">
        {/* Top Header */}
        <div className="relative flex items-center justify-center min-h-[44px]">
          <button
            type="button"
            onClick={onBack}
            className="absolute right-0 h-11 w-11 rounded-full hover:bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center transition cursor-pointer"
            aria-label="العودة إلى النسخ الاحتياطي"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
          <h1 className="app-page-title text-[var(--brand-primary)]">النسخ التلقائي</h1>
        </div>

        {/* Status + Concise Description */}
        <div className="text-center space-y-4 pt-2">
          <p
            className={`app-section-title ${
              isRecent ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'
            }`}
          >
            {isRecent
              ? 'الحالة: اكتمل النسخ الاحتياطي'
              : 'الحالة: يحتاج إلى إجراء'}
          </p>

          <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed max-w-md mx-auto">
            يتم حفظ نسخة يومية تلقائياً على هذا الجهاز كل 24 ساعة لحماية بياناتك. لحفظ نسخة في حسابك السحابي استخدم زر الرفع في صفحة النسخ الاحتياطي.
          </p>

          <div className="app-meta-text app-num pt-1">
            <span>آخر نسخة تلقائية: </span>
            <span className="font-bold text-[var(--text-primary)]">
              {latestAuto
                ? new Date(latestAuto.createdAt).toLocaleString('ar-EG', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'لم يتم أخذ نسخة تلقائية بعد'}
            </span>
          </div>

          {!isRecent && (
            <div className="pt-2">
              <button
                type="button"
                onClick={onRunAutoBackupNow}
                disabled={loading}
                className="app-btn-primary rounded-2xl px-6 py-3 min-h-[48px]"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span>أخذ نسخة تلقائية الآن</span>
              </button>
            </div>
          )}
        </div>

        {/* Backed-up Data List */}
        <div className="space-y-2 pt-2">
          <h2 className="app-section-title text-[var(--brand-primary)] pb-2">
            البيانات التي تم نسخها
          </h2>

          <div className="divide-y divide-[var(--border-default)]">
            {backedUpCategories.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.id}
                  className="py-4 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className="font-bold text-[var(--text-primary)] text-[16px]">
                      {item.label}
                    </span>
                  </div>

                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
                      latestAuto
                        ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                        : 'bg-[var(--bg-surface-subtle)] text-[var(--text-muted)]'
                    }`}
                    title={latestAuto ? 'مشمول في النسخة التلقائية' : 'في انتظار أول نسخة'}
                  >
                    <Check className="h-4 w-4" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Action */}
      <div className="pt-2 text-center">
        <button
          type="button"
          onClick={onRunAutoBackupNow}
          disabled={loading}
          className="min-h-[44px] text-[14px] font-bold text-[var(--brand-primary)] py-2.5 px-5 rounded-xl hover:bg-[var(--brand-soft)] transition cursor-pointer disabled:opacity-60"
        >
          {loading ? 'جاري حفظ النسخة...' : 'تحديث النسخة التلقائية الآن'}
        </button>
      </div>
    </div>
  );
};
