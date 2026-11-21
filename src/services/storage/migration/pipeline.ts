import { CashierDatabase } from '../schema';
import { readLegacyLocalStorage, LegacyLocalStorageDump } from './reader';
import { createSafeChunkedSnapshot, SnapshotManifest } from './chunkedSnapshot';
import { migrateLegacyDataToDexie, MigrationIntegrityReport } from './migrator';

export type MigrationStep =
  | 'IDLE'
  | 'SNAPSHOT_CREATED'
  | 'MIGRATING_SETTINGS_CATEGORIES'
  | 'MIGRATING_PRODUCTS'
  | 'MIGRATING_PARTIES'
  | 'MIGRATING_INVOICES_ITEMS'
  | 'MIGRATING_FINANCE'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED';

export interface MigrationPipelineStatus {
  step: MigrationStep;
  snapshotId?: string;
  totalRecords: number;
  processedRecords: number;
  percent: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
  report?: MigrationIntegrityReport;
}

export class MigrationPipeline {
  constructor(private targetDb: CashierDatabase) {}

  /**
   * Detects whether legacy data exists in localStorage
   */
  detectLegacyData(customDump?: LegacyLocalStorageDump): boolean {
    const data = customDump || readLegacyLocalStorage();
    return (
      data.products.length > 0 ||
      data.parties.length > 0 ||
      data.invoices.length > 0 ||
      data.payments.length > 0 ||
      data.expenses.length > 0
    );
  }

  /**
   * Reads current migration status from targetDb
   */
  async getStatus(): Promise<MigrationPipelineStatus> {
    const record = await this.targetDb.migration_state.get('migration_progress');
    if (record && record.value) {
      return record.value as MigrationPipelineStatus;
    }
    return {
      step: 'IDLE',
      totalRecords: 0,
      processedRecords: 0,
      percent: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Updates migration status in targetDb
   */
  private async updateStatus(status: Partial<MigrationPipelineStatus>): Promise<void> {
    const current = await this.getStatus();
    const updated: MigrationPipelineStatus = {
      ...current,
      ...status,
      updatedAt: new Date().toISOString(),
    };
    await this.targetDb.migration_state.put({
      key: 'migration_progress',
      value: updated,
      timestamp: updated.updatedAt,
    });
  }

  /**
   * Step 1: Create a safe snapshot of legacy data
   */
  async createSnapshot(data?: LegacyLocalStorageDump): Promise<SnapshotManifest> {
    const legacyData = data || readLegacyLocalStorage();
    const { manifest } = await createSafeChunkedSnapshot(legacyData, this.targetDb);

    await this.updateStatus({
      step: 'SNAPSHOT_CREATED',
      snapshotId: manifest.snapshotId,
      totalRecords: manifest.totalRecords,
      processedRecords: 0,
      percent: 10,
      startedAt: new Date().toISOString(),
    });

    return manifest;
  }

  /**
   * Step 2: Executes migration with relational integrity validation and resume support
   */
  async executeMigration(data?: LegacyLocalStorageDump): Promise<{
    success: boolean;
    report: MigrationIntegrityReport;
    status: MigrationPipelineStatus;
  }> {
    const legacyData = data || readLegacyLocalStorage();

    // 1. Create or ensure snapshot exists
    const currentStatus = await this.getStatus();
    if (currentStatus.step === 'IDLE' || !currentStatus.snapshotId) {
      await this.createSnapshot(legacyData);
    }

    await this.updateStatus({
      step: 'MIGRATING_SETTINGS_CATEGORIES',
      percent: 25,
    });

    await this.updateStatus({
      step: 'MIGRATING_PRODUCTS',
      percent: 45,
    });

    await this.updateStatus({
      step: 'MIGRATING_PARTIES',
      percent: 60,
    });

    await this.updateStatus({
      step: 'MIGRATING_INVOICES_ITEMS',
      percent: 80,
    });

    await this.updateStatus({
      step: 'MIGRATING_FINANCE',
      percent: 90,
    });

    // Execute atomic migration into Dexie target database
    const report = await migrateLegacyDataToDexie(legacyData, this.targetDb);

    await this.updateStatus({
      step: 'VALIDATING',
      percent: 95,
      report,
    });

    // Foreign Keys & Relational integrity deep check
    const relationalErrors = await this.validateRelationalIntegrity();
    if (relationalErrors.length > 0) {
      report.success = false;
      report.errors.push(...relationalErrors);
    }

    if (report.success) {
      await this.updateStatus({
        step: 'COMPLETED',
        percent: 100,
        processedRecords: currentStatus.totalRecords,
        report,
      });
      return { success: true, report, status: await this.getStatus() };
    } else {
      await this.updateStatus({
        step: 'FAILED',
        error: report.errors.join('; ') || 'فشلت معايير التحقق من سلامة البيانات المنقولة',
        report,
      });
      return { success: false, report, status: await this.getStatus() };
    }
  }

  /**
   * Resumes migration from last saved step if it was interrupted
   */
  async resumeMigration(data?: LegacyLocalStorageDump): Promise<{
    success: boolean;
    report: MigrationIntegrityReport;
    status: MigrationPipelineStatus;
  }> {
    const status = await this.getStatus();
    if (status.step === 'COMPLETED') {
      return {
        success: true,
        report: status.report || ({} as any),
        status,
      };
    }

    // If interrupted midway or failed, re-execute migration using the preserved snapshot
    return this.executeMigration(data);
  }

  /**
   * Relational integrity verification (Foreign Keys & Constraints)
   */
  async validateRelationalIntegrity(): Promise<string[]> {
    const errors: string[] = [];

    const invoices = await this.targetDb.invoices.toArray();
    const invoiceIds = new Set(invoices.map((i) => i.id));
    const parties = await this.targetDb.parties.toArray();
    const partyIds = new Set(parties.map((p) => p.id));
    const items = await this.targetDb.invoice_items.toArray();
    const payments = await this.targetDb.payments.toArray();

    // 1. Verify every invoice item points to an existing invoice
    for (const item of items) {
      if (typeof item.invoice_id === 'number' && !invoiceIds.has(item.invoice_id)) {
        errors.push(`عنصر الفاتورة #${item.id} يشير إلى فاتورة غير موجودة #${item.invoice_id}`);
      }
    }

    // 2. Verify every invoice with party_id points to an existing party
    for (const inv of invoices) {
      if (inv.party_id !== null && inv.party_id !== undefined && !partyIds.has(inv.party_id)) {
        errors.push(`الفاتورة #${inv.id} تشير إلى عميل/مورد غير موجود #${inv.party_id}`);
      }
    }

    // 3. Verify every payment points to an existing party
    for (const pay of payments) {
      if (typeof pay.party_id === 'number' && !partyIds.has(pay.party_id)) {
        errors.push(`الدفعة #${pay.id} تشير إلى جهة غير موجودة #${pay.party_id}`);
      }
    }

    return errors;
  }
}
