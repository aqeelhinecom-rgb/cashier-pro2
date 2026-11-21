export type CloudServiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface DriveAccountInfo {
  email: string;
  name?: string;
  picture?: string;
}

export type DriveFileKind =
  | 'sqlite'
  | 'json'
  | 'folder'
  | 'google_docs_editor'
  | 'binary_other'
  | 'unknown';

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  size?: string;
  parents?: string[];
  md5Checksum?: string;
  appProperties?: Record<string, string>;
  capabilities?: {
    canDownload?: boolean;
    canEdit?: boolean;
  };
  kind?: DriveFileKind;
}

export interface DriveBackupVerificationResult {
  fileId: string;
  fileName: string;
  mimeType?: string;
  parents?: string[];
  driveFileKind?: DriveFileKind;
  downloadMethod?: 'alt_media' | 'files_export' | 'rejected';
  httpStatus?: number;
  driveErrorReason?: string;
  driveRawErrorMessage?: string;
  verifiedAt: string;
  sizeBytes: number;
  reportedSizeBytes?: number;
  format: 'sqlite3' | 'dexie_v2_json' | 'legacy_json' | 'unknown';
  structureValid: boolean;
  sandboxTested: boolean;
  sandboxRestorable: boolean;
  computedSha256: string;
  storedSha256?: string;
  sha256Status: 'matched' | 'mismatch' | 'no_reference';
  sha256Note: string;
  jsonPayloadSha256?: string;
  storedJsonPayloadSha256?: string;
  md5Checksum?: string;
  storeName?: string;
  exportedAt?: string;
  tables: Array<{ name: string; rows: number }>;
  totalRecords: number;
  sandboxTableCounts?: Record<string, number>;
  warnings: string[];
  error?: string;
}

export interface GoogleDriveConnectionState {
  status: CloudServiceStatus;
  account: DriveAccountInfo | null;
  tokenValid: boolean;
  lastBackupAt?: string;
  error?: string;
}

export interface FirebaseTestProjectConfig {
  projectId: string;
  apiKey: string;
  authDomain: string;
  appId: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface FirebaseUserInfo {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface FirebaseConnectionState {
  status: CloudServiceStatus;
  user: FirebaseUserInfo | null;
  projectId: string;
  firestoreDatabaseId: string;
  isTestProject: boolean;
  lastSyncAt?: string;
  error?: string;
}

export interface FirestoreDiagnosticResult {
  ok: boolean;
  status: CloudServiceStatus;
  writeOk: boolean;
  readOk: boolean;
  cleanupOk: boolean;
  projectId: string;
  firestoreDatabaseId: string;
  docPath?: string;
  message: string;
  latencyMs: number;
}
