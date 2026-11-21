/**
 * Backwards-compatible Facade for Cloud Services.
 * Phase 27: Google Drive and Firebase are completely isolated in:
 *  - src/services/cloud/googleDriveService.ts (GIS OAuth2 + Drive REST API)
 *  - src/services/cloud/firebaseCloudService.ts (Firebase Auth + Firestore Diagnostics)
 *
 * Zero Drive scopes are attached to Firebase Auth and zero tokens are shared.
 */
export * from './cloud/types';

export {
  GOOGLE_DRIVE_SCOPES,
  subscribeGoogleDriveState,
  getGoogleDriveState,
  hasValidDriveToken,
  clearDriveToken,
  hydrateDriveMetadata,
  translateDriveError,
  connectGoogleDrive,
  disconnectGoogleDrive,
  getDriveAccessToken as getAccessToken,
  uploadBackupToGoogleDrive,
  listGoogleDriveBackups,
  fetchDriveFileMetadata,
  classifyDriveFileKind,
  parseGoogleDriveErrorBody,
  DriveDownloadDetailedError,
  downloadDriveBackupWithMetadata,
  downloadBackupFromGoogleDrive,
  deleteBackupFromGoogleDrive,
  verifyBackupOnGoogleDrive,
  setDriveTestOverrides,
} from './cloud/googleDriveService';

export {
  app,
  auth,
  firestore,
  firebaseAuthProvider,
  OperationType,
  type FirestoreErrorInfo,
  type CloudConnectionDiagnostics,
  type FirestoreBackupItem,
  subscribeFirebaseState,
  getFirebaseState,
  getActiveFirebaseTarget,
  hydrateFirebaseMetadata,
  translateFirebaseError,
  handleFirestoreError,
  configureTestFirebaseProject,
  diagnoseFirestoreConnection,
  testFirestoreConnection,
  runFirestoreTestProjectDiagnostic,
  initFirebaseAuth,
  connectFirebaseWithGoogle,
  disconnectFirebase,
  getCurrentFirebaseUser as getCurrentUser,
  saveBackupToFirestore,
  listFirestoreBackups,
  loadBackupFromFirestore,
  deleteBackupFromFirestore,
} from './cloud/firebaseCloudService';

import type { User } from 'firebase/auth';
import {
  initFirebaseAuth,
  connectFirebaseWithGoogle,
  disconnectFirebase,
  getCurrentFirebaseUser,
} from './cloud/firebaseCloudService';

/**
 * Legacy compatibility helper (Firebase Auth ONLY — does NOT obtain or share Drive tokens).
 */
export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  return initFirebaseAuth(
    (user) => {
      if (onAuthSuccess) onAuthSuccess(user, null);
    },
    onAuthFailure
  );
};

/**
 * Legacy compatibility helper (Firebase Auth ONLY — does NOT grant Drive scopes).
 */
export const signInWithGoogle = async (): Promise<{ user: User; accessToken: string } | null> => {
  await connectFirebaseWithGoogle();
  const user = getCurrentFirebaseUser();
  if (!user) return null;
  return { user, accessToken: '' };
};

/**
 * Legacy compatibility helper (Signs out of Firebase ONLY — leaves Google Drive independent).
 */
export const signOutGoogle = async (): Promise<void> => {
  await disconnectFirebase();
};
