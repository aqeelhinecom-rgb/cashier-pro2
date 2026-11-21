import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import type { PluginListenerHandle } from '@capacitor/core';
import firebaseConfig from '../../../firebase-applet-config.json';
import { generateBackupFileName } from '../dbFormat';
import { computeBytesSha256 } from './sha256';
import type {
  CloudServiceStatus,
  DriveAccountInfo,
  DriveBackupVerificationResult,
  DriveFileItem,
  DriveFileKind,
  GoogleDriveConnectionState,
} from './types';

export type {
  DriveAccountInfo,
  DriveBackupVerificationResult,
  DriveFileItem,
  DriveFileKind,
  GoogleDriveConnectionState,
};

/**
 * Least-privilege Google Drive OAuth2 scopes requested EXCLUSIVELY by Google Drive service.
 * Never shared with Firebase Auth or Firestore.
 */
export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;

const DRIVE_TOKEN_SAFETY_MARGIN_MS = 60 * 1000; // Refresh 60s before Google expiry
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000; // 55m fallback if expires_in absent
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const GOOGLE_OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CAPACITOR_OAUTH_REDIRECT_URI =
  'https://aqeelhinecom-rgb.github.io/cashier-pro1/oauth-callback.html';
export const CAPACITOR_OAUTH_CALLBACK_PREFIX = 'cashierpro://oauth';
const CAPACITOR_OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
const CAPACITOR_BROWSER_CLOSE_GRACE_MS = 1200;

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GoogleIdentityGlobal {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: GisTokenResponse) => void;
        error_callback?: (err: { type?: string; message?: string }) => void;
      }) => GisTokenClient;
      revoke: (token: string, done?: () => void) => void;
    };
  };
}

export type DriveOAuthRequester = (params: {
  clientId: string;
  scopes: string[];
  prompt: string;
}) => Promise<{ accessToken: string; expiresInSec?: number; grantedScopes?: string }>;

// Strictly In-Memory Token & Session State (NEVER stored in localStorage, sessionStorage, or Dexie)
let cachedDriveAccessToken: string | null = null;
let cachedDriveTokenExpiresAt: number | null = null;
let driveAccount: DriveAccountInfo | null = null;
let driveStatus: CloudServiceStatus = 'disconnected';
let driveError: string | undefined;
let driveLastBackupAt: string | undefined;
let isDriveConnecting = false;

let customOAuthRequesterForTests: DriveOAuthRequester | null = null;
let customFetchForTests: typeof fetch | null = null;
let gisScriptPromise: Promise<void> | null = null;

const stateListeners = new Set<(state: GoogleDriveConnectionState) => void>();

function notifyDriveListeners(): void {
  const snapshot = getGoogleDriveState();
  stateListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (e) {
      console.error('Drive state listener error:', e);
    }
  });
}

function getFetchImpl(): typeof fetch {
  return customFetchForTests || fetch;
}

export function setDriveTestOverrides(overrides: {
  oauthRequester?: DriveOAuthRequester | null;
  fetchImpl?: typeof fetch | null;
} | null): void {
  if (!overrides) {
    customOAuthRequesterForTests = null;
    customFetchForTests = null;
    return;
  }
  if (overrides.oauthRequester !== undefined) {
    customOAuthRequesterForTests = overrides.oauthRequester;
  }
  if (overrides.fetchImpl !== undefined) {
    customFetchForTests = overrides.fetchImpl;
  }
}

export function subscribeGoogleDriveState(
  cb: (state: GoogleDriveConnectionState) => void
): () => void {
  stateListeners.add(cb);
  cb(getGoogleDriveState());
  return () => {
    stateListeners.delete(cb);
  };
}

export function getGoogleDriveState(): GoogleDriveConnectionState {
  const tokenValid = hasValidDriveToken();
  return {
    status: driveStatus,
    account: driveAccount ? { ...driveAccount } : null,
    tokenValid,
    lastBackupAt: driveLastBackupAt,
    error: driveError,
  };
}

export function hasValidDriveToken(): boolean {
  if (!cachedDriveAccessToken || !cachedDriveTokenExpiresAt) return false;
  if (Date.now() >= cachedDriveTokenExpiresAt - DRIVE_TOKEN_SAFETY_MARGIN_MS) {
    clearDriveToken();
    return false;
  }
  return true;
}

export function clearDriveToken(): void {
  cachedDriveAccessToken = null;
  cachedDriveTokenExpiresAt = null;
  if (driveStatus === 'connected') {
    driveStatus = 'disconnected';
  }
  notifyDriveListeners();
}

export function hydrateDriveMetadata(metadata: {
  email?: string;
  lastBackupAt?: string;
}): void {
  if (metadata.lastBackupAt && !driveLastBackupAt) {
    driveLastBackupAt = metadata.lastBackupAt;
  }
  if (metadata.email && !driveAccount) {
    driveAccount = { email: metadata.email };
  }
  notifyDriveListeners();
}

export function translateDriveError(
  error: unknown,
  fallbackMessage = 'تعذر الاتصال بخدمة Google Drive'
): string {
  const errObj = error as { type?: string; code?: string; message?: string } | undefined;
  const type = String(errObj?.type || errObj?.code || '').toLowerCase();
  const msg = String(errObj?.message || error || '');
  const lower = msg.toLowerCase();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'الجهاز غير متصل بالإنترنت حالياً. يبقى العمل المحلي متاحاً دون انقطاع.';
  }
  if (type === 'popup_closed' || lower.includes('popup_closed') || lower.includes('closed')) {
    return 'تم إغلاق نافذة تسجيل دخول Google Drive قبل منح الصلاحية.';
  }
  if (type === 'popup_failed_to_open' || lower.includes('popup_failed') || lower.includes('popup')) {
    return Capacitor.isNativePlatform()
      ? 'تعذر فتح متصفح تسجيل دخول Google Drive على الجهاز. تأكد من وجود متصفح Chrome وتحديثه.'
      : 'تم حظر النافذة المنبثقة لتسجيل دخول Google Drive. يرجى السماح بالنوافذ المنبثقة.';
  }
  if (lower.includes('access_denied') || lower.includes('consent')) {
    return 'تم رفض منح صلاحيات الوصول إلى Google Drive.';
  }
  if (lower.includes('origin_mismatch') || lower.includes('redirect_uri_mismatch')) {
    return Capacitor.isNativePlatform()
      ? `رابط إعادة التوجيه (${CAPACITOR_OAUTH_REDIRECT_URI}) غير مضاف في Authorized redirect URIs ضمن إعدادات Google Cloud OAuth.`
      : 'النطاق الحالي غير مضاف في Authorized JavaScript Origins ضمن إعدادات Google Cloud OAuth.';
  }
  if (lower.includes('client_id') || lower.includes('invalid_client')) {
    return 'معرّف عميل OAuth الخاص بـ Google Drive غير مهيأ أو غير صالح.';
  }
  return msg && !lower.startsWith('[object') ? `${fallbackMessage}: ${msg}` : fallbackMessage;
}

async function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('بيئة المتصفح غير متاحة لتحميل تسجيل دخول Google Drive.');
  }
  const googleGlobal = (window as unknown as { google?: GoogleIdentityGlobal }).google;
  if (googleGlobal?.accounts?.oauth2?.initTokenClient) {
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('الجهاز غير متصل بالإنترنت لتشغيل مصادقة Google Drive.');
  }

  if (!gisScriptPromise) {
    gisScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${GIS_SCRIPT_URL}"]`
      );
      if (existing) {
        if ((window as unknown as { google?: GoogleIdentityGlobal }).google?.accounts?.oauth2) {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => {
            gisScriptPromise = null;
            reject(new Error('تعذر تحميل مكتبة Google Identity Services من Google.'));
          },
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisScriptPromise = null;
        reject(new Error('تعذر تحميل مكتبة Google Identity Services. تحقق من الإنترنت.'));
      };
      document.head.appendChild(script);
    });
  }

  return gisScriptPromise;
}

async function requestDriveTokenViaGis(params: {
  clientId: string;
  scopes: string[];
  prompt: string;
}): Promise<{ accessToken: string; expiresInSec?: number; grantedScopes?: string }> {
  await loadGisScript();
  const googleGlobal = (window as unknown as { google?: GoogleIdentityGlobal }).google;
  const initTokenClient = googleGlobal?.accounts?.oauth2?.initTokenClient;
  if (!initTokenClient) {
    throw new Error('واجهة Google Identity OAuth2 غير متاحة في المتصفح.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const tokenClient = initTokenClient({
      client_id: params.clientId,
      scope: params.scopes.join(' '),
      callback: (resp: GisTokenResponse) => {
        if (settled) return;
        settled = true;
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error_description || resp.error || 'لم يتم استلام رمز وصول Google Drive.'));
          return;
        }
        resolve({
          accessToken: resp.access_token,
          expiresInSec: resp.expires_in ? Number(resp.expires_in) : undefined,
          grantedScopes: resp.scope,
        });
      },
      error_callback: (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    });

    tokenClient.requestAccessToken({ prompt: params.prompt });
  });
}

function generateOAuthState(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function buildCapacitorOAuthUrl(params: {
  clientId: string;
  scopes: string[];
  prompt: string;
  state: string;
  redirectUri?: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri || CAPACITOR_OAUTH_REDIRECT_URI,
    response_type: 'token',
    scope: params.scopes.join(' '),
    include_granted_scopes: 'true',
    state: params.state,
  });
  if (params.prompt) {
    query.set('prompt', params.prompt);
  }
  return `${GOOGLE_OAUTH_AUTH_ENDPOINT}?${query.toString()}`;
}

export function parseCapacitorOAuthCallbackUrl(
  callbackUrl: string,
  expectedState?: string
): { accessToken: string; expiresInSec?: number; grantedScopes?: string } | null {
  const trimmed = String(callbackUrl || '').trim();
  if (!trimmed.toLowerCase().startsWith(CAPACITOR_OAUTH_CALLBACK_PREFIX)) {
    return null;
  }

  const hashIdx = trimmed.indexOf('#');
  const queryIdx = trimmed.indexOf('?');
  const hashPart = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
  const queryPart =
    queryIdx >= 0
      ? trimmed.slice(queryIdx + 1, hashIdx >= 0 && hashIdx > queryIdx ? hashIdx : undefined)
      : '';

  const hashParams = new URLSearchParams(hashPart);
  const queryParams = new URLSearchParams(queryPart);
  const getParam = (key: string): string => hashParams.get(key) || queryParams.get(key) || '';

  const returnedState = getParam('state');
  if (expectedState && returnedState !== expectedState) {
    throw new Error('فشل التحقق من أمان جلسة تسجيل الدخول (تعارض state). يرجى إعادة المحاولة.');
  }

  const errorCode = getParam('error');
  const errorDesc = getParam('error_description');
  if (errorCode) {
    throw new Error(errorDesc || errorCode);
  }

  const accessToken = getParam('access_token');
  if (!accessToken) {
    throw new Error('لم يتم استلام رمز وصول Google Drive من رابط العودة.');
  }

  const expiresRaw = getParam('expires_in');
  const parsedExpires = expiresRaw ? Number(expiresRaw) : NaN;
  const expiresInSec = Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : undefined;
  const grantedScopes = getParam('scope') || undefined;

  return { accessToken, expiresInSec, grantedScopes };
}

async function requestDriveTokenViaCapacitorBrowser(params: {
  clientId: string;
  scopes: string[];
  prompt: string;
}): Promise<{ accessToken: string; expiresInSec?: number; grantedScopes?: string }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('الجهاز غير متصل بالإنترنت لتشغيل مصادقة Google Drive.');
  }

  const expectedState = generateOAuthState();
  const authUrl = buildCapacitorOAuthUrl({
    clientId: params.clientId,
    scopes: params.scopes,
    prompt: params.prompt,
    state: expectedState,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let appUrlHandle: PluginListenerHandle | null = null;
    let browserFinishedHandle: PluginListenerHandle | null = null;
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (appUrlHandle) {
        appUrlHandle.remove().catch(() => {});
        appUrlHandle = null;
      }
      if (browserFinishedHandle) {
        browserFinishedHandle.remove().catch(() => {});
        browserFinishedHandle = null;
      }
    };

    const finishSuccess = (result: {
      accessToken: string;
      expiresInSec?: number;
      grantedScopes?: string;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      Browser.close().catch(() => {});
      resolve(result);
    };

    const finishError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      Browser.close().catch(() => {});
      reject(err);
    };

    timeoutTimer = setTimeout(() => {
      finishError(new Error('انتهت مهلة انتظار تسجيل دخول Google Drive. يرجى المحاولة مجدداً.'));
    }, CAPACITOR_OAUTH_TIMEOUT_MS);

    (async () => {
      try {
        appUrlHandle = await App.addListener('appUrlOpen', (event) => {
          if (settled || !event?.url) return;
          try {
            const parsed = parseCapacitorOAuthCallbackUrl(event.url, expectedState);
            if (!parsed) return; // Unrelated deep link; ignore
            finishSuccess(parsed);
          } catch (parseErr) {
            finishError(parseErr);
          }
        });

        browserFinishedHandle = await Browser.addListener('browserFinished', () => {
          if (settled || closeGraceTimer) return;
          // Allow a brief grace window for appUrlOpen intent to arrive as Chrome Custom Tab closes
          closeGraceTimer = setTimeout(() => {
            if (!settled) {
              finishError({
                type: 'popup_closed',
                message: 'تم إغلاق نافذة تسجيل دخول Google Drive قبل منح الصلاحية.',
              });
            }
          }, CAPACITOR_BROWSER_CLOSE_GRACE_MS);
        });

        await Browser.open({ url: authUrl });
      } catch (openErr) {
        finishError(openErr);
      }
    })();
  });
}

async function fetchGoogleUserProfile(token: string): Promise<DriveAccountInfo | null> {
  try {
    const res = await getFetchImpl()('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.email) return null;
    return {
      email: String(data.email),
      name: data.name ? String(data.name) : undefined,
      picture: data.picture ? String(data.picture) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Independent Google Drive OAuth2 sign-in & permission grant.
 * Does NOT sign into Firebase Auth and does NOT share tokens with Firebase.
 */
export async function connectGoogleDrive(options?: {
  prompt?: 'consent' | 'select_account' | '';
  clientId?: string;
}): Promise<GoogleDriveConnectionState> {
  if (isDriveConnecting) {
    throw new Error('عملية ربط Google Drive قيد التنفيذ بالفعل.');
  }

  const clientId = (options?.clientId || firebaseConfig.oAuthClientId || '').trim();
  if (!clientId) {
    driveStatus = 'error';
    driveError = 'معرّف عميل OAuth غير متوفر في إعدادات التطبيق.';
    notifyDriveListeners();
    throw new Error(driveError);
  }

  isDriveConnecting = true;
  driveStatus = 'connecting';
  driveError = undefined;
  notifyDriveListeners();

  try {
    const requester =
      customOAuthRequesterForTests ||
      (Capacitor.isNativePlatform()
        ? requestDriveTokenViaCapacitorBrowser
        : requestDriveTokenViaGis);
    const tokenResult = await requester({
      clientId,
      scopes: [...GOOGLE_DRIVE_SCOPES],
      prompt: options?.prompt ?? 'select_account',
    });

    if (!tokenResult?.accessToken) {
      throw new Error('فشل الحصول على رمز وصول مستقل لـ Google Drive.');
    }

    const ttlMs =
      tokenResult.expiresInSec && tokenResult.expiresInSec > 0
        ? tokenResult.expiresInSec * 1000
        : DEFAULT_TOKEN_TTL_MS;

    cachedDriveAccessToken = tokenResult.accessToken;
    cachedDriveTokenExpiresAt = Date.now() + ttlMs;

    const profile = await fetchGoogleUserProfile(tokenResult.accessToken);
    if (profile) {
      driveAccount = profile;
    } else if (!driveAccount) {
      driveAccount = { email: 'حساب Google Drive متصل' };
    }

    driveStatus = 'connected';
    driveError = undefined;
    notifyDriveListeners();
    return getGoogleDriveState();
  } catch (err) {
    clearDriveToken();
    driveStatus = 'error';
    driveError = translateDriveError(err);
    notifyDriveListeners();
    throw new Error(driveError);
  } finally {
    isDriveConnecting = false;
  }
}

/**
 * Independent Google Drive disconnect.
 * Revokes Drive token and clears Drive session WITHOUT touching Firebase Auth, Firestore, or CashierPro_DB.
 */
export async function disconnectGoogleDrive(): Promise<GoogleDriveConnectionState> {
  const tokenToRevoke = cachedDriveAccessToken;
  cachedDriveAccessToken = null;
  cachedDriveTokenExpiresAt = null;
  driveAccount = null;
  driveError = undefined;
  driveLastBackupAt = undefined;
  driveStatus = 'disconnected';

  if (tokenToRevoke && typeof window !== 'undefined') {
    try {
      const revokeFn = (window as unknown as { google?: GoogleIdentityGlobal }).google?.accounts
        ?.oauth2?.revoke;
      if (revokeFn) {
        await new Promise<void>((resolve) => {
          try {
            revokeFn(tokenToRevoke, () => resolve());
            setTimeout(resolve, 400);
          } catch {
            resolve();
          }
        });
      } else {
        await getFetchImpl()(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          }
        ).catch(() => {});
      }
    } catch {
      // Best-effort revocation only
    }
  }

  notifyDriveListeners();
  return getGoogleDriveState();
}

export async function getDriveAccessToken(): Promise<string | null> {
  return hasValidDriveToken() ? cachedDriveAccessToken : null;
}

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const DRIVE_FILE_FIELDS =
  'id,name,mimeType,createdTime,size,parents,md5Checksum,appProperties,capabilities';

export function classifyDriveFileKind(file: {
  name?: string;
  mimeType?: string;
}): DriveFileKind {
  const mime = String(file.mimeType || '').toLowerCase().trim();
  const lowerName = String(file.name || '').toLowerCase().trim();

  if (mime === DRIVE_FOLDER_MIME) {
    return 'folder';
  }
  if (mime.startsWith(DRIVE_GOOGLE_APPS_PREFIX)) {
    return 'google_docs_editor';
  }
  if (
    lowerName.endsWith('.db') ||
    lowerName.endsWith('.sqlite') ||
    lowerName.endsWith('.sqlite3') ||
    mime.includes('sqlite')
  ) {
    return 'sqlite';
  }
  if (
    lowerName.endsWith('.json') ||
    mime === 'application/json' ||
    mime === 'text/json'
  ) {
    return 'json';
  }
  if (mime === 'application/octet-stream' || mime.startsWith('application/')) {
    return 'binary_other';
  }
  return 'unknown';
}

export function parseGoogleDriveErrorBody(errorText: string): {
  reason?: string;
  rawMessage?: string;
} {
  const trimmed = String(errorText || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    const errNode = parsed?.error;
    if (errNode && typeof errNode === 'object') {
      const firstErr = Array.isArray(errNode.errors) ? errNode.errors[0] : undefined;
      return {
        reason: firstErr?.reason ? String(firstErr.reason) : undefined,
        rawMessage: errNode.message ? String(errNode.message) : trimmed,
      };
    }
  } catch {
    // Plain text error body
  }
  return { rawMessage: trimmed };
}

export class DriveDownloadDetailedError extends Error {
  httpStatus: number;
  driveErrorReason?: string;
  driveRawErrorMessage?: string;
  fileMeta?: DriveFileItem;
  downloadMethod: 'alt_media' | 'files_export' | 'rejected';

  constructor(params: {
    message: string;
    httpStatus: number;
    driveErrorReason?: string;
    driveRawErrorMessage?: string;
    fileMeta?: DriveFileItem;
    downloadMethod: 'alt_media' | 'files_export' | 'rejected';
  }) {
    super(params.message);
    this.name = 'DriveDownloadDetailedError';
    this.httpStatus = params.httpStatus;
    this.driveErrorReason = params.driveErrorReason;
    this.driveRawErrorMessage = params.driveRawErrorMessage;
    this.fileMeta = params.fileMeta;
    this.downloadMethod = params.downloadMethod;
  }
}

async function handleDriveApiError(
  res: Response,
  fallbackMsg: string,
  options?: {
    fileMeta?: DriveFileItem;
    downloadMethod?: 'alt_media' | 'files_export' | 'rejected';
    isFileOperation?: boolean;
  }
): Promise<never> {
  const errorText = await res.text().catch(() => '');
  const lower = errorText.toLowerCase();
  const { reason, rawMessage } = parseGoogleDriveErrorBody(errorText);
  const lowerReason = String(reason || '').toLowerCase();
  const downloadMethod = options?.downloadMethod || 'rejected';

  if (res.status === 401) {
    cachedDriveAccessToken = null;
    cachedDriveTokenExpiresAt = null;
    driveStatus = 'error';
    driveError = 'انتهت صلاحية رمز Google Drive (401). أعد تسجيل الدخول إلى Google Drive لتجديد الإذن.';
    notifyDriveListeners();
    throw new DriveDownloadDetailedError({
      message: driveError,
      httpStatus: 401,
      driveErrorReason: reason || 'authError',
      driveRawErrorMessage: rawMessage || errorText,
      fileMeta: options?.fileMeta,
      downloadMethod,
    });
  }

  if (res.status === 403) {
    if (
      lowerReason === 'accessnotconfigured' ||
      lower.includes('accessnotconfigured') ||
      lower.includes('drive.googleapis.com')
    ) {
      driveStatus = 'error';
      driveError = 'خدمة Google Drive API غير مفعلة في مشروع Google Cloud Console المرتبط.';
      notifyDriveListeners();
      throw new DriveDownloadDetailedError({
        message: driveError,
        httpStatus: 403,
        driveErrorReason: reason || 'accessNotConfigured',
        driveRawErrorMessage: rawMessage || errorText,
        fileMeta: options?.fileMeta,
        downloadMethod,
      });
    }

    const isTokenScopeError =
      lowerReason === 'insufficientpermissions' ||
      lowerReason === 'insufficientauthenticationscopes' ||
      lower.includes('insufficient authentication scopes') ||
      lower.includes('insufficient scope') ||
      (!options?.isFileOperation && (lower.includes('insufficient') || lower.includes('scope')));

    if (isTokenScopeError) {
      cachedDriveAccessToken = null;
      cachedDriveTokenExpiresAt = null;
      driveStatus = 'error';
      driveError = 'لم يتم منح صلاحية الوصول إلى Google Drive. أعد ربط Google Drive ووافق على الإذن.';
      notifyDriveListeners();
      throw new DriveDownloadDetailedError({
        message: driveError,
        httpStatus: 403,
        driveErrorReason: reason || 'insufficientPermissions',
        driveRawErrorMessage: rawMessage || errorText,
        fileMeta: options?.fileMeta,
        downloadMethod,
      });
    }

    // File-level 403: keep Drive connection alive and explain exact reason
    if (options?.isFileOperation) {
      let friendlyMsg = `رفض Google Drive تنزيل هذا الملف (HTTP 403${reason ? ` · ${reason}` : ''})`;
      if (
        lowerReason === 'appnotauthorizedtofile' ||
        lowerReason === 'insufficientfilepermissions' ||
        lowerReason === 'notauthorizedforfile'
      ) {
        friendlyMsg = `رفض Google Drive الوصول إلى هذا الملف (HTTP 403 · ${reason}): بنطاق الصلاحيات المقيّد (drive.file)، يمكن للتطبيق تنزيل الملفات التي أُنشئت أو فُتحت عبر نفس التطبيق وعميل OAuth الحالي فقط.`;
      } else if (lowerReason === 'filenotdownloadable') {
        friendlyMsg = `هذا العنصر في Google Drive غير قابل للتنزيل المباشر عبر alt=media (HTTP 403 · fileNotDownloadable).`;
      } else if (lowerReason === 'cannotdownloadfile' || lowerReason === 'cannotdownloadabusivefile') {
        friendlyMsg = `صلاحيات هذا الملف في Google Drive تمنع التنزيل (HTTP 403 · ${reason}).`;
      }

      throw new DriveDownloadDetailedError({
        message: friendlyMsg,
        httpStatus: 403,
        driveErrorReason: reason || 'forbidden',
        driveRawErrorMessage: rawMessage || errorText,
        fileMeta: options?.fileMeta,
        downloadMethod,
      });
    }

    driveStatus = 'error';
    driveError = `تم رفض الوصول إلى Google Drive (403): ${rawMessage || errorText || fallbackMsg}`;
    notifyDriveListeners();
    throw new DriveDownloadDetailedError({
      message: driveError,
      httpStatus: 403,
      driveErrorReason: reason || 'forbidden',
      driveRawErrorMessage: rawMessage || errorText,
      fileMeta: options?.fileMeta,
      downloadMethod,
    });
  }

  const msg = `${fallbackMsg} (HTTP ${res.status})${rawMessage ? `: ${rawMessage}` : ''}`;
  if (!options?.isFileOperation) {
    driveStatus = 'error';
    driveError = msg;
    notifyDriveListeners();
  }
  throw new DriveDownloadDetailedError({
    message: msg,
    httpStatus: res.status,
    driveErrorReason: reason,
    driveRawErrorMessage: rawMessage || errorText,
    fileMeta: options?.fileMeta,
    downloadMethod,
  });
}

async function getOrCreateDriveBackupFolder(token: string): Promise<string | null> {
  const fetchFn = getFetchImpl();
  const q = "mimeType='application/vnd.google-apps.folder' and name='Cashier_Backups' and trashed=false";
  const res = await fetchFn(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    await handleDriveApiError(res, 'تعذر البحث عن مجلد النسخ الاحتياطية في Google Drive');
  }
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await fetchFn('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Cashier_Backups',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!createRes.ok) {
    await handleDriveApiError(createRes, 'تعذر إنشاء مجلد Cashier_Backups في Google Drive');
  }
  const folderData = await createRes.json();
  return folderData.id;
}

export async function uploadBackupToGoogleDrive(
  data: string | Uint8Array,
  customName?: string
): Promise<{ id: string; name: string; uploadedAt: string; sha256: string }> {
  if (!hasValidDriveToken() || !cachedDriveAccessToken) {
    throw new Error(
      'خدمة Google Drive غير متصلة أو انتهت صلاحية الرمز. اضغط "تسجيل الدخول إلى Google Drive" ثم أعد المحاولة.'
    );
  }
  const token = cachedDriveAccessToken;
  const folderId = await getOrCreateDriveBackupFolder(token);
  const fileName = customName || generateBackupFileName('autoSave');
  const isBinary = data instanceof Uint8Array;
  const mimeType = isBinary ? 'application/x-sqlite3' : 'application/json';

  const rawBytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const sha256Hex = await computeBytesSha256(rawBytes);

  const metadata: {
    name: string;
    mimeType: string;
    parents?: string[];
    appProperties?: Record<string, string>;
  } = {
    name: fileName,
    mimeType,
    appProperties: {
      cashierSha256: sha256Hex,
      cashierFormat: isBinary ? 'sqlite3' : 'json',
    },
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const metaPart = new TextEncoder().encode(
    delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      `Content-Type: ${mimeType}\r\n\r\n`
  );
  const dataBytes: BlobPart =
    typeof data === 'string'
      ? data
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const endPart = new TextEncoder().encode(closeDelim);

  const combinedBody = new Blob([
    metaPart.buffer as ArrayBuffer,
    dataBytes,
    endPart.buffer as ArrayBuffer,
  ]);

  const res = await getFetchImpl()(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime,md5Checksum,appProperties',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: combinedBody,
    }
  );

  if (!res.ok) {
    await handleDriveApiError(res, 'فشل رفع النسخة الاحتياطية على Google Drive');
  }

  const uploaded = await res.json();
  const uploadedAt = new Date().toISOString();
  driveLastBackupAt = uploadedAt;
  driveStatus = 'connected';
  driveError = undefined;
  notifyDriveListeners();
  return { ...uploaded, uploadedAt, sha256: sha256Hex };
}

export async function fetchDriveFileMetadata(
  fileId: string,
  knownMeta?: DriveFileItem
): Promise<DriveFileItem> {
  if (!hasValidDriveToken() || !cachedDriveAccessToken) {
    throw new Error('انتهت صلاحية جلسة Google Drive. يرجى تسجيل الدخول إلى Google Drive أولاً.');
  }

  const res = await getFetchImpl()(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`,
    {
      headers: { Authorization: `Bearer ${cachedDriveAccessToken}` },
    }
  );

  if (!res.ok) {
    await handleDriveApiError(res, 'تعذر جلب بيانات تعريف الملف من Google Drive', {
      fileMeta: knownMeta,
      downloadMethod: 'rejected',
      isFileOperation: true,
    });
  }

  const raw = (await res.json()) as DriveFileItem;
  return {
    ...raw,
    kind: classifyDriveFileKind(raw),
  };
}

export async function listGoogleDriveBackups(): Promise<DriveFileItem[]> {
  if (!hasValidDriveToken() || !cachedDriveAccessToken) {
    return [];
  }
  const token = cachedDriveAccessToken;
  const q =
    `mimeType != '${DRIVE_FOLDER_MIME}' and ` +
    "(name contains 'data' or name contains 'autoSave' or name contains 'Cashier' or name contains '.db' or name contains 'backup') and trashed=false";

  const res = await getFetchImpl()(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=${encodeURIComponent(`files(${DRIVE_FILE_FIELDS})`)}&orderBy=createdTime desc&pageSize=25`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok) {
    await handleDriveApiError(res, 'تعذر جلب قائمة النسخ الاحتياطية من Google Drive');
  }
  const data = await res.json();
  const rawFiles: DriveFileItem[] = Array.isArray(data.files) ? data.files : [];

  // Hard client-side safeguard: never include Drive folders in backup list
  const filteredFiles = rawFiles
    .filter((f) => String(f.mimeType || '').toLowerCase() !== DRIVE_FOLDER_MIME)
    .map((f) => ({
      ...f,
      kind: classifyDriveFileKind(f),
    }));

  driveStatus = 'connected';
  driveError = undefined;
  notifyDriveListeners();
  return filteredFiles;
}

export async function downloadDriveBackupWithMetadata(
  fileId: string,
  knownMeta?: DriveFileItem
): Promise<{
  buffer: ArrayBuffer;
  metadata: DriveFileItem;
  downloadMethod: 'alt_media' | 'files_export';
}> {
  if (!hasValidDriveToken() || !cachedDriveAccessToken) {
    throw new Error('انتهت صلاحية جلسة Google Drive. يرجى تسجيل الدخول إلى Google Drive أولاً.');
  }

  const metadata = await fetchDriveFileMetadata(fileId, knownMeta);
  const kind = metadata.kind || classifyDriveFileKind(metadata);

  // 1. Folders must NEVER be treated as downloadable backup files
  if (kind === 'folder' || metadata.mimeType === DRIVE_FOLDER_MIME) {
    throw new DriveDownloadDetailedError({
      message: `العنصر "${metadata.name}" عبارة عن مجلد في Google Drive (${DRIVE_FOLDER_MIME}) وليس ملف نسخة احتياطية قابلاً للتنزيل.`,
      httpStatus: 400,
      driveErrorReason: 'folder_not_downloadable',
      fileMeta: metadata,
      downloadMethod: 'rejected',
    });
  }

  // 2. Google Docs Editor files: allow files.export ONLY for Google Docs whose exported text is valid Cashier JSON
  if (kind === 'google_docs_editor' || metadata.mimeType?.startsWith(DRIVE_GOOGLE_APPS_PREFIX)) {
    if (metadata.mimeType !== 'application/vnd.google-apps.document') {
      throw new DriveDownloadDetailedError({
        message: `الملف "${metadata.name}" من نوع Google Workspace غير مدعوم كنسخة احتياطية (${metadata.mimeType}). لن يتم تحويله قسراً.`,
        httpStatus: 415,
        driveErrorReason: 'unsupported_google_workspace_type',
        fileMeta: metadata,
        downloadMethod: 'rejected',
      });
    }

    const exportRes = await getFetchImpl()(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}/export?mimeType=${encodeURIComponent('text/plain')}`,
      {
        headers: { Authorization: `Bearer ${cachedDriveAccessToken}` },
      }
    );

    if (!exportRes.ok) {
      await handleDriveApiError(exportRes, 'تعذر تصدير مستند Google Docs من Google Drive', {
        fileMeta: metadata,
        downloadMethod: 'files_export',
        isFileOperation: true,
      });
    }

    const rawText = new TextDecoder('utf-8').decode(await exportRes.arrayBuffer());
    const cleaned = rawText.replace(/^\uFEFF/, '').trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = null;
    }

    const isRecognizedCashierJson =
      Boolean(parsed) &&
      ((parsed.format === 'CashierProCompleteDexieBackup' && Boolean(parsed.data)) ||
        Array.isArray(parsed.products));

    if (!isRecognizedCashierJson) {
      throw new DriveDownloadDetailedError({
        message: `مستند Google Docs "${metadata.name}" لا يحتوي على بيانات نسخة احتياطية صالحة لنظام Cashier، ولن يتم تحويله.`,
        httpStatus: 422,
        driveErrorReason: 'non_backup_google_doc',
        fileMeta: metadata,
        downloadMethod: 'files_export',
      });
    }

    const encoded = new TextEncoder().encode(cleaned);
    return {
      buffer: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
      metadata,
      downloadMethod: 'files_export',
    };
  }

  // 3. Binary / standard files (SQLite, JSON, etc.): check capability and download via alt=media
  if (metadata.capabilities?.canDownload === false) {
    throw new DriveDownloadDetailedError({
      message: `صلاحيات Google Drive للملف "${metadata.name}" تمنع التنزيل المباشر (canDownload=false).`,
      httpStatus: 403,
      driveErrorReason: 'cannotDownloadFile',
      fileMeta: metadata,
      downloadMethod: 'alt_media',
    });
  }

  const res = await getFetchImpl()(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${cachedDriveAccessToken}` },
    }
  );

  if (!res.ok) {
    await handleDriveApiError(res, 'تعذر تحميل ملف النسخة الاحتياطية من Google Drive', {
      fileMeta: metadata,
      downloadMethod: 'alt_media',
      isFileOperation: true,
    });
  }

  const buffer = await res.arrayBuffer();
  return {
    buffer,
    metadata,
    downloadMethod: 'alt_media',
  };
}

export async function downloadBackupFromGoogleDrive(fileId: string): Promise<ArrayBuffer> {
  const { buffer } = await downloadDriveBackupWithMetadata(fileId);
  return buffer;
}

export async function deleteBackupFromGoogleDrive(fileId: string): Promise<void> {
  if (!hasValidDriveToken() || !cachedDriveAccessToken) {
    throw new Error('انتهت صلاحية جلسة Google Drive. يرجى تسجيل الدخول إلى Google Drive أولاً.');
  }

  const res = await getFetchImpl()(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cachedDriveAccessToken}` },
  });

  if (!res.ok && res.status !== 404) {
    await handleDriveApiError(res, 'تعذر حذف الملف من Google Drive');
  }
}

/**
 * Strictly Read-Only Drive Backup Download & Sandbox Integrity Verification.
 * Downloads the file into temporary memory and verifies structure, tables,
 * record counts, and SHA-256 without modifying CashierPro_DB or calling restore.
 */
export async function verifyBackupOnGoogleDrive(
  file: DriveFileItem
): Promise<DriveBackupVerificationResult> {
  try {
    const { buffer, metadata, downloadMethod } = await downloadDriveBackupWithMetadata(
      file.id,
      file
    );
    const { verifyDriveBackupInSandbox } = await import(
      '../storage/backup/driveBackupVerifier'
    );
    const result = await verifyDriveBackupInSandbox(buffer, {
      fileId: metadata.id,
      fileName: metadata.name,
      mimeType: metadata.mimeType,
      parents: metadata.parents,
      driveFileKind: metadata.kind || classifyDriveFileKind(metadata),
      downloadMethod,
      reportedSize: metadata.size || file.size,
      md5Checksum: metadata.md5Checksum || file.md5Checksum,
      appProperties: metadata.appProperties || file.appProperties,
    });
    return {
      ...result,
      httpStatus: 200,
    };
  } catch (err: any) {
    const meta: DriveFileItem =
      err instanceof DriveDownloadDetailedError && err.fileMeta
        ? err.fileMeta
        : file;
    const reportedSizeBytes = meta.size ? Number(meta.size) || undefined : undefined;
    const storedSha256 = meta.appProperties?.cashierSha256?.trim() || undefined;

    return {
      fileId: meta.id,
      fileName: meta.name,
      mimeType: meta.mimeType,
      parents: meta.parents,
      driveFileKind: meta.kind || classifyDriveFileKind(meta),
      downloadMethod:
        err instanceof DriveDownloadDetailedError ? err.downloadMethod : 'rejected',
      httpStatus: err instanceof DriveDownloadDetailedError ? err.httpStatus : undefined,
      driveErrorReason:
        err instanceof DriveDownloadDetailedError ? err.driveErrorReason : undefined,
      driveRawErrorMessage:
        err instanceof DriveDownloadDetailedError ? err.driveRawErrorMessage : undefined,
      verifiedAt: new Date().toISOString(),
      sizeBytes: 0,
      reportedSizeBytes,
      format: 'unknown',
      structureValid: false,
      sandboxTested: false,
      sandboxRestorable: false,
      computedSha256: '',
      storedSha256,
      sha256Status: storedSha256 ? 'mismatch' : 'no_reference',
      sha256Note: 'تعذر تنزيل الملف من Google Drive لحساب بصمة SHA-256.',
      md5Checksum: meta.md5Checksum,
      tables: [],
      totalRecords: 0,
      warnings: [],
      error: err?.message || String(err),
    };
  }
}
