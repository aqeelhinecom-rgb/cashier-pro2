import { SyncQueueItem, SyncStatus, ConflictRecord, SyncTable, DeviceMetadata } from './types';
import { generateUUID } from '../storage/uuid';

/**
 * Isolated Cloud Sync Prototype Simulator (Phase 8B)
 * Implements Device-to-Cloud queue, Idempotency, and Conflict Resolution
 * without touching production shop data.
 */
export class SimulatedCloudSyncServer {
  private remoteStore = new Map<string, Record<string, any>>(); // key: table:recordUuid -> doc
  private syncQueue = new Map<string, SyncQueueItem>();          // key: idempotencyKey -> SyncQueueItem
  private devices = new Map<string, DeviceMetadata>();
  private conflicts: ConflictRecord[] = [];

  registerDevice(device: DeviceMetadata): boolean {
    this.devices.set(device.deviceId, device);
    return true;
  }

  isDeviceActive(deviceId: string): boolean {
    const d = this.devices.get(deviceId);
    return d !== undefined && d.status === 'active';
  }

  /**
   * Idempotent push of operations from a client device
   */
  pushOperation(op: SyncQueueItem): { success: boolean; duplicateIgnored?: boolean; conflict?: ConflictRecord } {
    if (!this.isDeviceActive(op.deviceId)) {
      throw new Error(`Device ${op.deviceId} is unauthorized or revoked.`);
    }

    // 1. Idempotency Guard: If idempotencyKey was already processed, ignore as duplicate
    if (this.syncQueue.has(op.idempotencyKey)) {
      return { success: true, duplicateIgnored: true };
    }

    const docKey = `${op.table}:${op.recordUuid}`;
    const existingDoc = this.remoteStore.get(docKey);

    // 2. Conflict Detection (OCC Version Check)
    if (existingDoc && op.action === 'update') {
      if (existingDoc.version >= op.version && existingDoc.updatedByDevice !== op.deviceId) {
        // Conflict detected: Another device committed a newer or concurrent version
        const conflict: ConflictRecord = {
          id: `conf_${generateUUID().substring(0, 8)}`,
          table: op.table,
          recordUuid: op.recordUuid,
          localVersion: op.version,
          remoteVersion: existingDoc.version,
          localData: op.dataPayload,
          remoteData: existingDoc,
          resolutionStrategy: 'last_write_wins',
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'cloud_sync_engine',
        };
        this.conflicts.push(conflict);

        // Apply Field-Level Merge / Last Write Wins resolution
        const mergedData = {
          ...existingDoc,
          ...op.dataPayload,
          version: Math.max(existingDoc.version, op.version) + 1,
          updatedAt: new Date().toISOString(),
        };
        this.remoteStore.set(docKey, mergedData);
        this.syncQueue.set(op.idempotencyKey, { ...op, status: 'conflict' });
        return { success: true, conflict };
      }
    }

    // 3. Normal commit to remote store
    const newDoc = {
      ...op.dataPayload,
      version: op.version,
      updatedByDevice: op.deviceId,
      updatedAt: new Date().toISOString(),
    };
    this.remoteStore.set(docKey, newDoc);

    const committedOp: SyncQueueItem = {
      ...op,
      status: 'synced',
      serverTimestamp: new Date().toISOString(),
    };
    this.syncQueue.set(op.idempotencyKey, committedOp);

    return { success: true };
  }

  /**
   * Pull operations committed to remote store
   */
  pullLatestChanges(table: SyncTable): Record<string, any>[] {
    const list: Record<string, any>[] = [];
    const prefix = `${table}:`;
    for (const [k, v] of this.remoteStore.entries()) {
      if (k.startsWith(prefix)) {
        list.push(v);
      }
    }
    return list;
  }

  getConflicts(): ConflictRecord[] {
    return [...this.conflicts];
  }

  getProcessedOpsCount(): number {
    return this.syncQueue.size;
  }

  getDoc(table: SyncTable, recordUuid: string): Record<string, any> | undefined {
    return this.remoteStore.get(`${table}:${recordUuid}`);
  }
}

/**
 * Simulated POS Terminal Device Client
 */
export class SimulatedDeviceClient {
  public deviceId: string;
  public storeId: string;
  public isOnline: boolean = true;
  private localQueue: SyncQueueItem[] = [];
  private clientSeq: number = 0;
  private cloudServer: SimulatedCloudSyncServer;

  constructor(deviceId: string, storeId: string, cloudServer: SimulatedCloudSyncServer) {
    this.deviceId = deviceId;
    this.storeId = storeId;
    this.cloudServer = cloudServer;
  }

  enqueueLocalOperation(
    table: SyncTable,
    action: SyncQueueItem['action'],
    recordUuid: string,
    dataPayload: Record<string, any>,
    version: number
  ): SyncQueueItem {
    this.clientSeq++;
    const idempotencyKey = `idem_${this.deviceId}_${this.clientSeq}_${recordUuid}_${action}`;
    const item: SyncQueueItem = {
      idempotencyKey,
      deviceId: this.deviceId,
      storeId: this.storeId,
      seq: this.clientSeq,
      table,
      action,
      recordUuid,
      status: 'pending',
      retryCount: 0,
      maxRetries: 5,
      clientTimestamp: new Date().toISOString(),
      dataPayload,
      version,
    };
    this.localQueue.push(item);
    return item;
  }

  async syncPendingQueue(): Promise<{ synced: number; failed: number; duplicates: number; conflicts: number }> {
    if (!this.isOnline) {
      return { synced: 0, failed: this.localQueue.length, duplicates: 0, conflicts: 0 };
    }

    let synced = 0;
    let failed = 0;
    let duplicates = 0;
    let conflicts = 0;

    const remaining: SyncQueueItem[] = [];

    for (const item of this.localQueue) {
      try {
        const res = this.cloudServer.pushOperation(item);
        if (res.duplicateIgnored) {
          duplicates++;
          synced++;
        } else if (res.conflict) {
          conflicts++;
          synced++;
        } else if (res.success) {
          synced++;
        }
      } catch (err: any) {
        item.retryCount++;
        item.lastError = err.message;
        if (item.retryCount >= item.maxRetries) {
          item.status = 'failed';
          failed++;
        } else {
          remaining.push(item);
        }
      }
    }

    this.localQueue = remaining;
    return { synced, failed, duplicates, conflicts };
  }

  getLocalQueueLength(): number {
    return this.localQueue.length;
  }
}
