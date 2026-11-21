/**
 * Multi-Window / Multi-Tab Synchronization Manager
 * Coordinates real-time cache invalidation and state synchronization across multiple browser tabs/windows.
 */

export interface SyncMessage {
  type: 'MUTATION_OCCURRED' | 'CACHE_INVALIDATE' | 'FORCE_RELOAD';
  sourceWindowId: string;
  table: string;
  action: 'create' | 'update' | 'delete' | 'void' | 'stock_change';
  recordId?: number | string;
  seq?: number;
  timestamp: string;
}

// In-memory global event bus fallback when BroadcastChannel is unavailable (e.g., in Node/test environments)
type SyncListener = (msg: SyncMessage) => void;
const memorySyncBus: Set<SyncListener> = new Set();

export class MultiWindowSyncManager {
  private channel: BroadcastChannel | null = null;
  private memoryListener: SyncListener | null = null;
  public windowId: string;
  public lastSeenJournalSeq: number = 0;
  private onInvalidateCallback?: (msg: SyncMessage) => void;

  constructor(windowId?: string, channelName = 'cashier_pro_multi_window_sync') {
    this.windowId = windowId || `win_${Math.random().toString(36).substring(2, 9)}`;

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(channelName);
        this.channel.onmessage = (event: MessageEvent<SyncMessage>) => {
          if (event.data && event.data.sourceWindowId !== this.windowId) {
            this.handleIncomingMessage(event.data);
          }
        };
      } catch (e) {
        this.channel = null;
      }
    }

    // Always wire up the memory bus to support unit tests and fallback
    this.memoryListener = (msg: SyncMessage) => {
      if (msg.sourceWindowId !== this.windowId) {
        this.handleIncomingMessage(msg);
      }
    };
    memorySyncBus.add(this.memoryListener);
  }

  public onInvalidate(callback: (msg: SyncMessage) => void): void {
    this.onInvalidateCallback = callback;
  }

  private handleIncomingMessage(msg: SyncMessage): void {
    if (this.onInvalidateCallback) {
      try {
        this.onInvalidateCallback(msg);
      } catch (err) {
        console.error('MultiWindowSyncManager callback error:', err);
      }
    }
  }

  /**
   * Broadcasts a mutation event to all other open windows/tabs
   */
  public broadcastMutation(
    table: string,
    action: 'create' | 'update' | 'delete' | 'void' | 'stock_change',
    recordId?: number | string,
    seq?: number
  ): void {
    if (seq !== undefined && seq > this.lastSeenJournalSeq) {
      this.lastSeenJournalSeq = seq;
    }

    const msg: SyncMessage = {
      type: 'MUTATION_OCCURRED',
      sourceWindowId: this.windowId,
      table,
      action,
      recordId,
      seq,
      timestamp: new Date().toISOString(),
    };

    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch (e) {
        // Ignored
      }
    }

    // Dispatch to in-memory bus
    memorySyncBus.forEach((listener) => {
      try {
        listener(msg);
      } catch (e) {
        // Ignored
      }
    });
  }

  /**
   * Catches up on any missed journal entries from Dexie directly when waking from idle or on dropped broadcast
   */
  public async catchUpMissedJournal(
    db: any,
    onMissedEntries?: (entries: any[]) => void
  ): Promise<number> {
    if (!db.change_journal) return 0;
    const missed = await db.change_journal
      .where('seq')
      .above(this.lastSeenJournalSeq)
      .toArray();

    if (missed.length > 0) {
      const highestSeq = missed[missed.length - 1].seq;
      if (highestSeq) {
        this.lastSeenJournalSeq = highestSeq;
      }
      if (onMissedEntries) {
        onMissedEntries(missed);
      }
    }
    return missed.length;
  }

  public close(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch (e) {
        // Ignored
      }
      this.channel = null;
    }
    if (this.memoryListener) {
      memorySyncBus.delete(this.memoryListener);
      this.memoryListener = null;
    }
  }
}
