# Cashier Pro — تقرير التدقيق الشامل النهائي للمرحلة 17 (Phase 17: Final Regression & Audit)

**التاريخ**: المرحلة 17 (تدقيق مرجعي قبل الإصلاح — بدون تعديل الكود)  
**المرجع التشغيلي**: `CashierPro_DB` (Dexie IndexedDB) غير ممسوس مطلقاً.  
**السجل المرتبط**: `docs/MASTER_FINDINGS_REGISTER.md`

---

## 1. ملخص نطاق التدقيق

شمل التدقيق فحص الكود المصدري وقواعد الأمان وبروتوكولات النسخ الاحتياطي وتقارير الأرباح والديون في الملفات الحقيقية للمشروع دون الاعتماد على التقارير النصية السابقة:
1. سلامة قاعدة Dexie والعلاقات والمعاملات (`cacheAdapter.ts`, `db.ts`, المستودعات، `schema.ts`).
2. الدقة المحاسبية والمالية (`ReportRepository`, `DB.getReport`, `AccountsScreen`, `PartyRepository`).
3. إدارة تعارض المخزون والحجز والإلغاء (`InventoryConflictEngine`).
4. النسخ الاحتياطي والاسترجاع بصيغتي Dexie Complete Backup (12 جدولاً) وSQLite `.db` / Legacy `.json` (`dexieBackupEngine.ts`, `dbFormat.ts`).
5. الأمان السحابي (`firestore.rules`, `storage.rules`, `firebase-blueprint.json`, `src/services/firebase.ts`).
6. محرك ضغط الصور والشفافية وقراءة الأرقام الصغيرة (`imageOptimizationEngine.ts`, `src/utils/image.ts`).
7. الأداء التسلسلي الواقعي وحدود القياس داخل حاوية Node / `fake-indexeddb`.

---

## 2. النتائج التفصيلية لكل محور

### أ. قاعدة البيانات والمعاملات (`FIND-P17-06`)
- معاملة إنشاء الفاتورة في `InvoiceRepository.ts` ذرية بالكامل مع تحديث الأرصدة و`change_journal` و`settings`.
- في المقابل، كشف التدقيق أن مستودعات `products`, `parties`, `payments`, `expenses`, `product_images`, `held_invoices` تكتب التعديل ثم تستدعي `change_journal.add()` منفصلة خارج `transaction('rw')`.
- كما لا يضع `ProductRepository.save()` قيمة ابتدائية `version: 1` عند إنشاء منتج جديد، ويعود `StorageCacheAdapter.initializeAsync()` بالقيمة `false` عند الاستدعاء المتزامن الثاني.

### ب. المالية والتقارير والمرتجعات وعروض الأسعار (`FIND-P17-03`)
- تقارير المبيعات والأرباح (`ReportRepository.getReport()`, `DB.getReport()`, `AccountsScreen.tsx`) تحسب فواتير `sale` فقط دون خصم `sale_return`، مما يضخم المبيعات وصافي هامش الربح بمقدار البضاعة المرتجعة.
- حساب رصيد الطرف في `PartyRepository`, `StorageCacheAdapter`, و`DB.getParties()` يجمع `(total - paid)` دون فحص نوع الفاتورة؛ وبذلك فإن مرتجع المبيعات غير المدفوع نقداً وعرض السعر (`quote`) يرفعان دين العميل خطأً!

### ج. النسخ الاحتياطي والاسترجاع (`FIND-P17-01`, `FIND-P17-02`, `FIND-P17-05`)
- مسار Phase 7A (`createFullDexieBackup` / `restoreDexieBackupSafely`) يعمل بذرية كاملة وبصمة SHA-256 على الـ 12 جدولاً، إلا أن `validateBackupInSandbox` يتحقق من عدد صفوف `products` فقط، و`restoreDexieBackupSafely` تستدعي `storageCacheAdapter.refreshCacheFromDb()` حتى عند تمرير قاعدة معزولة.
- مسار الاستيراد/التصدير المتوافق مع SQLite وJSON القديم (`createSqliteDbBlob` و`universalRestore` / `DB.restoreData`):
  - `createSqliteDbBlob()` يقرأ `parties` و`invoice_items` و`payments` من `localStorage` الفارغ بدل Dexie (`FIND-P17-02`).
  - `DB.restoreData()` يُرجع `true` فوراً قبل إتمام الكتابة، ويفشل عند تمرير `p.id` لـ `products.save()`، ويتجاهل استعادة الفواتير وبنودها (`FIND-P17-01` — أولوية `P0`).

### د. المزامنة بين النوافذ والأمان السحابي (`FIND-P17-04`, `FIND-P17-05`)
- `StorageCacheAdapter` لا يستدعي `MultiWindowSyncManager.broadcastMutation(...)` عند التعديل (`FIND-P17-04`).
- `firestore.rules` محكم لمتاجر `/stores/{storeId}/...` ومزود بـ `isAuthorizedDevice`، لكنه يحظر المسار الجذري `/users/{uid}/backups/{backupId}` المستخدم في `src/services/firebase.ts` (`FIND-P17-05`).

### هـ. الحدود الصادقة للبيئة الاختبارية (Container & Test Boundaries)
- كافة القياسات والأدلة تمت على بيئة Node.js + `fake-indexeddb` + `sharp` + `sql.js`.
- **لم يتم القياس** على هواتف Android فعلية (Chrome / Capacitor WebView)، ولم تُختبر طابعات الإيصالات الحرارية (Bluetooth/USB)، ولا الاتصال الحي بخوادم Firebase الإنتاجية أو قواعد Firestore عبر Firebase Emulator Java.
