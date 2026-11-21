# تقرير تشخيص وإصلاح مشكلة توقف التمرير العمودي (Scrolling Bug Fix Report)

**التاريخ**: 2026-11-12  
**المشروع**: Cashier Pro  
**نطاق العمل**: تشخيص وإصلاح مشكلة عدم استجابة التمرير العمودي باللمس على الجوال وسطح المكتب، دون أي تعديل على `CashierPro_DB` أو Dexie أو Firebase أو منطق المبيعات والمخزون والحسابات أو التصميم البصري للواجهة.

---

## 1. السبب الجذري للمشكلة (Root Cause Analysis)

### السبب الجذري الأساسي (Primary Root Cause — `src/index.css`)
كان ملف `src/index.css` يطبّق القاعدة التالية على كل من `html` و `body` معاً:

```css
html, body {
  max-width: 100vw;
  overflow-x: hidden;
  overscroll-behavior-y: none;
}
```

تسببت هذه القاعدة في سلسلتين من الآثار السلبية الحاسمة وفق مواصفات CSS Overflow:

1. **تحويل `body` إلى حاوية تمرير مغلقة (Overflow Coercion to `auto`)**:
   - تنص مواصفات CSS Overflow Level 3 على أن تعيين `overflow-x: hidden` دون تعيين `overflow-y: visible` صراحةً (أو عند تطبيق `overflow-x: hidden` على `body` مع عدم بقاء `overflow` موحداً) يؤدي إلى حساب `overflow-y` تلقائياً كـ **`auto`** على عنصر `body` نفسه.
   - تم التحقق فعلياً من ذلك في متصفح Chromium قبل الإصلاح عبر `getComputedStyle`:
     - `html`: `overflowX: "hidden"`, **`overflowY: "auto"`**, `overscrollBehaviorY: "none"`
     - `body`: `overflowX: "hidden"`, **`overflowY: "auto"`**, `overscrollBehaviorY: "none"`
2. **حجز التمرير داخل `body` عديم الارتفاع القابل للتمرير + كسر Scroll Chaining**:
   - لأن عنصر `body` لم يكن مقيداً بارتفاع ثابت (`height: auto`)، فقد تمدد ارتفاعه ليتطابق مع كامل المحتوى (`body.clientHeight === body.scrollHeight = 1948px` على شاشة `BackupScreen` الموسعة بارتفاع نافذة `700px`).
   - وبسبب وجود `overflow-y: auto` على `body` مقترناً بـ **`overscroll-behavior-y: none`** على `body`، فإن أي لمسة تمرير (Touch Swipe) أو عجلة فأرة (Mouse Wheel) كانت تستهدف `body` أولاً، فتجد أن المساحة القابلة للتمرير بداخله تساوي **`0px`** (`scrollHeight === clientHeight`)، ثم يمنع `overscroll-behavior-y: none` انتقال التمرير (Scroll Chaining) من `body` إلى العنصر الجذري `html` / `window`!
   - إضافةً إلى ذلك، فإن `overflow-x: hidden` على `html` و `body` يكسر سلوك `position: sticky` للشريط العلوي `Navbar`.

**النتيجة المقاسة قبل الإصلاح (Chromium `390×700` Touch Emulation + Desktop Wheel)**:
- على شاشة `BackupScreen` الموسعة (`html.scrollHeight = 1948px`, `innerHeight = 700px`):
  - بعد سحب لمسي عمودي (`Input.dispatchTouchEvent` من `y=460` إلى `y=120`): `window.scrollY = 0`, `html.scrollTop = 0`, `body.scrollTop = 0`.
  - بعد تحريك عجلة الفأرة (`mouse.wheel(0, 500)`): `window.scrollY = 0`.

### أسباب ثانوية مكتشفة في الشاشات والنوافذ المنبثقة (Secondary Causes)
1. **حساسية السحب الأفقي في `AccountsScreen.tsx`**:
   - كان شرط قفل السحب الأفقي يعتمد على `Math.abs(dx) > Math.abs(dy) * 1.15`، ما قد يلتقط السحب العمودي المائل بزاوية طفيفة كمحاولة سحب أفقي بين التبويبات؛ كما استُخدمت `100vh` بدلاً من `100dvh` في `min-h-[calc(100vh-150px)]`.
2. **نوافذ منبثقة (Modals) غير قابلة للتمرير على الشاشات الصغيرة**:
   - عدة نوافذ منبثقة كانت تفتقر إلى `max-h-[...dvh] overflow-y-auto` أو `min-h-0` داخل حاويات `flex flex-col` (خصوصاً عند صغر ارتفاع شاشة الهاتف أو ظهور لوحة المفاتيح الافتراضية).
   - في `ReceiptModal.tsx`، استخدام `flex items-center justify-center` على الخلفية الثابتة مع محتوى أطول من الشاشة يؤدي في المتصفحات إلى قص الجزء العلوي من الإيصال خارج نطاق التمرير (`top clipping`).

---

## 2. الملفات التي تم فحصها بالكامل

تم فحص بنية التخطيط (Layout)، وأنماط CSS، وأحداث اللمس والتمرير في جميع الملفات ذات الصلة:
- `src/index.css`
- `index.html`
- `src/main.tsx`
- `src/App.tsx`
- `src/components/Navbar.tsx`
- `src/components/ReceiptModal.tsx`
- `src/components/BarcodeScannerModal.tsx`
- `src/components/ExcelImportModal.tsx`
- `src/screens/HomeScreen.tsx`
- `src/screens/InvoiceScreen.tsx`
- `src/screens/InvoicesListScreen.tsx`
- `src/screens/ProductsScreen.tsx`
- `src/screens/PartiesScreen.tsx`
- `src/screens/AccountsScreen.tsx`
- `src/screens/ExpensesScreen.tsx`
- `src/screens/ReportsScreen.tsx`
- `src/screens/BackupScreen.tsx`
- `src/services/navigation.ts`
- `vite.config.ts` و `package.json`

كما تم إجراء مسح شامل (Code Audit) لـ `src/` و `index.html` للتأكد من خلو الكود من:
- أي `touch-action: none` أو `h-screen` / `min-h-screen` / `100vh`.
- أي مستمعي `onTouchStart` / `onTouchMove` / `onWheel` غير سلبية (`non-passive`) أو استدعاءات `preventDefault()` تعيق التمرير (جميع مستمعي اللمس في `AccountsScreen.tsx` يستخدمون `{ passive: true }` ولا يستدعون `preventDefault()`).

---

## 3. الملفات التي تم تعديلها والإصلاح المطبق

| الملف | التعديل المطبق | سبب النجاح |
|---|---|---|
| `src/index.css` | نقل قاعدة القص الأفقي إلى `html` فقط باستخدام `overflow-x: clip` و `overscroll-behavior-y: contain`، وإزالة `max-width: 100vw` و `overflow-x: hidden` و `overscroll-behavior-y: none` من `body`. | يبقي `body` على حالته الافتراضية (`overflow: visible`) فلا يتحول أبداً إلى حاوية تمرير داخلية، ويسمح بتمرير الصفحة بالكامل عبر `window` / `html` بسلاسة باللمس وعجلة الفأرة مع الحفاظ على عمل `sticky` في `Navbar` ومنع التمرير الأفقي الزائد. |
| `src/App.tsx` | إضافة `overflow-y-auto` لخلفية نافذة الأذونات الأولى و `max-h-[90dvh] overflow-y-auto` للبطاقة الداخلية. | يضمن إمكانية تمرير نافذة الأذونات على الشاشات ذات الارتفاع الصغير. |
| `src/screens/AccountsScreen.tsx` | تشديد شرط السحب الأفقي إلى `Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.4`، واستبدال `100vh` بـ `100dvh`، وتحديث `ReportViewerModal` لاستخدام `max-h-[90dvh]` مع `min-h-0` على حاوية التمرير `flex-1 overflow-y-auto`. | يمنع التباس السحب العمودي المائل بالسحب الأفقي، ويسمح لجدول التقرير بالانكماش والتمرير داخل النافذة المنبثقة. |
| `src/components/ReceiptModal.tsx` | استبدال `flex items-center justify-center` و `my-4` بـ `flex` على الخلفية (مع `overflow-y-auto`) و `m-auto` على بطاقة الإيصال. | يتوسط الإيصال عندما يكون أقصر من الشاشة، ويبدأ التمرير من قمته كاملة دون قص الجزء العلوي عندما يكون أطول من ارتفاع الشاشة. |
| `src/components/BarcodeScannerModal.tsx` | إضافة `overflow-y-auto` للخلفية و `max-h-[92dvh] overflow-y-auto` للبطاقة. | يمنع احتباس أزرار المسح اليدوي أو قائمة الباركود السريعة خارج الشاشة. |
| `src/components/ExcelImportModal.tsx` | إضافة `min-h-0` لمنطقة العرض `flex-1 overflow-y-auto`. | يفعّل التمرير الصحيح لجدول معاينة Excel داخل حاوية Flex. |
| `src/screens/ProductsScreen.tsx` | إضافة `max-h-[92dvh]` لنافذتي الإضافة والتعديل، و `max-h-[85dvh]` + `min-h-0` لقائمة التصنيفات. | يتيح تمرير نماذج المنتجات الطويلة وإدارة التصنيفات على الجوال. |
| `src/screens/PartiesScreen.tsx` | إضافة `max-h-[90dvh] overflow-y-auto` لنوافذ الإضافة والتعديل والدفع، و `max-h-[85dvh]` + `min-h-0` لنافذة كشف الحساب. | يضمن تمرير السجل المالي للعملاء والموردين ونماذج الدفع. |
| `src/screens/InvoiceScreen.tsx` | تحديث جميع النوافذ المنبثقة (`bottomOptionsOpen`, `newProductModalOpen`, `newPartyModalOpen`, `editingItem`, `ProductPickModal`) بـ `max-h-[85dvh..92dvh]` و `overflow-y-auto` و `min-h-0`. | يتيح تمرير قوائم اختيار الأصناف ونماذج إنشاء منتج/عميل داخل الفاتورة على الشاشات الصغيرة. |
| `src/screens/BackupScreen.tsx` | إضافة `overflow-y-auto` و `max-h-[90dvh] overflow-y-auto` لنافذة التأكيد `confirmModal`. | يحافظ على وصول المستخدم لأزرار التأكيد والإلغاء على أي ارتفاع شاشة. |

---

## 4. نتائج الاختبار الفعلي بعد الإصلاح (Verification Results)

> **بيئة الاختبار الفعلية (تصريح مهني صادق)**:
> تم إجراء اختبارات المحاكاة الفعلية عبر **Playwright + Headless Chromium** على الخادم المحلي `http://localhost:3000`:
> - **محاكاة اللمس على الجوال (Mobile Touch Emulation)**: نافذة `390×560` (`hasTouch: true`, `isMobile: true`, `deviceScaleFactor: 2`) وإرسال أحداث لمس حقيقية عبر Chrome DevTools Protocol (`Input.dispatchTouchEvent`: `touchStart` → `touchMove` → `touchEnd`).
> - **سطح المكتب (Desktop Mouse Wheel)**: نافذة `1280×720` عبر أحداث `page.mouse.wheel`.
> - **ما لم يُختبر يدوياً في هذه البيئة**: لم يُجرَ اختبار يدوي على جهاز **Android حقيقي** أو داخل **Capacitor WebView** مادي؛ النتائج التالية توثق سلوك Chromium Headless بالمحاكاة اللمسية بدقة.

### أ. فحص الخصائص المحسوبة للجذر (`getComputedStyle`) بعد الإصلاح
- `html`: `overflowX: "clip"`, `overflowY: "visible"`, `overscrollBehaviorY: "contain"` ✅
- `body`: `overflowX: "visible"`, `overflowY: "visible"`, `overscrollBehaviorY: "auto"` ✅

### ب. نتائج اختبار التمرير باللمس عبر الشاشات (Mobile Touch `390×560`)

| الشاشة / الحالة المختبرة | ارتفاع المحتوى / النافذة (`scrollH / clientH`) | `scrollY` قبل ← بعد التمرير للأسفل ← بعد التمرير للأعلى | تجاوز أفقي (`overflowH`) | موضع `Navbar` (`headerTop`) | النتيجة |
|---|---|---|---|---|---|
| **HomeScreen** | `635 / 560` | `0 → 75 → 0` | `false` | `0` | ✅ نجح |
| **BackupScreen (Expanded)** | `1683 / 560` | `0 → 423 → 28` | `false` | `0` | ✅ نجح |
| **ProductsScreen (12 منتجاً + بعد إغلاق Modal)** | `1003 / 560` | `0 → 414 → 16` | `false` | `0` | ✅ نجح |
| **InvoiceScreen — مبيعات (7 أصناف)** | `932 / 560` | `0 → 372 → 0` | `false` | `0` | ✅ نجح |
| **InvoiceScreen — مشتريات (6 أصناف)** | `878 / 560` | `0 → 318 → 0` | `false` | `0` | ✅ نجح |
| **InvoicesListScreen (8 فواتير)** | `846 / 560` | `0 → 286 → 0` | `false` | `0` | ✅ نجح |
| **PartiesScreen — العملاء (7 عملاء + بعد إغلاق Modal)** | `1201 / 560` | `0 → 409 → 21` | `false` | `0` | ✅ نجح |
| **ExpensesScreen — نموذج الإضافة** | `630 / 560` | `0 → 70 → 0` | `false` | `0` | ✅ نجح |
| **ExpensesScreen — قائمة 9 مصروفات** | `795 / 560` | `37 → 235 → 0` | `false` | `0` | ✅ نجح |
| **AccountsScreen — نظرة عامة** | `777 / 560` | `0 → 217 → 0` | `false` | `0` | ✅ نجح |
| **AccountsScreen — سحب عمودي مائل قليلاً (`dx=+9px`)** | `777 / 560` | `0 → 217` (لم ينتقل أفقياً للتبويب التالي) | `false` | `0` | ✅ نجح |
| **AccountsScreen — التقارير بعد إغلاق Modal** | `729 / 560` | `0 → 169 → 0` | `false` | `0` | ✅ نجح |

### ج. نتائج اختبار التمرير باللمس داخل النوافذ المنبثقة الطويلة (Tall Modals)
- **نافذة إضافة منتج (`ProductsScreen`)**: `scrollH: 521 / clientH: 515` ← `scrollTop: 0 → 5` ✅
- **نافذة إيصال الفاتورة (`ReceiptModal`)**: `scrollH: 837 / clientH: 560` ← `scrollTop: 0 → 277` ✅
- **نافذة عارض التقرير (`ReportViewerModal` في `AccountsScreen`)**: `scrollH: 754 / clientH: 393` ← `scrollTop: 0 → 273` ✅

### د. نتائج اختبار سطح المكتب (`1280×720` — عجلة الفأرة)
- شاشة `BackupScreen` الموسعة (`scrollH: 1699 / innerH: 720`):
  - `mouse.wheel(0, 500)`: `scrollY: 0 → 500` (`headerTop: 0`) ✅
  - `mouse.wheel(0, -500)`: `scrollY: 500 → 0` ✅

---

## 5. نتائج الفحص البرمجي والبناء (TypeScript / Build / Lint)

- `npx tsc --noEmit` (`lint_applet`): **نجح بدون أي أخطاء** (`exit code 0`).
- `npm run build` (`vite build` / `compile_applet`): **نجح بدون أي أخطاء** (`1923 modules transformed`, `✓ built in 3.00s`).
- تم التحقق من عدم إجراء أي تعديل على `CashierPro_DB` أو ملفات `src/services/db.ts` أو `firestore.rules` أو منطق المبيعات والمخزون.
