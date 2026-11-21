import React, { useState, useRef, useEffect } from 'react';
import {
  Check,
  AlertTriangle,
  Cloud,
  CloudCheck,
  CheckCircle2,
  RotateCcw,
  Trash2,
  HardDrive,
  UploadCloud,
  Loader2,
  RefreshCw,
  Settings,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ShieldCheck,
  Download,
  FolderOpen,
  Unlink,
} from 'lucide-react';
import { DB } from '../services/db';
import { StoreSettings } from '../types';
import { playSuccessChime } from '../services/audio';
import {
  subscribeGoogleDriveState,
  getGoogleDriveState,
  hydrateDriveMetadata,
  connectGoogleDrive,
  disconnectGoogleDrive,
  uploadBackupToGoogleDrive,
  listGoogleDriveBackups,
  downloadBackupFromGoogleDrive,
  deleteBackupFromGoogleDrive,
  verifyBackupOnGoogleDrive,
  type DriveBackupVerificationResult,
  type DriveFileItem,
  type GoogleDriveConnectionState,
} from '../services/cloud/googleDriveService';
import {
  subscribeFirebaseState,
  getFirebaseState,
  hydrateFirebaseMetadata,
  initFirebaseAuth,
  connectFirebaseWithGoogle,
  disconnectFirebase,
  configureTestFirebaseProject,
  diagnoseFirestoreConnection,
  runFirestoreTestProjectDiagnostic,
  saveBackupToFirestore,
  listFirestoreBackups,
  loadBackupFromFirestore,
  deleteBackupFromFirestore,
  type FirebaseConnectionState,
  type FirebaseTestProjectConfig,
  type FirestoreDiagnosticResult,
  type FirestoreBackupItem,
} from '../services/cloud/firebaseCloudService';
import {
  createSqliteDbBlob,
  universalRestore,
} from '../services/dbFormat';
import type { StorageBackupRecord } from '../services/storage/types';
import { AutoBackupView } from '../components/backup/AutoBackupView';
import { StoreSettingsHub } from '../components/backup/StoreSettingsHub';
import { clearAllInvoiceDrafts } from '../utils/invoiceDraftStore';

type BackupScreenView = 'backup' | 'auto_backup' | 'settings';
type BackupSourceTab = 'drive' | 'local' | 'firebase';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const POST_RESTORE_RELOAD_DELAY_MS = 500;

function readFileAsTextWithFileReader(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('تعذر قراءة محتوى الملف كنص JSON'));
      }
    };
    reader.onerror = () => {
      reject(new Error(reader.error?.message || 'حدث خطأ أثناء قراءة الملف عبر FileReader'));
    };
    reader.onabort = () => {
      reject(new Error('تم إلغاء قراءة الملف'));
    };
    reader.readAsText(file, 'utf-8');
  });
}

function readFileAsArrayBufferWithFileReader(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('تعذر قراءة بيانات الملف'));
      }
    };
    reader.onerror = () => {
      reject(new Error(reader.error?.message || 'حدث خطأ أثناء قراءة الملف عبر FileReader'));
    };
    reader.onabort = () => {
      reject(new Error('تم إلغاء قراءة الملف'));
    };
    reader.readAsArrayBuffer(file);
  });
}

interface BackupScreenProps {
  initialView?: BackupScreenView;
  onExitView?: () => void;
}

export const BackupScreen: React.FC<BackupScreenProps> = ({
  initialView = 'backup',
  onExitView,
}) => {
  const [settings, setSettings] = useState<StoreSettings>(DB.getSettings());
  const [activeView, setActiveView] = useState<BackupScreenView>(initialView);

  useEffect(() => {
    setActiveView(initialView);
  }, [initialView]);
  const [backupSource, setBackupSource] = useState<BackupSourceTab>('drive');
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  // Service 1: Independent Google Drive state
  const [driveState, setDriveState] = useState<GoogleDriveConnectionState>(() =>
    getGoogleDriveState()
  );
  const [driveBackups, setDriveBackups] = useState<DriveFileItem[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveBusyId, setDriveBusyId] = useState<string | null>(null);
  const [driveVerificationResult, setDriveVerificationResult] =
    useState<DriveBackupVerificationResult | null>(null);

  // Service 2: Independent Firebase (Auth & Firestore) state
  const [firebaseState, setFirebaseState] = useState<FirebaseConnectionState>(() =>
    getFirebaseState()
  );
  const [firestoreBackups, setFirestoreBackups] = useState<FirestoreBackupItem[]>([]);
  const [firebaseLoading, setFirebaseLoading] = useState(false);
  const [firebaseDiagnostic, setFirebaseDiagnostic] =
    useState<FirestoreDiagnosticResult | null>(null);
  const [testProjectForm, setTestProjectForm] = useState<FirebaseTestProjectConfig>({
    projectId: '',
    apiKey: '',
    authDomain: '',
    appId: '',
    firestoreDatabaseId: '(default)',
  });

  // Local Dexie historical backups state
  const [historicalBackups, setHistoricalBackups] = useState<StorageBackupRecord[]>([]);
  const [dexieBackupLoading, setDexieBackupLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);

  const dexieFileInputRef = useRef<HTMLInputElement>(null);
  const sqliteFileInputRef = useRef<HTMLInputElement>(null);

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmText: string;
    isDanger?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMessage({ text, type });
    setTimeout(() => setStatusMessage(null), 4500);
  };

  const triggerPostRestoreReload = () => {
    clearAllInvoiceDrafts();
    window.setTimeout(() => {
      window.location.reload();
    }, POST_RESTORE_RELOAD_DELAY_MS);
  };

  const loadGoogleDriveBackupsOnly = async () => {
    setDriveLoading(true);
    try {
      const files = await listGoogleDriveBackups();
      setDriveBackups(files);
    } catch (err: any) {
      setDriveBackups([]);
      showToast(err?.message || 'تعذر جلب نسخ Google Drive', 'error');
    } finally {
      setDriveLoading(false);
    }
  };

  const loadFirestoreBackupsOnly = async (uid: string) => {
    if (!uid) {
      setFirestoreBackups([]);
      return;
    }
    setFirebaseLoading(true);
    try {
      const items = await listFirestoreBackups(uid);
      setFirestoreBackups(items);
    } catch (err: any) {
      setFirestoreBackups([]);
      showToast(err?.message || 'تعذر جلب لقطات Firestore', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const loadHistoricalBackups = async () => {
    try {
      const list = await DB.listHistoricalBackups();
      setHistoricalBackups(list);
    } catch (err) {
      console.warn('Failed to load historical backups:', err);
    }
  };

  useEffect(() => {
    const initialSettings = DB.getSettings();
    hydrateDriveMetadata({
      email: initialSettings.driveAccountEmail,
      lastBackupAt: initialSettings.driveLastBackupAt,
    });
    hydrateFirebaseMetadata({
      lastSyncAt: initialSettings.firebaseLastSyncAt,
    });

    const unsubDrive = subscribeGoogleDriveState((nextDrive) => {
      setDriveState(nextDrive);
    });

    const unsubFirebase = subscribeFirebaseState((nextFb) => {
      setFirebaseState(nextFb);
    });

    const unsubAuth = initFirebaseAuth(
      (user) => {
        if (user) {
          DB.saveSettings({
            firebaseLinked: true,
            firebaseAccountEmail: user.email || '',
          }).catch(console.error);
        } else {
          setFirestoreBackups([]);
        }
      },
      () => {
        setFirestoreBackups([]);
      }
    );

    const unsubDB = DB.subscribe(() => {
      setSettings(DB.getSettings());
    });

    if (getGoogleDriveState().tokenValid) {
      loadGoogleDriveBackupsOnly();
    }

    return () => {
      unsubDrive();
      unsubFirebase();
      unsubAuth();
      unsubDB();
    };
  }, []);

  useEffect(() => {
    loadHistoricalBackups();
    DB.checkAndRunDailyAutoBackup()
      .then((autoRec) => {
        if (autoRec) {
          loadHistoricalBackups();
        }
      })
      .catch((e) => console.warn('Auto backup check:', e));
  }, []);

  // =========================================================================
  // Local Dexie & File Backup Handlers (Sandbox Verified Before Restore)
  // =========================================================================
  const handleCreateDexieBackup = async (type: 'manual' | 'daily_auto' = 'manual') => {
    setDexieBackupLoading(true);
    try {
      const res = await DB.createFullBackup(type);
      playSuccessChime();

      if (type === 'manual') {
        const url = URL.createObjectURL(res.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = res.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }

      showToast(
        type === 'daily_auto'
          ? 'تم حفظ النسخة التلقائية بنجاح على هذا الجهاز'
          : 'تم حفظ وتنزيل النسخة الاحتياطية المحلية بنجاح'
      );
      await loadHistoricalBackups();
    } catch (err: any) {
      console.error(err);
      showToast(err?.message || 'حدث خطأ أثناء إنشاء النسخة الاحتياطية', 'error');
    } finally {
      setDexieBackupLoading(false);
    }
  };

  const handleDexieFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDexieBackupLoading(true);
    try {
      const rawText = await readFileAsTextWithFileReader(file);
      const cleanText = rawText.replace(/^\uFEFF/, '').trim();
      if (!cleanText) {
        showToast('ملف النسخة الاحتياطية فارغ ولا يحتوي على بيانات JSON', 'error');
        return;
      }

      let parsedJson: any;
      try {
        parsedJson = JSON.parse(cleanText);
      } catch {
        showToast('ملف النسخة الاحتياطية غير صالح: صيغة JSON غير صحيحة أو تالفة', 'error');
        return;
      }

      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        showToast('تنسيق ملف JSON غير متوافق مع نسخة Cashier الاحتياطية', 'error');
        return;
      }

      // Path A: Complete Dexie v2 JSON Backup
      if (parsedJson.format === 'CashierProCompleteDexieBackup' && parsedJson.data) {
        const validation = await DB.validateBackupInSandbox(cleanText);
        if (!validation.valid || !validation.manifest) {
          showToast(validation.error || 'الملف غير صالح أو تالف', 'error');
          return;
        }

        const m = validation.manifest;
        setConfirmModal({
          title: 'تأكيد استعادة النسخة المحلية',
          message: `تم التحقق من سلامة الملف بنجاح (${m.totalRecords} سجل).\nتاريخ النسخة: ${new Date(
            m.createdAt
          ).toLocaleString('ar-EG')}\n\nسيتم أخذ نسخة أمان تلقائية للبيانات الحالية قبل الاستعادة. هل توافق؟`,
          confirmText: 'نعم، استعادة الآن',
          isDanger: true,
          onConfirm: async () => {
            setDexieBackupLoading(true);
            try {
              const res = await DB.restoreDexieBackupSafely(cleanText);
              await loadHistoricalBackups();
              setSettings(DB.getSettings());
              setConfirmModal(null);
              playSuccessChime();
              showToast(`${res.message} جاري تحديث التطبيق...`);
              triggerPostRestoreReload();
            } catch (err: any) {
              setConfirmModal(null);
              showToast(err?.message || 'فشلت عملية الاستعادة', 'error');
            } finally {
              setDexieBackupLoading(false);
            }
          },
        });
        return;
      }

      // Path B: Standard / Legacy Cashier JSON Backup
      if (Array.isArray(parsedJson.products)) {
        const { verifyDriveBackupInSandbox } = await import(
          '../services/storage/backup/driveBackupVerifier'
        );
        const encoded = new TextEncoder().encode(cleanText);
        const verification = await verifyDriveBackupInSandbox(encoded.buffer as ArrayBuffer, {
          fileId: 'local_json_import',
          fileName: file.name,
          reportedSize: String(file.size),
        });
        setDriveVerificationResult(verification);

        if (!verification.structureValid || !verification.sandboxRestorable) {
          showToast(verification.error || 'فشل فحص ملف JSON في البيئة المعزولة (Sandbox)', 'error');
          return;
        }

        setConfirmModal({
          title: 'تأكيد استعادة نسخة JSON',
          message: `تم التحقق من سلامة ملف JSON "${file.name}" بنجاح (${verification.totalRecords} سجل).\n\nسيتم أخذ نسخة أمان تلقائية للبيانات الحالية قبل الاستعادة. هل توافق؟`,
          confirmText: 'نعم، استعادة الآن',
          isDanger: true,
          onConfirm: async () => {
            setDexieBackupLoading(true);
            try {
              const restored = await DB.restoreDataAsync(cleanText);
              if (!restored) {
                throw new Error('تعذر كتابة بيانات النسخة الاحتياطية في قاعدة البيانات');
              }
              await loadHistoricalBackups();
              setSettings(DB.getSettings());
              setConfirmModal(null);
              playSuccessChime();
              const prods = DB.getProducts().length;
              const invs = DB.getInvoices().length;
              showToast(
                `تمت استعادة النسخة الاحتياطية بنجاح (${prods} صنف، ${invs} فاتورة). جاري تحديث التطبيق...`
              );
              triggerPostRestoreReload();
            } catch (err: any) {
              setConfirmModal(null);
              showToast(err?.message || 'فشلت عملية الاستعادة', 'error');
            } finally {
              setDexieBackupLoading(false);
            }
          },
        });
        return;
      }

      showToast('تنسيق ملف JSON غير متوافق مع بنية قاعدة بيانات Cashier', 'error');
    } catch (err: any) {
      showToast(err?.message || 'تعذر قراءة ملف النسخة الاحتياطية', 'error');
    } finally {
      setDexieBackupLoading(false);
      if (dexieFileInputRef.current) dexieFileInputRef.current.value = '';
    }
  };

  const handleRestoreHistorical = async (item: StorageBackupRecord) => {
    setDexieBackupLoading(true);
    try {
      // Mandatory Sandbox check before confirmation
      const validation = await DB.validateBackupInSandbox(item.payloadJson);
      if (!validation.valid || !validation.manifest) {
        showToast(validation.error || 'تعذر التحقق من سلامة النسخة في Sandbox', 'error');
        return;
      }

      setConfirmModal({
        title: 'تأكيد استعادة النسخة المحفوظة',
        message: `تم فحص النسخة والتأكد من سلامتها (${validation.manifest.totalRecords} سجل).\nتاريخ الحفظ: ${new Date(
          item.createdAt
        ).toLocaleString('ar-EG')}\n\nسيتم أخذ نسخة أمان تلقائية للبيانات الحالية قبل التطبيق. هل تريد المتابعة؟`,
        confirmText: 'نعم، استعادة النسخة',
        isDanger: true,
        onConfirm: async () => {
          setDexieBackupLoading(true);
          try {
            const res = await DB.restoreDexieBackupSafely(item.payloadJson);
            await loadHistoricalBackups();
            setSettings(DB.getSettings());
            setConfirmModal(null);
            playSuccessChime();
            showToast(`${res.message} جاري تحديث التطبيق...`);
            triggerPostRestoreReload();
          } catch (err: any) {
            setConfirmModal(null);
            showToast(err?.message || 'فشلت عملية الاستعادة', 'error');
          } finally {
            setDexieBackupLoading(false);
          }
        },
      });
    } catch (err: any) {
      showToast(err?.message || 'حدث خطأ أثناء فحص النسخة قبل الاستعادة', 'error');
    } finally {
      setDexieBackupLoading(false);
    }
  };

  const handleDeleteHistorical = (item: StorageBackupRecord) => {
    setConfirmModal({
      title: 'حذف النسخة الاحتياطية',
      message: `هل تريد حذف النسخة المحفوظة بتاريخ ${new Date(item.createdAt).toLocaleString(
        'ar-EG'
      )}؟`,
      confirmText: 'حذف النسخة',
      isDanger: true,
      onConfirm: async () => {
        try {
          await DB.deleteHistoricalBackup(item.id);
          showToast('تم حذف النسخة المحلية بنجاح');
          await loadHistoricalBackups();
        } catch {
          showToast('فشل حذف النسخة', 'error');
        } finally {
          setConfirmModal(null);
        }
      },
    });
  };

  const handleDownloadHistorical = (item: StorageBackupRecord) => {
    const blob = new Blob([item.payloadJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = item.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('تم تنزيل ملف النسخة الاحتياطية');
  };

  const handleExportSqliteFile = async () => {
    setFileLoading(true);
    try {
      const { blob, fileName } = await createSqliteDbBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      playSuccessChime();
      showToast('تم تصدير النسخة الاحتياطية بصيغة .db بنجاح');
    } catch (err) {
      console.error(err);
      showToast('حدث خطأ أثناء تصدير الملف', 'error');
    } finally {
      setFileLoading(false);
    }
  };

  const handleSqliteFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileLoading(true);
    try {
      const buffer = await readFileAsArrayBufferWithFileReader(file);
      // Mandatory Sandbox check for uploaded file before confirming restore
      const { verifyDriveBackupInSandbox } = await import(
        '../services/storage/backup/driveBackupVerifier'
      );
      const verification = await verifyDriveBackupInSandbox(buffer, {
        fileId: 'local_file_import',
        fileName: file.name,
        reportedSize: String(file.size),
      });
      setDriveVerificationResult(verification);

      if (!verification.structureValid || !verification.sandboxRestorable) {
        showToast(verification.error || 'فشل فحص الملف في البيئة المعزولة (Sandbox)', 'error');
        return;
      }

      setConfirmModal({
        title: 'تأكيد استعادة ملف النسخة الاحتياطية',
        message: `تم فحص الملف "${file.name}" بنجاح (${verification.totalRecords} سجل).\n\nهل تريد استعادة البيانات الحالية من هذا الملف؟`,
        confirmText: 'نعم، استعادة البيانات',
        isDanger: true,
        onConfirm: async () => {
          setFileLoading(true);
          try {
            const res = await universalRestore(buffer);
            if (res.success) {
              await loadHistoricalBackups();
              setSettings(DB.getSettings());
              setConfirmModal(null);
              playSuccessChime();
              showToast(`${res.message} جاري تحديث التطبيق...`);
              triggerPostRestoreReload();
            } else {
              setConfirmModal(null);
              showToast(res.message, 'error');
            }
          } catch (err: any) {
            setConfirmModal(null);
            showToast(err?.message || 'تعذر استعادة الملف', 'error');
          } finally {
            setFileLoading(false);
          }
        },
      });
    } catch (err: any) {
      showToast(err?.message || 'تعذر قراءة الملف المحدد', 'error');
    } finally {
      setFileLoading(false);
      if (sqliteFileInputRef.current) sqliteFileInputRef.current.value = '';
    }
  };

  // =========================================================================
  // Service 1: Independent Google Drive Handlers (Preserves all Sandbox rules)
  // =========================================================================
  const handleConnectGoogleDrive = async (): Promise<boolean> => {
    setDriveLoading(true);
    try {
      const nextState = await connectGoogleDrive({ prompt: 'select_account' });
      const email = nextState.account?.email || '';
      await DB.saveSettings({
        googleDriveLinked: true,
        driveAccountEmail: email,
      });
      setSettings(DB.getSettings());
      playSuccessChime();
      await loadGoogleDriveBackupsOnly();
      return true;
    } catch (err: any) {
      console.error(err);
      showToast(err?.message || 'تعذر ربط حساب Google Drive', 'error');
      return false;
    } finally {
      setDriveLoading(false);
    }
  };

  const handleDisconnectGoogleDrive = async () => {
    setDriveLoading(true);
    try {
      await disconnectGoogleDrive();
      await DB.clearGoogleDriveLink();
      setDriveBackups([]);
      setDriveVerificationResult(null);
      setSettings(DB.getSettings());
      playSuccessChime();
      showToast('تم فصل حساب Google Drive دون التأثير على البيانات المحلية');
    } catch (err: any) {
      showToast(err?.message || 'حدث خطأ أثناء فصل Google Drive', 'error');
    } finally {
      setDriveLoading(false);
    }
  };

  const handleBackupToGoogleDrive = async () => {
    setDriveLoading(true);
    try {
      if (!getGoogleDriveState().tokenValid) {
        const nextState = await connectGoogleDrive({ prompt: 'select_account' });
        await DB.saveSettings({
          googleDriveLinked: true,
          driveAccountEmail: nextState.account?.email || '',
        });
      }

      const { binary, fileName } = await createSqliteDbBlob();
      const uploaded = await uploadBackupToGoogleDrive(binary, fileName);
      await DB.saveSettings({ driveLastBackupAt: uploaded.uploadedAt });
      setSettings(DB.getSettings());
      playSuccessChime();
      showToast('تم رفع النسخة الاحتياطية إلى Google Drive بنجاح');
      await loadGoogleDriveBackupsOnly();
    } catch (err: any) {
      console.error(err);
      showToast(err?.message || 'تعذر رفع النسخة الاحتياطية إلى Google Drive', 'error');
    } finally {
      setDriveLoading(false);
    }
  };

  const handleVerifyDriveBackup = async (file: DriveFileItem) => {
    setDriveBusyId(file.id);
    try {
      const result = await verifyBackupOnGoogleDrive(file);
      setDriveVerificationResult(result);
      if (result.structureValid && result.sandboxRestorable && result.sha256Status !== 'mismatch') {
        playSuccessChime();
        showToast(`تم فحص النسخة "${file.name}" بنجاح (${result.totalRecords} سجل)`);
      } else {
        showToast(result.error || 'تعذر التحقق من سلامة هذه النسخة', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'تعذر فحص النسخة في Sandbox', 'error');
    } finally {
      setDriveBusyId(null);
    }
  };

  const handleRestoreFromGoogleDrive = async (file: DriveFileItem) => {
    setDriveBusyId(file.id);
    try {
      // Mandatory Sandbox check before showing confirmation or restoring
      const verification = await verifyBackupOnGoogleDrive(file);
      setDriveVerificationResult(verification);

      if (
        !verification.structureValid ||
        !verification.sandboxRestorable ||
        verification.sha256Status === 'mismatch'
      ) {
        showToast(
          verification.error || 'فشل فحص النسخة في Sandbox؛ تم إيقاف الاستعادة لحماية بياناتك.',
          'error'
        );
        return;
      }

      setConfirmModal({
        title: 'تأكيد استعادة النسخة الاحتياطية',
        message: `تم فحص النسخة "${file.name}" والتأكد من سلامتها (${verification.totalRecords} سجل).\n\nهل تريد استعادة البيانات الحالية من هذه النسخة؟`,
        confirmText: 'نعم، استعادة النسخة',
        isDanger: false,
        onConfirm: async () => {
          setDriveLoading(true);
          try {
            const buffer = await downloadBackupFromGoogleDrive(file.id);
            const res = await universalRestore(buffer);
            if (res.success) {
              await loadHistoricalBackups();
              setSettings(DB.getSettings());
              setConfirmModal(null);
              playSuccessChime();
              showToast(`${res.message} جاري تحديث التطبيق...`);
              triggerPostRestoreReload();
            } else {
              setConfirmModal(null);
              showToast(res.message, 'error');
            }
          } catch (err: any) {
            setConfirmModal(null);
            showToast(err?.message || 'تعذر استعادة النسخة من Google Drive', 'error');
          } finally {
            setDriveLoading(false);
          }
        },
      });
    } catch (err: any) {
      showToast(err?.message || 'تعذر فحص النسخة قبل الاستعادة', 'error');
    } finally {
      setDriveBusyId(null);
    }
  };

  const handleDeleteDriveBackup = (file: DriveFileItem) => {
    setConfirmModal({
      title: 'حذف النسخة الاحتياطية',
      message: `هل تريد حذف النسخة "${file.name}" من Google Drive نهائياً؟`,
      confirmText: 'حذف نهائياً',
      isDanger: true,
      onConfirm: async () => {
        setDriveLoading(true);
        try {
          await deleteBackupFromGoogleDrive(file.id);
          playSuccessChime();
          showToast('تم حذف النسخة من Google Drive');
          await loadGoogleDriveBackupsOnly();
        } catch (err: any) {
          showToast(err?.message || 'تعذر حذف الملف من Google Drive', 'error');
        } finally {
          setDriveLoading(false);
          setConfirmModal(null);
        }
      },
    });
  };

  // =========================================================================
  // Service 2: Independent Firebase Handlers (Test Project Isolated)
  // =========================================================================
  const handleConnectFirebase = async () => {
    setFirebaseLoading(true);
    try {
      const nextFb = await connectFirebaseWithGoogle();
      await DB.saveSettings({
        firebaseLinked: true,
        firebaseAccountEmail: nextFb.user?.email || '',
        firebaseLastSyncAt: nextFb.lastSyncAt || new Date().toISOString(),
        firebaseProjectId: nextFb.projectId,
      });
      setSettings(DB.getSettings());
      playSuccessChime();
      showToast(`تم تسجيل الدخول في Firebase (${nextFb.projectId})`);
      if (nextFb.user?.uid && nextFb.isTestProject) {
        await loadFirestoreBackupsOnly(nextFb.user.uid);
      }
    } catch (err: any) {
      showToast(err?.message || 'فشل تسجيل الدخول في Firebase', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleDisconnectFirebase = async () => {
    setFirebaseLoading(true);
    try {
      await disconnectFirebase();
      await DB.clearFirebaseLink();
      setFirestoreBackups([]);
      setFirebaseDiagnostic(null);
      setSettings(DB.getSettings());
      playSuccessChime();
      showToast('تم فصل Firebase دون حذف أي بيانات محلية');
    } catch (err: any) {
      showToast(err?.message || 'حدث خطأ أثناء فصل Firebase', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleApplyTestProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setFirebaseLoading(true);
    try {
      const next = await configureTestFirebaseProject(testProjectForm);
      setFirebaseDiagnostic(null);
      setFirestoreBackups([]);
      await DB.saveSettings({ firebaseProjectId: next.projectId });
      showToast(`تم تهيئة المشروع الاختباري (${next.projectId})`);
    } catch (err: any) {
      showToast(err?.message || 'تعذر تهيئة المشروع الاختباري', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleClearTestProject = async () => {
    setFirebaseLoading(true);
    try {
      await configureTestFirebaseProject(null);
      setFirebaseDiagnostic(null);
      setFirestoreBackups([]);
      showToast('تم إلغاء المشروع الاختباري');
    } catch (err: any) {
      showToast(err?.message || 'تعذر إعادة الضبط', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handlePasteFirebaseJsonConfig = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setTestProjectForm((prev) => ({
          projectId: String(parsed.projectId || prev.projectId),
          apiKey: String(parsed.apiKey || prev.apiKey),
          authDomain: String(parsed.authDomain || prev.authDomain),
          appId: String(parsed.appId || prev.appId),
          firestoreDatabaseId: String(parsed.firestoreDatabaseId || '(default)'),
          storageBucket: parsed.storageBucket ? String(parsed.storageBucket) : undefined,
          messagingSenderId: parsed.messagingSenderId ? String(parsed.messagingSenderId) : undefined,
        }));
        showToast('تم تعبئة حقول المشروع الاختباري');
      }
    } catch {
      showToast('صيغة JSON غير صالحة', 'error');
    }
  };

  const handleCheckFirestoreReachability = async () => {
    setFirebaseLoading(true);
    try {
      const diag = await diagnoseFirestoreConnection();
      if (diag.ok) {
        await DB.saveSettings({ firebaseLastSyncAt: new Date().toISOString() });
        playSuccessChime();
        showToast(diag.message);
      } else {
        showToast(diag.message, 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'فشل فحص اتصال Firestore', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleRunTestProjectReadWrite = async () => {
    setFirebaseLoading(true);
    try {
      const result = await runFirestoreTestProjectDiagnostic();
      setFirebaseDiagnostic(result);
      if (result.ok) {
        await DB.saveSettings({
          firebaseLastSyncAt: new Date().toISOString(),
          firebaseProjectId: result.projectId,
        });
        playSuccessChime();
        showToast(result.message);
      } else {
        showToast(result.message, 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'فشل اختبار القراءة والكتابة', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleBackupToFirestore = async () => {
    if (!firebaseState.user?.uid) {
      await handleConnectFirebase();
      return;
    }
    if (!firebaseState.isTestProject) {
      showToast('يرجى إعداد وتفعيل مشروع اختباري معزول من الإعدادات أولاً.', 'error');
      return;
    }
    setFirebaseLoading(true);
    try {
      const dataStr = DB.backupData();
      const products = DB.getProducts();
      const invoices = DB.getInvoices();
      await saveBackupToFirestore(firebaseState.user.uid, dataStr, {
        productsCount: products.length,
        invoicesCount: invoices.length,
      });
      await DB.saveSettings({ firebaseLastSyncAt: new Date().toISOString() });
      playSuccessChime();
      showToast('تم رفع اللقطة السحابية بنجاح');
      await loadFirestoreBackupsOnly(firebaseState.user.uid);
    } catch (err: any) {
      showToast(err?.message || 'فشل رفع النسخة إلى Firestore', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleRestoreFromFirestore = async (backup: FirestoreBackupItem) => {
    if (!firebaseState.user?.uid) return;
    const uid = firebaseState.user.uid;
    setFirebaseLoading(true);
    try {
      const jsonStr = await loadBackupFromFirestore(uid, backup.id);
      const parsed = JSON.parse(jsonStr);
      if (parsed?.format === 'CashierProCompleteDexieBackup') {
        const validation = await DB.validateBackupInSandbox(parsed);
        if (!validation.valid) {
          showToast(validation.error || 'فشل التحقق من سلامة النسخة السحابية', 'error');
          return;
        }
      } else if (!parsed || !Array.isArray(parsed.products)) {
        showToast('تنسيق النسخة السحابية غير صالح للاستعادة', 'error');
        return;
      }

      setConfirmModal({
        title: 'تأكيد استعادة النسخة السحابية',
        message: `تم فحص اللقطة "${backup.fileName}" بنجاح.\n\nهل تريد استعادة بيانات المحل من هذه اللقطة؟`,
        confirmText: 'نعم، استعادة الآن',
        isDanger: false,
        onConfirm: async () => {
          setFirebaseLoading(true);
          try {
            const res = await universalRestore(jsonStr);
            if (res.success) {
              await loadHistoricalBackups();
              setSettings(DB.getSettings());
              setConfirmModal(null);
              playSuccessChime();
              showToast(`${res.message} جاري تحديث التطبيق...`);
              triggerPostRestoreReload();
            } else {
              setConfirmModal(null);
              showToast(res.message, 'error');
            }
          } catch (err: any) {
            setConfirmModal(null);
            showToast(err?.message || 'تعذر استعادة النسخة', 'error');
          } finally {
            setFirebaseLoading(false);
          }
        },
      });
    } catch (err: any) {
      showToast(err?.message || 'تعذر تحميل وفحص النسخة السحابية', 'error');
    } finally {
      setFirebaseLoading(false);
    }
  };

  const handleDeleteFirestoreBackup = (backup: FirestoreBackupItem) => {
    if (!firebaseState.user?.uid) return;
    const uid = firebaseState.user.uid;
    setConfirmModal({
      title: 'حذف النسخة السحابية',
      message: `هل تريد حذف اللقطة "${backup.fileName}" من المشروع الاختباري؟`,
      confirmText: 'حذف اللقطة',
      isDanger: true,
      onConfirm: async () => {
        setFirebaseLoading(true);
        try {
          await deleteBackupFromFirestore(uid, backup.id);
          playSuccessChime();
          showToast('تم حذف النسخة السحابية');
          await loadFirestoreBackupsOnly(uid);
        } catch (err: any) {
          showToast(err?.message || 'تعذر حذف النسخة', 'error');
        } finally {
          setFirebaseLoading(false);
          setConfirmModal(null);
        }
      },
    });
  };

  // =========================================================================
  // Settings Persistence Helpers
  // =========================================================================
  const updateSettingImmediate = async (partial: Partial<StoreSettings>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    try {
      await DB.saveSettings(partial);
    } catch (err) {
      console.error('Failed to update setting:', err);
    }
  };

  const handleSaveStoreForm = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await DB.saveSettings(settings);
      playSuccessChime();
      showToast('تم حفظ إعدادات المحل بنجاح');
    } catch {
      showToast('حدث خطأ أثناء حفظ الإعدادات', 'error');
    }
  };

  // =========================================================================
  // Derived Honest Status & Timestamps (Strictly Isolated Per Source)
  // =========================================================================
  const autoBackups = historicalBackups.filter((b) => b.type === 'daily_auto');
  const latestAutoIsRecent =
    autoBackups.length > 0 &&
    Date.now() - new Date(autoBackups[0].createdAt).getTime() < TWENTY_FOUR_HOURS_MS;

  const lastDriveTimestamp =
    driveBackups[0]?.createdTime ||
    driveState.lastBackupAt ||
    settings.driveLastBackupAt ||
    null;

  const isSourceComplete =
    backupSource === 'drive'
      ? driveState.tokenValid && (driveBackups.length > 0 || Boolean(lastDriveTimestamp))
      : backupSource === 'local'
        ? historicalBackups.length > 0
        : Boolean(firebaseState.user && firebaseState.isTestProject && firestoreBackups.length > 0);

  const activeLastBackupAt: string | null =
    backupSource === 'drive'
      ? lastDriveTimestamp
      : backupSource === 'local'
        ? historicalBackups[0]?.createdAt || null
        : firestoreBackups[0]?.createdAt || firebaseState.lastSyncAt || null;

  const isPrimaryActionBusy =
    backupSource === 'drive'
      ? driveLoading
      : backupSource === 'local'
        ? dexieBackupLoading
        : firebaseLoading;

  const handlePrimaryUpload = async () => {
    if (backupSource === 'drive') {
      await handleBackupToGoogleDrive();
    } else if (backupSource === 'local') {
      await handleCreateDexieBackup('manual');
    } else {
      await handleBackupToFirestore();
    }
  };

  const formatArabicDateTime = (iso: string | null): string => {
    if (!iso) return 'لا توجد نسخة محفوظة بعد';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'تاريخ غير متوفر';
    return d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  };

  return (
    <div dir="rtl" className="max-w-2xl mx-auto py-1 space-y-4">
      {/* Toast Notification */}
      {statusMessage && (
        <div
          className={`sticky top-2 z-30 p-3.5 rounded-2xl text-[14px] font-bold text-center flex items-center justify-center gap-2 shadow-sm border ${
            statusMessage.type === 'success'
              ? 'bg-[var(--color-success-bg)] text-[var(--color-success)] border-[var(--color-success-border)]'
              : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-border)]'
          }`}
        >
          {statusMessage.type === 'success' ? (
            <Check className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* VIEW 1: Auto-Backup Dedicated Konnash-style Screen */}
      {activeView === 'auto_backup' && (
        <AutoBackupView
          autoBackups={autoBackups}
          loading={dexieBackupLoading}
          onBack={() => setActiveView(initialView === 'settings' ? 'settings' : 'backup')}
          onRunAutoBackupNow={() => handleCreateDexieBackup('daily_auto')}
        />
      )}

      {/* VIEW 2: Clean Settings Hub (Preserves Theme, Currency, Fonts, Store, Firebase) */}
      {activeView === 'settings' && (
        <StoreSettingsHub
          settings={settings}
          onUpdateImmediate={updateSettingImmediate}
          onSaveStoreForm={handleSaveStoreForm}
          onBack={() => (initialView === 'settings' && onExitView ? onExitView() : setActiveView('backup'))}
          onOpenAutoBackup={() => setActiveView('auto_backup')}
          firebaseState={firebaseState}
          firebaseLoading={firebaseLoading}
          firebaseDiagnostic={firebaseDiagnostic}
          testProjectForm={testProjectForm}
          setTestProjectForm={setTestProjectForm}
          onConnectFirebase={handleConnectFirebase}
          onDisconnectFirebase={handleDisconnectFirebase}
          onApplyTestProject={handleApplyTestProject}
          onClearTestProject={handleClearTestProject}
          onPasteFirebaseJson={handlePasteFirebaseJsonConfig}
          onCheckFirestoreReachability={handleCheckFirestoreReachability}
          onRunTestProjectReadWrite={handleRunTestProjectReadWrite}
        />
      )}

      {/* VIEW 3: Primary Backup & Restore Screen */}
      {activeView === 'backup' && (
        <div className="app-card px-5 py-6 sm:px-8 sm:py-8 space-y-8">
          {/* 1. Header: Title "النسخ الاحتياطي" + Clean Shortcuts */}
          <div className="flex items-center justify-between gap-3">
            <h1 className="app-page-title text-[var(--brand-primary)]">النسخ الاحتياطي</h1>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveView('auto_backup')}
                className="flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-full hover:bg-[var(--brand-soft)] text-[var(--text-primary)] text-[14px] font-bold transition cursor-pointer"
                title="النسخ التلقائي"
              >
                <span
                  className={`h-7 w-7 rounded-full flex items-center justify-center ${
                    latestAutoIsRecent
                      ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                      : 'bg-[var(--brand-soft)] text-[var(--brand-primary)]'
                  }`}
                >
                  {latestAutoIsRecent ? (
                    <CloudCheck className="h-4 w-4" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                </span>
                <span>النسخ التلقائي</span>
                <ChevronLeft className="h-4 w-4 text-[var(--brand-primary)]" />
              </button>

              <button
                type="button"
                onClick={() => setActiveView('settings')}
                className="h-11 w-11 rounded-full bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] text-[var(--brand-primary)] flex items-center justify-center transition cursor-pointer"
                title="إعدادات المتجر والمظهر"
                aria-label="إعدادات المتجر والمظهر"
              >
                <Settings className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 2, 3, 4: Hero Status + Last Backup Time + Clear Primary Upload CTA */}
          <div className="text-center space-y-5 py-2">
            <div className="h-16 w-16 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center mx-auto">
              <Cloud className="h-8 w-8" />
            </div>

            {/* 2. Backup Status */}
            <div className="space-y-1.5">
              <div
                className={`inline-flex items-center justify-center gap-2 app-section-title ${
                  isSourceComplete ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'
                }`}
              >
                {isSourceComplete ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-5 w-5 shrink-0" />
                )}
                <span>
                  {isSourceComplete
                    ? 'حالة النسخ: النسخ الاحتياطي مكتمل'
                    : 'حالة النسخ: يحتاج إلى إجراء'}
                </span>
              </div>

              {/* 3. Last Backup Date & Time */}
              <div className="app-meta-text app-num">
                <span>آخر نسخة احتياطية: </span>
                <span className="font-bold text-[var(--text-primary)]">
                  {formatArabicDateTime(activeLastBackupAt)}
                </span>
              </div>

              {backupSource === 'drive' && (driveState.account?.email || settings.driveAccountEmail) && (
                <div className="text-[13px] text-[var(--text-muted)] flex items-center justify-center gap-2 pt-0.5">
                  <span dir="ltr">{driveState.account?.email || settings.driveAccountEmail}</span>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={handleDisconnectGoogleDrive}
                    disabled={driveLoading}
                    className="text-[var(--color-danger)] hover:underline font-bold cursor-pointer inline-flex items-center gap-1 min-h-[36px]"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    <span>فصل الحساب</span>
                  </button>
                </div>
              )}
            </div>

            {/* 4. Clear Upload Backup Button */}
            <div className="pt-1">
              <button
                type="button"
                onClick={handlePrimaryUpload}
                disabled={isPrimaryActionBusy}
                className="app-btn-primary w-full max-w-sm mx-auto rounded-2xl text-[16px] py-3.5 px-6 min-h-[52px]"
              >
                {isPrimaryActionBusy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <UploadCloud className="h-5 w-5" />
                )}
                <span>رفع نسخة احتياطية</span>
              </button>
            </div>
          </div>

          {/* 5. Saved Backups Section (Strict Source Isolation Tabs) */}
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="app-section-title text-[var(--brand-primary)]">النسخ المحفوظة</h2>

              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface-subtle)] rounded-xl border border-[var(--border-default)] text-[13px]">
                  <button
                    type="button"
                    onClick={() => setBackupSource('drive')}
                    className={`px-3 min-h-[38px] rounded-lg font-bold transition cursor-pointer whitespace-nowrap ${
                      backupSource === 'drive'
                        ? 'bg-[var(--bg-surface)] text-[var(--brand-primary)] shadow-xs'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Google Drive
                  </button>
                  <button
                    type="button"
                    onClick={() => setBackupSource('local')}
                    className={`px-3 min-h-[38px] rounded-lg font-bold transition cursor-pointer whitespace-nowrap ${
                      backupSource === 'local'
                        ? 'bg-[var(--bg-surface)] text-[var(--brand-primary)] shadow-xs'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    محلية
                  </button>
                  <button
                    type="button"
                    onClick={() => setBackupSource('firebase')}
                    className={`px-3 min-h-[38px] rounded-lg font-bold transition cursor-pointer whitespace-nowrap ${
                      backupSource === 'firebase'
                        ? 'bg-[var(--bg-surface)] text-[var(--brand-primary)] shadow-xs'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    سحابية
                  </button>
                </div>

                {backupSource === 'drive' && driveState.tokenValid && (
                  <button
                    type="button"
                    onClick={loadGoogleDriveBackupsOnly}
                    disabled={driveLoading}
                    className="h-11 w-11 rounded-full hover:bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center transition cursor-pointer"
                    title="تحديث القائمة"
                  >
                    <RefreshCw className={`h-4 w-4 ${driveLoading ? 'animate-spin' : ''}`} />
                  </button>
                )}

                {backupSource === 'firebase' && firebaseState.user && firebaseState.isTestProject && (
                  <button
                    type="button"
                    onClick={() =>
                      firebaseState.user && loadFirestoreBackupsOnly(firebaseState.user.uid)
                    }
                    disabled={firebaseLoading}
                    className="h-11 w-11 rounded-full hover:bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center transition cursor-pointer"
                    title="تحديث القائمة"
                  >
                    <RefreshCw className={`h-4 w-4 ${firebaseLoading ? 'animate-spin' : ''}`} />
                  </button>
                )}
              </div>
            </div>

            {/* 6. Backups List — Google Drive */}
            {backupSource === 'drive' && (
              <div>
                {!driveState.tokenValid ? (
                  <div className="py-8 text-center space-y-3">
                    <p className="text-[15px] text-[var(--text-secondary)]">
                      سجّل الدخول بحساب Google لعرض أو رفع النسخ الاحتياطية على Google Drive
                    </p>
                    <button
                      type="button"
                      onClick={handleConnectGoogleDrive}
                      disabled={driveLoading}
                      className="min-h-[44px] text-[15px] font-bold text-[var(--brand-primary)] py-2 px-5 rounded-xl bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
                    >
                      {driveLoading ? 'جاري الاتصال...' : 'ربط حساب Google Drive'}
                    </button>
                  </div>
                ) : driveBackups.length === 0 ? (
                  <div className="py-8 text-center text-[15px] text-[var(--text-muted)]">
                    لا توجد نسخ احتياطية محفوظة في Google Drive حتى الآن
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-default)]">
                    {driveBackups.map((file) => {
                      const isBusy = driveBusyId === file.id || driveLoading;
                      return (
                        <div
                          key={file.id}
                          className="py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 overflow-hidden min-w-0">
                            <div className="h-10 w-10 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                              <Cloud className="h-5 w-5" />
                            </div>
                            <div className="overflow-hidden min-w-0">
                              <div className="font-bold text-[var(--text-primary)] text-[15px] truncate" dir="ltr">
                                {file.name}
                              </div>
                              <div className="app-meta-text app-num mt-0.5">
                                {formatArabicDateTime(file.createdTime || null)}
                                {file.size ? ` · ${(Number(file.size) / 1024).toFixed(0)} KB` : ''}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleRestoreFromGoogleDrive(file)}
                              disabled={isBusy}
                              className="px-3.5 py-2 min-h-[44px] rounded-xl bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] text-[var(--brand-soft-text)] text-[14px] font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                            >
                              {driveBusyId === file.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RotateCcw className="h-4 w-4" />
                              )}
                              <span>استعادة</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteDriveBackup(file)}
                              disabled={isBusy}
                              className="px-3.5 py-2 min-h-[44px] rounded-xl hover:bg-[var(--color-danger-bg)] text-[var(--color-danger)] text-[14px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            >
                              <Trash2 className="h-4 w-4" />
                              <span>حذف</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 6. Backups List — Local Device */}
            {backupSource === 'local' && (
              <div>
                {historicalBackups.length === 0 ? (
                  <div className="py-8 text-center text-[15px] text-[var(--text-muted)]">
                    لا توجد نسخ محلية محفوظة على هذا الجهاز حتى الآن
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-default)]">
                    {historicalBackups.map((item) => (
                      <div
                        key={item.id}
                        className="py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 overflow-hidden min-w-0">
                          <div className="h-10 w-10 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                            <HardDrive className="h-5 w-5" />
                          </div>
                          <div className="overflow-hidden min-w-0">
                            <div className="font-bold text-[var(--text-primary)] text-[15px] truncate">
                              {item.type === 'daily_auto'
                                ? 'نسخة تلقائية'
                                : item.type === 'pre_restore_safety'
                                  ? 'نسخة أمان قبل الاستعادة'
                                  : 'نسخة محلية يدوية'}
                            </div>
                            <div className="app-meta-text app-num mt-0.5">
                              {formatArabicDateTime(item.createdAt)} · {item.totalRecords} سجل
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRestoreHistorical(item)}
                            disabled={dexieBackupLoading}
                            className="px-3.5 py-2 min-h-[44px] rounded-xl bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] text-[var(--brand-soft-text)] text-[14px] font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className="h-4 w-4" />
                            <span>استعادة</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteHistorical(item)}
                            disabled={dexieBackupLoading}
                            className="px-3.5 py-2 min-h-[44px] rounded-xl hover:bg-[var(--color-danger-bg)] text-[var(--color-danger)] text-[14px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />
                            <span>حذف</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 6. Backups List — Firebase Cloud (Isolated Test Project) */}
            {backupSource === 'firebase' && (
              <div>
                {!firebaseState.user || !firebaseState.isTestProject ? (
                  <div className="py-8 text-center space-y-3">
                    <p className="text-[15px] text-[var(--text-secondary)]">
                      {!firebaseState.isTestProject
                        ? 'فعّل المشروع الاختباري من الإعدادات للوصول إلى اللقطات السحابية'
                        : 'سجّل الدخول إلى Firebase لعرض اللقطات المحفوظة'}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        firebaseState.isTestProject
                          ? handleConnectFirebase()
                          : setActiveView('settings')
                      }
                      className="min-h-[44px] text-[15px] font-bold text-[var(--brand-primary)] py-2 px-5 rounded-xl bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
                    >
                      {firebaseState.isTestProject ? 'تسجيل دخول Firebase' : 'فتح الإعدادات'}
                    </button>
                  </div>
                ) : firestoreBackups.length === 0 ? (
                  <div className="py-8 text-center text-[15px] text-[var(--text-muted)]">
                    لا توجد لقطات سحابية محفوظة حالياً
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-default)]">
                    {firestoreBackups.map((item) => (
                      <div
                        key={item.id}
                        className="py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 overflow-hidden min-w-0">
                          <div className="h-10 w-10 rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] flex items-center justify-center shrink-0">
                            <Cloud className="h-5 w-5" />
                          </div>
                          <div className="overflow-hidden min-w-0">
                            <div className="font-bold text-[var(--text-primary)] text-[15px] truncate">
                              {item.fileName}
                            </div>
                            <div className="app-meta-text app-num mt-0.5">
                              {formatArabicDateTime(item.createdAt || null)} ·{' '}
                              {item.totalProducts || 0} صنف
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRestoreFromFirestore(item)}
                            disabled={firebaseLoading}
                            className="px-3.5 py-2 min-h-[44px] rounded-xl bg-[var(--brand-soft)] hover:bg-[var(--bg-hover)] text-[var(--brand-soft-text)] text-[14px] font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className="h-4 w-4" />
                            <span>استعادة</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteFirestoreBackup(item)}
                            disabled={firebaseLoading}
                            className="px-3.5 py-2 min-h-[44px] rounded-xl hover:bg-[var(--color-danger-bg)] text-[var(--color-danger)] text-[14px] font-bold transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />
                            <span>حذف</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 7. Optional Collapsible Technical Inspection & File Tools Section */}
          <div className="pt-4 border-t border-[var(--border-default)]">
            <button
              type="button"
              onClick={() => setShowTechnicalDetails((v) => !v)}
              className="w-full min-h-[44px] py-2.5 flex items-center justify-between text-[14px] font-bold text-[var(--text-secondary)] hover:text-[var(--brand-primary)] transition cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                <span>خيارات الملفات وتفاصيل الفحص الفني (اختياري)</span>
              </span>
              {showTechnicalDetails ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>

            {showTechnicalDetails && (
              <div className="pt-4 space-y-5 text-[14px]">
                {/* File Import/Export Utilities */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => dexieFileInputRef.current?.click()}
                    disabled={dexieBackupLoading}
                    className="app-btn-secondary justify-center text-[14px]"
                  >
                    <FolderOpen className="h-4 w-4 text-[var(--brand-primary)]" />
                    <span>استيراد نسخة JSON من الجهاز</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportSqliteFile}
                    disabled={fileLoading}
                    className="app-btn-secondary justify-center text-[14px]"
                  >
                    <Download className="h-4 w-4 text-[var(--brand-primary)]" />
                    <span>تصدير نسخة SQLite (.db)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => sqliteFileInputRef.current?.click()}
                    disabled={fileLoading}
                    className="app-btn-secondary justify-center text-[14px]"
                  >
                    <RotateCcw className="h-4 w-4 text-[var(--brand-primary)]" />
                    <span>استيراد ملف SQLite (.db)</span>
                  </button>
                  {historicalBackups[0] && (
                    <button
                      type="button"
                      onClick={() => handleDownloadHistorical(historicalBackups[0])}
                      className="app-btn-secondary justify-center text-[14px]"
                    >
                      <Download className="h-4 w-4 text-[var(--brand-primary)]" />
                      <span>تنزيل آخر نسخة محلية</span>
                    </button>
                  )}
                </div>

                {/* Read-only Sandbox Checks for Drive Files */}
                {driveState.tokenValid && driveBackups.length > 0 && (
                  <div className="space-y-2">
                    <div className="font-bold text-[var(--text-primary)]">فحص نسخ Google Drive في Sandbox (قراءة فقط):</div>
                    <div className="space-y-2">
                      {driveBackups.map((file) => (
                        <div
                          key={file.id}
                          className="flex items-center justify-between gap-2 bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] rounded-xl px-3.5 py-2.5"
                        >
                          <span className="font-mono text-[12px] text-[var(--text-primary)] truncate" dir="ltr">
                            {file.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleVerifyDriveBackup(file)}
                            disabled={driveBusyId !== null || driveLoading}
                            className="text-[var(--brand-primary)] hover:underline font-bold shrink-0 cursor-pointer min-h-[36px]"
                          >
                            {driveBusyId === file.id ? 'جاري الفحص...' : 'فحص Sandbox'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Technical Verification Report */}
                {driveVerificationResult && (
                  <div className="app-card-subtle p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[var(--text-primary)]">
                        تقرير الفحص الفني (Sandbox)
                      </span>
                      <button
                        type="button"
                        onClick={() => setDriveVerificationResult(null)}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer font-bold"
                      >
                        إخفاء
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[12px] bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-3">
                      <div className="font-mono break-all" dir="ltr">
                        id: {driveVerificationResult.fileId}
                      </div>
                      <div className="font-mono break-all" dir="ltr">
                        mimeType: {driveVerificationResult.mimeType || 'N/A'}
                      </div>
                      <div className="font-mono" dir="ltr">
                        format: {driveVerificationResult.format} · {driveVerificationResult.sizeBytes} B
                      </div>
                      <div className="font-mono" dir="ltr">
                        records: {driveVerificationResult.totalRecords}
                      </div>
                      <div className="font-mono break-all" dir="ltr">
                        parents: {driveVerificationResult.parents?.join(', ') || 'N/A'}
                      </div>
                      <div className="font-mono break-all" dir="ltr">
                        md5: {driveVerificationResult.md5Checksum || 'N/A'}
                      </div>
                    </div>

                    {driveVerificationResult.computedSha256 && (
                      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-3 space-y-1">
                        <div className="font-bold text-[var(--text-primary)]">
                          حالة SHA-256: {driveVerificationResult.sha256Status}
                        </div>
                        <div className="font-mono text-[11px] text-[var(--text-muted)] break-all" dir="ltr">
                          {driveVerificationResult.computedSha256}
                        </div>
                      </div>
                    )}

                    {driveVerificationResult.tables.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {driveVerificationResult.tables.map((t) => (
                          <div
                            key={t.name}
                            className="flex items-center justify-between bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-2.5 py-1.5 text-[12px]"
                          >
                            <span className="font-mono truncate" dir="ltr">
                              {t.name}
                            </span>
                            <span className="font-mono font-bold">{t.rows}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {driveVerificationResult.error && (
                      <div className="bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-[var(--color-danger-border)] rounded-xl p-2.5 space-y-1">
                        <div className="font-bold">
                          {driveVerificationResult.httpStatus
                            ? `HTTP ${driveVerificationResult.httpStatus} · `
                            : ''}
                          {driveVerificationResult.driveErrorReason
                            ? `${driveVerificationResult.driveErrorReason}: `
                            : ''}
                          {driveVerificationResult.error}
                        </div>
                        {driveVerificationResult.driveRawErrorMessage && (
                          <div className="font-mono text-[11px] break-all" dir="ltr">
                            {driveVerificationResult.driveRawErrorMessage}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <input
                  ref={dexieFileInputRef}
                  type="file"
                  accept=".json,application/json,text/plain,application/octet-stream"
                  onChange={handleDexieFileChange}
                  className="hidden"
                />
                <input
                  ref={sqliteFileInputRef}
                  type="file"
                  accept=".db,.sqlite,.sqlite3,application/x-sqlite3,application/octet-stream,*/*"
                  onChange={handleSqliteFileChange}
                  className="hidden"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mandatory User Confirmation Dialog Before Restore or Delete */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex bg-black/55 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto overscroll-contain">
          <div className="m-auto w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-3xl bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div
                className={`h-11 w-11 rounded-full flex items-center justify-center shrink-0 ${
                  confirmModal.isDanger
                    ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
                    : 'bg-[var(--brand-soft)] text-[var(--brand-primary)]'
                }`}
              >
                {confirmModal.isDanger ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <RotateCcw className="h-5 w-5" />
                )}
              </div>
              <h3 className="app-section-title text-[17px] leading-tight">
                {confirmModal.title}
              </h3>
            </div>

            <p className="text-[14px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-line">
              {confirmModal.message}
            </p>

            <div className="grid grid-cols-2 gap-2.5 pt-2">
              <button
                type="button"
                disabled={confirmBusy}
                onClick={() => setConfirmModal(null)}
                className="app-btn-secondary w-full disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={confirmBusy}
                onClick={async () => {
                  if (confirmBusy) return;
                  setConfirmBusy(true);
                  try {
                    await confirmModal.onConfirm();
                  } finally {
                    setConfirmBusy(false);
                  }
                }}
                className={confirmModal.isDanger ? 'app-btn-danger w-full' : 'app-btn-primary w-full'}
              >
                {confirmBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{confirmBusy ? 'جاري التنفيذ...' : confirmModal.confirmText}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
