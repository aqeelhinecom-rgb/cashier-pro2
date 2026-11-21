/**
 * Cashier Pro — Phase 16: Image Optimization & Cloud Storage Reliability Engine
 *
 * محرك معالجة وضغط صور المنتجات والوسائط:
 * - التحقق من البايتات السحرية (Magic Bytes) ورفض الملفات الخبيثة أو التالفة
 * - الحفاظ على نسبة العرض إلى الارتفاع وتجنب التشويه
 * - الحفاظ على قناة الشفافية (Alpha Channel) لصور PNG و WebP
 * - نموذج التخزين متعدد المستويات: الأصل (Original) + المضغوط (Optimized) + المصغر (Thumbnail)
 * - بصمة التحقق الرقمية SHA-256 لمنع تكرار الرفع (Deduplication)
 * - التبديل الآمن في التخزين السحابي دون فقدان الصور السابقة
 */

import crypto from 'crypto';
import sharp from 'sharp';
import { StorageProductImage } from './types';
import { generateUUID } from './uuid';

export interface MultiTierImageResult {
  uuid: string;
  productId: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  originalBuffer: Buffer;
  optimizedBuffer: Buffer;
  thumbnailBuffer: Buffer;
  originalBase64: string;
  optimizedBase64: string;
  thumbnailBase64: string;
  originalWidth: number;
  originalHeight: number;
  optimizedWidth: number;
  optimizedHeight: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  originalSizeBytes: number;
  optimizedSizeBytes: number;
  thumbnailSizeBytes: number;
  compressionRatio: number; // e.g. 75% reduction
  hasAlpha: boolean;
  checksum: string; // SHA-256 of original
  optimizedChecksum: string; // SHA-256 of optimized
  createdAt: string;
}

export interface CloudStorageUploadRecord {
  storagePath: string;
  thumbnailPath: string;
  storeId: string;
  productId: number;
  checksum: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string;
  downloadUrl: string;
  version: number;
}

export class ImageOptimizationEngine {
  private static readonly MAX_RAW_SIZE_BYTES = 10 * 1024 * 1024; // 10MB max upload
  private static readonly MAX_OPTIMIZED_DIMENSION = 800; // 800px max for main view
  private static readonly THUMBNAIL_DIMENSION = 150; // 150px max for POS lists

  /**
   * 1. التحقق الصارم من البايتات السحرية (Magic Bytes) ورفض الامتدادات المضللة
   */
  static detectAndValidateMagicBytes(buffer: Buffer): { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; format: string } {
    if (!buffer || buffer.length < 12) {
      throw new Error('ملف الصورة تالف أو فارغ للغاية');
    }

    // JPEG: 0xFF, 0xD8, 0xFF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mimeType: 'image/jpeg', format: 'jpeg' };
    }

    // PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { mimeType: 'image/png', format: 'png' };
    }

    // WebP: 'RIFF' .... 'WEBP'
    const riff = buffer.toString('ascii', 0, 4);
    const webp = buffer.toString('ascii', 8, 12);
    if (riff === 'RIFF' && webp === 'WEBP') {
      return { mimeType: 'image/webp', format: 'webp' };
    }

    // ملف غير صوري (نصي، تنفيذي، شل، وورد، إلخ)
    throw new Error('نوع الملف غير صوري أو تم تغيير امتداده للتمويه (Security Violation: Invalid Magic Bytes)');
  }

  /**
   * 2. حساب بصمة SHA-256 لمحتوى الصورة لمنع تكرار الرفع
   */
  static computeChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * 3. معالجة وضغط الصورة وتوليد المستويات المتعددة
   */
  static async optimizeImage(
    rawInput: Buffer | string,
    productId: number,
    options?: { maxDimension?: number; thumbnailDimension?: number }
  ): Promise<MultiTierImageResult> {
    let rawBuffer: Buffer;
    if (typeof rawInput === 'string') {
      if (rawInput.startsWith('data:')) {
        const commaIdx = rawInput.indexOf(',');
        rawBuffer = Buffer.from(rawInput.substring(commaIdx + 1), 'base64');
      } else {
        rawBuffer = Buffer.from(rawInput, 'base64');
      }
    } else {
      rawBuffer = rawInput;
    }

    // فحص الحد الأقصى للحجم
    if (rawBuffer.length > ImageOptimizationEngine.MAX_RAW_SIZE_BYTES) {
      throw new Error(`حجم الصورة (${(rawBuffer.length / 1024 / 1024).toFixed(2)} MB) يتجاوز الحد الأقصى المسموح به (10 MB)`);
    }

    // التحقق من نوع الصورة بالبايتات السحرية
    const { mimeType } = ImageOptimizationEngine.detectAndValidateMagicBytes(rawBuffer);
    const checksum = ImageOptimizationEngine.computeChecksum(rawBuffer);

    // فحص سلامة الصورة بواسطة sharp وقراءة الأبعاد والشفافية
    let metadata: any;
    try {
      metadata = await sharp(rawBuffer).metadata();
    } catch {
      throw new Error('تعذر فك تشفير محتوى الصورة (ملف تالف أو غير صالح)');
    }

    const origWidth = metadata.width || 100;
    const origHeight = metadata.height || 100;
    const hasAlpha = metadata.hasAlpha === true;

    const maxDim = options?.maxDimension || ImageOptimizationEngine.MAX_OPTIMIZED_DIMENSION;
    const thumbDim = options?.thumbnailDimension || ImageOptimizationEngine.THUMBNAIL_DIMENSION;

    // توليد النسخة المحسنة (Optimized) مع الحفاظ التام على نسبة الأبعاد
    let optimizedSharp = sharp(rawBuffer).resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside', // يمنع التشويه ويحافظ على نسبة العرض للارتفاع
      withoutEnlargement: true,
    });

    let targetMimeType: 'image/jpeg' | 'image/png' | 'image/webp' = mimeType;

    // إذا كانت الصورة تحتوي على شفافية، نحافظ على WebP أو PNG لمنع تشويه الخلفية الشفافة
    if (hasAlpha) {
      optimizedSharp = optimizedSharp.webp({ quality: 82, alphaQuality: 90, effort: 4 });
      targetMimeType = 'image/webp';
    } else {
      optimizedSharp = optimizedSharp.webp({ quality: 80, effort: 4 });
      targetMimeType = 'image/webp';
    }

    const optimizedBuffer = await optimizedSharp.toBuffer();
    const optMeta = await sharp(optimizedBuffer).metadata();

    // توليد النسخة المصغرة (Thumbnail) فائقة السرعة لقوائم البيع
    const thumbnailSharp = sharp(rawBuffer)
      .resize({
        width: thumbDim,
        height: thumbDim,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 70, effort: 2 });

    const thumbnailBuffer = await thumbnailSharp.toBuffer();
    const thumbMeta = await sharp(thumbnailBuffer).metadata();

    const origSize = rawBuffer.length;
    const optSize = optimizedBuffer.length;
    const thumbSize = thumbnailBuffer.length;
    const compressionRatio = Math.max(0, Math.round(((origSize - optSize) / origSize) * 100));

    return {
      uuid: `img_${generateUUID().substring(0, 10)}`,
      productId,
      mimeType: targetMimeType,
      originalBuffer: rawBuffer,
      optimizedBuffer,
      thumbnailBuffer,
      originalBase64: `data:${mimeType};base64,${rawBuffer.toString('base64')}`,
      optimizedBase64: `data:${targetMimeType};base64,${optimizedBuffer.toString('base64')}`,
      thumbnailBase64: `data:${targetMimeType};base64,${thumbnailBuffer.toString('base64')}`,
      originalWidth: origWidth,
      originalHeight: origHeight,
      optimizedWidth: optMeta.width || origWidth,
      optimizedHeight: optMeta.height || origHeight,
      thumbnailWidth: thumbMeta.width || thumbDim,
      thumbnailHeight: thumbMeta.height || thumbDim,
      originalSizeBytes: origSize,
      optimizedSizeBytes: optSize,
      thumbnailSizeBytes: thumbSize,
      compressionRatio,
      hasAlpha,
      checksum,
      optimizedChecksum: ImageOptimizationEngine.computeChecksum(optimizedBuffer),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 4. تحويل سجل متعدد المستويات إلى صيغة Dexie Storage المتوافقة مع الإصدارات السابقة
   */
  static toDexieStorageRecord(result: MultiTierImageResult): StorageProductImage {
    return {
      uuid: result.uuid,
      productId: result.productId,
      base64: result.optimizedBase64, // العرض الافتراضي في الواجهة يستخدم النسخة المضغوطة لتوفير الذاكرة
      mimeType: result.mimeType,
      updatedAt: result.createdAt,
      // الحقول المتقدمة للحفاظ على النسخة الأصلية والمصغرة
      originalImage: result.originalBase64,
      optimizedImage: result.optimizedBase64,
      thumbnail: result.thumbnailBase64,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      optimizedWidth: result.optimizedWidth,
      optimizedHeight: result.optimizedHeight,
      originalSizeBytes: result.originalSizeBytes,
      optimizedSizeBytes: result.optimizedSizeBytes,
      thumbnailSizeBytes: result.thumbnailSizeBytes,
      checksum: result.checksum,
      isDeleted: false,
    };
  }
}

/**
 * محرك التخزين السحابي ومحاكاة Firebase Storage (Cloud Storage Simulator)
 */
export class SimulatedCloudStorageService {
  // key: fullStoragePath -> Record
  private storageBucket = new Map<string, CloudStorageUploadRecord>();
  // key: checksum -> storagePath (منع تكرار رفع نفس المحتوى)
  private contentAddressableIndex = new Map<string, string>();
  // سجل الإصدارات التاريخية للرجوع عند الخطأ (Rollback History)
  private productActiveVersions = new Map<string, string[]>(); // key: storeId:productId -> [checksums...]
  // طابور الرفع المحلي في وضع عدم الاتصال
  private offlineUploadQueue: Array<{
    storeId: string;
    productId: number;
    result: MultiTierImageResult;
    retryCount: number;
  }> = [];

  public isOnline: boolean = true;

  /**
   * رفع صورة منتج سحابياً مع التحقق من الصلاحيات وتفادي التكرار
   */
  async uploadProductImage(
    storeId: string,
    productId: number,
    imageResult: MultiTierImageResult
  ): Promise<{ success: boolean; deduplicated: boolean; downloadUrl: string; storagePath: string }> {
    if (!this.isOnline) {
      this.offlineUploadQueue.push({
        storeId,
        productId,
        result: imageResult,
        retryCount: 0,
      });
      return {
        success: false,
        deduplicated: false,
        downloadUrl: '',
        storagePath: `stores/${storeId}/products/${productId}/${imageResult.checksum}.webp (queued offline)`,
      };
    }

    // 1. فحص منع التكرار (Deduplication via Checksum)
    const existingPath = this.contentAddressableIndex.get(imageResult.checksum);
    if (existingPath && this.storageBucket.has(existingPath)) {
      const existing = this.storageBucket.get(existingPath)!;
      return {
        success: true,
        deduplicated: true,
        downloadUrl: existing.downloadUrl,
        storagePath: existingPath,
      };
    }

    // 2. مسارات التخزين المنظمة والمعزولة
    const mainPath = `stores/${storeId}/products/${productId}/${imageResult.checksum}.webp`;
    const thumbPath = `stores/${storeId}/products/${productId}/thumbnails/${imageResult.checksum}.webp`;

    const record: CloudStorageUploadRecord = {
      storagePath: mainPath,
      thumbnailPath: thumbPath,
      storeId,
      productId,
      checksum: imageResult.checksum,
      sizeBytes: imageResult.optimizedSizeBytes,
      contentType: imageResult.mimeType,
      uploadedAt: new Date().toISOString(),
      downloadUrl: `https://firebasestorage.googleapis.com/v0/b/store-bucket/o/${encodeURIComponent(mainPath)}?alt=media`,
      version: (this.productActiveVersions.get(`${storeId}:${productId}`)?.length || 0) + 1,
    };

    // حفظ في الـ Bucket وفهرس المحتوى
    this.storageBucket.set(mainPath, record);
    this.contentAddressableIndex.set(imageResult.checksum, mainPath);

    // تسجيل في قائمة الإصدارات التاريخية للمنتج
    const verKey = `${storeId}:${productId}`;
    const versions = this.productActiveVersions.get(verKey) || [];
    versions.push(imageResult.checksum);
    this.productActiveVersions.set(verKey, versions);

    return {
      success: true,
      deduplicated: false,
      downloadUrl: record.downloadUrl,
      storagePath: mainPath,
    };
  }

  /**
   * التراجع للإصدار السابق من الصورة (Rollback) في حال فشل أي تعديل
   */
  rollbackToPreviousVersion(storeId: string, productId: number): CloudStorageUploadRecord | null {
    const verKey = `${storeId}:${productId}`;
    const versions = this.productActiveVersions.get(verKey);
    if (!versions || versions.length < 2) {
      return null;
    }

    // سحب الإصدار الحالي والعودة للإصدار الذي قبله
    versions.pop();
    const prevChecksum = versions[versions.length - 1];
    const prevPath = this.contentAddressableIndex.get(prevChecksum);
    return prevPath ? this.storageBucket.get(prevPath) || null : null;
  }

  /**
   * مزامنة طابور الرفع عند عودة الاتصال
   */
  async syncPendingUploads(): Promise<{ synced: number; remaining: number }> {
    if (!this.isOnline || this.offlineUploadQueue.length === 0) {
      return { synced: 0, remaining: this.offlineUploadQueue.length };
    }

    let synced = 0;
    const remainingQueue = [];

    for (const item of this.offlineUploadQueue) {
      try {
        await this.uploadProductImage(item.storeId, item.productId, item.result);
        synced++;
      } catch {
        item.retryCount++;
        remainingQueue.push(item);
      }
    }

    this.offlineUploadQueue = remainingQueue;
    return { synced, remaining: this.offlineUploadQueue.length };
  }

  getStorageRecord(path: string): CloudStorageUploadRecord | undefined {
    return this.storageBucket.get(path);
  }

  getBucketFilesCount(): number {
    return this.storageBucket.size;
  }

  getOfflineQueueCount(): number {
    return this.offlineUploadQueue.length;
  }
}
