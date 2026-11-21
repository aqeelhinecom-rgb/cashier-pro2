# Cashier Pro — تقرير بيئة التجربة المعزولة (Phase 18: Isolated Pilot Report)

**التاريخ**: المرحلة 18 (تشغيل تجريبي معزول قبل تطبيق الإصلاحات)  
**السكربت المنفذ**: `scripts/run-phase18-pilot.ts`  
**قاعدة التشغيل الحية**: `CashierPro_DB` لم تُمس أو يُكتب بها أي سجل؛ عملت جميع الاختبارات على `Cashier_Pilot_P18_*` وتم حذفها تلقائياً عند الانتهاء.

---

## 1. ملخص سيناريوهات يوم العمل والأعطال (10 / 10 ناجح)

تمت محاكاة يوم عمل متكامل مع 3 أجهزة (`dev_android_pos1`, `dev_windows_desk`, `dev_android_inv`) وأرصدة حقيقية:
1. **`Workday-Setup`**: تهيئة الإعدادات والعملة (`د.ع`) وتفعيل 3 أجهزة ورصيد افتتاحي (`250,000 د.ع`) — **اجتياز ✅**.
2. **`Workday-Inventory`**: شراء (10 بطاريات + 4 شاشات)، بيع نقدي (2)، بيع آجل مع خصم (3 بطاريات + 1 شاشة)، سند قبض (50,000)، مصروف (15,000)، مرتجع مبيعات (1)، عرض سعر، وإلغاء فاتورة (`Void`) -> المخزون النهائي الدقيق: `بطاريات=6`, `شاشات=3` — **اجتياز ✅**.
3. **`Workday-Conflict`**: بيع متزامن من 3 أجهزة Offline -> اكتشاف `reconciliationRequired=true` وعجز موثق `deficit=2` دون فساد أو إخفاء — **اجتياز ✅**.
4. **`Outage-Network`**: انقطاع الشبكة + تراكم الطابور (`offlineSynced=0`) + المزامنة عند العودة (`reconnectSynced=2`) + رفض التكرار (`duplicateIgnored=true`) — **اجتياز ✅**.
5. **`Outage-Crash`**: انهيار محقون وسط معاملة Dexie + إغلاق القاعدة وإعادة فتحها -> تراجع ذري وبقاء `phoneQtyAfterReopen=6` — **اجتياز ✅**.
6. **`Outage-Quota`**: محاكاة `QuotaExceededError` دون تلف البيانات — **اجتياز ✅**.
7. **`Outage-SyncFail`**: رفض مزامنة جهاز ملغى (`revoked`) مع بقاء العملية في الطابور دون ضياع (`preservedInQueue=1`) — **اجتياز ✅**.
8. **`Outage-BadImage`**: رفض ملف تنفيذي مموه بصيغة صورة (`Security Violation`) — **اجتياز ✅**.
9. **`Outage-Concurrency`**: تعديل متزامن لصنف واكتشاف تعارض الإصدار (`ConcurrencyConflictError`) — **اجتياز ✅**.
10. **`Outage-BackupRestore`**: رفض النسخة المتلاعب بسعرها في `Sandbox` + الاستعادة إلى قاعدة جديدة فارغة (`freshProds=2`, `freshInvs=6`, `63 سجلاً`) — **اجتياز ✅**.

---

## 2. نتائج مجسّات إعادة إنتاج الأخطاء قبل الإصلاح (6 / 6 تم إثباتها فعلياً)

| المجس / المعرف | القيمة المرصودة في التشغيل الحي قبل الإصلاح | القيمة الصحيحة المتوقعة | التوجيه للمرحلة 19 |
|---|---|---|---|
| **Probe-FIND-P17-01** (`P0`) | `returned=true`, `backgroundError="المنتج المطلوب تعديله غير موجود"`, `restoredProducts=0`, `restoredInvoices=0` | `async await`, استرجاع 100% للفواتير والمنتجات والصور | إصلاح شامل لـ `restoreDataAsync` و`universalRestore`. |
| **Probe-FIND-P17-02** (`P1`) | `SQLite parties=0`, `invoice_items=0` | `parties=1`, `invoice_items=1` | قراءة الجداول الحية من Dexie. |
| **Probe-FIND-P17-03** (`P1`) | `sales=270,000`, `customerBalance=215,000` | `sales=230,000`, `customerBalance=60,000` | خصم المرتجعات في التقارير وتصحيح ذمم المرتجع وعروض الأسعار. |
| **Probe-FIND-P17-04** (`P1`) | `receivedBroadcastCount=0` | `receivedBroadcastCount >= 1` | بث `broadcastMutation` في `StorageCacheAdapter` وعزل تحديث Singleton. |
| **Probe-FIND-P17-05** (`P1`) | `firestoreRulesHasRootBackupsRule=false` | `true` + مطابقة الـ 12 جدولاً في Sandbox | إضافة قواعد `/users/{uid}/backups/{backupId}` والتحقق الكامل للجداول. |
| **Probe-FIND-P17-06** (`P2`) | `init2=false`, `createdProductVersion=undefined` | `init2=true`, `version=1`, معاملات ذرية | إضافة `initPromise`، `version: 1`، ومزامنة أذونات `App.tsx`، ومعاملات `rw`. |
