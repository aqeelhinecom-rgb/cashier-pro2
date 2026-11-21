import React from 'react';
import {
  Home,
  Boxes,
  TrendingUp,
  ShoppingCart,
  RotateCcw,
  FileText,
  Users,
  Truck,
  CreditCard,
  FileSpreadsheet,
  Receipt,
  Settings,
  Cloud,
  Sun,
  Moon,
} from 'lucide-react';
import { ScreenId, StoreSettings } from '../types';

interface DesktopSidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  settings: StoreSettings;
  onToggleTheme: () => void;
}

interface NavGroup {
  title: string;
  items: {
    id: ScreenId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'العمليات السريعة',
    items: [
      { id: 'home', label: 'الرئيسية', icon: Home },
      { id: 'sale', label: 'فاتورة بيع جديدة', icon: TrendingUp },
      { id: 'purchase', label: 'فاتورة شراء (توريد)', icon: ShoppingCart },
      { id: 'sale_return', label: 'فاتورة مرتجع', icon: RotateCcw },
      { id: 'quote', label: 'عرض سعر', icon: FileText },
    ],
  },
  {
    title: 'المخزن والأطراف',
    items: [
      { id: 'products', label: 'مخزن المنتجات', icon: Boxes },
      { id: 'customers', label: 'العملاء', icon: Users },
      { id: 'suppliers', label: 'الموردين', icon: Truck },
    ],
  },
  {
    title: 'الفواتير والمالية',
    items: [
      { id: 'invoices_sale', label: 'فواتير البيع', icon: Receipt },
      { id: 'invoices_purchase', label: 'فواتير الشراء', icon: ShoppingCart },
      { id: 'invoices_return', label: 'فواتير المرتجع', icon: RotateCcw },
      { id: 'invoices_quote', label: 'عروض الأسعار', icon: FileSpreadsheet },
      { id: 'expenses', label: 'المصروفات', icon: CreditCard },
      { id: 'accounts', label: 'إدارة الحسابات', icon: FileSpreadsheet },
    ],
  },
  {
    title: 'النظام',
    items: [
      { id: 'settings', label: 'إعدادات المتجر', icon: Settings },
      { id: 'backup', label: 'النسخ الاحتياطي', icon: Cloud },
    ],
  },
];

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  currentScreen,
  onNavigate,
  settings,
  onToggleTheme,
}) => {
  const isDark = settings.theme === 'dark';

  return (
    <aside
      dir="rtl"
      aria-label="القائمة الجانبية"
      className="hidden lg:flex w-64 shrink-0 flex-col bg-[var(--bg-chrome)] border-l border-[var(--border-default)] h-full select-none print:hidden"
    >
      {/* Navigation Groups (independently scrollable if screen height is compact) */}
      <nav className="app-scroll-region flex-1 px-3 py-4 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-1">
            <div className="px-3 pb-1 text-[12px] font-bold text-[var(--text-muted)] tracking-wide">
              {group.title}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = currentScreen === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
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
        ))}
      </nav>

      {/* Fixed Sidebar Footer */}
      <div className="shrink-0 p-3 border-t border-[var(--border-default)] space-y-2.5 bg-[var(--bg-chrome)]">
        <button
          type="button"
          onClick={onToggleTheme}
          className="w-full min-h-[44px] flex items-center justify-between px-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] text-[14px] font-bold transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2">
            {isDark ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4 text-[var(--brand-primary)]" />
            )}
            <span>{isDark ? 'الوضع النهاري' : 'الوضع الليلي'}</span>
          </span>
          <span className="text-[12px] text-[var(--text-muted)] font-semibold">
            {isDark ? 'داكن' : 'فاتح'}
          </span>
        </button>

        <div className="flex items-center justify-between px-1 text-[12px] text-[var(--text-muted)]">
          <span className="font-semibold">العملة: {settings.currency || 'د.ع'}</span>
          <span className="font-mono">F1 بيع · F2 شراء</span>
        </div>
      </div>
    </aside>
  );
};
