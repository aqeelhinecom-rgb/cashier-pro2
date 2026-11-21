import { CashierDatabase } from '../schema';
import { StorageProduct, ConcurrencyConflictError, InsufficientStockError } from '../types';
import { generateUUID } from '../uuid';

export class ProductRepository {
  constructor(private db: CashierDatabase) {}

  async getAll(query = ''): Promise<StorageProduct[]> {
    let collection = this.db.products.filter((p) => !p.isDeleted);
    let list = await collection.toArray();

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.barcode && p.barcode.toLowerCase().includes(q)) ||
          (p.category && p.category.toLowerCase().includes(q)) ||
          (p.description && p.description.toLowerCase().includes(q))
      );
    }

    return list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  async getById(id: number): Promise<StorageProduct | undefined> {
    return this.db.products.get(id);
  }

  async getByUuid(uuid: string): Promise<StorageProduct | undefined> {
    return this.db.products.where('uuid').equals(uuid).first();
  }

  async getByBarcode(code: string): Promise<StorageProduct | undefined> {
    const clean = code.trim();
    if (!clean) return undefined;
    return this.db.products
      .filter((p) => !p.isDeleted && Boolean(p.barcode && p.barcode.trim() === clean))
      .first();
  }

  async save(productData: Partial<StorageProduct> & { name?: string; expectedVersion?: number }): Promise<StorageProduct> {
    const now = new Date().toISOString();

    return this.db.transaction('rw', [this.db.products, this.db.categories, this.db.change_journal], async () => {
      let saved: StorageProduct;

      if (productData.id) {
        const existing = await this.db.products.get(productData.id);
        if (!existing) {
          throw new Error('المنتج المطلوب تعديله غير موجود');
        }

        // Optimistic Concurrency Control (OCC) Check
        const currentVersion = existing.version || 1;
        if (productData.expectedVersion !== undefined && currentVersion !== productData.expectedVersion) {
          throw new ConcurrencyConflictError(
            'المنتج',
            productData.id,
            productData.expectedVersion,
            currentVersion,
            existing
          );
        }
        const nextVersion = currentVersion + 1;

        saved = {
          ...existing,
          ...productData,
          name: productData.name !== undefined ? productData.name.trim() : existing.name,
          category: productData.category !== undefined ? productData.category.trim() : existing.category,
          buy_price: productData.buy_price !== undefined ? Number(productData.buy_price) : existing.buy_price,
          sell_price: productData.sell_price !== undefined ? Number(productData.sell_price) : existing.sell_price,
          qty: productData.qty !== undefined ? Number(productData.qty) : existing.qty,
          currency: productData.currency?.trim() || existing.currency || 'د.ع',
          image: productData.image !== undefined ? productData.image : existing.image,
          version: nextVersion,
          updatedAt: now,
        };

        await this.db.products.put(saved);

        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: saved.uuid,
            table: 'products',
            action: 'update',
            recordId: saved.id,
            recordUuid: saved.uuid,
            timestamp: now,
            beforeState: existing,
            afterState: saved,
          });
        }
      } else {
        if (!productData.name || !productData.name.trim()) {
          throw new Error('اسم المنتج مطلوب عند إنشاء صنف جديد');
        }
        saved = {
          name: productData.name.trim(),
          barcode: productData.barcode?.trim() || '',
          category: productData.category?.trim() || 'عام',
          description: productData.description?.trim() || '',
          buy_price: Number(productData.buy_price) || 0,
          sell_price: Number(productData.sell_price) || 0,
          qty: Number(productData.qty) || 0,
          currency: productData.currency?.trim() || 'د.ع',
          image: productData.image || undefined,
          uuid: productData.uuid || generateUUID(),
          version: 1,
          updatedAt: now,
          isDeleted: false,
        } as StorageProduct;

        const newId = await this.db.products.add(saved);
        saved.id = newId;

        if (this.db.change_journal) {
          await this.db.change_journal.add({
            operationId: saved.uuid,
            table: 'products',
            action: 'create',
            recordId: newId,
            recordUuid: saved.uuid,
            timestamp: now,
            afterState: saved,
          });
        }
      }

      // Ensure category exists inside the same atomic transaction
      if (saved.category && saved.category.trim()) {
        await this.db.categories.put({ name: saved.category.trim() });
      }

      return saved;
    });
  }

  async delete(id: number, soft = true): Promise<void> {
    await this.db.transaction('rw', [this.db.products, this.db.change_journal], async () => {
      const existing = await this.db.products.get(id);
      const now = new Date().toISOString();
      const nextVersion = existing ? (existing.version || 1) + 1 : 1;

      if (soft) {
        await this.db.products.update(id, {
          isDeleted: true,
          version: nextVersion,
          updatedAt: now,
        });
      } else {
        await this.db.products.delete(id);
      }

      if (this.db.change_journal && existing) {
        await this.db.change_journal.add({
          operationId: generateUUID(),
          table: 'products',
          action: 'delete',
          recordId: id,
          recordUuid: existing.uuid,
          timestamp: now,
          beforeState: existing,
          afterState: soft ? { ...existing, isDeleted: true, version: nextVersion, updatedAt: now } : undefined,
        });
      }
    });
  }

  async updateStock(id: number, delta: number): Promise<void> {
    await this.db.transaction('rw', [this.db.products, this.db.change_journal], async () => {
      const product = await this.db.products.get(id);
      if (!product) {
        throw new Error(`المنتج (المعرف: ${id}) غير موجود في المخزن.`);
      }
      const oldQty = Number(product.qty) || 0;
      const newQty = oldQty + delta;
      if (newQty < 0) {
        throw new InsufficientStockError(
          product.id,
          product.name,
          Math.abs(delta),
          oldQty
        );
      }
      const now = new Date().toISOString();
      const nextVersion = (product.version || 1) + 1;

      await this.db.products.update(id, {
        qty: newQty,
        version: nextVersion,
        updatedAt: now,
      });

      if (this.db.change_journal) {
        await this.db.change_journal.add({
          operationId: generateUUID(),
          table: 'products',
          action: 'stock_change',
          recordId: id,
          recordUuid: product.uuid,
          timestamp: now,
          diff: { oldQty, newQty, delta },
        });
      }
    });
  }

  // Categories management
  async getCategories(): Promise<string[]> {
    const dbCats = await this.db.categories.toArray();
    const set = new Set<string>(['عام', ...dbCats.map((c) => c.name)]);

    const products = await this.db.products.filter((p) => !p.isDeleted).toArray();
    products.forEach((p) => {
      if (p.category && p.category.trim()) {
        set.add(p.category.trim());
      }
    });

    return Array.from(set);
  }

  async addCategory(name: string): Promise<string[]> {
    const clean = name.trim();
    if (!clean) return this.getCategories();

    await this.db.categories.put({ name: clean });
    return this.getCategories();
  }

  async renameCategory(oldName: string, newName: string): Promise<string[]> {
    const cleanOld = oldName.trim();
    const cleanNew = newName.trim();
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return this.getCategories();

    await this.db.transaction('rw', [this.db.categories, this.db.products], async () => {
      await this.db.categories.delete(cleanOld);
      await this.db.categories.put({ name: cleanNew });

      const products = await this.db.products
        .filter((p) => (p.category || 'عام').trim() === cleanOld)
        .toArray();

      for (const p of products) {
        await this.db.products.update(p.id, {
          category: cleanNew,
          updatedAt: new Date().toISOString(),
        });
      }
    });

    return this.getCategories();
  }

  async deleteCategory(name: string): Promise<string[]> {
    const clean = name.trim();
    if (!clean || clean === 'عام') return this.getCategories();

    await this.db.transaction('rw', [this.db.categories, this.db.products], async () => {
      await this.db.categories.delete(clean);

      const products = await this.db.products
        .filter((p) => (p.category || '').trim() === clean)
        .toArray();

      for (const p of products) {
        await this.db.products.update(p.id, {
          category: 'عام',
          updatedAt: new Date().toISOString(),
        });
      }
    });

    return this.getCategories();
  }
}
