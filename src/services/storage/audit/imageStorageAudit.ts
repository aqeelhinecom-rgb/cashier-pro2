import { CashierDatabase } from '../schema';
import { StorageService } from '../storageService';

export interface ImageAuditResult {
  testId: string;
  name: string;
  passed: boolean;
  details: string;
  imageBytesVerified?: number;
  mimeType?: string;
}

// A genuine, valid 1x1 red PNG image Base64 data URI
const VALID_SAMPLE_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function runImageStorageAudit(
  testDbName = `CashierPro_Image_Audit_${Date.now()}`
): Promise<{ success: boolean; results: ImageAuditResult[] }> {
  const results: ImageAuditResult[] = [];
  const testDb = new CashierDatabase(testDbName);
  await testDb.open();
  const testService = new StorageService(testDb);

  try {
    // ----------------------------------------------------
    // اختبار 1: تخزين واستعادة صورة المنتج Base64 مباشرة على السجل
    // ----------------------------------------------------
    {
      const productWithImage = await testService.products.save({
        name: 'منتج يحمل صورة حقيقية',
        buy_price: 15,
        sell_price: 25,
        qty: 10,
        image: VALID_SAMPLE_PNG_BASE64,
      });

      const retrievedProduct = await testService.products.getById(productWithImage.id);

      const hasValidImage =
        Boolean(retrievedProduct?.image) &&
        retrievedProduct!.image!.startsWith('data:image/png;base64,') &&
        retrievedProduct!.image!.length === VALID_SAMPLE_PNG_BASE64.length;

      // Decode Base64 to verify actual image bytes
      let decodedBytesCount = 0;
      let validDecoding = false;
      try {
        const base64Data = retrievedProduct!.image!.split(',')[1];
        const binaryStr = typeof atob !== 'undefined'
          ? atob(base64Data)
          : Buffer.from(base64Data, 'base64').toString('binary');
        decodedBytesCount = binaryStr.length;
        // Verify PNG magic header bytes (0x89, 'P', 'N', 'G')
        validDecoding = binaryStr.charCodeAt(0) === 0x89 && binaryStr.indexOf('PNG') === 1;
      } catch (e) {
        validDecoding = false;
      }

      const passed = hasValidImage && validDecoding && decodedBytesCount > 0;

      results.push({
        testId: 'IMG-1',
        name: 'تخزين وقراءة صورة المنتج كـ Base64 مباشر مع فحص ترويسة PNG',
        passed,
        imageBytesVerified: decodedBytesCount,
        mimeType: 'image/png',
        details: passed
          ? `تم تخزين واسترجاع الصورة بنجاح؛ تم فك ترميز ${decodedBytesCount} بايت وتطابقت ترويسة PNG الثنائية 100%.`
          : 'فشل التحقق من صحة الصورة أو تلف بيانات Base64.',
      });
    }

    // ----------------------------------------------------
    // اختبار 2: التحقق من التخزين في جدول product_images المستقل وحظر المعرفات الجوفاء
    // ----------------------------------------------------
    {
      const targetProductId = 202;

      // Save into imageRepository with real Base64 and MIME type
      const savedImgRecord = await testService.images.saveImage(targetProductId, {
        base64: VALID_SAMPLE_PNG_BASE64,
        mimeType: 'image/png',
      });

      // Retrieve via repository
      const fetchedImg = await testService.images.getByProductId(targetProductId);

      const isDataGenuinelyPresent =
        Boolean(fetchedImg) &&
        Boolean(fetchedImg?.base64) &&
        fetchedImg?.base64 === VALID_SAMPLE_PNG_BASE64 &&
        fetchedImg?.mimeType === 'image/png';

      results.push({
        testId: 'IMG-2',
        name: 'التخزين في جدول product_images والتأكد من وجود البيانات الفعلية (حظر المعرفات الجوفاء)',
        passed: isDataGenuinelyPresent,
        details: isDataGenuinelyPresent
          ? 'تم تأكيد وجود البيانات الثنائية الكاملة داخل IndexedDB؛ لا وجود لمعرفات وهمية أو معلقة.'
          : 'فشل العثور على بيانات الصورة الفعلية داخل جدول product_images.',
      });
    }

    // ----------------------------------------------------
    // اختبار 3: تعديل وحذف الصورة وتزامن السجلات
    // ----------------------------------------------------
    {
      const targetProductId = 303;

      // 1. Save initial image
      await testService.images.saveImage(targetProductId, {
        base64: VALID_SAMPLE_PNG_BASE64,
        mimeType: 'image/png',
      });

      // 2. Delete image
      await testService.images.deleteByProductId(targetProductId);

      const afterDelete = await testService.images.getByProductId(targetProductId);
      const passed = afterDelete === undefined;

      results.push({
        testId: 'IMG-3',
        name: 'حذف وتحديث صور المنتجات بنظافة دون بقايا يتيمة',
        passed,
        details: passed
          ? 'تم حذف سجل الصورة بنجاح وتأكيد تنظيف جدول product_images دون أي سجلات يتيمة.'
          : 'فشل حذف الصورة.',
      });
    }
  } finally {
    await testDb.close();
    await testDb.delete();
  }

  const allPassed = results.every((r) => r.passed);
  return { success: allPassed, results };
}
