import { CashierDatabase } from '../schema';
import { StoreSettings } from '../../../types';
import { generateUUID } from '../uuid';

export const DEFAULT_STORAGE_SETTINGS: StoreSettings = {
  storeName: 'Cashier - إدارة حسابات المحلات',
  phone: '0501234567',
  address: 'الفرع الرئيسي',
  currency: 'د.ع',
  exchangeRate: 1500,
  taxRate: 0,
  receiptFooter: 'شكراً لزيارتكم ونتطلع لخدمتكم دائماً',
  googleDriveLinked: false,
  driveAccountEmail: '',
  driveLastBackupAt: '',
  userEmail: '',
  firebaseLinked: false,
  firebaseAccountEmail: '',
  firebaseLastSyncAt: '',
  firebaseProjectId: '',
  fontFamily: 'Cairo',
  fontSize: 15,
  productsFontSize: 14,
  theme: 'light',
  permissionsGranted: false,
  backupCustomFolder: 'Download/Cashier/backup',
};

export class SettingsRepository {
  constructor(private db: CashierDatabase) {}

  async getSettings(): Promise<StoreSettings> {
    const records = await this.db.settings.toArray();
    const settingsObj: any = { ...DEFAULT_STORAGE_SETTINGS };

    records.forEach((r) => {
      settingsObj[r.key] = r.value;
    });

    return settingsObj;
  }

  async saveSettings(partial: Partial<StoreSettings>): Promise<StoreSettings> {
    const current = await this.getSettings();
    const updated = { ...current, ...partial };
    const now = new Date().toISOString();
    const opId = generateUUID();

    const tables: any[] = [this.db.settings];
    if (this.db.change_journal) tables.push(this.db.change_journal);

    await this.db.transaction('rw', tables, async () => {
      for (const [key, val] of Object.entries(partial)) {
        await this.db.settings.put({ key, value: val });
      }

      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: opId,
          table: 'settings',
          action: 'update',
          recordId: 'store_settings',
          timestamp: now,
          beforeState: current,
          afterState: updated,
        });
      }
    });

    return updated;
  }

  async getSetting<T = any>(key: string, defaultValue?: T): Promise<T | undefined> {
    const record = await this.db.settings.get(key);
    return record ? record.value : defaultValue;
  }

  async setSetting(key: string, value: any): Promise<void> {
    await this.db.settings.put({ key, value });
  }
}
