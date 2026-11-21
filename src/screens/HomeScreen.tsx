import React, { useState, useEffect } from 'react';
import {
  Search,
  Boxes,
  ShoppingCart,
  Users,
  Truck,
  FileSpreadsheet,
  CreditCard,
  TrendingUp,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Product, ScreenId } from '../types';
import { DB } from '../services/db';

interface HomeScreenProps {
  onNavigate: (screen: ScreenId) => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ onNavigate }) => {
  const [search, setSearch] = useState('');
  const [quickResults, setQuickResults] = useState<Product[]>([]);
  const [stats, setStats] = useState({
    todaySales: 0,
    salesCount: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
    totalProducts: 0,
    totalCustomerDebt: 0,
  });

  const settings = DB.getSettings();

  useEffect(() => {
    const updateStats = () => {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      const report = DB.getReport(startOfDay, endOfDay);
      const products = DB.getProducts();
      const lowStock = products.filter((p) => p.qty <= 5);
      const outStock = products.filter((p) => p.qty <= 0);
      const customers = DB.getParties('customer');
      const customerDebt = customers.reduce((sum, c) => sum + Math.max(0, c.balance || 0), 0);

      setStats({
        todaySales: report.sales,
        salesCount: report.salesInvoicesCount ?? 0,
        lowStockCount: lowStock.length,
        outOfStockCount: outStock.length,
        totalProducts: products.length,
        totalCustomerDebt: customerDebt,
      });
    };

    updateStats();
    return DB.subscribe(updateStats);
  }, []);

  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setQuickResults([]);
      return;
    }
    setQuickResults(DB.getProducts(q).slice(0, 6));
  }, [search]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) {
      onNavigate('products');
    }
  };

  // Ordered from Right to Left in RTL grid
  const cards = [
    {
      id: 'products' as ScreenId,
      title: 'مخزن المنتجات',
      subtitle: `${stats.totalProducts} صنف مسجل`,
      image:
        'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=700&q=80',
      icon: Boxes,
      isFullWidth: true,
    },
    {
      id: 'purchase' as ScreenId,
      title: 'المشتريات',
      subtitle: 'توريد بضاعة للمخزن',
      image:
        'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&w=700&q=80',
      icon: ShoppingCart,
    },
    {
      id: 'sale' as ScreenId,
      title: 'المبيعات',
      subtitle: 'فاتورة بيع سريعة',
      image:
        'https://images.unsplash.com/photo-1556740758-90de374c12ad?auto=format&fit=crop&w=700&q=80',
      icon: TrendingUp,
    },
    {
      id: 'customers' as ScreenId,
      title: 'العملاء',
      subtitle: 'دفتر الديون والتحصيل',
      image:
        'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=700&q=80',
      icon: Users,
    },
    {
      id: 'suppliers' as ScreenId,
      title: 'الموردين',
      subtitle: 'حسابات ومستحقات الموردين',
      image:
        'https://images.unsplash.com/photo-1580674684081-7617fbf3d745?auto=format&fit=crop&w=700&q=80',
      icon: Truck,
    },
    {
      id: 'expenses' as ScreenId,
      title: 'المصروفات',
      subtitle: 'تسجيل مصاريف المحل',
      image:
        'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?auto=format&fit=crop&w=700&q=80',
      icon: CreditCard,
    },
    {
      id: 'accounts' as ScreenId,
      title: 'إدارة الحسابات',
      subtitle: 'التقارير والأرباح والجرد',
      image:
        'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=700&q=80',
      icon: FileSpreadsheet,
    },
  ];

  return (
    <div dir="rtl" className="space-y-4 text-right">
      {/* Top Instant Price & Stock Lookup Bar */}
      <div className="relative">
        <form onSubmit={handleSearchSubmit} className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث عن منتج أو باركود لمعرفة السعر..."
            className="app-input pr-12 pl-11 bg-[var(--bg-surface)]"
          />
          <Search className="pointer-events-none absolute right-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--brand-primary)]" />
          {search.trim() !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute left-2 top-1/2 -translate-y-1/2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
              aria-label="مسح البحث"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>

        {/* Live Price & Stock Checker Results */}
        {search.trim() !== '' && (
          <div className="absolute inset-x-0 top-full mt-2 z-30 app-card shadow-2xl overflow-hidden">
            <div className="bg-[var(--brand-primary)] text-white px-4 py-2 text-[13px] font-bold flex items-center justify-between">
              <span>كاشف السعر والرصيد السريع</span>
              <span className="app-num">النتائج: {quickResults.length}</span>
            </div>
            {quickResults.length === 0 ? (
              <div className="p-5 text-center text-[15px] font-semibold text-[var(--text-muted)]">
                لا يوجد منتج مطابق لـ &quot;{search}&quot;
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-default)] max-h-72 overflow-y-auto">
                {quickResults.map((p) => (
                  <div
                    key={p.id}
                    className="p-3.5 flex items-center justify-between gap-3 hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-[var(--text-primary)] text-[16px] truncate">
                        {p.name}
                      </div>
                      <div className="text-[13px] text-[var(--text-secondary)] mt-0.5 flex items-center gap-2">
                        <span className="truncate">{p.category || 'عام'}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-bold shrink-0 app-num ${
                            p.qty <= 0
                              ? 'text-[var(--color-danger)]'
                              : p.qty <= 5
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-success)]'
                          }`}
                        >
                          الرصيد: {p.qty}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-left">
                        <span className="text-[12px] text-[var(--text-muted)] block">سعر البيع</span>
                        <span className="font-extrabold app-num text-[16px] text-[var(--brand-soft-text)]">
                          {p.sell_price.toFixed(0)} {settings.currency}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onNavigate('sale')}
                        className="app-btn-primary min-h-[40px] px-3.5 py-1.5 text-[14px]"
                      >
                        بيع
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Business KPI Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-right">
        <button
          type="button"
          onClick={() => onNavigate('invoices_sale')}
          className="app-card p-3.5 text-right hover:border-[var(--brand-primary)] transition-colors cursor-pointer"
        >
          <span className="text-[var(--text-secondary)] font-semibold block text-[13px] truncate">
            مبيعات اليوم ({stats.salesCount})
          </span>
          <span className="font-extrabold app-num text-[var(--brand-soft-text)] text-[18px] mt-1 block truncate">
            {stats.todaySales.toFixed(0)} {settings.currency}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('customers')}
          className="app-card p-3.5 text-right hover:border-[var(--color-danger)] transition-colors cursor-pointer"
        >
          <span className="text-[var(--text-secondary)] font-semibold block text-[13px] truncate">
            ديون لنا عند العملاء
          </span>
          <span
            className={`font-extrabold app-num text-[18px] mt-1 block truncate ${
              stats.totalCustomerDebt > 0
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-success)]'
            }`}
          >
            {stats.totalCustomerDebt.toFixed(0)} {settings.currency}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('products')}
          className="app-card p-3.5 text-right hover:border-[var(--brand-primary)] transition-colors cursor-pointer"
        >
          <span className="text-[var(--text-secondary)] font-semibold block text-[13px] truncate">
            أصناف المخزن
          </span>
          <span className="font-extrabold app-num text-[var(--text-primary)] text-[18px] mt-1 block truncate">
            {stats.totalProducts} صنف
          </span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('accounts')}
          className="app-card p-3.5 text-right hover:border-[var(--color-warning)] transition-colors cursor-pointer"
        >
          <span className="text-[var(--text-secondary)] font-semibold block text-[13px] truncate">
            النواقص والمنتهي
          </span>
          <span
            className={`font-extrabold app-num text-[18px] mt-1 flex items-center gap-1.5 truncate ${
              stats.lowStockCount > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'
            }`}
          >
            {stats.lowStockCount > 0 && (
              <AlertTriangle className="h-4 w-4 text-[var(--color-warning)] shrink-0" />
            )}
            <span>{stats.lowStockCount} صنف</span>
          </span>
        </button>
      </div>

      {/* Main Navigation Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3" dir="rtl">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              onClick={() => onNavigate(card.id)}
              className={`group relative overflow-hidden rounded-2xl bg-[#0f2435] cursor-pointer shadow-xs hover:shadow-md transition-all active:scale-98 border border-[var(--border-default)] ${
                card.isFullWidth ? 'col-span-2 lg:col-span-3 h-32 sm:h-40' : 'h-28 sm:h-36'
              }`}
            >
              {/* Background Image with clean navy overlay & offline fallback */}
              <img
                src={card.image}
                alt={card.title}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0d1626]/90 via-[#0d1626]/35 to-transparent" />

              <div className="absolute top-2.5 left-2.5 h-9 w-9 rounded-xl bg-white/15 backdrop-blur-xs border border-white/20 flex items-center justify-center text-white">
                <Icon className="h-5 w-5" />
              </div>

              {/* Title Label on bottom right */}
              <div className="absolute bottom-2.5 right-2.5 rounded-xl bg-[#0d1626]/90 backdrop-blur-xs px-3 py-1.5 text-white shadow-md border border-white/15 transition-transform group-hover:scale-105">
                <span className="text-[15px] sm:text-[17px] font-extrabold tracking-wide block leading-snug">
                  {card.title}
                </span>
                <span className="text-[12px] text-slate-200 font-medium block leading-tight">
                  {card.subtitle}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
