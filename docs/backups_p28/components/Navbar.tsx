import React, { useState, useEffect } from 'react';
import {
  Menu,
  ArrowRight,
  Home,
  Boxes,
  ShoppingCart,
  Users,
  Truck,
  FileSpreadsheet,
  CreditCard,
  Receipt,
  RotateCcw,
  FileText,
  X,
  TrendingUp,
  Sun,
  Moon,
  Settings,
  Edit2,
  Check,
} from 'lucide-react';
import { ScreenId, StoreSettings } from '../types';
import { DB } from '../services/db';
import { useBackHandler } from '../services/navigation';

interface NavbarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  onStepBack?: () => void;
  title?: string;
}

export const Navbar: React.FC<NavbarProps> = ({ currentScreen, onNavigate, onStepBack, title }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState<StoreSettings>(DB.getSettings());
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  useBackHandler(menuOpen, () => setMenuOpen(false));

  useEffect(() => {
    const sync = () => {
      setSettings(DB.getSettings());
    };
    return DB.subscribe(sync);
  }, []);

  const isDark = settings.theme === 'dark';

  const toggleTheme = async () => {
    const nextTheme = isDark ? 'light' : 'dark';
    try {
      await DB.saveSettings({ theme: nextTheme });
    } catch (err) {
      console.error('Failed to toggle theme:', err);
    }
  };

  const startEditingName = () => {
    setNameDraft(settings.storeName || 'Cashier Pro');
    setIsEditingName(true);
  };

  const saveStoreName = async (e?: React.MouseEvent | React.FormEvent) => {
    if (e) e.stopPropagation();
    const trimmed = nameDraft.trim() || 'Cashier Pro';
    try {
      await DB.saveSettings({ storeName: trimmed });
    } catch (err) {
      console.error('Failed to save store name:', err);
    }
    setIsEditingName(false);
  };

  const cancelEditingName = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setIsEditingName(false);
  };

  const navItems: { id: ScreenId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'home', label: 'الرئيسية', icon: Home },
    { id: 'sale', label: 'المبيعات (فاتورة جديدة)', icon: TrendingUp },
    { id: 'purchase', label: 'المشتريات (توريد)', icon: ShoppingCart },
    { id: 'sale_return', label: 'فاتورة مرتجع', icon: RotateCcw },
    { id: 'quote', label: 'عرض سعر', icon: FileText },
    { id: 'products', label: 'مخزن المنتجات', icon: Boxes },
    { id: 'customers', label: 'العملاء', icon: Users },
    { id: 'suppliers', label: 'الموردين', icon: Truck },
    { id: 'expenses', label: 'المصروفات', icon: CreditCard },
    { id: 'accounts', label: 'إدارة الحسابات', icon: FileSpreadsheet },
    { id: 'invoices_sale', label: 'فواتير البيع', icon: Receipt },
    { id: 'invoices_purchase', label: 'فواتير الشراء', icon: ShoppingCart },
    { id: 'invoices_return', label: 'فواتير المرتجع', icon: RotateCcw },
    { id: 'invoices_quote', label: 'عروض الأسعار', icon: FileSpreadsheet },
    { id: 'backup', label: 'الإعدادات والنسخ الاحتياطي', icon: Settings },
  ];

  const handleItemClick = (id: ScreenId) => {
    setMenuOpen(false);
    onNavigate(id);
  };

  const displayTitle = title || settings.storeName || 'Cashier Pro';

  return (
    <>
      <header
        dir="rtl"
        className="shrink-0 z-30 h-14 sm:h-16 bg-[var(--bg-chrome)] text-[var(--text-primary)] border-b border-[var(--border-default)] transition-colors print:hidden"
      >
        <div className="h-full max-w-6xl mx-auto px-3 sm:px-5 flex items-center justify-between gap-2.5">
          {/* Right Cluster (RTL start): Mobile Menu or Back Button + Brand/Page Title */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {currentScreen === 'home' ? (
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0 cursor-pointer"
                title="القائمة الرئيسية"
                aria-label="القائمة الرئيسية"
              >
                <Menu className="h-6 w-6" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => (onStepBack ? onStepBack() : onNavigate('home'))}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0 cursor-pointer"
                title="رجوع"
                aria-label="رجوع"
              >
                <ArrowRight className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>
            )}

            <img
              src="/app-icon.svg"
              alt="POS"
              className="h-8 w-8 sm:h-9 sm:w-9 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] p-0.5 object-contain shrink-0"
            />

            {currentScreen === 'home' ? (
              <div className="min-w-0 flex-1">
                {isEditingName ? (
                  <div
                    className="flex items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveStoreName(e);
                        if (e.key === 'Escape') cancelEditingName();
                      }}
                      autoFocus
                      placeholder="اسم المحل..."
                      className="app-input min-h-[38px] py-1 px-2.5 text-[15px] font-bold max-w-[200px] sm:max-w-[260px]"
                    />
                    <button
                      type="button"
                      onClick={saveStoreName}
                      className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl bg-[var(--color-success)] text-white shrink-0 cursor-pointer"
                      title="حفظ الاسم"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditingName}
                      className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] shrink-0 cursor-pointer"
                      title="إلغاء"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={startEditingName}
                    title="اضغط لتغيير اسم المحل"
                    className="group flex items-center gap-1.5 min-w-0 text-right cursor-pointer"
                  >
                    <h1 className="text-[18px] sm:text-[21px] font-extrabold text-[var(--text-primary)] truncate leading-tight">
                      {settings.storeName || 'Cashier Pro'}
                    </h1>
                    <Edit2 className="h-3.5 w-3.5 text-[var(--text-muted)] group-hover:text-[var(--brand-primary)] transition-colors shrink-0" />
                  </button>
                )}
              </div>
            ) : (
              <h1 className="text-[18px] sm:text-[21px] font-extrabold text-[var(--text-primary)] truncate leading-tight">
                {displayTitle}
              </h1>
            )}
          </div>

          {/* Left Cluster (RTL end): Instant Theme Toggle across ALL screens */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              className="min-h-[40px] px-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] text-[13px] sm:text-[14px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              title={isDark ? 'التحويل إلى الوضع النهاري' : 'التحويل إلى الوضع الليلي'}
            >
              {isDark ? (
                <>
                  <Sun className="h-4 w-4 text-amber-400 shrink-0" />
                  <span className="hidden sm:inline">نهاري</span>
                </>
              ) : (
                <>
                  <Moon className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                  <span className="hidden sm:inline">ليلي</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile / Tablet Slide-out Drawer */}
      {menuOpen && (
        <div
          dir="rtl"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-50 flex justify-start bg-black/55 backdrop-blur-[2px] lg:hidden"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-72 sm:w-80 bg-[var(--bg-chrome)] text-[var(--text-primary)] h-full shadow-2xl border-l border-[var(--border-default)] flex flex-col p-4"
          >
            <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border-default)] gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <img
                  src="/app-icon.svg"
                  alt="POS"
                  className="h-10 w-10 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] object-contain p-1 shrink-0"
                />
                <div className="min-w-0">
                  <h3 className="font-extrabold text-[16px] text-[var(--text-primary)] leading-snug truncate">
                    {settings.storeName || 'Cashier Pro'}
                  </h3>
                  <span className="text-[12px] text-[var(--brand-soft-text)] font-bold bg-[var(--brand-soft)] px-2 py-0.5 rounded-md inline-block mt-0.5">
                    نظام نقاط البيع والمخزن
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] shrink-0 cursor-pointer"
                aria-label="إغلاق القائمة"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="app-scroll-region flex-1 py-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = currentScreen === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleItemClick(item.id)}
                    className={`w-full min-h-[44px] flex items-center gap-3 px-3 py-2 rounded-xl text-[15px] font-bold text-right transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="pt-3 border-t border-[var(--border-default)] text-center text-[13px] text-[var(--text-muted)] space-y-0.5">
              <p className="font-bold text-[var(--text-primary)]">Cashier Pro</p>
              <p>العملة: {settings.currency} · الخط: {settings.fontFamily || 'Cairo'}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
