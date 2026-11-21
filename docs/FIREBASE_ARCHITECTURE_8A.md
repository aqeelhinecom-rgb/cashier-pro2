# Cashier Pro — بنية المزامنة السحابية وتعدد الأجهزة (Phase 8A)

## 1. فلسفة المزامنة: Dexie هو مصدر الحقيقة الأوحد (Single Source of Truth)
في Cashier Pro، لا تعتمد شاشات الكاشير ونقاط البيع على قراءة البيانات مباشرة من خوادم السحاب؛ فالقاعدة المحلية (IndexedDB بواسطة Dexie) هي المصدر الوحيد للقراءة والكتابة اليومية الفورية بدون أي زمن تأخير (Zero Latency). تعمل السحابة (Firebase Firestore) كطبقة وسيطة لنقل التغييرات بين الأجهزة (Sync Relay & Backup Store).

```
[شاشة الكاشير / الجهاز]
       │
       ▼ (عمليات ذرية فورية)
[قاعدة Dexie المحلية: CashierPro_DB]
       │
       ▼ (تسجيل التغيير في نفس المعاملة الذرية)
[Change Journal المحلي] ──► [طابور المزامنة المحلي Sync Queue]
                                    │
                                    ▼ (عند توفر الإنترنت)
                         [Firebase Firestore / Sync Relay]
                                    │
                                    ▼
                         [الأجهزة المتزامنة الأخرى]
```

---

## 2. هيكل البيانات السحابية (Cloud Firestore Schema)

تعتمد البنية على عزل كامل للمتاجر (Zero-Trust Multi-Tenancy):

### المسارات الرئيسية المعتمدة والمحصّنة في `firestore.rules` و`storage.rules`:
1. `/stores/{storeId}`: بيانات المتجر الأساسية، الإعدادات، ومعرف مالك المتجر.
2. `/stores/{storeId}/devices/{deviceId}`: سجل الأجهزة المصرح بها (`active`, `pending`, `suspended`, `revoked`) مع فرض `isAuthorizedDevice()`.
3. `/stores/{storeId}/users/{userId}`: حسابات الموظفين، الأدوار (`owner`, `admin`, `manager`, `cashier`, `inventory_manager`, `accountant`) وحالة النشاط.
4. `/stores/{storeId}/products/{productId}`: كتالوج المنتجات العام وأسعار البيع والكميات والإصدار `version` (دون سعر الشراء).
5. `/stores/{storeId}/products_cost/{productId}`: أسعار الشراء والهوامش السرية (معزولة عن الكاشير ومحجوزة للمحاسب فأعلى).
6. `/stores/{storeId}/invoices/{invoiceId}` و`/payments/{paymentId}`: السجلات المالية المحمية من تعديل الأرقام المعتمدة أو الحذف الفعلي.
7. `/stores/{storeId}/reconciliation_records/{recordId}`: سجل تسوية العجز المخزني عند التعارض المتزامن (المرحلة 14).
8. `/stores/{storeId}/sync_queue/{idempotencyKey}` و`/change_journal/{entryId}`: طابور المزامنة وسجل التدقيق غير القابل للتعديل أو الحذف من العميل.
9. `/users/{userId}` و`/users/{userId}/backups/{backupId}`: مسار النسخ السحابية الشخصية للمالك فقط (غير قابلة للتعديل بعد الإنشاء، حد أقصى `1MB`، مضافة في المرحلة 19).
10. **Cloud Storage (`storage.rules`)**: عزل صور المتجر تحت `/stores/{storeId}/products/{productId}/...` ونسخ المتجر تحت `/stores/{storeId}/backups/...` مع فحص الجهاز المصرح به ونوع الصورة (`jpeg/png/webp`) وسقف الحجم.

---

## 3. معالجة التعارض وتحديثات المخزون المتزامنة (OCC & Conflict Resolution)

1. **التحكم بالتزامن التفاؤلي (Optimistic Concurrency Control - OCC)**:
   - يحمل كل سجل حقلي `version` (رقم تصاعدي) و `updatedAt`.
   - عند إرسال تعديل من جهاز ما، يتحقق الخادم من تطابق الـ `version`.
2. **استراتيجية دمج وتصحيح المخزون**:
   - لا يتم استبدال قيمة المخزون كرقم مطلق في حال حدوث تعارض.
   - يتم احتساب الفارق النسبي (Delta): `StockDelta = NewStock - OldStock` وتطبيقه على المخزون الأحدث في السحابة لمنع ضياع مبيعات الكاشير الآخر.
3. **مفتاح منع التكرار (Idempotency Key)**:
   - كل قيد يحمل معرفاً فريداً: `idem_{deviceId}_{seq}_{recordId}_{action}`.
   - إذا انقطع الاتصال وأعيد إرسال الحزمة، يمنع الخادم تكرار قيد المبيعات أو الدفعات.

---

## 4. وضع عدم الاتصال (Offline-First Execution)
- يعمل الكاشير بشكل طبيعي 100% دون الحاجة إلى الإنترنت.
- تسجل العمليات في طابور محلي مشفر ومحمٍ.
- فور استشعار عودة الشبكة (`window.addEventListener('online')`)، يتم تفريغ الطابور على دفعات (Batches) دون إيقاف شاشة البيع.
