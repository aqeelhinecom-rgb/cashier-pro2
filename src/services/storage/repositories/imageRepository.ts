import { CashierDatabase } from '../schema';
import { StorageProductImage } from '../types';
import { generateUUID } from '../uuid';

export class ImageRepository {
  constructor(private db: CashierDatabase) {}

  async saveImage(productId: number, data: { blob?: Blob; base64?: string; mimeType?: string }): Promise<StorageProductImage> {
    const now = new Date().toISOString();

    return this.db.transaction('rw', [this.db.product_images, this.db.change_journal], async () => {
      const imageRecord: StorageProductImage = {
        productId,
        blob: data.blob,
        base64: data.base64,
        mimeType: data.mimeType || 'image/jpeg',
        uuid: generateUUID(),
        updatedAt: now,
      };

      const id = await this.db.product_images.add(imageRecord);
      imageRecord.id = id;

      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: imageRecord.uuid,
          table: 'product_images',
          action: 'create',
          recordId: id,
          recordUuid: imageRecord.uuid,
          timestamp: now,
          afterState: imageRecord,
        });
      }

      return imageRecord;
    });
  }

  async getByProductId(productId: number): Promise<StorageProductImage | undefined> {
    return this.db.product_images.where('productId').equals(productId).first();
  }

  async deleteByProductId(productId: number): Promise<void> {
    await this.db.transaction('rw', [this.db.product_images, this.db.change_journal], async () => {
      const items = await this.db.product_images.where('productId').equals(productId).toArray();
      const now = new Date().toISOString();
      for (const item of items) {
        if (item.id) {
          await this.db.product_images.delete(item.id);
          if (this.db.change_journal) {
            await this.db.change_journal.add({
              operationId: generateUUID(),
              table: 'product_images',
              action: 'delete',
              recordId: item.id,
              recordUuid: item.uuid,
              timestamp: now,
              beforeState: item,
            });
          }
        }
      }
    });
  }
}
