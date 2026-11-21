import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Invoice, InvoiceItem, StoreSettings } from '../types';

export type PdfPaperSize = 'a4' | 'thermal80' | 'thermal58';

export interface PdfExportOptions {
  share?: boolean;
  shareTitle?: string;
  shareText?: string;
  paperSize?: PdfPaperSize;
}

export interface PdfExportResult {
  success: boolean;
  error?: string;
  fileName?: string;
  method?: 'capacitor_share' | 'browser_download' | 'web_share';
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  const withExt = cleaned.endsWith('.pdf') ? cleaned : `${cleaned || 'document'}.pdf`;
  return withExt;
}

function preventA4RowSplitting(doc: Document, targetEl: HTMLElement): void {
  const pageHeightPx = (794 * 297) / 210; // ~1122.94px
  const bottomSafeMarginPx = 20;
  const topSafeMarginPx = 16;

  const candidates = Array.from(targetEl.querySelectorAll('tbody tr, .pdf-avoid-break'));
  for (const el of candidates) {
    if (el.getAttribute('data-pdf-spacer') === 'true') continue;
    const rootRect = targetEl.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const relTop = rect.top - rootRect.top;
    const relBottom = rect.bottom - rootRect.top;
    const height = rect.height;

    if (height <= 0 || height > pageHeightPx - 80) continue;

    const startPage = Math.floor(relTop / pageHeightPx);
    const pageLimit = (startPage + 1) * pageHeightPx - bottomSafeMarginPx;
    if (relBottom > pageLimit) {
      const pushHeight = Math.ceil((startPage + 1) * pageHeightPx + topSafeMarginPx - relTop);
      if (pushHeight > 0 && el.tagName.toLowerCase() === 'tr' && el.parentElement) {
        const colCount = Math.max(1, (el as HTMLTableRowElement).cells?.length || 1);
        const spacerTr = doc.createElement('tr');
        spacerTr.setAttribute('data-pdf-spacer', 'true');
        spacerTr.innerHTML = `<td colspan="${colCount}" style="height:${pushHeight}px;border:none !important;background:#ffffff !important;padding:0 !important;"></td>`;
        el.parentElement.insertBefore(spacerTr, el);
      } else if (pushHeight > 0) {
        (el as HTMLElement).style.marginTop = `${pushHeight}px`;
      }
    }
  }
}

async function deliverPdfCrossPlatform(
  pdf: jsPDF,
  cleanFilename: string,
  options?: PdfExportOptions
): Promise<PdfExportResult> {
  if (Capacitor.isNativePlatform()) {
    const dataUri = pdf.output('datauristring');
    const commaIdx = dataUri.indexOf(',');
    const base64Data = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : '';
    if (!base64Data) {
      return {
        success: false,
        error: 'تعذر ترميز بيانات PDF للحفظ على جهاز Android.',
      };
    }

    // Best-effort persistent copy in app-scoped Documents folder
    try {
      await Filesystem.writeFile({
        path: `CashierPro_PDF/${cleanFilename}`,
        data: base64Data,
        directory: Directory.Documents,
        recursive: true,
      });
    } catch {
      // Documents may be restricted on older Android without legacy storage; Cache below is always available
    }

    try {
      const cacheFile = await Filesystem.writeFile({
        path: cleanFilename,
        data: base64Data,
        directory: Directory.Cache,
        recursive: true,
      });

      try {
        await Share.share({
          title: options?.shareTitle || cleanFilename,
          text: options?.shareText || cleanFilename,
          url: cacheFile.uri,
          files: [cacheFile.uri],
          dialogTitle: 'حفظ أو مشاركة ملف PDF',
        });
      } catch (shareErr: unknown) {
        const msg = shareErr instanceof Error ? shareErr.message.toLowerCase() : String(shareErr).toLowerCase();
        // If the user explicitly dismissed the Android share sheet, the PDF was still saved cleanly
        if (!msg.includes('cancel') && !msg.includes('abort')) {
          return {
            success: false,
            error: `تم إنشاء الملف لكن تعذر فتح نافذة المشاركة على Android: ${
              shareErr instanceof Error ? shareErr.message : String(shareErr)
            }`,
          };
        }
      }

      return {
        success: true,
        fileName: cleanFilename,
        method: 'capacitor_share',
      };
    } catch (fsErr: unknown) {
      return {
        success: false,
        error: `تعذر حفظ ملف PDF على ذاكرة Android: ${
          fsErr instanceof Error ? fsErr.message : String(fsErr)
        }`,
      };
    }
  }

  // Browser environment
  pdf.save(cleanFilename);

  if (options?.share && typeof navigator !== 'undefined' && navigator.share) {
    try {
      const pdfBlob = pdf.output('blob');
      const pdfFile = new File([pdfBlob], cleanFilename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({
          title: options.shareTitle || cleanFilename,
          text: options.shareText || cleanFilename,
          files: [pdfFile],
        });
      } else {
        await navigator.share({
          title: options.shareTitle || cleanFilename,
          text: options.shareText || cleanFilename,
        });
      }
      return { success: true, fileName: cleanFilename, method: 'web_share' };
    } catch {
      // User dismissed share dialog; direct download already succeeded
    }
  }

  return { success: true, fileName: cleanFilename, method: 'browser_download' };
}

/**
 * Renders an isolated HTML string (using standard hex/rgb inline styles and Arabic RTL layout)
 * inside a clean off-screen iframe so global oklch() stylesheets never interfere with html2canvas,
 * then converts it into a multi-page A4 or thermal (58mm/80mm) PDF file and delivers it on Web or Android.
 */
export async function renderHtmlToPdfFile(
  innerHtml: string,
  filename: string,
  options?: PdfExportOptions
): Promise<PdfExportResult> {
  if (typeof document === 'undefined') {
    return {
      success: false,
      error: 'بيئة المتصفح غير متاحة لتوليد PDF.',
    };
  }

  const paperSize: PdfPaperSize = options?.paperSize || 'a4';
  const viewportWidthPx =
    paperSize === 'thermal58' ? 219 : paperSize === 'thermal80' ? 302 : 794;
  const bodyPaddingPx = paperSize === 'a4' ? 32 : 10;
  const cleanFilename = sanitizeFileName(filename);

  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '0';
    iframe.style.width = `${viewportWidthPx}px`;
    iframe.style.height = '1200px';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const cleanup = () => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    };

    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) {
        cleanup();
        resolve({ success: false, error: 'تعذر تهيئة مستند PDF المؤقت.' });
        return;
      }

      const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      const fontLinkTag = isOnline
        ? '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">'
        : '';

      doc.open();
      doc.write(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  ${fontLinkTag}
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Cairo', 'Noto Sans Arabic', 'Tahoma', 'Arial', sans-serif;
    }
    body {
      background-color: #ffffff;
      color: #0f172a;
      direction: rtl;
      text-align: right;
      width: ${viewportWidthPx}px;
      padding: ${bodyPaddingPx}px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: ${paperSize === 'a4' ? '14px' : '8px'};
    }
    th {
      background-color: #1e4663;
      color: #ffffff;
      font-weight: 700;
      font-size: ${paperSize === 'a4' ? '13px' : paperSize === 'thermal80' ? '11px' : '10px'};
      padding: ${paperSize === 'a4' ? '10px 12px' : '5px 4px'};
      border: 1px solid #1e4663;
      text-align: right;
    }
    td {
      padding: ${paperSize === 'a4' ? '9px 12px' : '4px 4px'};
      border: 1px solid #cbd5e1;
      font-size: ${paperSize === 'a4' ? '13px' : paperSize === 'thermal80' ? '11px' : '9.5px'};
      color: #1e293b;
      vertical-align: middle;
      word-break: break-word;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
  </style>
</head>
<body>
  <div id="pdf-root">${innerHtml}</div>
</body>
</html>`);
      doc.close();

      setTimeout(async () => {
        try {
          const targetEl = doc.getElementById('pdf-root') || doc.body;
          if (doc.fonts && doc.fonts.ready) {
            await Promise.race([
              doc.fonts.ready,
              new Promise((r) => setTimeout(r, 350)),
            ]);
          }

          if (paperSize === 'a4') {
            preventA4RowSplitting(doc, targetEl);
          }

          const canvas = await html2canvas(targetEl, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: viewportWidthPx,
          });

          if (!canvas || canvas.width === 0 || canvas.height === 0) {
            cleanup();
            resolve({ success: false, error: 'فشل تصوير محتوى التقرير أو الفاتورة لتوليد PDF.' });
            return;
          }

          const imgData = canvas.toDataURL('image/jpeg', 0.96);
          let pdf: jsPDF;

          if (paperSize === 'thermal80' || paperSize === 'thermal58') {
            const widthMm = paperSize === 'thermal58' ? 58 : 80;
            const imgHeightMm = (canvas.height * widthMm) / canvas.width;
            const heightMm = Math.max(40, Math.ceil(imgHeightMm) + 2);
            pdf = new jsPDF({
              orientation: 'portrait',
              unit: 'mm',
              format: [widthMm, heightMm],
            });
            pdf.addImage(imgData, 'JPEG', 0, 0, widthMm, imgHeightMm);
          } else {
            pdf = new jsPDF({
              orientation: 'portrait',
              unit: 'mm',
              format: 'a4',
            });

            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const imgWidth = pageWidth;
            const imgHeight = (canvas.height * imgWidth) / canvas.width;

            let heightLeft = imgHeight;
            let position = 0;

            pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;

            while (heightLeft > 2) {
              position = heightLeft - imgHeight;
              pdf.addPage();
              pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
              heightLeft -= pageHeight;
            }
          }

          const delivery = await deliverPdfCrossPlatform(pdf, cleanFilename, options);
          cleanup();
          resolve(delivery);
        } catch (err: unknown) {
          console.error('PDF generation error:', err);
          cleanup();
          resolve({
            success: false,
            error: `حدث خطأ أثناء إنشاء ملف PDF: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }, 150);
    } catch (e: unknown) {
      console.error('PDF iframe error:', e);
      cleanup();
      resolve({
        success: false,
        error: `تعذر تحضير قالب PDF: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}

export function buildInvoicePdfHtml(
  invoice: Invoice,
  items: InvoiceItem[],
  settings: StoreSettings,
  paperSize: PdfPaperSize = 'a4'
): string {
  const invCurrency = escapeHtml(invoice.currency || settings.currency || 'د.ع');
  const remaining = Math.max(0, (Number(invoice.total) || 0) - (Number(invoice.paid) || 0));
  const dateFormatted = new Date(invoice.date).toISOString().split('T')[0];
  const displayNumber = escapeHtml(invoice.invoice_number || `#${invoice.id}`);
  const storeName = escapeHtml(settings.storeName || 'Cashier Pro');
  const phone = escapeHtml(settings.phone || '');
  const address = escapeHtml(settings.address || '');
  const partyLabel = invoice.type === 'purchase' ? 'المورد:' : 'العميل:';
  const partyName = escapeHtml(invoice.party_name || 'مفرد');
  const footerText = escapeHtml(settings.receiptFooter || 'شكراً لتعاملكم معنا');

  const typeLabel =
    invoice.type === 'sale'
      ? 'فاتورة بيع'
      : invoice.type === 'purchase'
      ? 'فاتورة شراء'
      : invoice.type === 'sale_return'
      ? 'فاتورة مرتجع'
      : 'عرض سعر';

  if (paperSize === 'thermal80' || paperSize === 'thermal58') {
    const isSmall = paperSize === 'thermal58';
    const thermalRows =
      items.length > 0
        ? items
            .map(
              (it) => `
          <tr>
            <td style="font-weight:700;">${escapeHtml(it.name)}</td>
            <td style="text-align:center;font-weight:700;">${Number(it.qty)}</td>
            <td style="text-align:center;">${Number(it.price).toFixed(0)}</td>
            <td style="text-align:left;font-weight:800;">${(Number(it.qty) * Number(it.price)).toFixed(0)}</td>
          </tr>`
            )
            .join('')
        : `<tr><td colspan="4" style="text-align:center;padding:8px;color:#64748b;">لا توجد أصناف</td></tr>`;

    return `
      <div style="background:#ffffff;color:#0f172a;font-size:${isSmall ? '10px' : '11px'};">
        <div style="text-align:center;border-bottom:1px dashed #64748b;padding-bottom:8px;margin-bottom:8px;">
          <div style="font-size:${isSmall ? '14px' : '16px'};font-weight:800;">${storeName}</div>
          ${phone ? `<div style="font-size:${isSmall ? '9px' : '10px'};color:#475569;">هاتف: ${phone}</div>` : ''}
          ${address ? `<div style="font-size:${isSmall ? '9px' : '10px'};color:#475569;">${address}</div>` : ''}
        </div>
        <div style="border-bottom:1px dashed #64748b;padding-bottom:6px;margin-bottom:6px;line-height:1.6;">
          <div style="display:flex;justify-content:space-between;"><span>النوع:</span><strong>${typeLabel}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>رقم الفاتورة:</span><strong>${displayNumber}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>التاريخ:</span><span>${dateFormatted}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>${partyLabel}</span><strong>${partyName}</strong></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>الصنف</th>
              <th style="text-align:center;">كمية</th>
              <th style="text-align:center;">سعر</th>
              <th style="text-align:left;">مجموع</th>
            </tr>
          </thead>
          <tbody>${thermalRows}</tbody>
        </table>
        <div style="border-top:1px dashed #64748b;margin-top:8px;padding-top:6px;line-height:1.7;">
          ${
            invoice.discount > 0
              ? `<div style="display:flex;justify-content:space-between;color:#dc2626;"><span>الخصم:</span><strong>-${Number(invoice.discount).toFixed(0)} ${invCurrency}</strong></div>`
              : ''
          }
          <div style="display:flex;justify-content:space-between;font-size:${isSmall ? '12px' : '13px'};font-weight:800;">
            <span>الإجمالي:</span>
            <span>${Number(invoice.total).toFixed(0)} ${invCurrency}</span>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <span>المدفوع:</span>
            <strong>${Number(invoice.paid).toFixed(0)} ${invCurrency}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;color:${remaining > 0 ? '#dc2626' : '#15803d'};">
            <span>المتبقي:</span>
            <strong>${remaining.toFixed(0)} ${invCurrency}</strong>
          </div>
        </div>
        <div style="margin-top:10px;padding-top:6px;border-top:1px dashed #94a3b8;text-align:center;font-size:${isSmall ? '9px' : '10px'};color:#475569;">
          ${footerText}
        </div>
      </div>
    `;
  }

  const rowsHtml =
    items.length > 0
      ? items
          .map(
            (it, idx) => `
        <tr>
          <td style="text-align:center;font-weight:700;width:45px;">${idx + 1}</td>
          <td style="font-weight:700;">${escapeHtml(it.name)}</td>
          <td style="text-align:center;font-weight:700;">${Number(it.qty)}</td>
          <td style="text-align:center;">${Number(it.price).toFixed(0)} ${invCurrency}</td>
          <td style="text-align:left;font-weight:800;color:#0f172a;">${(Number(it.qty) * Number(it.price)).toFixed(0)} ${invCurrency}</td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="5" style="text-align:center;padding:16px;color:#64748b;">لا توجد أصناف</td></tr>`;

  return `
    <div style="border:2px solid #1e4663;border-radius:14px;padding:24px;background:#ffffff;">
      <div class="pdf-avoid-break" style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #e2e8f0;padding-bottom:16px;margin-bottom:16px;">
        <div>
          <h1 style="font-size:24px;font-weight:800;color:#1e4663;">${storeName}</h1>
          ${phone ? `<p style="font-size:13px;color:#475569;margin-top:4px;">هاتف: ${phone}</p>` : ''}
          ${address ? `<p style="font-size:13px;color:#64748b;">${address}</p>` : ''}
        </div>
        <div style="text-align:left;background:#f1f5f9;padding:12px 18px;border-radius:10px;border:1px solid #cbd5e1;">
          <div style="font-size:18px;font-weight:800;color:#1e4663;">${typeLabel}</div>
          <div style="font-size:14px;font-weight:700;color:#334155;margin-top:2px;">فاتورة رقم: ${displayNumber}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">التاريخ: ${dateFormatted}</div>
        </div>
      </div>

      <div class="pdf-avoid-break" style="display:flex;justify-content:space-between;background:#f8fafc;padding:12px 16px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:16px;font-size:14px;">
        <div>
          <span style="color:#64748b;font-weight:600;">${partyLabel}</span>
          <strong style="color:#0f172a;margin-right:6px;">${partyName}</strong>
        </div>
        <div>
          <span style="color:#64748b;font-weight:600;">العملة:</span>
          <strong style="color:#0f172a;margin-right:6px;">${invCurrency}</strong>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="text-align:center;width:45px;">#</th>
            <th>المنتج / الصنف</th>
            <th style="text-align:center;">الكمية</th>
            <th style="text-align:center;">السعر</th>
            <th style="text-align:left;">الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <div class="pdf-avoid-break" style="margin-top:20px;display:flex;justify-content:flex-end;">
        <div style="width:280px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:14px;">
          ${
            invoice.discount > 0
              ? `<div style="display:flex;justify-content:space-between;font-size:13px;color:#dc2626;margin-bottom:6px;">
                  <span>الخصم:</span>
                  <strong>${Number(invoice.discount).toFixed(0)} ${invCurrency}</strong>
                </div>`
              : ''
          }
          <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:800;color:#1e4663;border-bottom:1px solid #cbd5e1;padding-bottom:8px;margin-bottom:8px;">
            <span>اجمالي الفاتورة:</span>
            <span style="color:#b91c1c;">${Number(invoice.total).toFixed(0)} ${invCurrency}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:#15803d;margin-bottom:4px;">
            <span>المدفوع:</span>
            <strong>${Number(invoice.paid).toFixed(0)} ${invCurrency}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:${remaining > 0 ? '#dc2626' : '#475569'};">
            <span>المتبقي:</span>
            <strong>${remaining.toFixed(0)} ${invCurrency}</strong>
          </div>
        </div>
      </div>

      <div class="pdf-avoid-break" style="margin-top:24px;padding-top:12px;border-top:1px dashed #cbd5e1;text-align:center;font-size:12px;color:#64748b;font-weight:600;">
        ${footerText}
      </div>
    </div>
  `;
}

export async function exportInvoiceToPdf(
  invoice: Invoice,
  items: InvoiceItem[],
  settings: StoreSettings,
  options?: PdfExportOptions
): Promise<PdfExportResult> {
  const dateFormatted = new Date(invoice.date).toISOString().split('T')[0];
  const paperSize: PdfPaperSize = options?.paperSize || 'a4';
  const html = buildInvoicePdfHtml(invoice, items, settings, paperSize);
  const invNumPart = (invoice.invoice_number || String(invoice.id)).replace(/[\\/:*?"<>|#\s]+/g, '_');
  const sizeSuffix = paperSize === 'a4' ? '' : `_${paperSize}`;
  return renderHtmlToPdfFile(html, `فاتورة_${invNumPart}_${dateFormatted}${sizeSuffix}.pdf`, {
    ...options,
    paperSize,
  });
}

export function buildReportPdfHtml(params: {
  reportTitle: string;
  reportDate: string;
  columns: string[];
  rows: (string | number)[][];
  summaryCards?: { label: string; value: string }[];
  supplierName?: string;
  supplierPhone?: string;
  settings: StoreSettings;
}): string {
  const {
    reportTitle,
    reportDate,
    columns,
    rows,
    summaryCards = [],
    supplierName,
    supplierPhone,
    settings,
  } = params;

  const storeName = escapeHtml(settings.storeName || 'Cashier Pro');
  const phone = escapeHtml(settings.phone || '');
  const address = escapeHtml(settings.address || '');

  const supplierBannerHtml = supplierName
    ? `<div class="pdf-avoid-break" style="display:flex;justify-content:space-between;background:#f8fafc;padding:12px 16px;border-radius:10px;border:1px solid #cbd5e1;margin-bottom:16px;font-size:14px;">
        <div>
          <span style="color:#64748b;font-weight:600;">موجه إلى المورد:</span>
          <strong style="color:#0f172a;margin-right:6px;">${escapeHtml(supplierName)}</strong>
        </div>
        ${
          supplierPhone
            ? `<div>
                <span style="color:#64748b;font-weight:600;">هاتف المورد:</span>
                <strong style="color:#0f172a;margin-right:6px;">${escapeHtml(supplierPhone)}</strong>
              </div>`
            : ''
        }
      </div>`
    : '';

  const summaryHtml =
    summaryCards.length > 0
      ? `<div class="pdf-avoid-break" style="display:grid;grid-template-columns:repeat(${Math.min(3, summaryCards.length)}, 1fr);gap:12px;margin-bottom:18px;">
          ${summaryCards
            .map(
              (c) => `
            <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:12px 14px;">
              <div style="font-size:12px;color:#64748b;font-weight:600;">${escapeHtml(c.label)}</div>
              <div style="font-size:17px;font-weight:800;color:#1e4663;margin-top:4px;">${escapeHtml(c.value)}</div>
            </div>`
            )
            .join('')}
        </div>`
      : '';

  const headersHtml = columns
    .map((col, idx) => {
      if (col === '#') {
        return `<th style="width:55px;text-align:center;">${escapeHtml(col)}</th>`;
      }
      if (col === 'العدد المطلوب' || idx === columns.length - 1) {
        return `<th style="text-align:center;">${escapeHtml(col)}</th>`;
      }
      return `<th>${escapeHtml(col)}</th>`;
    })
    .join('');

  const bodyHtml =
    rows.length > 0
      ? rows
          .map(
            (r) =>
              `<tr>${r
                .map((cell, i) => {
                  const isIndexCol = columns[i] === '#';
                  const isLastCol = i === r.length - 1;
                  const align = isIndexCol || isLastCol ? 'center' : 'right';
                  return `<td style="text-align:${align};font-weight:${
                    i === 0 || isLastCol ? '700' : '600'
                  };${isIndexCol ? 'width:55px;color:#475569;' : ''}">${escapeHtml(cell)}</td>`;
                })
                .join('')}</tr>`
          )
          .join('')
      : `<tr><td colspan="${Math.max(1, columns.length)}" style="text-align:center;padding:20px;color:#64748b;">لا توجد بيانات مسجلة في هذا التقرير</td></tr>`;

  return `
    <div style="border:2px solid #1e4663;border-radius:14px;padding:24px;background:#ffffff;">
      <div class="pdf-avoid-break" style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #e2e8f0;padding-bottom:16px;margin-bottom:18px;">
        <div>
          <h1 style="font-size:22px;font-weight:800;color:#1e4663;">${storeName}</h1>
          ${phone ? `<p style="font-size:13px;color:#475569;margin-top:2px;">هاتف: ${phone}</p>` : ''}
          ${address ? `<p style="font-size:12px;color:#64748b;">${address}</p>` : ''}
        </div>
        <div style="text-align:left;background:#f1f5f9;padding:10px 16px;border-radius:10px;border:1px solid #cbd5e1;">
          <div style="font-size:16px;font-weight:800;color:#1e4663;">${escapeHtml(reportTitle)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">تاريخ التقرير: ${escapeHtml(reportDate)}</div>
        </div>
      </div>

      ${supplierBannerHtml}
      ${summaryHtml}

      <table>
        <thead>
          <tr>${headersHtml}</tr>
        </thead>
        <tbody>
          ${bodyHtml}
        </tbody>
      </table>

      <div class="pdf-avoid-break" style="margin-top:22px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#64748b;">
        <span>تم استخراج التقرير بصيغة PDF من تطبيق ${storeName}</span>
        <span>عدد الأصناف / السجلات: ${rows.length}</span>
      </div>
    </div>
  `;
}

export async function exportReportToPdf(params: {
  reportTitle: string;
  reportDate: string;
  columns: string[];
  rows: (string | number)[][];
  summaryCards?: { label: string; value: string }[];
  supplierName?: string;
  supplierPhone?: string;
  settings: StoreSettings;
  options?: PdfExportOptions;
}): Promise<PdfExportResult> {
  const html = buildReportPdfHtml(params);
  const safeTitle = params.reportTitle.replace(/\s+/g, '_');
  return renderHtmlToPdfFile(html, `${safeTitle}_${params.reportDate}.pdf`, params.options);
}
