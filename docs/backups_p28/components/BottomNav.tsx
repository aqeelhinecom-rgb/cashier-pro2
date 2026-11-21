import React from 'react';
import { Home, TrendingUp, Boxes, FileSpreadsheet, Settings } from 'lucide-react';
import { ScreenId } from '../types';

interface BottomNavProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  hidden?: boolean;
}

const BOTTOM_TABS: {
  id: ScreenId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  matchScreens?: ScreenId[];
}[] = [
  { id: 'home', label: 'الرئيسية', icon: Home },
  {
    id: 'sale',
    label: 'بيع جديد',
    icon: TrendingUp,
    matchScreens: ['sale', 'purchase', 'sale_return', 'quote'],
  },
  { id: 'products', label: 'المنتجات', icon: Boxes },
  {
    id: 'accounts',
    label: 'الحسابات',
    icon: FileSpreadsheet,
    matchScreens: ['accounts', 'customers', 'suppliers', 'expenses'],
  },
  { id: 'backup', label: 'الإعدادات', icon: Settings },
];

export const BottomNav: React.FC<BottomNavProps> = ({
  currentScreen,
  onNavigate,
  hidden = false,
}) => {
  if (hidden) return null;

  return (
    <nav
      dir="rtl"
      aria-label="التنقل السريع"
      className="lg:hidden shrink-0 z-30 bg-[var(--bg-chrome)] border-t border-[var(--border-default)] pb-[env(safe-area-inset-bottom,0px)] select-none print:hidden"
    >
      <div className="grid grid-cols-5 items-stretch max-w-2xl mx-auto">
        {BOTTOM_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive =
            currentScreen === tab.id ||
            (tab.matchScreens ? tab.matchScreens.includes(currentScreen) : false);

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onNavigate(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`min-h-[58px] flex flex-col items-center justify-center gap-1 px-1 py-1.5 transition-colors cursor-pointer ${
                isActive
                  ? 'text-[var(--brand-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span
                className={`flex items-center justify-center h-8 w-12 rounded-xl transition-colors ${
                  isActive ? 'bg-[var(--brand-soft)]' : 'bg-transparent'
                }`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="text-[12px] font-bold leading-none truncate max-w-full">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
