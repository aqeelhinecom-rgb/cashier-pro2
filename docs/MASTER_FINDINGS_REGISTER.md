# Cashier Pro — سجل الملاحظات والأخطاء الموحد (Master Findings Register)

**الوثيقة**: `docs/MASTER_FINDINGS_REGISTER.md`  
**الحالة المرجعية**: تم إغلاق جميع ملاحظات المرحلة 17 (`FIND-P17-01` إلى `FIND-P17-07`) والتحقق منها في المرحلتين 18 (ما بعد الإصلاح) و19  
**الهدف**: تتبع جميع الملاحظات والأخطاء المكتشفة عبر المراحل (7A–19)، مع توثيق دقيق للموقع، خطوات إعادة الإنتاج قبل الإصلاح، الإصلاح المنفذ، الأولوية (`P0`–`P3`)، وإثبات النجاح بعد الإصلاح دون أي تراجع.

---

## ملخص الأولويات المعتمدة

- **`P0` (حرج جداً / Critical)**: قد يسبب فقدان بيانات، تلف قاعدة البيانات، تلاعب محاسبي، أو ثغرة اختراق خطيرة.
- **`P1` (عالي / High)**: خلل وظيفي فعلي في المبيعات/المرتجعات/التقارير/النسخ/المزامنة/الأمان يؤثر على التشغيل اليومي.
- **`P2` (متوسط / Medium)**: ثغرة استقرار، سباق تهيئة، أو عدم ذرية في سجل التغييرات.
- **`P3` (منخفض / Low)**: تحسينات وقائية أو تجربة بصرية في أوضاع خاصة دون تأثير على دقة الدفاتر.

---

## 1. سجل ملاحظات المرحلة 17 المغلقة في المرحلة 19 (`FIND-P17-01` — `FIND-P17-07`)

| المعرف | المرحلة المصدر | الملف والدالة | الوصف الدقيق للمشكلة | الأثر المالي / الأمني / التشغيلي | الأولوية | الإصلاح المنفذ (المرحلة 19) | الحالة |
|---|---|---|---|---|---|---|---|
| **FIND-P17-01** | P17 | `src/services/db.ts` (`DB.restoreData`, `restoreDataAsync`)، `src/services/dbFormat.ts` (`universalRestore`, `restoreFromSqliteBinary`)، `src/services/storage/cacheAdapter.ts` (`restoreSnapshotAsync`) | عند استرجاع نسخة `.json` أو `.db` عبر `universalRestore()` في وضع `dexie`: 1) كانت تُستدعى `enqueueWrite` دون `await`؛ 2) تمرير `p.id` لـ `products.save()` يرمي `"المنتج المطلوب تعديله غير موجود"`؛ 3) **إسقاط `invoices` و`invoice_items` بالكامل**. | **فقدان جميع الفواتير وبنودها** عند الاستعادة من ملف `.db` أو JSON قديم، مع إرجاع `true` زائف! | **P0** | تنفيذ `restoreSnapshotAsync` داخل معاملة ذرية في `StorageCacheAdapter` لجميع الجداول وعدادات `seq_*` مع نسخة أمان تلقائية، وإضافة `DB.restoreDataAsync()` وتمرير `await` في `dbFormat.ts`. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-02** | P17 | `src/services/dbFormat.ts` (`createSqliteDbBlob`) | دالة تصدير SQLite `.db` كانت تقرأ `parties` و`invoice_items` و`payments` عبر `getStored('cashier_*_v1')` من `localStorage` المعزول بدل بيانات Dexie الحية. | ملف `.db` المُصدَّر كان يحتوي على جداول فارغة/ناقصة للعملاء وبنود الفواتير والدفعات. | **P1** | القراءة المباشرة من `DB.getParties()` و`storageCacheAdapter.getAllInvoiceItems()` و`getAllPayments()` عند تفعيل `dexie`. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-03** | P17 | `reportRepository.ts`، `db.ts`، `partyRepository.ts`، `cacheAdapter.ts`، `AccountsScreen.tsx` | 1) `getReport()` لم يكن يخصم `sale_return` من المبيعات وهامش الربح وكميات الأصناف؛ 2) `getParties()` كان يجمع `(inv.total - inv.paid)` لـ `sale_return` و`quote`. | تضخم تقارير المبيعات والأرباح بمقدار المرتجعات، وإضافة ديون وهمية على العملاء عند المرتجع الآجل وعروض الأسعار. | **P1** | احتساب صافي المبيعات وصافي هامش الربح وصافي `topSold`/`topProfit` بعد خصم `sale_return`؛ واستبعاد `quote` وعكس `(total - paid)` للـ `sale_return` في مواضع الديون الثلاثة و`AccountsScreen`. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-04** | P17 | `cacheAdapter.ts`، `dexieBackupEngine.ts` | 1) `StorageCacheAdapter` لم يكن يستدعي `MultiWindowSyncManager.broadcastMutation(...)` في دوال الكتابة؛ 2) `restoreDexieBackupSafely` كانت تستدعي `storageCacheAdapter.refreshCacheFromDb()` العالمي حتى على قواعد Sandbox معزولة. | عدم تحديث التبويبات المفتوحة فورياً، وربط استعادة القواعد المعزولة بحالة الـ Singleton العالمي (مع حماية `isOpen`/`dispose`). | **P1** | بث `broadcastMutation` عند كل تعديل في `StorageCacheAdapter`، وحراسة `handleCrossTabSync` ضد القواعد المغلقة، وحصر `refreshCacheFromDb` في `restoreDexieBackupSafely` على القاعدة النشطة فقط. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-05** | P17 | `firestore.rules`، `firebase-blueprint.json`، `dexieBackupEngine.ts` | 1) `firebase.ts` يكتب في `/users/{userId}` و`/users/{userId}/backups/{backupId}` دون قاعدة مطابقة في `firestore.rules`؛ 2) `validateBackupInSandbox` كانت تفحص عدد صفوف `products` فقط دون بقية الجداول الـ 11. | رفض النسخ السحابية الشخصية بـ `PERMISSION_DENIED` عند التفعيل، وعدم رصد نقص عددي في الجداول غير المنتجة بالـ Sandbox. | **P1** | إضافة قواعد المالك الصارمة `/users/{userId}` و`/users/{userId}/backups/{backupId}` (غير قابلة للتعديل، سقف `1MB`، تحديث `firebase-blueprint.json`)، وتوسيع التحقق في `validateBackupInSandbox` ليشمل الـ 12 جدولاً. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-06** | P17 | `cacheAdapter.ts`، `App.tsx`، مستودعات Dexie (`products`, `parties`, `payments`, `expenses`, `product_images`, `held_invoices`) | 1) `initializeAsync()` كان يرجع `false` أثناء `INITIALIZING`؛ 2) `App.tsx` يقرأ `isPermissionsGranted()` قبل جاهزية Dexie؛ 3) `ProductRepository.save()` لا يضع `version: 1` عند الإنشاء، وكتابة المستودعات و`change_journal` كانت خارج `transaction('rw')`. | فشل التهيئة المتزامنة، إعادة طلب الأذونات، أو انفصال `change_journal` عن الجدول عند انقطاع مفاجئ. | **P2** | حفظ `initPromise` المشترك، مزامنة `showFirstTimePermissions` بعد `READY`، تعيين `version: 1` عند الإنشاء وزيادته عند الحذف وتحديث المخزون، وتغليف كافة كتابات المستودعات داخل معاملات `transaction('rw', ...)`. | **مغلق (تم التحقق)** ✅ |
| **FIND-P17-07** | P17 | `src/screens/HomeScreen.tsx` | بطاقات الشاشة الرئيسية تستعمل روابط صور خارجية (`unsplash.com`) قد تظهر بشكل غير متسق عند انقطاع الإنترنت. | أثر بصري طفيف في وضع عدم الاتصال دون أثر وظيفي. | **P3** | إضافة خلفية لونية داكنة متناسقة `bg-[#0f2435]` ومعالج `onError` لإخفاء العنصر المكسور دون المساس بتصميم الواجهة المعتمد. | **مغلق (تم التحقق)** ✅ |

---

## 2. الملاحظات السابقة والبنود المؤجلة معمارياً للسحابة

| المعرف | المرحلة المصدر | التقييم والتحقق | الحالة |
|---|---|---|---|
| **SEC-01** | P13 / P15 | `isAuthorizedDevice` مفروض في `firestore.rules` (9 مواضع) و`change_journal` غير قابل للتعديل. | **مغلق** ✅ |
| **SEC-02** | P17 | `storage.rules` محصّن بعزل المتجر والأدوار والأجهزة وحماية `/thumbnails/`. | **مغلق** ✅ |
| **FIND-01 / ENV-01** | P13 | `.env.example` خالٍ من الأسرار. | **مغلق** ✅ |
| **FIND-02** | P13 / P14 | `InventoryConflictEngine` يفصل الأرصدة الأربعة ويدير العجز والتسوية دون حذف الفواتير. | **مغلق بالمحرك السحابي** ✅ |
| **IMAGE-01 / INFO-01** | P16 | دعم WebP والشفافية وحفظ الأصل والمصغرة وبصمة SHA-256. | **مغلق** ✅ |
| **DEXIE-TX-01** | P17 | حل `Transaction committed too early` عبر الاستيراد الثابت لـ `generateUUID`. | **مغلق** ✅ |
| **PERF-01 / FIND-03** | P11 / P13 | Chunked Export للبيانات >150,000 سجل على أجهزة 2GB RAM. | **مؤجل معمارياً (`P2`)** ⚠️ |
| **FIND-04** | P13 | توحيد التوقيت عبر `serverTimestamp()` عند التفعيل السحابي الفعلي. | **مؤجل للسحابة** ⏳ |
| **BACKEND-01** | P13 / P17 | بناء Cloud Functions / Backend API عند تفعيل المزامنة السحابية الفعلية. | **مؤجل للسحابة** 📋 |

---

## 3. مقارنة نتائج المجسّات: قبل الإصلاح (Phase 18) مقابل بعد الإصلاح (Phases 18/19)

| المجس / الفحص | قبل الإصلاح (`Phase 18 Baseline`) | بعد الإصلاح (`Phase 18 --post-fix` & `Phase 19 Verify`) |
|---|---|---|
| **FIND-P17-01** (استعادة SQLite وJSON القديم) | `backgroundError="المنتج المطلوب تعديله غير موجود"`, `restoredProducts=0`, `restoredInvoices=0` ❌ | استرجاع 100% للـ SQLite (القياسي + العلائقي العام) وCompleteDexieBackup، صفر `unhandledRejection` ✅ |
| **FIND-P17-02** (تصدير SQLite من Dexie) | `SQLite parties=0`, `invoice_items=0` ❌ | `SQLite parties=2`, `invoice_items=3`, `payments=1` مع فراغ `localStorage` بالكامل ✅ |
| **FIND-P17-03** (صافي المرتجع وعروض السعر) | `sales=270,000`، `customerBalance=215,000` ❌ | `sales=230,000`، `customerBalance=60,000` (Phase 18) و`Repo=Cache=15,000/9,000/10,000` (Phase 19) ✅ |
| **FIND-P17-04** (بث التبويبات وعزل الاستعادة) | `receivedBroadcastCount=0` ❌ | `events=[products:create, expenses:create]`, `isolatedRestore=true` ✅ |
| **FIND-P17-05** (قواعد `/users/{uid}/backups` + 12 جدول Sandbox) | `firestoreRulesHasRootBackupsRule=false` ❌ | قواعد `/users/{uid}` و`/backups/{backupId}` مضافة + رفض التلاعب بالعدّ في الـ 12 جدولاً ✅ |
| **FIND-P17-06** (تهيئة متزامنة + `version:1` + ذرية + أذونات) | `init2=false`, `createdProductVersion=undefined` ❌ | `init=[true,true]`, `version=1->2`, تراجع ذري تام عند عطل `change_journal`, مزامنة `App.tsx` ✅ |
| **FIND-P17-07** (Fallback دون اتصال) | بدون خلفية fallback ❌ | `bg-[#0f2435]` + معالج `onError` في `HomeScreen.tsx` ✅ |

