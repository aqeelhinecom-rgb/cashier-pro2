/**
 * Browser-side Image Optimization Helper (Phase 16 / Phase 17 Hardened)
 * - Validates image MIME types (rejects non-image files)
 * - Preserves aspect ratio without distortion
 * - Preserves transparency (PNG / WebP) instead of forcing opaque JPEG
 */
export async function compressImageFile(file: File, maxSize = 800, quality = 0.82): Promise<string> {
  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error('نوع الملف غير مدعوم: يرجى اختيار ملف صورة صالح (JPEG, PNG, WebP)');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }

        // Preserve transparency for PNG and WebP; use WebP (with PNG fallback) when alpha-capable
        const isAlphaCapable = file.type === 'image/png' || file.type === 'image/webp';
        if (isAlphaCapable) {
          ctx.clearRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);

        const outputMime = isAlphaCapable ? 'image/webp' : 'image/jpeg';
        let dataUrl = canvas.toDataURL(outputMime, quality);
        // Fallback if browser doesn't support WebP encoding and returns PNG
        if (isAlphaCapable && !dataUrl.startsWith('data:image/webp') && !dataUrl.startsWith('data:image/png')) {
          dataUrl = canvas.toDataURL('image/png');
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('تعذر قراءة الصورة أو الملف تالف'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('تعذر تحميل ملف الصورة'));
    reader.readAsDataURL(file);
  });
}

export async function generateThumbnailDataUrl(file: File, thumbSize = 150, quality = 0.72): Promise<string> {
  return compressImageFile(file, thumbSize, quality);
}
