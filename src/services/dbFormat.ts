// @ts-ignore
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import type { Database, SqlValue } from 'sql.js';
import { DB } from './db';
import { storageCacheAdapter } from './storage/cacheAdapter';
import { computeUtf8Sha256 } from './cloud/sha256';
import { Product, Party, Invoice, InvoiceItem, Payment, Expense } from '../types';

let sqlJsInstance: any = null;

export async function getSqlJs() {
  if (!sqlJsInstance) {
    try {
      // sql-wasm-inline embeds the wasm binary directly as inline base64,
      // completely eliminating network fetch requests and "streaming compile failed: TypeError: Failed to fetch" errors.
      sqlJsInstance = await initSqlJs();
    } catch (err) {
      console.warn('Failed to initialize inline SQLite WASM:', err);
      throw err;
    }
  }
  return sqlJsInstance;
}

/**
 * Generates the standardized backup filename requested by the user:
 * e.g. "data (autoSave)222682025.db" or "data (backup)222682025.db"
 */
export function generateBackupFileName(
  type: 'autoSave' | 'backup' = 'autoSave',
  date: Date = new Date()
): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const day = date.getDate().toString();
  const month = (date.getMonth() + 1).toString();
  const year = date.getFullYear().toString();

  // Pattern: data (autoSave)HHmmDMYYYY.db -> e.g. data (autoSave)222682025.db
  const timestampStr = `${hours}${minutes}${day}${month}${year}`;
  const label = type === 'autoSave' ? '(autoSave)' : '(backup)';
  return `data ${label}${timestampStr}.db`;
}

function getStored<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Creates a complete SQLite 3 database (.db) containing all tables and metadata
 */
export async function createSqliteDbBlob(): Promise<{ blob: Blob; fileName: string; binary: Uint8Array }> {
  try {
    const SQL = await getSqlJs();
    const db: Database = new SQL.Database();

    // Create SQLite tables
    db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      barcode TEXT,
      category TEXT,
      description TEXT,
      buy_price REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      qty REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      type TEXT NOT NULL,
      balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      party_id INTEGER,
      party_name TEXT,
      date TEXT NOT NULL,
      discount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      paid REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      qty REAL DEFAULT 1,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      party_id INTEGER NOT NULL,
      party_name TEXT,
      amount REAL DEFAULT 0,
      date TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      recipient TEXT NOT NULL,
      amount REAL DEFAULT 0,
      date TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Insert settings
  const settings = DB.getSettings();
  Object.entries(settings).forEach(([key, val]) => {
    try {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(val)]);
    } catch (e) {
      console.warn('Could not insert setting:', key, e);
    }
  });

  // Insert products
  const products = DB.getProducts();
  const insertProductStmt = db.prepare(`
    INSERT INTO products (id, name, barcode, category, description, buy_price, sell_price, qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  products.forEach((p) => {
    const values: SqlValue[] = [
      p.id,
      p.name,
      p.barcode || '',
      p.category || '',
      p.description || '',
      p.buy_price || 0,
      p.sell_price || 0,
      p.qty || 0,
    ];
    insertProductStmt.run(values);
  });
  insertProductStmt.free();

  // Insert parties (live Dexie via DB.getParties)
  const parties: Party[] = DB.getParties('customer').concat(DB.getParties('supplier'));
  const insertPartyStmt = db.prepare(`
    INSERT INTO parties (id, name, phone, type, balance)
    VALUES (?, ?, ?, ?, ?)
  `);
  parties.forEach((pt) => {
    const values: SqlValue[] = [
      pt.id,
      pt.name,
      pt.phone || '',
      pt.type,
      pt.balance || 0,
    ];
    insertPartyStmt.run(values);
  });
  insertPartyStmt.free();

  // Insert invoices
  const invoices = DB.getInvoices();
  const insertInvoiceStmt = db.prepare(`
    INSERT INTO invoices (id, type, party_id, party_name, date, discount, total, paid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  invoices.forEach((inv) => {
    const values: SqlValue[] = [
      inv.id,
      inv.type,
      inv.party_id ?? null,
      inv.party_name || '',
      inv.date,
      inv.discount || 0,
      inv.total || 0,
      inv.paid || 0,
    ];
    insertInvoiceStmt.run(values);
  });
  insertInvoiceStmt.free();

  // Insert invoice items (live Dexie when ready, fallback to localStorage)
  const invoiceItems: InvoiceItem[] =
    DB.getOperationalSource() === 'dexie' && storageCacheAdapter.isReady()
      ? storageCacheAdapter.getAllInvoiceItems()
      : getStored<InvoiceItem>('cashier_invoice_items_v1');
  const insertItemStmt = db.prepare(`
    INSERT INTO invoice_items (id, invoice_id, product_id, name, qty, price, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  invoiceItems.forEach((item) => {
    const values: SqlValue[] = [
      item.id || 0,
      item.invoice_id || 0,
      item.product_id || 0,
      item.name,
      item.qty ?? 0,
      item.price ?? 0,
      item.cost ?? 0,
    ];
    insertItemStmt.run(values);
  });
  insertItemStmt.free();

  // Insert payments (live Dexie when ready, fallback to localStorage)
  const payments: Payment[] =
    DB.getOperationalSource() === 'dexie' && storageCacheAdapter.isReady()
      ? storageCacheAdapter.getAllPayments()
      : getStored<Payment>('cashier_payments_v1');
  const insertPaymentStmt = db.prepare(`
    INSERT INTO payments (id, party_id, party_name, amount, date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  payments.forEach((pay) => {
    const values: SqlValue[] = [
      pay.id,
      pay.party_id || 0,
      pay.party_name || '',
      pay.amount || 0,
      pay.date,
      pay.notes || '',
    ];
    insertPaymentStmt.run(values);
  });
  insertPaymentStmt.free();

  // Insert expenses
  const expenses = DB.getExpenses();
  const insertExpenseStmt = db.prepare(`
    INSERT INTO expenses (id, recipient, amount, date, notes)
    VALUES (?, ?, ?, ?, ?)
  `);
  expenses.forEach((exp) => {
    const values: SqlValue[] = [
      exp.id,
      exp.recipient,
      exp.amount || 0,
      exp.date,
      exp.notes || '',
    ];
    insertExpenseStmt.run(values);
  });
  insertExpenseStmt.free();

  // Insert full JSON in metadata for instantaneous 1:1 lossless fidelity + SHA-256 checksum
  const fullJson = DB.backupData();
  const fullJsonSha256 = await computeUtf8Sha256(fullJson);
  db.run('INSERT INTO metadata (key, value) VALUES (?, ?)', ['json_backup', fullJson]);
  db.run('INSERT INTO metadata (key, value) VALUES (?, ?)', ['json_backup_sha256', fullJsonSha256]);
  db.run('INSERT INTO metadata (key, value) VALUES (?, ?)', ['format', 'cashier_sqlite3_v1']);
  db.run('INSERT INTO metadata (key, value) VALUES (?, ?)', ['exported_at', new Date().toISOString()]);

  const binary = db.export();
  db.close();

  // Convert binary to ArrayBuffer for standard Blob compatibility
  const blob = new Blob([binary.buffer as ArrayBuffer], { type: 'application/x-sqlite3' });
  const fileName = generateBackupFileName('autoSave');

  return { blob, fileName, binary };
  } catch (err) {
    console.warn('SQLite wasm export failed, falling back to JSON in .db format:', err);
    const fullJson = DB.backupData();
    const binary = new TextEncoder().encode(fullJson);
    const blob = new Blob([binary.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const fileName = generateBackupFileName('autoSave');
    return { blob, fileName, binary };
  }
}

/**
 * Reads any SQLite database file and extracts tables into Cashier structures
 */
export async function restoreFromSqliteBinary(uint8Array: Uint8Array): Promise<boolean> {
  const SQL = await getSqlJs();
  let db: Database | null = null;
  try {
    db = new SQL.Database(uint8Array);
    if (!db) return false;

    // 1. Check if metadata table with 'json_backup' exists (exact match)
    try {
      const metaRes = db.exec("SELECT value FROM metadata WHERE key = 'json_backup'");
      if (metaRes.length > 0 && metaRes[0].values.length > 0) {
        const jsonStr = metaRes[0].values[0][0] as string;
        if (jsonStr && (await DB.restoreDataAsync(jsonStr))) {
          return true;
        }
      }
    } catch {
      // metadata table not found, continue to relational schema parsing
    }

    // 2. Fallback: Parse generic SQLite database from other POS / Android cashier apps
    const tablesRes = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames: string[] = tablesRes[0] ? tablesRes[0].values.map((v) => String(v[0]).toLowerCase()) : [];

    // Helper to query table as array of objects
    const queryTable = (tableName: string): Record<string, any>[] => {
      try {
        if (!db) return [];
        const found = tableNames.find((t) => t.toLowerCase() === tableName.toLowerCase());
        if (!found) return [];
        const res = db.exec(`SELECT * FROM "${found}"`);
        if (!res || res.length === 0) return [];
        const columns = res[0].columns;
        return res[0].values.map((row) => {
          const obj: Record<string, any> = {};
          columns.forEach((col, idx) => {
            obj[col.toLowerCase()] = row[idx];
          });
          return obj;
        });
      } catch (e) {
        console.warn(`Could not read table ${tableName}:`, e);
        return [];
      }
    };

    // Extract products
    const productRows =
      queryTable('products').length > 0
        ? queryTable('products')
        : queryTable('items').length > 0
        ? queryTable('items')
        : queryTable('tbl_products');

    const products: Product[] = productRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      name: String(r.name || r.item_name || r.product_name || `صنف ${idx + 1}`),
      barcode: r.barcode ? String(r.barcode) : '',
      category: r.category ? String(r.category) : r.group_name ? String(r.group_name) : 'عام',
      description: r.description ? String(r.description) : '',
      buy_price: Number(r.buy_price ?? r.cost ?? r.cost_price ?? 0),
      sell_price: Number(r.sell_price ?? r.price ?? r.sale_price ?? 0),
      qty: Number(r.qty ?? r.quantity ?? r.stock ?? 0),
    }));

    // Extract parties
    const partyRows =
      queryTable('parties').length > 0
        ? queryTable('parties')
        : queryTable('customers').length > 0
        ? queryTable('customers')
        : queryTable('tbl_customers');

    const parties: Party[] = partyRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      name: String(r.name || r.customer_name || `عميل ${idx + 1}`),
      phone: r.phone ? String(r.phone) : '',
      type: (r.type === 'supplier' || r.type === 'مورد' ? 'supplier' : 'customer') as 'customer' | 'supplier',
      balance: Number(r.balance ?? r.debt ?? 0),
    }));

    // Extract invoices
    const invoiceRows =
      queryTable('invoices').length > 0
        ? queryTable('invoices')
        : queryTable('sales').length > 0
        ? queryTable('sales')
        : queryTable('tbl_invoices');

    const invoices: Invoice[] = invoiceRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      type: (r.type === 'purchase' || r.type === 'شراء' ? 'purchase' : 'sale') as 'sale' | 'purchase',
      party_id: r.party_id ? Number(r.party_id) : r.customer_id ? Number(r.customer_id) : null,
      party_name: r.party_name ? String(r.party_name) : r.customer_name ? String(r.customer_name) : 'مفرد',
      date: r.date ? String(r.date) : new Date().toISOString(),
      discount: Number(r.discount ?? 0),
      total: Number(r.total ?? r.amount ?? 0),
      paid: Number(r.paid ?? r.received ?? r.total ?? 0),
    }));

    // Extract invoice items
    const itemRows =
      queryTable('invoice_items').length > 0
        ? queryTable('invoice_items')
        : queryTable('sale_details').length > 0
        ? queryTable('sale_details')
        : queryTable('order_items');

    const invoiceItems: InvoiceItem[] = itemRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      invoice_id: Number(r.invoice_id || r.bill_id || r.sale_id || 1),
      product_id: Number(r.product_id) || 1,
      name: String(r.name || r.product_name || `بند ${idx + 1}`),
      qty: Number(r.qty ?? r.quantity ?? 1),
      price: Number(r.price ?? r.sell_price ?? 0),
      cost: Number(r.cost ?? r.buy_price ?? 0),
    }));

    // Extract payments
    const paymentRows =
      queryTable('payments').length > 0
        ? queryTable('payments')
        : queryTable('receipts');

    const payments: Payment[] = paymentRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      party_id: Number(r.party_id) || 1,
      party_name: String(r.party_name || 'عميل'),
      amount: Number(r.amount || 0),
      date: r.date ? String(r.date) : new Date().toISOString(),
      notes: r.notes ? String(r.notes) : '',
    }));

    // Extract expenses
    const expenseRows =
      queryTable('expenses').length > 0
        ? queryTable('expenses')
        : queryTable('costs');

    const expenses: Expense[] = expenseRows.map((r, idx) => ({
      id: Number(r.id) || idx + 1,
      recipient: String(r.recipient || r.title || r.name || 'مصروف عام'),
      amount: Number(r.amount || 0),
      date: r.date ? String(r.date) : new Date().toISOString(),
      notes: r.notes ? String(r.notes) : '',
    }));

    // Restore into DB if at least products or invoices exist
    if (products.length > 0 || invoices.length > 0 || parties.length > 0) {
      const syntheticBackup = {
        version: '1.0-sqlite-migrated',
        timestamp: new Date().toISOString(),
        settings: DB.getSettings(),
        products,
        parties,
        invoices,
        invoice_items: invoiceItems,
        payments,
        expenses,
      };
      return await DB.restoreDataAsync(JSON.stringify(syntheticBackup));
    }

    return false;
  } catch (err) {
    console.error('Error reading SQLite binary:', err);
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Universal restore function:
 * Accepts .db (SQLite or JSON), .json, binary ArrayBuffer, or string.
 * Accurately detects whether it is an SQLite database or JSON.
 */
export async function universalRestore(
  fileOrBuffer: File | ArrayBuffer | string
): Promise<{ success: boolean; message: string; details?: { products: number; invoices: number } }> {
  try {
    let arrayBuffer: ArrayBuffer | null = null;
    let textContent = '';

    if (typeof fileOrBuffer === 'string') {
      textContent = fileOrBuffer;
    } else if (fileOrBuffer instanceof File) {
      if (typeof FileReader !== 'undefined') {
        arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
              resolve(reader.result);
            } else {
              reject(new Error('تعذر قراءة ملف النسخة الاحتياطية'));
            }
          };
          reader.onerror = () => {
            reject(new Error(reader.error?.message || 'حدث خطأ أثناء قراءة الملف عبر FileReader'));
          };
          reader.onabort = () => {
            reject(new Error('تم إلغاء قراءة الملف'));
          };
          reader.readAsArrayBuffer(fileOrBuffer);
        });
      } else {
        arrayBuffer = await fileOrBuffer.arrayBuffer();
      }
    } else if (fileOrBuffer instanceof ArrayBuffer) {
      arrayBuffer = fileOrBuffer;
    }

    // Check if it's SQLite binary (header: "SQLite format 3\0")
    if (arrayBuffer) {
      const uint8 = new Uint8Array(arrayBuffer);
      const isSqlite =
        uint8.length >= 16 &&
        uint8[0] === 0x53 && // S
        uint8[1] === 0x51 && // Q
        uint8[2] === 0x4c && // L
        uint8[3] === 0x69 && // i
        uint8[4] === 0x74 && // t
        uint8[5] === 0x65; // e

      if (isSqlite) {
        const ok = await restoreFromSqliteBinary(uint8);
        if (ok) {
          const prods = DB.getProducts().length;
          const invs = DB.getInvoices().length;
          return {
            success: true,
            message: `تم استرجاع قاعدة البيانات بنجاح بصيغة SQLite (.db) - (${prods} صنف، ${invs} فاتورة)`,
            details: { products: prods, invoices: invs },
          };
        }
      }

      // If not sqlite or failed, try decoding text (in case .db is JSON text)
      try {
        const decoder = new TextDecoder('utf-8');
        textContent = decoder.decode(uint8);
      } catch {
        // ignore
      }
    }

    // Attempt JSON parse
    if (textContent && textContent.trim()) {
      const ok = await DB.restoreDataAsync(textContent);
      if (ok) {
        const prods = DB.getProducts().length;
        const invs = DB.getInvoices().length;
        return {
          success: true,
          message: `تم استرجاع البيانات بنجاح من الملف (.db / .json) - (${prods} صنف، ${invs} فاتورة)`,
          details: { products: prods, invoices: invs },
        };
      }
    }

    return {
      success: false,
      message: 'الملف غير صالح أو لا يحتوي على بنية قاعدة بيانات متوافقة',
    };
  } catch (err: any) {
    console.error('Universal restore error:', err);
    return {
      success: false,
      message: err.message || 'حدث خطأ أثناء فحص واسترجاع ملف النسخة الاحتياطية',
    };
  }
}
