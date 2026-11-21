import {
  initializeApp,
  getApps,
  getApp,
  deleteApp,
  type FirebaseApp,
} from 'firebase/app';
import { Capacitor } from '@capacitor/core';
import {
  getAuth,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  collection,
  getDocs,
  query,
  orderBy,
  deleteDoc,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../../firebase-applet-config.json';
import { generateBackupFileName } from '../dbFormat';
import type {
  CloudServiceStatus,
  FirebaseConnectionState,
  FirebaseTestProjectConfig,
  FirebaseUserInfo,
  FirestoreDiagnosticResult,
} from './types';

export type {
  FirebaseConnectionState,
  FirebaseTestProjectConfig,
  FirebaseUserInfo,
  FirestoreDiagnosticResult,
};

// ==========================================
// Structured Firestore Error Diagnostics
// ==========================================

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export interface CloudConnectionDiagnostics {
  ok: boolean;
  status: 'connected' | 'offline' | 'permission_denied' | 'config_error' | 'unauthenticated' | 'error';
  message: string;
  projectId: string;
  firestoreDatabaseId: string;
  isNativeAndroid: boolean;
}

const FIRESTORE_MAX_DOC_JSON_BYTES = 1000000; // Safe margin below 1,048,576 byte rule limit
const TEST_SANDBOX_APP_NAME = 'cashier_p27_test_sandbox';

// Primary App / Auth / Firestore (initialized cleanly without any Google Drive scopes)
export const app: FirebaseApp =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth: Auth = getAuth(app);
export const firestore: Firestore = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

// IMPORTANT: Firebase GoogleAuthProvider carries ZERO Google Drive scopes.
export const firebaseAuthProvider = new GoogleAuthProvider();
firebaseAuthProvider.setCustomParameters({
  prompt: 'select_account',
});

// Active isolated test sandbox state (does not touch primary app or CashierPro_DB)
let testApp: FirebaseApp | null = null;
let testAuth: Auth | null = null;
let testFirestore: Firestore | null = null;
let testProjectConfig: FirebaseTestProjectConfig | null = null;

let firebaseStatus: CloudServiceStatus = 'disconnected';
let firebaseUser: FirebaseUserInfo | null = null;
let firebaseError: string | undefined;
let firebaseLastSyncAt: string | undefined;
let isFirebaseSigningIn = false;
let testAuthUnsub: (() => void) | null = null;

const firebaseStateListeners = new Set<(state: FirebaseConnectionState) => void>();

function toFirebaseUserInfo(user: User | null): FirebaseUserInfo | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
  };
}

function getActiveApp(): FirebaseApp {
  return testApp || app;
}

export function getActiveAuth(): Auth {
  return testAuth || auth;
}

export function getActiveFirestore(): Firestore {
  return testFirestore || firestore;
}

export function getActiveFirebaseTarget(): {
  projectId: string;
  firestoreDatabaseId: string;
  isTestProject: boolean;
} {
  if (testProjectConfig && testApp) {
    return {
      projectId: testProjectConfig.projectId,
      firestoreDatabaseId: testProjectConfig.firestoreDatabaseId || '(default)',
      isTestProject: true,
    };
  }
  return {
    projectId: firebaseConfig.projectId || '',
    firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    isTestProject: false,
  };
}

function notifyFirebaseListeners(): void {
  const snapshot = getFirebaseState();
  firebaseStateListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (e) {
      console.error('Firebase state listener error:', e);
    }
  });
}

export function subscribeFirebaseState(
  cb: (state: FirebaseConnectionState) => void
): () => void {
  firebaseStateListeners.add(cb);
  cb(getFirebaseState());
  return () => {
    firebaseStateListeners.delete(cb);
  };
}

export function getFirebaseState(): FirebaseConnectionState {
  const target = getActiveFirebaseTarget();
  return {
    status: firebaseStatus,
    user: firebaseUser ? { ...firebaseUser } : null,
    projectId: target.projectId,
    firestoreDatabaseId: target.firestoreDatabaseId,
    isTestProject: target.isTestProject,
    lastSyncAt: firebaseLastSyncAt,
    error: firebaseError,
  };
}

export function hydrateFirebaseMetadata(metadata: {
  lastSyncAt?: string;
}): void {
  if (metadata.lastSyncAt && !firebaseLastSyncAt) {
    firebaseLastSyncAt = metadata.lastSyncAt;
    notifyFirebaseListeners();
  }
}

export function translateFirebaseError(
  error: unknown,
  fallbackMessage = 'حدث خطأ في الاتصال بـ Firebase'
): string {
  const errObj = error as { code?: string; message?: string } | undefined;
  const code = String(errObj?.code || '').toLowerCase();
  const msg = String(errObj?.message || error || '');
  const lowerMsg = msg.toLowerCase();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'الجهاز غير متصل بالإنترنت حالياً. يعمل التطبيق محلياً وسيستمر حفظ بياناتك في الجهاز.';
  }
  if (code === 'auth/unauthorized-domain' || lowerMsg.includes('unauthorized-domain')) {
    return 'النطاق الحالي غير مصرح به في إعدادات Firebase Authentication (Authorized Domains). يرجى إضافة النطاق في لوحة Firebase.';
  }
  if (code === 'auth/popup-blocked' || lowerMsg.includes('popup-blocked')) {
    return 'تم حظر نافذة تسجيل الدخول المنبثقة. يرجى السماح بالنوافذ المنبثقة لهذا الموقع.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'تم إغلاق نافذة تسجيل الدخول قبل إكمال الربط.';
  }
  if (
    code === 'auth/operation-not-supported-in-this-environment' ||
    lowerMsg.includes('operation-not-supported-in-this-environment')
  ) {
    return 'بيئة WebView الحالية لا تدعم النافذة المنبثقة لتسجيل الدخول (signInWithPopup). يتطلب نظام Android إعداد OAuth Client مخصص وبصمة SHA-1/SHA-256.';
  }
  if (code === 'auth/network-request-failed' || lowerMsg.includes('network-request-failed')) {
    return 'تعذر الاتصال بخوادم المصادقة من Google. تأكد من استقرار الإنترنت.';
  }
  if (
    code === 'permission-denied' ||
    lowerMsg.includes('missing or insufficient permissions') ||
    lowerMsg.includes('permission_denied')
  ) {
    return 'تم رفض الصلاحية في Firestore (Permission Denied). تأكد من تسجيل الدخول بنفس الحساب ومنح صلاحيات القواعد.';
  }
  if (code === 'unauthenticated' || lowerMsg.includes('unauthenticated')) {
    return 'انتهت جلسة المصادقة. يرجى تسجيل الدخول بحساب Google في Firebase مرة أخرى.';
  }
  if (
    code === 'unavailable' ||
    lowerMsg.includes('the client is offline') ||
    lowerMsg.includes('failed to get document because the client is offline')
  ) {
    return 'خدمة Firestore غير متاحة أو الجهاز غير متصل بالإنترنت.';
  }
  if (code === 'not-found' || (lowerMsg.includes('database') && lowerMsg.includes('not found'))) {
    const target = getActiveFirebaseTarget();
    return `قاعدة بيانات Firestore (${target.firestoreDatabaseId}) غير مهيأة أو غير موجودة في المشروع (${target.projectId}).`;
  }
  if (code === 'resource-exhausted') {
    return 'تم تجاوز حصة أو حدود الاستخدام المسموحة في Firestore.';
  }
  if (code === 'invalid-argument' || lowerMsg.includes('exceeds the maximum')) {
    return 'البيانات المرسلة تتجاوز الحد المسموح به في Firestore.';
  }

  return msg && !lowerMsg.startsWith('[object') ? `${fallbackMessage}: ${msg}` : fallbackMessage;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const activeAuth = getActiveAuth();
  const user = activeAuth.currentUser;
  const errMessage = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: errMessage,
    authInfo: {
      userId: user?.uid,
      email: user?.email,
      emailVerified: user?.emailVerified,
      isAnonymous: user?.isAnonymous,
      tenantId: user?.tenantId,
      providerInfo:
        user?.providerData.map((providerItem) => ({
          providerId: providerItem.providerId,
          displayName: providerItem.displayName,
          email: providerItem.email,
          photoUrl: providerItem.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  const friendlyError = new Error(translateFirebaseError(error, 'فشلت عملية Firestore'));
  (friendlyError as Error & { firestoreInfo?: FirestoreErrorInfo }).firestoreInfo = errInfo;
  throw friendlyError;
}

async function teardownTestSandboxApp(): Promise<void> {
  if (testAuthUnsub) {
    try {
      testAuthUnsub();
    } catch {
      // ignore
    }
    testAuthUnsub = null;
  }
  if (testFirestore) {
    await terminate(testFirestore).catch(() => {});
    testFirestore = null;
  }
  if (testApp) {
    await deleteApp(testApp).catch(() => {});
    testApp = null;
  }
  testAuth = null;
}

/**
 * Configures or clears an isolated Firebase Test Project instance for sandbox read/write verification.
 * Does NOT affect CashierPro_DB or Google Drive.
 */
export async function configureTestFirebaseProject(
  config: FirebaseTestProjectConfig | null
): Promise<FirebaseConnectionState> {
  await teardownTestSandboxApp();
  testProjectConfig = null;
  firebaseError = undefined;

  if (!config) {
    const activeUser = auth.currentUser;
    firebaseUser = toFirebaseUserInfo(activeUser);
    firebaseStatus = activeUser ? 'connected' : 'disconnected';
    notifyFirebaseListeners();
    return getFirebaseState();
  }

  if (!config.projectId?.trim() || !config.apiKey?.trim() || !config.appId?.trim()) {
    firebaseStatus = 'error';
    firebaseError = 'إعدادات المشروع الاختباري غير مكتملة (projectId و apiKey و appId مطلوبة).';
    notifyFirebaseListeners();
    throw new Error(firebaseError);
  }

  const normalized: FirebaseTestProjectConfig = {
    projectId: config.projectId.trim(),
    apiKey: config.apiKey.trim(),
    authDomain: (config.authDomain || `${config.projectId.trim()}.firebaseapp.com`).trim(),
    appId: config.appId.trim(),
    firestoreDatabaseId: (config.firestoreDatabaseId || '(default)').trim(),
    storageBucket: config.storageBucket?.trim(),
    messagingSenderId: config.messagingSenderId?.trim(),
  };

  const existingNamed = getApps().find((a) => a.name === TEST_SANDBOX_APP_NAME);
  if (existingNamed) {
    await deleteApp(existingNamed).catch(() => {});
  }

  const firebaseInitPayload: Record<string, string> = {
    projectId: normalized.projectId,
    apiKey: normalized.apiKey,
    authDomain: normalized.authDomain,
    appId: normalized.appId,
  };
  if (normalized.storageBucket) firebaseInitPayload.storageBucket = normalized.storageBucket;
  if (normalized.messagingSenderId) firebaseInitPayload.messagingSenderId = normalized.messagingSenderId;

  testApp = initializeApp(firebaseInitPayload, TEST_SANDBOX_APP_NAME);
  testAuth = getAuth(testApp);
  testFirestore =
    normalized.firestoreDatabaseId && normalized.firestoreDatabaseId !== '(default)'
      ? getFirestore(testApp, normalized.firestoreDatabaseId)
      : getFirestore(testApp);
  testProjectConfig = normalized;

  firebaseUser = toFirebaseUserInfo(testAuth.currentUser);
  firebaseStatus = testAuth.currentUser ? 'connected' : 'disconnected';

  testAuthUnsub = onAuthStateChanged(testAuth, (u) => {
    firebaseUser = toFirebaseUserInfo(u);
    if (!isFirebaseSigningIn) {
      firebaseStatus = u ? 'connected' : 'disconnected';
    }
    notifyFirebaseListeners();
  });

  notifyFirebaseListeners();
  return getFirebaseState();
}

export async function diagnoseFirestoreConnection(): Promise<CloudConnectionDiagnostics> {
  const target = getActiveFirebaseTarget();
  const baseDiag = {
    projectId: target.projectId,
    firestoreDatabaseId: target.firestoreDatabaseId,
    isNativeAndroid: Capacitor.isNativePlatform(),
  };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    firebaseStatus = 'error';
    firebaseError = 'الجهاز غير متصل بالإنترنت.';
    notifyFirebaseListeners();
    return {
      ...baseDiag,
      ok: false,
      status: 'offline',
      message: firebaseError,
    };
  }

  const activeDb = getActiveFirestore();
  const activeAuth = getActiveAuth();

  try {
    await getDocFromServer(doc(activeDb, 'test', 'connection'));
    firebaseLastSyncAt = new Date().toISOString();
    firebaseStatus = 'connected';
    firebaseError = undefined;
    notifyFirebaseListeners();
    return {
      ...baseDiag,
      ok: true,
      status: 'connected',
      message: 'تم التحقق من الاتصال بخادم Firestore بنجاح.',
    };
  } catch (error) {
    const code = String((error as { code?: string })?.code || '').toLowerCase();
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      code === 'unavailable' ||
      msg.includes('the client is offline') ||
      msg.includes('network')
    ) {
      firebaseStatus = 'error';
      firebaseError = 'تعذر الوصول إلى خادم Firestore (الجهاز غير متصل أو الخادم متوقف).';
      notifyFirebaseListeners();
      return {
        ...baseDiag,
        ok: false,
        status: 'offline',
        message: firebaseError,
      };
    }

    if (code === 'not-found' || code === 'invalid-argument' || msg.includes('api key')) {
      firebaseStatus = 'error';
      firebaseError = translateFirebaseError(error, 'خطأ في إعدادات مشروع Firebase');
      notifyFirebaseListeners();
      return {
        ...baseDiag,
        ok: false,
        status: 'config_error',
        message: firebaseError,
      };
    }

    if (code === 'permission-denied' || msg.includes('permission')) {
      if (!activeAuth.currentUser) {
        return {
          ...baseDiag,
          ok: false,
          status: 'unauthenticated',
          message: 'خادم Firestore متاح، لكن يلزم تسجيل الدخول في Firebase أولاً.',
        };
      }
      firebaseLastSyncAt = new Date().toISOString();
      firebaseStatus = 'connected';
      firebaseError = undefined;
      notifyFirebaseListeners();
      return {
        ...baseDiag,
        ok: true,
        status: 'connected',
        message: 'خادم Firestore متاح، لكن وثيقة test/connection مقيدة بقواعد الأمان.',
      };
    }

    firebaseStatus = 'error';
    firebaseError = translateFirebaseError(error, 'تعذر التحقق من اتصال Firestore');
    notifyFirebaseListeners();
    return {
      ...baseDiag,
      ok: false,
      status: 'error',
      message: firebaseError,
    };
  }
}

export async function testFirestoreConnection(): Promise<boolean> {
  const diag = await diagnoseFirestoreConnection();
  return diag.ok || diag.status === 'unauthenticated';
}

/**
 * Isolated Read / Write / Cleanup Diagnostic strictly on a configured Test Project.
 * Refuses to write to the primary production project and NEVER reads CashierPro_DB.
 */
export async function runFirestoreTestProjectDiagnostic(): Promise<FirestoreDiagnosticResult> {
  const startMs = Date.now();
  const target = getActiveFirebaseTarget();

  if (!target.isTestProject || !testProjectConfig || !testFirestore || !testAuth) {
    const errMsg =
      'لحماية البيانات، يتطلب اختبار القراءة والكتابة إدخال وتفعيل إعدادات مشروع Firebase اختباري معزول أولاً.';
    firebaseStatus = 'error';
    firebaseError = errMsg;
    notifyFirebaseListeners();
    return {
      ok: false,
      status: 'error',
      writeOk: false,
      readOk: false,
      cleanupOk: false,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      message: errMsg,
      latencyMs: Date.now() - startMs,
    };
  }

  if (testProjectConfig.projectId === firebaseConfig.projectId) {
    const errMsg =
      'ممنوع تشغيل اختبار الكتابة على نفس معرف المشروع الرئيسي. استخدم projectId لمشروع اختباري معزول.';
    firebaseStatus = 'error';
    firebaseError = errMsg;
    notifyFirebaseListeners();
    return {
      ok: false,
      status: 'error',
      writeOk: false,
      readOk: false,
      cleanupOk: false,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      message: errMsg,
      latencyMs: Date.now() - startMs,
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const errMsg = 'الجهاز غير متصل بالإنترنت.';
    firebaseStatus = 'error';
    firebaseError = errMsg;
    notifyFirebaseListeners();
    return {
      ok: false,
      status: 'error',
      writeOk: false,
      readOk: false,
      cleanupOk: false,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      message: errMsg,
      latencyMs: Date.now() - startMs,
    };
  }

  const user = testAuth.currentUser;
  if (!user) {
    const errMsg = 'يرجى تسجيل الدخول في خدمة Firebase أولاً قبل تشغيل اختبار القراءة والكتابة.';
    firebaseStatus = 'error';
    firebaseError = errMsg;
    notifyFirebaseListeners();
    return {
      ok: false,
      status: 'error',
      writeOk: false,
      readOk: false,
      cleanupOk: false,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      message: errMsg,
      latencyMs: Date.now() - startMs,
    };
  }

  firebaseStatus = 'connecting';
  firebaseError = undefined;
  notifyFirebaseListeners();

  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const docId = `diag_${nonce}`;
  const docPath = `p27_diagnostics/${user.uid}/probes/${docId}`;
  const probeRef = doc(testFirestore, 'p27_diagnostics', user.uid, 'probes', docId);

  let writeOk = false;
  let readOk = false;
  let cleanupOk = false;

  try {
    await setDoc(probeRef, {
      kind: 'p27_connection_probe',
      uid: user.uid,
      nonce,
      createdAt: new Date().toISOString(),
    });
    writeOk = true;

    const snap = await getDocFromServer(probeRef);
    readOk = snap.exists() && snap.data()?.nonce === nonce;
    if (!readOk) {
      throw new Error('تمت الكتابة لكن لم تتطابق نتيجة القراءة من خادم Firestore.');
    }

    await deleteDoc(probeRef);
    cleanupOk = true;

    firebaseLastSyncAt = new Date().toISOString();
    firebaseStatus = 'connected';
    firebaseError = undefined;
    notifyFirebaseListeners();

    return {
      ok: true,
      status: 'connected',
      writeOk,
      readOk,
      cleanupOk,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      docPath,
      message: 'نجح اختبار الكتابة والقراءة والتنظيف على المشروع الاختباري المعزول.',
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    const errMsg = translateFirebaseError(err, 'فشل اختبار القراءة والكتابة على المشروع الاختباري');
    firebaseStatus = 'error';
    firebaseError = errMsg;
    notifyFirebaseListeners();
    return {
      ok: false,
      status: 'error',
      writeOk,
      readOk,
      cleanupOk,
      projectId: target.projectId,
      firestoreDatabaseId: target.firestoreDatabaseId,
      docPath,
      message: errMsg,
      latencyMs: Date.now() - startMs,
    };
  }
}

export const initFirebaseAuth = (
  onAuthSuccess?: (user: User) => void,
  onAuthFailure?: () => void
) => {
  const activeAuth = getActiveAuth();
  return onAuthStateChanged(activeAuth, (user: User | null) => {
    firebaseUser = toFirebaseUserInfo(user);
    if (user) {
      if (!isFirebaseSigningIn) {
        firebaseStatus = 'connected';
        firebaseError = undefined;
      }
      notifyFirebaseListeners();
      if (onAuthSuccess) onAuthSuccess(user);
    } else {
      if (!isFirebaseSigningIn && firebaseStatus !== 'error') {
        firebaseStatus = 'disconnected';
      }
      notifyFirebaseListeners();
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/**
 * Independent Firebase Authentication using Google Sign-In.
 * Requests ONLY Firebase Authentication identity (NO Google Drive scopes, NO Drive tokens).
 */
export const connectFirebaseWithGoogle = async (): Promise<FirebaseConnectionState> => {
  if (isFirebaseSigningIn) {
    throw new Error('عملية تسجيل الدخول إلى Firebase قيد التنفيذ بالفعل، يرجى الانتظار.');
  }

  isFirebaseSigningIn = true;
  firebaseStatus = 'connecting';
  firebaseError = undefined;
  notifyFirebaseListeners();

  const activeAuth = getActiveAuth();
  const activeDb = getActiveFirestore();
  const target = getActiveFirebaseTarget();

  try {
    const result = await signInWithPopup(activeAuth, firebaseAuthProvider);
    firebaseUser = toFirebaseUserInfo(result.user);

    // Sync profile metadata only when connected to non-production or authenticated user doc
    if (result.user && target.isTestProject) {
      try {
        await setDoc(
          doc(activeDb, 'users', result.user.uid),
          {
            userId: result.user.uid,
            email: (result.user.email || '').slice(0, 150),
            displayName: (result.user.displayName || '').slice(0, 150),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (err) {
        console.warn('Could not sync test profile to Firestore:', err);
      }
    }

    firebaseLastSyncAt = new Date().toISOString();
    firebaseStatus = 'connected';
    firebaseError = undefined;
    notifyFirebaseListeners();
    return getFirebaseState();
  } catch (error) {
    console.error('Firebase Google Sign-In Error:', error);
    const msg = translateFirebaseError(error, 'فشل تسجيل الدخول إلى Firebase');
    firebaseStatus = 'error';
    firebaseError = msg;
    notifyFirebaseListeners();
    throw new Error(msg);
  } finally {
    isFirebaseSigningIn = false;
  }
};

/**
 * Independent Firebase disconnect.
 * Signs out ONLY from Firebase Auth and resets Firebase state.
 * Never deletes local CashierPro_DB data and never touches Google Drive connection.
 */
export const disconnectFirebase = async (): Promise<FirebaseConnectionState> => {
  const activeAuth = getActiveAuth();
  try {
    await signOut(activeAuth);
  } catch {
    // ignore signOut errors during cleanup
  }
  if (testApp) {
    await teardownTestSandboxApp();
    testProjectConfig = null;
  }
  firebaseUser = null;
  firebaseError = undefined;
  firebaseLastSyncAt = undefined;
  firebaseStatus = 'disconnected';
  notifyFirebaseListeners();
  return getFirebaseState();
};

export const getCurrentFirebaseUser = (): User | null => {
  return getActiveAuth().currentUser;
};

// ==========================================
// Cloud Firestore Backup Operations (Manual/On-Demand Only, Zero Auto-Sync)
// ==========================================

export interface FirestoreBackupItem {
  id: string;
  fileName: string;
  createdAt: string;
  totalProducts?: number;
  totalInvoices?: number;
}

export async function saveBackupToFirestore(
  userId: string,
  dataJson: string,
  summary?: { productsCount?: number; invoicesCount?: number; customName?: string }
): Promise<string> {
  if (!userId) {
    throw new Error('يرجى تسجيل الدخول في Firebase أولاً قبل الحفظ في Firestore.');
  }
  if (!dataJson || !dataJson.trim()) {
    throw new Error('بيانات النسخة الاحتياطية فارغة ولا يمكن حفظها.');
  }

  const byteSize = new TextEncoder().encode(dataJson).length;
  if (byteSize > FIRESTORE_MAX_DOC_JSON_BYTES || dataJson.length > 1048576) {
    throw new Error(
      `حجم النسخة الاحتياطية (${Math.round(byteSize / 1024)} KB) يتجاوز الحد الأقصى المسموح لمستند Firestore (1 MB). استخدم التصدير المحلي (.json) أو Google Drive.`
    );
  }

  const activeDb = getActiveFirestore();
  const backupId = `backup_${Date.now()}`;
  const path = `users/${userId}/backups/${backupId}`;
  const dateStr = new Date().toISOString();
  const docRef = doc(activeDb, 'users', userId, 'backups', backupId);
  const fileName = (summary?.customName || generateBackupFileName('autoSave')).slice(0, 150);

  try {
    await setDoc(docRef, {
      id: backupId,
      userId,
      fileName,
      createdAt: dateStr,
      dataJson,
      totalProducts: Number(summary?.productsCount) || 0,
      totalInvoices: Number(summary?.invoicesCount) || 0,
    });
    firebaseLastSyncAt = dateStr;
    notifyFirebaseListeners();
    return backupId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listFirestoreBackups(userId: string): Promise<FirestoreBackupItem[]> {
  if (!userId) return [];
  const activeDb = getActiveFirestore();
  const path = `users/${userId}/backups`;
  try {
    const q = query(
      collection(activeDb, 'users', userId, 'backups'),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);
    const items: FirestoreBackupItem[] = [];
    snap.forEach((d) => {
      const data = d.data();
      items.push({
        id: d.id,
        fileName: data.fileName || d.id,
        createdAt: data.createdAt || '',
        totalProducts: data.totalProducts,
        totalInvoices: data.totalInvoices,
      });
    });
    return items;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function loadBackupFromFirestore(userId: string, backupId: string): Promise<string> {
  const activeDb = getActiveFirestore();
  const path = `users/${userId}/backups/${backupId}`;
  try {
    const docRef = doc(activeDb, 'users', userId, 'backups', backupId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      throw new Error('ملف النسخة الاحتياطية غير موجود في Firestore');
    }
    return snap.data()?.dataJson || '';
  } catch (err) {
    if (err instanceof Error && err.message.includes('غير موجود')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function deleteBackupFromFirestore(userId: string, backupId: string): Promise<void> {
  const activeDb = getActiveFirestore();
  const path = `users/${userId}/backups/${backupId}`;
  try {
    const docRef = doc(activeDb, 'users', userId, 'backups', backupId);
    await deleteDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
