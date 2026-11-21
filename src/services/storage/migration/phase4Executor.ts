import { CashierDatabase, cashierStorageDb } from '../schema';
import { readLegacyLocalStorage, LegacyLocalStorageDump } from './reader';
import { createVerifiedPreMigrationBackup, PreMigrationBackupFile } from './preMigrationBackup';
import { migrateLegacyDataToDexie, MigrationIntegrityReport } from './migrator';
import { verifyEntityByEntity, EntityVerificationReport } from './entityVerifier';
import { computeCanonicalHash } from './chunkedSnapshot';

export interface Phase4ExecutionReport {
  success: boolean;
  timestamp: string;
  backup: {
    created: boolean;
    verified: boolean;
    checksum: string;
    totalRecords: number;
  };
  migration: MigrationIntegrityReport;
  deepVerification: EntityVerificationReport;
  localStorageUntouched: boolean;
  errors: string[];
}

/**
 * Executes Phase 4:
 * 1. Independent Pre-Migration Backup & Verification
 * 2. Source Key & Data Freezing Check
 * 3. Migration into real Dexie database (without altering localStorage)
 * 4. Deep Entity-by-Entity & Financial Verification
 */
export async function executePhase4Migration(
  targetDb: CashierDatabase = cashierStorageDb,
  customSourceDump?: LegacyLocalStorageDump
): Promise<Phase4ExecutionReport> {
  const errors: string[] = [];
  const now = new Date().toISOString();

  // Snapshot localStorage state before doing anything
  const beforeKeys: Record<string, string> = {};
  if (typeof localStorage !== 'undefined') {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) beforeKeys[k] = localStorage.getItem(k) || '';
    }
  }

  // 1. Gather Source Data
  const sourceData = customSourceDump || readLegacyLocalStorage();
  const sourceHash = computeCanonicalHash(sourceData);

  // 2. Create Independent Verified Backup
  const backupResult = await createVerifiedPreMigrationBackup(sourceData);
  if (!backupResult.verified) {
    errors.push(`فشل إنشاء النسخة الاحتياطية المستقلة أو التحقق منها: ${backupResult.error}`);
    return {
      success: false,
      timestamp: now,
      backup: {
        created: false,
        verified: false,
        checksum: '',
        totalRecords: 0,
      },
      migration: {} as any,
      deepVerification: {} as any,
      localStorageUntouched: true,
      errors,
    };
  }

  // 3. Ensure target database is open
  if (!targetDb.isOpen()) {
    await targetDb.open();
  }

  // 4. Execute atomic migration into the real Dexie database
  const migrationReport = await migrateLegacyDataToDexie(sourceData, targetDb);
  if (!migrationReport.success) {
    errors.push(...migrationReport.errors);
  }

  // 5. Deep Entity-by-Entity Verification
  const deepVerification = await verifyEntityByEntity(sourceData, targetDb);
  if (!deepVerification.success) {
    errors.push(...deepVerification.errors);
    if (deepVerification.mismatches.length > 0) {
      errors.push(`تم رصد ${deepVerification.mismatches.length} عدم تطابق على مستوى السجلات الفردية`);
    }
  }

  // 6. Verify localStorage remained 100% untouched
  let localStorageUntouched = true;
  if (typeof localStorage !== 'undefined') {
    for (const key of Object.keys(beforeKeys)) {
      if (localStorage.getItem(key) !== beforeKeys[key]) {
        localStorageUntouched = false;
        errors.push(`تم رصد تعديل على مفتاح localStorage: "${key}"!`);
      }
    }
  }

  const overallSuccess =
    backupResult.verified &&
    migrationReport.success &&
    deepVerification.success &&
    localStorageUntouched &&
    errors.length === 0;

  // Record audit entry in migration_state
  await targetDb.migration_state.put({
    key: 'phase4_migration_audit_result',
    value: {
      success: overallSuccess,
      timestamp: now,
      sourceHash,
      totalRecordsMigrated: deepVerification.counts.products.target + deepVerification.counts.invoices.target,
      errors,
    },
    timestamp: now,
  });

  return {
    success: overallSuccess,
    timestamp: now,
    backup: {
      created: true,
      verified: backupResult.verified,
      checksum: backupResult.backup.checksum,
      totalRecords: Object.values(backupResult.backup.counts).reduce((a, b) => a + b, 0),
    },
    migration: migrationReport,
    deepVerification,
    localStorageUntouched,
    errors,
  };
}
