import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldCheck, Camera, HardDrive, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { ScreenId, Invoice, StoreSettings } from './types';
import { DB, StorageInitState } from './services/db';
import {
  pushBackEntry,
  removeBackEntry,
  triggerStepBack,
  onRootExitPrompt,
} from './services/navigation';
import { Navbar } from './components/Navbar';
import { DesktopSidebar } from './components/DesktopSidebar';
import { BottomNav } from './components/BottomNav';
import { HomeScreen } from './screens/HomeScreen';
import { InvoiceScreen } from './screens/InvoiceScreen';
import { ProductsScreen } from './screens/ProductsScreen';
import { PartiesScreen } from './screens/PartiesScreen';
import { InvoicesListScreen } from './screens/InvoicesListScreen';
import { AccountsScreen } from './screens/AccountsScreen';
import { ExpensesScreen } from './screens/ExpensesScreen';
import { BackupScreen } from './screens/BackupScreen';

export default function App() {
  // Initialization Gate State (المرحلة 3C: حظر تشغيل الواجهات قبل اكتمال التهيئة)
  const [initState, setInitState] = useState<StorageInitState>(() => DB.getStorageState());
  const [initError, setInitError] = useState<string | null>(null);

  const [screenStack, setScreenStack] = useState<ScreenId[]>(['home']);
  const screenEntriesRef = useRef<ReturnType<typeof pushBackEntry>[]>([]);
  const mainScrollRef = useRef<HTMLElement | null>(null);

  // Store settings reactive state for DesktopSidebar & theme toggle
  const [settings, setSettings] = useState<StoreSettings>(() => DB.getSettings());

  // Mobile virtual keyboard visibility state (prevents BottomNav from crowding inputs)
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  // Double-tap-to-exit toast state
  const [exitToastVisible, setExitToastVisible] = useState(false);
  const exitToastTimeoutRef = useRef<number | null>(null);

  // One-time first-install permissions prompt state
  const [showFirstTimePermissions, setShowFirstTimePermissions] = useState<boolean>(
    () => !DB.isPermissionsGranted()
  );

  const currentScreen = screenStack[screenStack.length - 1] || 'home';
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);

  const handleNavigate = useCallback((nextScreen: ScreenId) => {
    setScreenStack((prev) => {
      const current = prev[prev.length - 1];
      if (current === nextScreen) return prev;

      if (nextScreen === 'home') {
        while (screenEntriesRef.current.length > 0) {
          const entry = screenEntriesRef.current.pop();
          if (entry) removeBackEntry(entry);
        }
        return ['home'];
      }

      const entry = pushBackEntry(() => {
        screenEntriesRef.current.pop();
        setScreenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : ['home']));
      });
      screenEntriesRef.current.push(entry);

      return [...prev, nextScreen];
    });
  }, []);

  const handleStartEditInvoice = useCallback(
    (invoice: Invoice) => {
      setEditingInvoice(invoice);
      handleNavigate(invoice.type === 'purchase' ? 'purchase' : 'sale');
    },
    [handleNavigate]
  );

  useEffect(() => {
    if (currentScreen !== 'sale' && currentScreen !== 'purchase' && editingInvoice) {
      setEditingInvoice(null);
    }
  }, [currentScreen, editingInvoice]);

  const handleStepBack = useCallback(() => {
    const handled = triggerStepBack();
    if (!handled && currentScreen !== 'home') {
      handleNavigate('home');
    }
  }, [currentScreen, handleNavigate]);

  const handleToggleTheme = useCallback(async () => {
    const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
    try {
      await DB.saveSettings({ theme: nextTheme });
    } catch (err) {
      console.error('Failed to toggle theme:', err);
    }
  }, [settings.theme]);

  // Subscribe to root exit prompt (1st tap on Back button at Home screen)
  useEffect(() => {
    return onRootExitPrompt(() => {
      setExitToastVisible(true);
      if (exitToastTimeoutRef.current) {
        window.clearTimeout(exitToastTimeoutRef.current);
      }
      exitToastTimeoutRef.current = window.setTimeout(() => {
        setExitToastVisible(false);
      }, 2000);
    });
  }, []);

  // Startup Initialization Gate (المرحلة 3C)
  useEffect(() => {
    let isMounted = true;
    async function initApp() {
      try {
        setInitState(StorageInitState.INITIALIZING);
        const ok = await DB.initializeAsync();
        if (!isMounted) return;
        if (ok) {
          setInitState(StorageInitState.READY);
          setShowFirstTimePermissions(!DB.isPermissionsGranted());
          setInitError(null);
        } else {
          setInitState(StorageInitState.FAILED);
          const lastErr = DB.getLastStorageError();
          setInitError(lastErr?.message || 'تعذر تهيئة محرك التخزين المحلي');
        }
      } catch (err: any) {
        if (!isMounted) return;
        setInitState(StorageInitState.FAILED);
        setInitError(err?.message || 'حدث خطأ غير متوقع أثناء بدء تشغيل التطبيق');
      }
    }

    initApp();

    return () => {
      isMounted = false;
    };
  }, []);

  // Grant permissions once on first install and persist settings automatically
  const handleGrantFirstTimePermissions = async () => {
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }
    } catch {
      // Ignore storage persistence error
    }

    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch {
      // Ignore if camera is unavailable or declined; never ask again
    }

    await DB.grantPermissionsOnce();
    setShowFirstTimePermissions(false);
  };

  // Disable automatic browser scroll restoration and reset ONLY the inner scroll region on screen change
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (mainScrollRef.current) {
      mainScrollRef.current.scrollTop = 0;
    }
  }, [currentScreen]);

  // Mobile keyboard handling: hide BottomNav while typing & keep focused input scrolled cleanly into view
  useEffect(() => {
    const isTextControl = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file'].includes(type);
      }
      return false;
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (window.innerWidth < 1024 && isTextControl(e.target)) {
        setIsKeyboardOpen(true);
        const target = e.target;
        window.setTimeout(() => {
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 180);
      }
    };

    const handleFocusOut = () => {
      window.setTimeout(() => {
        if (!isTextControl(document.activeElement)) {
          setIsKeyboardOpen(false);
        }
      }, 120);
    };

    const baselineHeight = window.innerHeight;
    const handleViewportResize = () => {
      if (window.visualViewport && window.innerWidth < 1024) {
        const shrunkBy = baselineHeight - window.visualViewport.height;
        if (shrunkBy > 150) {
          setIsKeyboardOpen(true);
        } else if (!isTextControl(document.activeElement)) {
          setIsKeyboardOpen(false);
        }
      } else {
        setIsKeyboardOpen(false);
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.visualViewport?.addEventListener('resize', handleViewportResize);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.visualViewport?.removeEventListener('resize', handleViewportResize);
    };
  }, []);

  // Apply font family, font size, and dark/light theme reactively from settings
  useEffect(() => {
    const applyAppearance = () => {
      const s = DB.getSettings();
      setSettings(s);
      const root = document.documentElement;
      const isCompact = window.innerWidth < 640;
      const configuredSize = s.fontSize || 15;
      // Preserve 16px clean baseline when fontSize is untouched default (15)
      const baseFontSize = configuredSize === 15 ? 16 : configuredSize;
      const effectiveFontSize = isCompact ? Math.min(baseFontSize, 16) : baseFontSize;

      root.style.setProperty('--app-font', `'${s.fontFamily || 'Cairo'}', sans-serif`);
      root.style.fontSize = `${effectiveFontSize}px`;
      root.style.setProperty('--products-font-size', `${s.productsFontSize || 15}px`);

      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (s.theme === 'dark') {
        root.classList.add('dark');
        themeMeta?.setAttribute('content', '#0d1626');
      } else {
        root.classList.remove('dark');
        themeMeta?.setAttribute('content', '#1d5fd6');
      }
    };

    applyAppearance();
    window.addEventListener('resize', applyAppearance);
    const unsub = DB.subscribe(applyAppearance);
    return () => {
      window.removeEventListener('resize', applyAppearance);
      unsub();
    };
  }, []);

  // Keyboard shortcut navigation (F1: sale, F2: purchase, Esc: step back)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        handleNavigate('sale');
      } else if (e.key === 'F2') {
        e.preventDefault();
        handleNavigate('purchase');
      } else if (e.key === 'Escape' && currentScreen !== 'home') {
        e.preventDefault();
        handleStepBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentScreen, handleNavigate, handleStepBack]);

  const getScreenTitle = (screen: ScreenId): string => {
    switch (screen) {
      case 'home':
        return '';
      case 'sale':
        return editingInvoice?.type === 'sale'
          ? `تعديل فاتورة بيع ${editingInvoice.invoice_number || `#${editingInvoice.id}`}`
          : 'فاتورة بيع جديدة';
      case 'purchase':
        return editingInvoice?.type === 'purchase'
          ? `تعديل فاتورة شراء ${editingInvoice.invoice_number || `#${editingInvoice.id}`}`
          : 'فاتورة شراء جديدة';
      case 'sale_return':
        return 'فاتورة مرتجع جديدة';
      case 'quote':
        return 'عرض سعر جديد';
      case 'products':
        return 'مخزن المنتجات';
      case 'customers':
        return 'العملاء';
      case 'suppliers':
        return 'الموردين';
      case 'invoices_sale':
        return 'فواتير البيع';
      case 'invoices_purchase':
        return 'فواتير الشراء';
      case 'invoices_return':
        return 'فواتير المرتجع';
      case 'invoices_quote':
        return 'عروض الأسعار';
      case 'accounts':
        return 'إدارة الحسابات';
      case 'expenses':
        return 'المصروفات';
      case 'backup':
        return 'الإعدادات والنسخ الاحتياطي';
      default:
        return '';
    }
  };

  const renderScreen = () => {
    switch (currentScreen) {
      case 'home':
        return <HomeScreen onNavigate={handleNavigate} />;
      case 'sale':
        return (
          <InvoiceScreen
            type="sale"
            onBack={handleStepBack}
            onNavigate={handleNavigate}
            editingInvoice={editingInvoice?.type === 'sale' ? editingInvoice : null}
            onCancelEdit={() => {
              setEditingInvoice(null);
              handleStepBack();
            }}
          />
        );
      case 'purchase':
        return (
          <InvoiceScreen
            type="purchase"
            onBack={handleStepBack}
            onNavigate={handleNavigate}
            editingInvoice={editingInvoice?.type === 'purchase' ? editingInvoice : null}
            onCancelEdit={() => {
              setEditingInvoice(null);
              handleStepBack();
            }}
          />
        );
      case 'sale_return':
        return (
          <InvoiceScreen type="sale_return" onBack={handleStepBack} onNavigate={handleNavigate} />
        );
      case 'quote':
        return <InvoiceScreen type="quote" onBack={handleStepBack} onNavigate={handleNavigate} />;
      case 'products':
        return <ProductsScreen />;
      case 'customers':
        return <PartiesScreen type="customer" />;
      case 'suppliers':
        return <PartiesScreen type="supplier" />;
      case 'invoices_sale':
        return <InvoicesListScreen type="sale" onEditInvoice={handleStartEditInvoice} />;
      case 'invoices_purchase':
        return <InvoicesListScreen type="purchase" onEditInvoice={handleStartEditInvoice} />;
      case 'invoices_return':
        return <InvoicesListScreen type="sale_return" />;
      case 'invoices_quote':
        return <InvoicesListScreen type="quote" />;
      case 'accounts':
        return <AccountsScreen />;
      case 'expenses':
        return <ExpensesScreen />;
      case 'backup':
        return <BackupScreen />;
      default:
        return <HomeScreen onNavigate={handleNavigate} />;
    }
  };

  // 1. Loading Gate (أثناء الفحص والتهيئة)
  if (initState === StorageInitState.INITIALIZING || initState === StorageInitState.UNINITIALIZED) {
    return (
      <div
        dir="rtl"
        className="h-dvh w-full overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)] flex flex-col items-center justify-center p-6 text-center"
      >
        <div className="w-16 h-16 rounded-2xl bg-[var(--brand-primary)] text-white flex items-center justify-center shadow-lg mb-4 animate-pulse">
          <HardDrive className="h-8 w-8" />
        </div>
        <h1 className="app-page-title mb-1.5">Cashier Pro</h1>
        <p className="app-meta-text mb-6 font-semibold">
          جاري فحص وتهيئة محرك التخزين وقاعدة البيانات...
        </p>
        <div className="w-52 h-2 bg-[var(--bg-surface-subtle)] rounded-full overflow-hidden border border-[var(--border-default)]">
          <div className="h-full bg-[var(--brand-primary)] rounded-full animate-pulse w-3/4" />
        </div>
      </div>
    );
  }

  // 2. Error Gate (إذا فشلت التهيئة مع إمكانية إعادة المحاولة)
  if (initState === StorageInitState.FAILED) {
    return (
      <div
        dir="rtl"
        className="h-dvh w-full overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)] flex flex-col items-center justify-center p-6 text-center"
      >
        <div className="max-w-md w-full app-card p-6 space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-[var(--color-danger-bg)] text-[var(--color-danger)] flex items-center justify-center mx-auto">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h2 className="app-section-title">تعذر بدء تشغيل قاعدة البيانات</h2>
          <p className="app-meta-text leading-relaxed">
            {initError ||
              'حدث خطأ أثناء الاتصال بمحرك التخزين المحلي. يرجى التأكد من تفعيل التخزين في المتصفح أو إعادة المحاولة.'}
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={async () => {
                setInitState(StorageInitState.INITIALIZING);
                const ok = await DB.initializeAsync();
                if (ok) {
                  setInitState(StorageInitState.READY);
                  setShowFirstTimePermissions(!DB.isPermissionsGranted());
                  setInitError(null);
                } else {
                  setInitState(StorageInitState.FAILED);
                  setInitError(DB.getLastStorageError()?.message || 'فشلت إعادة المحاولة');
                }
              }}
              className="app-btn-primary w-full"
            >
              <RefreshCw className="h-4 w-4" />
              <span>إعادة المحاولة</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      dir="rtl"
      className="h-dvh w-full overflow-hidden flex flex-col bg-[var(--bg-app)] text-[var(--text-primary)] selection:bg-[var(--brand-primary)] selection:text-white"
    >
      {/* Fixed Top Navigation Header */}
      <Navbar
        currentScreen={currentScreen}
        onNavigate={handleNavigate}
        onStepBack={handleStepBack}
        title={getScreenTitle(currentScreen)}
      />

      {/* Fixed Shell Workspace Row: Desktop Sidebar + Single Inner Scrollable Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <DesktopSidebar
          currentScreen={currentScreen}
          onNavigate={handleNavigate}
          settings={settings}
          onToggleTheme={handleToggleTheme}
        />

        <main ref={mainScrollRef} className="app-scroll-region flex-1 min-h-0 min-w-0">
          <div className="max-w-5xl mx-auto w-full px-3 py-3 sm:px-6 sm:py-5">
            {renderScreen()}
          </div>
        </main>
      </div>

      {/* Fixed Mobile / Tablet Bottom Navigation (auto-hides when soft keyboard opens) */}
      <BottomNav
        currentScreen={currentScreen}
        onNavigate={handleNavigate}
        hidden={isKeyboardOpen}
      />

      {/* First-Time Only Permissions Modal (Shown once on first app install/launch) */}
      {showFirstTimePermissions && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] overflow-y-auto"
        >
          <div className="w-full max-w-sm max-h-[88dvh] overflow-y-auto rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 shadow-2xl space-y-4 text-right">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl bg-[var(--brand-primary)] text-white flex items-center justify-center shrink-0">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-[17px] font-extrabold text-[var(--text-primary)]">
                  منح أذونات التطبيق (لأول مرة فقط)
                </h3>
                <p className="text-[13px] text-[var(--text-secondary)]">
                  يتم طلب هذه الأذونات عند التثبيت لأول مرة فقط وتُحفظ الإعدادات تلقائياً بعدها
                </p>
              </div>
            </div>

            <div className="space-y-2.5 bg-[var(--bg-surface-subtle)] p-3.5 rounded-xl border border-[var(--border-default)] text-[14px]">
              <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-semibold">
                <Camera className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                <span>إذن الكاميرا لقراءة الباركود السريع للمنتجات</span>
              </div>
              <div className="flex items-center gap-2.5 text-[var(--text-primary)] font-semibold">
                <HardDrive className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                <span>إذن الذاكرة لحفظ الفواتير وملفات PDF والإعدادات تلقائياً</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGrantFirstTimePermissions}
              className="app-btn-primary w-full"
            >
              <Check className="h-4 w-4" />
              <span>سماح وحفظ الإعدادات تلقائياً</span>
            </button>
          </div>
        </div>
      )}

      {/* Double-Tap Back to Exit Toast */}
      {exitToastVisible && (
        <div
          dir="rtl"
          className="fixed bottom-20 lg:bottom-8 left-1/2 -translate-x-1/2 z-50 rounded-full bg-[var(--text-primary)] text-[var(--bg-surface)] px-4 py-2 text-[13px] font-bold shadow-xl pointer-events-none whitespace-nowrap"
        >
          اضغط مرة أخرى للخروج من التطبيق
        </div>
      )}
    </div>
  );
}
