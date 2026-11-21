import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Sun,
  Moon,
  Coins,
  Type,
  Store,
  Database,
  Check,
  Minus,
  Plus,
  Link2,
  LogOut,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { StoreSettings } from '../../types';
import type {
  FirebaseConnectionState,
  FirebaseTestProjectConfig,
  FirestoreDiagnosticResult,
} from '../../services/cloud/firebaseCloudService';

const ARABIC_FONTS = [
  { id: 'Cairo', name: 'خط كايرو (Cairo)', desc: 'عصري وواضح جداً للكاشير' },
  { id: 'Tajawal', name: 'خط تجول (Tajawal)', desc: 'أنيق وناعم ومريح للعين' },
  { id: 'Almarai', name: 'خط المراعي (Almarai)', desc: 'رسمي وممتاز لقراءة الفواتير' },
  { id: 'Readex Pro', name: 'خط ريدكس برو (Readex Pro)', desc: 'هندسي حديث وواضح للأرقام' },
  { id: 'Changa', name: 'خط تشانغا (Changa)', desc: 'عريض وبارز للعناوين والأسعار' },
  { id: 'IBM Plex Sans Arabic', name: 'خط آي بي إم (IBM Plex)', desc: 'تقني ودقيق للجداول المحاسبية' },
  { id: 'Noto Kufi Arabic', name: 'خط نوتو كوفي (Noto Kufi)', desc: 'خط كوفي عربي أصيل ومتناسق' },
  { id: 'Amiri', name: 'خط أميري (Amiri)', desc: 'خط عربي كلاسيكي فاخر' },
];

const CURRENCY_PRESETS = [
  { label: 'دينار عراقي (د.ع)', value: 'د.ع' },
  { label: 'دينار عراقي (كتابة كاملة)', value: 'دينار عراقي' },
  { label: 'دولار أمريكي ($)', value: '$' },
  { label: 'دولار (كتابة كاملة)', value: 'دولار' },
];

interface StoreSettingsHubProps {
  settings: StoreSettings;
  onUpdateImmediate: (partial: Partial<StoreSettings>) => void;
  onSaveStoreForm: (e: React.FormEvent) => void;
  onBack: () => void;
  onOpenAutoBackup: () => void;
  firebaseState: FirebaseConnectionState;
  firebaseLoading: boolean;
  firebaseDiagnostic: FirestoreDiagnosticResult | null;
  testProjectForm: FirebaseTestProjectConfig;
  setTestProjectForm: React.Dispatch<React.SetStateAction<FirebaseTestProjectConfig>>;
  onConnectFirebase: () => void;
  onDisconnectFirebase: () => void;
  onApplyTestProject: (e: React.FormEvent) => void;
  onClearTestProject: () => void;
  onPasteFirebaseJson: (raw: string) => void;
  onCheckFirestoreReachability: () => void;
  onRunTestProjectReadWrite: () => void;
}

export const StoreSettingsHub: React.FC<StoreSettingsHubProps> = ({
  settings,
  onUpdateImmediate,
  onSaveStoreForm,
  onBack,
  onOpenAutoBackup,
  firebaseState,
  firebaseLoading,
  firebaseDiagnostic,
  testProjectForm,
  setTestProjectForm,
  onConnectFirebase,
  onDisconnectFirebase,
  onApplyTestProject,
  onClearTestProject,
  onPasteFirebaseJson,
  onCheckFirestoreReachability,
  onRunTestProjectReadWrite,
}) => {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showTestProjectForm, setShowTestProjectForm] = useState(false);

  const toggle = (key: string) => setOpenKey((prev) => (prev === key ? null : key));

  const currentFontSize = settings.fontSize || 16;
  const currentProductsFontSize = settings.productsFontSize || 15;
  const currentFont = settings.fontFamily || 'Cairo';
  const isDark = settings.theme === 'dark';

  return (
    <div dir="rtl" className="app-card px-5 py-6 sm:px-8 sm:py-8 space-y-6">
      {/* Header */}
      <div className="relative flex items-center justify-center min-h-[44px]">
        <button
          type="button"
          onClick={onBack}
          className="absolute right-0 h-11 w-11 rounded-full hover:bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center transition cursor-pointer"
          aria-label="العودة"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
        <h1 className="app-page-title text-[var(--brand-primary)]">إعدادات النظام</h1>
      </div>

      {/* Menu List */}
      <div className="divide-y divide-[var(--border-default)]">
        {/* 1. Store Info */}
        <div>
          <button
            type="button"
            onClick={() => toggle('store')}
            className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
          >
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                <Store className="h-5 w-5" />
              </div>
              <div>
                <div className="font-bold text-[var(--text-primary)] text-[16px]">بيانات المحل والطباعة</div>
                <div className="app-meta-text">{settings.storeName || 'Cashier'}</div>
              </div>
            </div>
            {openKey === 'store' ? (
              <ChevronUp className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            ) : (
              <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            )}
          </button>

          {openKey === 'store' && (
            <form onSubmit={onSaveStoreForm} className="pb-5 pt-2 px-2 space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">اسم المحل / الشركة</label>
                  <input
                    type="text"
                    value={settings.storeName}
                    onChange={(e) => onUpdateImmediate({ storeName: e.target.value })}
                    className="app-input"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">رقم الهاتف</label>
                  <input
                    type="text"
                    value={settings.phone}
                    onChange={(e) => onUpdateImmediate({ phone: e.target.value })}
                    className="app-input app-num"
                    dir="ltr"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">العنوان</label>
                  <input
                    type="text"
                    value={settings.address}
                    onChange={(e) => onUpdateImmediate({ address: e.target.value })}
                    className="app-input"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">عبارة أسفل الفاتورة</label>
                  <input
                    type="text"
                    value={settings.receiptFooter}
                    onChange={(e) => onUpdateImmediate({ receiptFooter: e.target.value })}
                    className="app-input"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[13px] font-bold text-[var(--color-success)] flex items-center gap-1.5">
                  <Check className="h-4 w-4" /> الحفظ التلقائي مفعل
                </span>
                <button type="submit" className="app-btn-primary px-5">
                  تأكيد الحفظ
                </button>
              </div>
            </form>
          )}
        </div>

        {/* 2. Currency & Exchange Rate */}
        <div>
          <button
            type="button"
            onClick={() => toggle('currency')}
            className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
          >
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                <Coins className="h-5 w-5" />
              </div>
              <div>
                <div className="font-bold text-[var(--text-primary)] text-[16px]">العملة وسعر الصرف</div>
                <div className="app-meta-text">{settings.currency || 'د.ع'}</div>
              </div>
            </div>
            {openKey === 'currency' ? (
              <ChevronUp className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            ) : (
              <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            )}
          </button>

          {openKey === 'currency' && (
            <div className="pb-5 pt-2 px-2 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {CURRENCY_PRESETS.map((preset) => {
                  const active = settings.currency === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => onUpdateImmediate({ currency: preset.value })}
                      className={`min-h-[44px] p-2.5 rounded-xl border text-[13px] font-bold transition cursor-pointer ${
                        active
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white'
                          : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">كتابة العملة يدوياً</label>
                  <input
                    type="text"
                    value={settings.currency}
                    onChange={(e) => onUpdateImmediate({ currency: e.target.value })}
                    className="app-input font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[14px] font-bold text-[var(--text-secondary)] mb-1.5">سعر صرف 1 دولار</label>
                  <input
                    type="number"
                    step="any"
                    value={settings.exchangeRate || 1500}
                    onChange={(e) => onUpdateImmediate({ exchangeRate: parseFloat(e.target.value) || 1500 })}
                    className="app-input app-num font-bold"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 3. Theme Mode */}
        <div>
          <button
            type="button"
            onClick={() => toggle('theme')}
            className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
          >
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                {isDark ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
              </div>
              <div>
                <div className="font-bold text-[var(--text-primary)] text-[16px]">النمط الليلي والنهاري</div>
                <div className="app-meta-text">
                  {isDark ? 'النمط الليلي (داكن)' : 'النمط النهاري (فاتح)'}
                </div>
              </div>
            </div>
            {openKey === 'theme' ? (
              <ChevronUp className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            ) : (
              <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            )}
          </button>

          {openKey === 'theme' && (
            <div className="pb-5 pt-2 px-2 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => onUpdateImmediate({ theme: 'light' })}
                className={`min-h-[48px] flex items-center justify-center gap-2 p-3.5 rounded-2xl border-2 font-bold text-[15px] transition cursor-pointer ${
                  !isDark
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-soft-text)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Sun className="h-5 w-5" />
                <span>النهاري (فاتح)</span>
              </button>
              <button
                type="button"
                onClick={() => onUpdateImmediate({ theme: 'dark' })}
                className={`min-h-[48px] flex items-center justify-center gap-2 p-3.5 rounded-2xl border-2 font-bold text-[15px] transition cursor-pointer ${
                  isDark
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-soft-text)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Moon className="h-5 w-5" />
                <span>الليلي (داكن)</span>
              </button>
            </div>
          )}
        </div>

        {/* 4. Arabic Fonts & Sizes */}
        <div>
          <button
            type="button"
            onClick={() => toggle('fonts')}
            className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
          >
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                <Type className="h-5 w-5" />
              </div>
              <div>
                <div className="font-bold text-[var(--text-primary)] text-[16px]">الخطوط العربية وحجم النصوص</div>
                <div className="app-meta-text app-num">
                  {currentFont} · {currentFontSize}px
                </div>
              </div>
            </div>
            {openKey === 'fonts' ? (
              <ChevronUp className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            ) : (
              <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            )}
          </button>

          {openKey === 'fonts' && (
            <div className="pb-5 pt-2 px-2 space-y-4">
              <div className="space-y-2.5 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] p-4 rounded-2xl">
                <div className="flex items-center justify-between text-[14px] font-bold">
                  <span className="text-[var(--text-primary)]">حجم خط البرنامج العام</span>
                  <span className="app-num text-[var(--brand-primary)]">{currentFontSize}px</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onUpdateImmediate({ fontSize: Math.max(12, currentFontSize - 1) })}
                    className="h-11 w-11 flex items-center justify-center rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] cursor-pointer"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    type="range"
                    min={12}
                    max={22}
                    step={1}
                    value={currentFontSize}
                    onChange={(e) => onUpdateImmediate({ fontSize: Number(e.target.value) })}
                    className="flex-1 accent-[var(--brand-primary)] cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() => onUpdateImmediate({ fontSize: Math.min(22, currentFontSize + 1) })}
                    className="h-11 w-11 flex items-center justify-center rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-2.5 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] p-4 rounded-2xl">
                <div className="flex items-center justify-between text-[14px] font-bold">
                  <span className="text-[var(--text-primary)]">حجم خط المنتجات والأسعار</span>
                  <span className="app-num text-[var(--brand-primary)]">{currentProductsFontSize}px</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateImmediate({ productsFontSize: Math.max(11, currentProductsFontSize - 1) })
                    }
                    className="h-11 w-11 flex items-center justify-center rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] cursor-pointer"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    type="range"
                    min={11}
                    max={26}
                    step={1}
                    value={currentProductsFontSize}
                    onChange={(e) => onUpdateImmediate({ productsFontSize: Number(e.target.value) })}
                    className="flex-1 accent-[var(--brand-primary)] cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateImmediate({ productsFontSize: Math.min(26, currentProductsFontSize + 1) })
                    }
                    className="h-11 w-11 flex items-center justify-center rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {ARABIC_FONTS.map((font) => {
                  const selected = currentFont === font.id;
                  return (
                    <button
                      key={font.id}
                      type="button"
                      onClick={() => onUpdateImmediate({ fontFamily: font.id })}
                      style={{ fontFamily: `'${font.id}', sans-serif` }}
                      className={`min-h-[56px] p-3.5 rounded-2xl border text-right transition flex items-center justify-between cursor-pointer ${
                        selected
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-soft-text)]'
                          : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-[15px]">{font.name}</div>
                        <div className="app-meta-text">{font.desc}</div>
                      </div>
                      {selected && (
                        <div className="h-6 w-6 rounded-full bg-[var(--brand-primary)] text-white flex items-center justify-center shrink-0">
                          <Check className="h-3.5 w-3.5" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 5. Shortcut row to Auto-Backup */}
        <button
          type="button"
          onClick={onOpenAutoBackup}
          className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
        >
          <div className="flex items-center gap-3.5">
            <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
              <RefreshCw className="h-5 w-5" />
            </div>
            <div>
              <div className="font-bold text-[var(--text-primary)] text-[16px]">النسخ التلقائي</div>
              <div className="app-meta-text">متابعة حالة النسخة اليومية والبيانات المنسوخة</div>
            </div>
          </div>
          <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
        </button>

        {/* 6. Firebase Test Project Isolation Settings */}
        <div>
          <button
            type="button"
            onClick={() => toggle('firebase')}
            className="w-full min-h-[56px] py-4 flex items-center justify-between gap-3 text-right cursor-pointer hover:bg-[var(--bg-hover)] transition rounded-xl px-2"
          >
            <div className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <div className="font-bold text-[var(--text-primary)] text-[16px]">إعدادات Firebase (مشروع اختباري)</div>
                <div className="app-meta-text">
                  {firebaseState.user?.email || 'غير متصل · المزامنة التلقائية معطلة'}
                </div>
              </div>
            </div>
            {openKey === 'firebase' ? (
              <ChevronUp className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            ) : (
              <ChevronLeft className="h-5 w-5 text-[var(--brand-primary)] shrink-0" />
            )}
          </button>

          {openKey === 'firebase' && (
            <div className="pb-5 pt-2 px-2 space-y-3 text-[14px]">
              <p className="text-[var(--text-secondary)] leading-relaxed">
                المزامنة التلقائية لبيانات المتجر معطّلة لحماية البيانات. يمكنك ربط مشروع Firebase اختباري معزول لإجراء اختبارات الاتصال فقط.
              </p>

              <div className="flex items-center justify-between bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] rounded-xl p-3">
                <span className="text-[var(--text-secondary)]">المشروع النشط:</span>
                <span className="font-mono font-bold text-[var(--text-primary)]" dir="ltr">
                  {firebaseState.projectId || 'غير محدد'} {firebaseState.isTestProject ? '(اختباري)' : ''}
                </span>
              </div>

              {firebaseState.error && (
                <div className="rounded-xl bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger)] p-3 flex items-start gap-2 font-bold">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{firebaseState.error}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {!firebaseState.user ? (
                  <button
                    type="button"
                    onClick={onConnectFirebase}
                    disabled={firebaseLoading}
                    className="app-btn-primary flex-1"
                  >
                    {firebaseLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                    <span>تسجيل دخول Firebase</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onRunTestProjectReadWrite}
                    disabled={firebaseLoading}
                    className="app-btn-primary flex-1"
                  >
                    {firebaseLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    <span>اختبار القراءة والكتابة (اختباري)</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={onCheckFirestoreReachability}
                  disabled={firebaseLoading}
                  className="app-btn-secondary px-4"
                >
                  فحص الوصول
                </button>

                {(firebaseState.user || firebaseState.status === 'connected' || settings.firebaseLinked) && (
                  <button
                    type="button"
                    onClick={onDisconnectFirebase}
                    disabled={firebaseLoading}
                    className="min-h-[44px] py-2 px-4 rounded-xl text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>فصل</span>
                  </button>
                )}
              </div>

              <div className="pt-1 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowTestProjectForm((v) => !v)}
                  className="min-h-[40px] text-[var(--brand-primary)] font-bold hover:underline cursor-pointer"
                >
                  {showTestProjectForm ? 'إخفاء نموذج المشروع الاختباري' : 'إعداد مشروع Firebase اختباري معزول'}
                </button>
                {firebaseState.isTestProject && (
                  <button
                    type="button"
                    onClick={onClearTestProject}
                    className="min-h-[40px] text-[var(--color-danger)] font-bold hover:underline cursor-pointer"
                  >
                    إلغاء الاختباري
                  </button>
                )}
              </div>

              {showTestProjectForm && (
                <form onSubmit={onApplyTestProject} className="space-y-3 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] p-3.5 rounded-2xl">
                  <textarea
                    rows={2}
                    placeholder='لصق JSON اختياري: {"apiKey":"...","projectId":"...","appId":"..."}'
                    onChange={(e) => {
                      if (e.target.value.trim().startsWith('{')) onPasteFirebaseJson(e.target.value.trim());
                    }}
                    className="app-input text-[13px] font-mono"
                    dir="ltr"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <input
                      type="text"
                      required
                      placeholder="projectId"
                      value={testProjectForm.projectId}
                      onChange={(e) => setTestProjectForm((p) => ({ ...p, projectId: e.target.value }))}
                      className="app-input text-[14px] font-mono"
                      dir="ltr"
                    />
                    <input
                      type="text"
                      required
                      placeholder="apiKey"
                      value={testProjectForm.apiKey}
                      onChange={(e) => setTestProjectForm((p) => ({ ...p, apiKey: e.target.value }))}
                      className="app-input text-[14px] font-mono"
                      dir="ltr"
                    />
                    <input
                      type="text"
                      placeholder="authDomain"
                      value={testProjectForm.authDomain}
                      onChange={(e) => setTestProjectForm((p) => ({ ...p, authDomain: e.target.value }))}
                      className="app-input text-[14px] font-mono"
                      dir="ltr"
                    />
                    <input
                      type="text"
                      required
                      placeholder="appId"
                      value={testProjectForm.appId}
                      onChange={(e) => setTestProjectForm((p) => ({ ...p, appId: e.target.value }))}
                      className="app-input text-[14px] font-mono"
                      dir="ltr"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={firebaseLoading}
                    className="app-btn-primary w-full"
                  >
                    حفظ وتفعيل المشروع الاختباري
                  </button>
                </form>
              )}

              {firebaseDiagnostic && (
                <div
                  className={`rounded-xl border p-3 font-bold ${
                    firebaseDiagnostic.ok
                      ? 'bg-[var(--color-success-bg)] border-[var(--color-success-border)] text-[var(--color-success)]'
                      : 'bg-[var(--color-danger-bg)] border-[var(--color-danger-border)] text-[var(--color-danger)]'
                  }`}
                >
                  <div>{firebaseDiagnostic.message}</div>
                  <div className="text-[13px] mt-1 font-normal">
                    كتابة: {firebaseDiagnostic.writeOk ? 'نجحت' : 'فشلت'} · قراءة:{' '}
                    {firebaseDiagnostic.readOk ? 'نجحت' : 'فشلت'} · تنظيف:{' '}
                    {firebaseDiagnostic.cleanupOk ? 'تم' : 'لا'}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer Info */}
      <div className="pt-4 text-center space-y-1 text-[var(--text-muted)]">
        <div className="flex items-center justify-center gap-2">
          <img src="/app-icon.svg" alt="Cashier Pro" className="h-6 w-6 rounded-lg object-contain" />
          <span className="text-[14px] font-bold text-[var(--text-secondary)]">Cashier Pro</span>
        </div>
        <div className="text-[13px]">نظام نقاط البيع والمحاسبة والمخازن</div>
      </div>
    </div>
  );
};
