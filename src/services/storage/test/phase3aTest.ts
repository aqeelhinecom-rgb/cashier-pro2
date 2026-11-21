// @ts-ignore
import 'fake-indexeddb/auto';
import { CashierDatabase } from '../schema';
import { StorageCacheAdapter, StorageInitState } from '../cacheAdapter';
import { DB } from '../../db';

export interface Phase3aTestReport {
  allPassed: boolean;
  totalTests: number;
  passedTests: number;
  results: {
    id: number;
    name: string;
    passed: boolean;
    details: string;
  }[];
}

export async function runPhase3aTestSuite(): Promise<Phase3aTestReport> {
  const results: Phase3aTestReport['results'] = [];

  // -------------------------------------------------------------
  // Test 1: Four Initialization States (UNINITIALIZED, INITIALIZING, READY, FAILED)
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Phase3a_StateTest_${Date.now()}`);
    const adapter = new StorageCacheAdapter(testDb);

    // Initial state
    const state1 = adapter.getState();
    if (state1 !== StorageInitState.UNINITIALIZED) {
      throw new Error(`الحالة الأولية غير صحيحة: المتوقع UNINITIALIZED، الفعلي: ${state1}`);
    }

    // Trigger initialization
    const initPromise = adapter.initializeAsync();
    const state2 = adapter.getState();
    if (state2 !== StorageInitState.INITIALIZING && state2 !== StorageInitState.READY) {
      throw new Error(`حالة قيد التهيئة غير صحيحة: ${state2}`);
    }

    const initSuccess = await initPromise;
    const state3 = adapter.getState();
    if (!initSuccess || state3 !== StorageInitState.READY) {
      throw new Error(`حالة الجاهزية غير صحيحة: المتوقع READY، الفعلي: ${state3}`);
    }

    // Test failure state with an intentionally broken/closed database
    const brokenDb = new CashierDatabase(`Phase3a_Broken_${Date.now()}`);
    // Simulate error by closing and defining an invalid table getter
    const brokenAdapter = new StorageCacheAdapter(brokenDb);
    // Overwrite db.open with a rejection
    (brokenDb as any).open = async () => {
      throw new Error('SIMULATED_DB_CONNECTION_FAILURE');
    };

    const failSuccess = await brokenAdapter.initializeAsync();
    const state4 = brokenAdapter.getState();
    const err = brokenAdapter.getLastError();

    if (failSuccess || state4 !== StorageInitState.FAILED || !err?.message.includes('SIMULATED_DB_CONNECTION_FAILURE')) {
      throw new Error(`حالة الفشل FAILED لم تتحقق بالشكل الصحيح: ${state4}`);
    }

    await testDb.delete();
    await brokenDb.delete();

    results.push({
      id: 1,
      name: 'اختبار حالات التهيئة الأربع (UNINITIALIZED, INITIALIZING, READY, FAILED)',
      passed: true,
      details: 'تم التحقق من الانتقال بين كافة الحالات بنجاح، والتقاط رسالة الخطأ عند فشل الاتصال.',
    });
  } catch (err: any) {
    results.push({
      id: 1,
      name: 'اختبار حالات التهيئة الأربع',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 2: Guard against reading operational data before READY
  // -------------------------------------------------------------
  try {
    const uninitDb = new CashierDatabase(`Phase3a_GuardTest_${Date.now()}`);
    const uninitAdapter = new StorageCacheAdapter(uninitDb);

    let threwOnProducts = false;
    try {
      uninitAdapter.getProducts();
    } catch (e: any) {
      if (e.message.includes('قبل اكتمال التهيئة')) {
        threwOnProducts = true;
      }
    }

    let threwOnInvoices = false;
    try {
      uninitAdapter.getInvoices();
    } catch (e: any) {
      if (e.message.includes('قبل اكتمال التهيئة')) {
        threwOnInvoices = true;
      }
    }

    let threwOnSettings = false;
    try {
      uninitAdapter.getSettings();
    } catch (e: any) {
      if (e.message.includes('قبل اكتمال التهيئة')) {
        threwOnSettings = true;
      }
    }

    if (!threwOnProducts || !threwOnInvoices || !threwOnSettings) {
      throw new Error('تم السماح بالقراءة من Cache قبل حالة READY وهذا يخالف معايير الأمان');
    }

    await uninitDb.delete();

    results.push({
      id: 2,
      name: 'اختبار منع قراءة البيانات التشغيلية من الـ Cache قبل الجاهزية (assertReady Guard)',
      passed: true,
      details: 'تم حظر قراءة المنتجات والفواتير والإعدادات قبل اكتمال التهيئة مع رمي استثناءات واضحة.',
    });
  } catch (err: any) {
    results.push({
      id: 2,
      name: 'اختبار منع قراءة البيانات قبل الجاهزية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 3: Safe Legacy Operational Fallback (No empty database shown)
  // -------------------------------------------------------------
  try {
    DB.init();
    // Current DB functions continue to read safely from the established operational path
    const products = DB.getProducts();
    const settings = DB.getSettings();
    const categories = DB.getCategories();

    if (!Array.isArray(products) || !settings.storeName || categories.length === 0) {
      throw new Error('تعطل مسار التشغيل الآمن للبيانات الحالية');
    }

    // Verify DB.initializeAsync is accessible without breaking legacy reads
    if (typeof DB.initializeAsync !== 'function' || typeof DB.getStorageState !== 'function') {
      throw new Error('دالة initializeAsync أو getStorageState غير معرفة في كائن DB');
    }

    results.push({
      id: 3,
      name: 'اختبار استمرار النظام القديم كمسار تشغيل آمن دون عرض بيانات فارغة للمستخدم',
      passed: true,
      details: `مسار التشغيل الآمن فعال: تم قراءة ${products.length} منتج واسم المتجر "${settings.storeName}" بنجاح دون أي تأثر.`,
    });
  } catch (err: any) {
    results.push({
      id: 3,
      name: 'اختبار استمرار النظام القديم كمسار تشغيل آمن',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 4: Commit to IndexedDB first, THEN update In-Memory Cache
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Phase3a_CommitTest_${Date.now()}`);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Save a product through adapter
    const savedProd = await adapter.saveProduct({
      name: 'منتج اختبار الالتزام أولاً',
      barcode: '9900112233',
      buy_price: 1500,
      sell_price: 2500,
      qty: 12,
    });

    // Check IndexedDB directly
    const directDbProduct = await testDb.products.get(savedProd.id);
    if (!directDbProduct || directDbProduct.name !== 'منتج اختبار الالتزام أولاً') {
      throw new Error('لم يتم حفظ المنتج في قاعدة بيانات IndexedDB');
    }

    // Check In-Memory Cache
    const cachedProducts = adapter.getProducts();
    const inCache = cachedProducts.find((p) => p.id === savedProd.id);
    if (!inCache || inCache.name !== 'منتج اختبار الالتزام أولاً' || inCache.qty !== 12) {
      throw new Error('لم يتم تحديث الـ In-Memory Cache بعد نجاح التخزين');
    }

    await testDb.delete();

    results.push({
      id: 4,
      name: 'اختبار نجاح الكتابة في IndexedDB أولاً ثم تحديث الـ Cache (Commit-First Success)',
      passed: true,
      details: `تم تثبيت المنتج في IndexedDB (ID: ${savedProd.id}) وعكسه على الفور داخل In-Memory Cache.`,
    });
  } catch (err: any) {
    results.push({
      id: 4,
      name: 'اختبار نجاح الكتابة ثم تحديث Cache',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 5: Failed Write DOES NOT mutate In-Memory Cache
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Phase3a_FailNoCache_${Date.now()}`);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Add 1 initial product
    const p1 = await adapter.saveProduct({ name: 'صنف أصلي ثابت', barcode: '111111', buy_price: 100, sell_price: 200, qty: 5 });
    const initialCacheCount = adapter.getProducts().length;

    // Simulate database failure during write
    // Force testDb.products.put to throw an error
    (testDb.products as any).put = async () => {
      throw new Error('SIMULATED_DISK_WRITE_FAILURE');
    };

    let caughtError = false;
    try {
      await adapter.saveProduct({
        id: p1.id,
        name: 'اسم مزور لا يجب أن يصل للذاكرة',
        sell_price: 999999,
      });
    } catch (e: any) {
      if (e.message.includes('SIMULATED_DISK_WRITE_FAILURE')) {
        caughtError = true;
      }
    }

    const currentCachedProducts = adapter.getProducts();
    const unchangedProd = adapter.getProductById(p1.id);

    if (!caughtError) {
      throw new Error('لم يتم التقاط خطأ فشل التخزين');
    }
    if (unchangedProd?.name === 'اسم مزور لا يجب أن يصل للذاكرة' || unchangedProd?.sell_price === 999999) {
      throw new Error('تم تلويث الـ In-Memory Cache برغم فشل التخزين على القرص! هذا خرق لقاعدة Commit-First');
    }
    if (currentCachedProducts.length !== initialCacheCount) {
      throw new Error('تغير عدد السجلات في Cache بالرغم من فشل العملية');
    }

    await testDb.delete();

    results.push({
      id: 5,
      name: 'اختبار فشل الكتابة وعدم تحديث الـ Cache نهائياً (No False Positive on Error)',
      passed: true,
      details: 'عند تعمد إفشال الكتابة في IndexedDB، رُفضت العملية وظل الـ Cache محمياً بنسبة 100% دون أي تعديل.',
    });
  } catch (err: any) {
    results.push({
      id: 5,
      name: 'اختبار فشل الكتابة وعدم تحديث Cache',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 6: Write Queue Resilience (Failed task does NOT stall queue)
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Phase3a_QueueTest_${Date.now()}`);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    const sequenceResults: string[] = [];

    // Task 1: Normal success
    const t1 = adapter.enqueueWrite(async () => {
      sequenceResults.push('task_1_success');
      return 'T1_OK';
    });

    // Task 2: Deliberately fails
    const t2 = adapter.enqueueWrite(async () => {
      sequenceResults.push('task_2_failed');
      throw new Error('ERR_TASK_2_INTENTIONAL_FAIL');
    });

    // Task 3: Normal success (Must execute even after Task 2 failed!)
    const t3 = adapter.enqueueWrite(async () => {
      sequenceResults.push('task_3_success');
      return 'T3_OK';
    });

    const [res1, res2Catch, res3] = await Promise.all([
      t1,
      t2.catch((e) => e.message),
      t3,
    ]);

    if (res1 !== 'T1_OK' || res2Catch !== 'ERR_TASK_2_INTENTIONAL_FAIL' || res3 !== 'T3_OK') {
      throw new Error('فشل تسلسل المعاملات أو تعطل الطابور بعد العملية الفاشلة');
    }

    if (sequenceResults.join(' -> ') !== 'task_1_success -> task_2_failed -> task_3_success') {
      throw new Error(`ترتيب التنفيذ غير صحيح: ${sequenceResults.join(' -> ')}`);
    }

    await testDb.delete();

    results.push({
      id: 6,
      name: 'اختبار استمرار الـ Write Queue بعد فشل عملية دون تعطل الطابور (Non-blocking Mutex)',
      passed: true,
      details: 'العملية الفاشلة أرجعت خطأ لصاحبها، والعملية التالية نفذت بنجاح كامل دون أي deadlock.',
    });
  } catch (err: any) {
    results.push({
      id: 6,
      name: 'اختبار استمرار Write Queue بعد فشل عملية',
      passed: false,
      details: err.message,
    });
  }

  // -------------------------------------------------------------
  // Test 7: Concurrency & Race-condition Prevention
  // -------------------------------------------------------------
  try {
    const testDb = new CashierDatabase(`Phase3a_RaceTest_${Date.now()}`);
    const adapter = new StorageCacheAdapter(testDb);
    await adapter.initializeAsync();

    // Insert 1 initial product
    const initialProduct = await adapter.saveProduct({
      name: 'منتج اختبار التزامن',
      buy_price: 1000,
      sell_price: 2000,
      qty: 0,
    });

    // Fire 5 concurrent stock additions simultaneously
    const deltas = [5, 10, 15, 20, 25]; // sum = 75
    await Promise.all(
      deltas.map((d) => adapter.updateStockQuantity(initialProduct.id, d))
    );

    const finalProduct = adapter.getProductById(initialProduct.id);
    const dbProduct = await testDb.products.get(initialProduct.id);

    if (finalProduct?.qty !== 75 || dbProduct?.qty !== 75) {
      throw new Error(`تعارض كتابات متزامنة: المتوقع 75، الفعلي في Cache: ${finalProduct?.qty}، في DB: ${dbProduct?.qty}`);
    }

    await testDb.delete();

    results.push({
      id: 7,
      name: 'اختبار منع تعارض العمليات المتزامنة وحماية أرصدة المخزن (Race-Condition Safe)',
      passed: true,
      details: 'تم تنفيذ 5 عمليات متزامنة في نفس اللحظة وتجميع الرصيد تسلسلياً (0 + 5 + 10 + 15 + 20 + 25 = 75) بدقة تامة.',
    });
  } catch (err: any) {
    results.push({
      id: 7,
      name: 'اختبار منع تعارض العمليات المتزامنة',
      passed: false,
      details: err.message,
    });
  }

  const passedTests = results.filter((r) => r.passed).length;
  const allPassed = passedTests === results.length;

  return {
    allPassed,
    totalTests: results.length,
    passedTests,
    results,
  };
}
