/**
 * Cashier Pro — Phase 19: Consolidated Findings Verification Suite
 *
 * يتحقق بشكل مباشر وحتمي من إغلاق جميع الملاحظات (FIND-P17-01 إلى FIND-P17-07)
 * على قواعد بيانات معزولة مؤقتة دون أي مساس بـ CashierPro_DB.
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CashierDatabase } from '../src/services/storage/schema';
import { StorageService } from '../src/services/storage/storageService';
import { StorageCacheAdapter, storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { MultiWindowSyncManager } from '../src/services/storage/sync/multiWindowSync';
import {
  createFullDexieBackup,
  computeBackupChecksum,
  validateBackupInSandbox,
  restoreDexieBackupSafely,
} from '../src/services/storage/backup/dexieBackupEngine';
import { DB } from '../src/services/db';
import { createSqliteDbBlob, getSqlJs, universalRestore } from '../src/services/dbFormat';

const checks: Array<{ id: string; name: string; passed: boolean; details: string }> = [];

function verify(id: string, name: string, condition: boolean, details: string) {
  checks.push({ id, name, passed: condition, details });
  if (!condition) {
    throw new Error(`❌ فشل [${id}] ${name}: ${details}`);
  }
  console.log(`✅ [${id}] ${name} — ${details}`);
}

function setupMockLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
  return store;
}

async function runPhase19Verification() {
  console.log('================================================================');
  console.log('   Cashier Pro — Phase 19: All Findings Closure Verification');
  console.log('================================================================\n');

  const ls = setupMockLocalStorage();

  // -------------------------------------------------------------------------
  // TEST 1 & 2: FIND-P17-01 & FIND-P17-02 (SQLite export/restore + restoreDataAsync)
  // -------------------------------------------------------------------------
  const db1Name = `Cashier_P19_Main_${Date.now()}`;
  const db1 = new CashierDatabase(db1Name);
  await db1.open();
  await DB.initializeAsync(db1);

  const cust = await DB.addParty('عميل التحقق 19', '07701234567', 'customer');
  const supp = await DB.addParty('مورد التحقق 19', '07801234567', 'supplier');
  const prod = await DB.saveProduct({
    name: 'شاشة ايفون 14 برو',
    barcode: '6289900112233',
    category: 'شاشات',
    buy_price: 80000,
    sell_price: 120000,
    qty: 10,
  });

  // Sale 2 units = 240,000, paid 140,000 (customer debt = 100,000)
  await DB.saveInvoice({
    type: 'sale',
    partyId: cust.id,
    items: [{ product_id: prod.id, name: prod.name, qty: 2, price: 120000, cost: 80000 }],
    discount: 0,
    paid: 140000,
  });
  // Payment 30,000 -> customer debt = 70,000
  await DB.addPayment(cust.id, 30000, 'تسديد جزء من الدين');
  // Sale return 1 unit = 120,000 unpaid -> customer debt = -50,000 (credit 50,000), net sales = 120,000, net profit = 40,000
  await DB.saveInvoice({
    type: 'sale_return',
    partyId: cust.id,
    items: [{ product_id: prod.id, name: prod.name, qty: 1, price: 120000, cost: 80000 }],
    discount: 0,
    paid: 0,
  });
  // Quote 500,000 -> must NOT affect customer balance or sales!
  await DB.saveInvoice({
    type: 'quote',
    partyId: cust.id,
    items: [{ product_id: prod.id, name: prod.name, qty: 1, price: 120000, cost: 80000 }],
    discount: 0,
    paid: 0,
  });
  await DB.addExpense('صيانة', 10000, 'مصروف تجريبي');

  // Verify localStorage has NO legacy tables (FIND-P17-02 check)
  ls.clear();
  const sqliteExport = await createSqliteDbBlob();
  const SQL = await getSqlJs();
  const sqlInspector = new SQL.Database(sqliteExport.binary);
  const sqParties = Number(sqlInspector.exec('SELECT COUNT(*) FROM parties')[0]?.values[0][0] || 0);
  const sqItems = Number(sqlInspector.exec('SELECT COUNT(*) FROM invoice_items')[0]?.values[0][0] || 0);
  const sqPayments = Number(sqlInspector.exec('SELECT COUNT(*) FROM payments')[0]?.values[0][0] || 0);
  sqlInspector.close();

  verify(
    'FIND-P17-02',
    'تصدير SQLite يقرأ parties وinvoice_items وpayments من Dexie الحي مع فراغ localStorage',
    sqParties === 2 && sqItems === 3 && sqPayments === 1,
    `parties=${sqParties}, invoice_items=${sqItems}, payments=${sqPayments}`
  );

  // Wipe db1 and test universalRestore with SQLite binary ArrayBuffer
  const sqliteArrayBuffer = sqliteExport.binary.buffer.slice(
    sqliteExport.binary.byteOffset,
    sqliteExport.binary.byteOffset + sqliteExport.binary.byteLength
  ) as ArrayBuffer;

  let rejectedMsg = '';
  const rejHandler = (r: any) => {
    rejectedMsg = r?.message || String(r);
  };
  process.on('unhandledRejection', rejHandler);

  await DB.restoreDataAsync(JSON.stringify({ products: [], parties: [], invoices: [], invoice_items: [], payments: [], expenses: [] }));
  assert.strictEqual(DB.getProducts().length, 0);
  assert.strictEqual(DB.getInvoices().length, 0);

  const uniSqliteRes = await universalRestore(sqliteArrayBuffer);
  await new Promise((r) => setTimeout(r, 80));
  process.off('unhandledRejection', rejHandler);

  verify(
    'FIND-P17-01',
    'استعادة ملف SQLite (.db) عبر universalRestore + restoreDataAsync تعيد جميع الجداول دون رفض خلفي',
    uniSqliteRes.success &&
      rejectedMsg === '' &&
      DB.getProducts().length === 1 &&
      (DB.getParties('customer').length + DB.getParties('supplier').length) === 2 &&
      DB.getInvoices().length === 3 &&
      storageCacheAdapter.getAllInvoiceItems().length === 3 &&
      storageCacheAdapter.getAllPayments().length === 1 &&
      DB.getExpenses().length === 1,
    `success=${uniSqliteRes.success}, err="${rejectedMsg}", prods=${DB.getProducts().length}, invs=${DB.getInvoices().length}, items=${storageCacheAdapter.getAllInvoiceItems().length}, pay=${storageCacheAdapter.getAllPayments().length}`
  );

  // Also verify relational-only SQLite fallback (without json_backup metadata row)
  const relDb = new SQL.Database();
  relDb.run(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, barcode TEXT, category TEXT, description TEXT, buy_price REAL, sell_price REAL, qty REAL);
    CREATE TABLE parties (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, type TEXT, balance REAL);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, type TEXT, party_id INTEGER, party_name TEXT, date TEXT, discount REAL, total REAL, paid REAL);
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY, invoice_id INTEGER, product_id INTEGER, name TEXT, qty REAL, price REAL, cost REAL);
    INSERT INTO products VALUES (1, 'منتج علائقي SQLite', '111222', 'عام', '', 500, 900, 12);
    INSERT INTO parties VALUES (1, 'عميل علائقي', '0771', 'customer', 0);
    INSERT INTO invoices VALUES (1, 'sale', 1, 'عميل علائقي', '${new Date().toISOString()}', 0, 1800, 1800);
    INSERT INTO invoice_items VALUES (1, 1, 1, 'منتج علائقي SQLite', 2, 900, 500);
  `);
  const relBytes = relDb.export();
  relDb.close();
  const relBuf = relBytes.buffer.slice(relBytes.byteOffset, relBytes.byteOffset + relBytes.byteLength) as ArrayBuffer;
  const relRestore = await universalRestore(relBuf);
  verify(
    'FIND-P17-01',
    'استعادة ملف SQLite عام (بدون metadata json_backup) تعيد الفواتير والبنود والأطراف',
    relRestore.success && DB.getProducts()[0]?.name === 'منتج علائقي SQLite' && DB.getInvoices().length === 1,
    `restoredProds=${DB.getProducts().length}, restoredInvs=${DB.getInvoices().length}`
  );

  // Restore full backup again using CompleteDexieBackup JSON via universalRestore
  const fullBkp = await createFullDexieBackup(db1, 'manual', 'P19 Check');
  const fullUniRes = await universalRestore(fullBkp.jsonString);
  verify(
    'FIND-P17-01',
    'استعادة CompleteDexieBackup عبر universalRestore دون فقدان أو أخطاء',
    fullUniRes.success && DB.getProducts().length === 1 && DB.getInvoices().length === 1,
    fullUniRes.message
  );

  // -------------------------------------------------------------------------
  // TEST 3: FIND-P17-03 (Net sales/profit/items/balances with sale_return & quote)
  // -------------------------------------------------------------------------
  const repoDbName = `Cashier_P19_Acc_${Date.now()}`;
  const repoDb = new CashierDatabase(repoDbName);
  await repoDb.open();
  const svc = new StorageService(repoDb);

  const c2 = await svc.parties.save({ name: 'عميل الحسابات', phone: '0770', type: 'customer' });
  const p2 = await svc.products.save({ name: 'كفر حماية', barcode: '4455', category: 'اكسسوارات', buy_price: 2000, sell_price: 5000, qty: 20 });
  // Sale 4 units -> 20,000 (cost 8,000, profit 12,000), paid 5,000 -> debt +15,000
  await svc.invoices.createInvoice({
    type: 'sale',
    partyId: c2.id,
    items: [{ product_id: p2.id!, name: p2.name, qty: 4, price: 5000, cost: 2000 }],
    discount: 0,
    paid: 5000,
  });
  // Sale return 1 unit -> 5,000 (cost 2,000, profit 3,000), paid 0 -> debt -5,000 (net debt = 10,000)
  await svc.invoices.createInvoice({
    type: 'sale_return',
    partyId: c2.id,
    items: [{ product_id: p2.id!, name: p2.name, qty: 1, price: 5000, cost: 2000 }],
    discount: 0,
    paid: 0,
  });
  // Quote 50,000 -> ignored for balance & sales
  await svc.invoices.createInvoice({
    type: 'quote',
    partyId: c2.id,
    items: [{ product_id: p2.id!, name: p2.name, qty: 10, price: 5000, cost: 2000 }],
    discount: 0,
    paid: 0,
  });

  const rep = await svc.reports.getReport(new Date(0), new Date(Date.now() + 86400000));
  const c2After = (await svc.parties.getAll('customer')).find((x) => x.id === c2.id)!;

  // Also test DB + StorageCacheAdapter (synchronous path used by UI)
  await DB.initializeAsync(repoDb);
  const syncRep = DB.getReport(new Date(0), new Date(Date.now() + 86400000));
  const syncCust = DB.getParties('customer').find((x) => x.id === c2.id)!;

  const syncAdapter = new StorageCacheAdapter();
  await syncAdapter.initializeAsync(repoDb);

  const accountsSrc = fs.readFileSync(path.join(process.cwd(), 'src/screens/AccountsScreen.tsx'), 'utf8');
  const accountsHandlesReturns = accountsSrc.includes("i.type === 'sale_return'") && accountsSrc.includes('const sales = grossSales - returnsTotal;');

  verify(
    'FIND-P17-03',
    'تطابق ReportRepository وDB/StorageCacheAdapter وPartyRepository وAccountsScreen في صافي المرتجع واستبعاد عروض السعر',
    rep.sales === 15000 &&
      rep.profit === 9000 &&
      rep.topSold[0]?.v === 3 &&
      c2After.balance === 10000 &&
      syncRep.sales === 15000 &&
      syncRep.profit === 9000 &&
      syncRep.topSold[0]?.v === 3 &&
      syncCust.balance === 10000 &&
      accountsHandlesReturns,
    `Repo sales=${rep.sales}/profit=${rep.profit}/v=${rep.topSold[0]?.v}/bal=${c2After.balance} | Cache sales=${syncRep.sales}/profit=${syncRep.profit}/v=${syncRep.topSold[0]?.v}/bal=${syncCust.balance} | AccountsScreen=${accountsHandlesReturns}`
  );

  // -------------------------------------------------------------------------
  // TEST 4: FIND-P17-04 (Cross-tab MultiWindowSync + isolated restore)
  // -------------------------------------------------------------------------
  const observer = new MultiWindowSyncManager('tab_p19_observer');
  const events: string[] = [];
  observer.onInvalidate((evt) => events.push(`${evt.table}:${evt.action}`));

  await syncAdapter.saveProduct({
    name: 'منتج بث النوافذ',
    barcode: '998877',
    category: 'عام',
    buy_price: 100,
    sell_price: 200,
    qty: 5,
  });
  await syncAdapter.addExpense('بث مصروف', 500);

  // Restore into an isolated DB without touching global storageCacheAdapter
  const isoRestoreTarget = new CashierDatabase(`Cashier_P19_Iso_${Date.now()}`);
  await isoRestoreTarget.open();
  const bkpRepo = await createFullDexieBackup(repoDb, 'manual', 'iso restore');
  const isoRes = await restoreDexieBackupSafely(bkpRepo.jsonString, isoRestoreTarget);

  observer.close();
  syncAdapter.dispose();
  await isoRestoreTarget.close();
  await isoRestoreTarget.delete();

  verify(
    'FIND-P17-04',
    'بث MultiWindowSync من StorageCacheAdapter وعزل restoreDexieBackupSafely على القواعد المؤقتة',
    events.includes('products:create') && events.includes('expenses:create') && isoRes.success,
    `events=[${events.join(', ')}], isolatedRestore=${isoRes.success}`
  );

  // -------------------------------------------------------------------------
  // TEST 5: FIND-P17-05 (12-table sandbox count validation + Firestore /users rules & blueprint)
  // -------------------------------------------------------------------------
  const parsedBkp = JSON.parse(bkpRepo.jsonString);
  // Construct tampered backup whose SHA-256 matches data, but claims wrong invoices count
  parsedBkp.tableCounts.invoices = 999;
  parsedBkp.checksum = computeBackupChecksum(parsedBkp.data);
  const countMismatchValidation = await validateBackupInSandbox(parsedBkp);

  const rulesText = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
  const blueprintText = fs.readFileSync(path.join(process.cwd(), 'firebase-blueprint.json'), 'utf8');
  const rulesSecuredUsersBackups =
    rulesText.includes('match /users/{userId}') &&
    rulesText.includes('match /backups/{backupId}') &&
    rulesText.includes('incoming().userId == userId') &&
    rulesText.includes('incoming().id == backupId') &&
    rulesText.includes('incoming().dataJson.size() <= 1048576') &&
    rulesText.includes('allow update: if false; // Cloud backups are immutable snapshots');
  const blueprintHasUsers =
    blueprintText.includes('"/users/{userId}"') &&
    blueprintText.includes('"/users/{userId}/backups/{backupId}"');

  verify(
    'FIND-P17-05',
    'التحقق من الجداول الـ 12 في Sandbox وتأمين /users/{uid}/backups في Firestore Rules والـ Blueprint',
    !countMismatchValidation.valid && rulesSecuredUsersBackups && blueprintHasUsers,
    `tamperedTableCountRejected=${!countMismatchValidation.valid}, rules=${rulesSecuredUsersBackups}, blueprint=${blueprintHasUsers}`
  );

  // -------------------------------------------------------------------------
  // TEST 6: FIND-P17-06 (Concurrent init, version=1, App.tsx sync, atomic rollback)
  // -------------------------------------------------------------------------
  const concDb = new CashierDatabase(`Cashier_P19_Conc_${Date.now()}`);
  await concDb.open();
  const concAdapter = new StorageCacheAdapter();
  const [c1, c2Init] = await Promise.all([
    concAdapter.initializeAsync(concDb),
    concAdapter.initializeAsync(concDb),
  ]);
  concAdapter.dispose();

  const pNew = await new StorageService(concDb).products.save({
    name: 'صنف إصدار 1',
    barcode: '555111',
    category: 'عام',
    buy_price: 10,
    sell_price: 20,
    qty: 5,
  });
  await new StorageService(concDb).products.updateStock(pNew.id!, 3);
  const pUpdated = await concDb.products.get(pNew.id!);

  // Fault injection on change_journal.add inside ProductRepository.save to prove atomic rollback!
  const svcConc = new StorageService(concDb);
  const countBeforeFault = await concDb.products.count();
  const origJournalAdd = concDb.change_journal.add.bind(concDb.change_journal);
  (concDb.change_journal as any).add = () => Promise.reject(new Error('INJECTED_JOURNAL_FAILURE'));
  let atomicRolledBack = false;
  try {
    await svcConc.products.save({
      name: 'صنف يجب التراجع عنه',
      barcode: '000999',
      category: 'عام',
      buy_price: 1,
      sell_price: 2,
      qty: 1,
    });
  } catch {
    const countAfterFault = await concDb.products.count();
    atomicRolledBack = countAfterFault === countBeforeFault;
  } finally {
    (concDb.change_journal as any).add = origJournalAdd;
  }

  const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  const appSyncsPermissions = (appSrc.match(/setShowFirstTimePermissions\(!DB\.isPermissionsGranted\(\)\)/g) || []).length >= 2;

  await concDb.close();
  await concDb.delete();

  verify(
    'FIND-P17-06',
    'تهيئة متزامنة آمنة + تفعيل version=1 + مزامنة أذونات App.tsx + التراجع الذري للمعاملات عند العطل',
    c1 === true && c2Init === true && pNew.version === 1 && pUpdated?.version === 2 && atomicRolledBack && appSyncsPermissions,
    `concurrent=[${c1},${c2Init}], versions=[${pNew.version}->${pUpdated?.version}], atomicRollback=${atomicRolledBack}, appPerms=${appSyncsPermissions}`
  );

  // -------------------------------------------------------------------------
  // TEST 7: FIND-P17-07 (Offline fallback on HomeScreen cards)
  // -------------------------------------------------------------------------
  const homeSrc = fs.readFileSync(path.join(process.cwd(), 'src/screens/HomeScreen.tsx'), 'utf8');
  const hasOfflineFallback = homeSrc.includes('bg-[#0f2435]') && homeSrc.includes("e.currentTarget.style.display = 'none'");

  verify(
    'FIND-P17-07',
    'خلفية احتياطية متناسقة ومعالجة فشل تحميل الصور دون اتصال في HomeScreen',
    hasOfflineFallback,
    `bg-[#0f2435] & onError handler verified`
  );

  // Cleanup remaining temp DBs and close singleton adapter cleanly
  storageCacheAdapter.dispose();
  await db1.close();
  await db1.delete();
  await repoDb.close();
  await repoDb.delete();

  console.log('\n================================================================');
  console.log(`🏆 اجتازت حزمة تحقق المرحلة 19 جميع الاختبارات: ${checks.length}/${checks.length} (100%)`);
  console.log('================================================================');
}

runPhase19Verification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ فشل اختبار المرحلة 19:', err);
    process.exit(1);
  });
