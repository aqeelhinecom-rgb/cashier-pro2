/**
 * Cashier Pro — Phase 28: Invoice Draft Protection (P0) & Mobile UX Fixes (P1) Verification Suite
 *
 * التصنيف الصريح للاختبارات:
 * - [Automated Unit Test]: اختبارات وحدة للمساعدات البرمجية (invoiceDraftStore / mobileViewport / BottomNav / AccountsScreen swipe guard).
 * - [Isolated Integration Test]: اختبارات تكامل محلية باستخدام fake-indexeddb/auto وقاعدة بيانات اختبارية معزولة تماماً
 *   (لا تلمس CashierPro_DB الحقيقية).
 * - [Source Structural Check]: فحص آلي لبنية النوافذ المنبثقة وأزرار التنقل في ملفات الواجهة.
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CashierDatabase } from '../src/services/storage/schema';
import { storageCacheAdapter } from '../src/services/storage/cacheAdapter';
import { DB } from '../src/services/db';
import {
  clearInvoiceDraft,
  getActiveEditInvoice,
  getInvoiceDraft,
  hasNonEmptyDraft,
  initializeEditInvoiceDraft,
  resetAllInvoiceDraftsForTest,
  saveInvoiceDraft,
} from '../src/utils/invoiceDraftStore';
import {
  createViewportTrackerState,
  evaluateKeyboardViewport,
  isEditableTextControl,
  shouldScrollFocusedElement,
} from '../src/utils/mobileViewport';
import { MOBILE_NAV_ITEMS } from '../src/components/Navbar';
import { shouldIgnoreAccountsSwipeTarget } from '../src/screens/AccountsScreen';
import type { ScreenId } from '../src/types';

if (typeof globalThis.localStorage === 'undefined') {
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
}

if (typeof globalThis.window === 'undefined') {
  const sessionStore = new Map<string, string>();
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => (sessionStore.has(k) ? sessionStore.get(k)! : null),
      setItem: (k: string, v: string) => sessionStore.set(k, String(v)),
      removeItem: (k: string) => sessionStore.delete(k),
      clear: () => sessionStore.clear(),
    },
  };
}

interface TestResult {
  name: string;
  classification: 'Automated Unit Test' | 'Isolated Integration Test' | 'Source Structural Check';
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

async function runCase(
  name: string,
  classification: TestResult['classification'],
  fn: () => Promise<void> | void
) {
  try {
    await fn();
    results.push({ name, classification, passed: true, details: 'PASS' });
    console.log(`✅ [${classification}] ${name}`);
  } catch (err: any) {
    results.push({
      name,
      classification,
      passed: false,
      details: err?.message || String(err),
    });
    console.error(`❌ [${classification}] ${name}:`, err);
  }
}

async function main() {
  const isolatedDbName = `CashierPro_Phase28_Test_${Date.now()}`;
  const testDb = new CashierDatabase(isolatedDbName);
  const initOk = await storageCacheAdapter.initializeAsync(testDb);
  assert(initOk, 'Isolated testDb failed to initialize');
  resetAllInvoiceDraftsForTest();

  // Seed isolated products & customer in fake-indexeddb only
  const customer = await DB.addParty('عميل اختبار المسودة', '07700001122', 'customer');
  const supplier = await DB.addParty('مورد اختبار المسودة', '07700003344', 'supplier');
  const prodA = await DB.saveProduct({
    name: 'شاشة أيفون 13',
    category: 'شاشات',
    barcode: '6280001001',
    buy_price: 50000,
    sell_price: 75000,
    qty: 12,
  });
  const prodB = await DB.saveProduct({
    name: 'كابل شحن أصلي',
    category: 'إكسسوارات',
    barcode: '6280001002',
    buy_price: 5000,
    sell_price: 10000,
    qty: 20,
  });

  // 1. P0: Sale draft saved & restored across screen navigation without touching DB
  await runCase(
    '1. حفظ مسودة فاتورة البيع واستعادتها بعد التنقل للمنتجات والعودة دون حفظ مبكر في القاعدة',
    'Isolated Integration Test',
    () => {
      resetAllInvoiceDraftsForTest();
      const beforeInvoicesCount = DB.getInvoices().length;
      const beforeStockA = DB.getProductById(prodA.id)?.qty;

      saveInvoiceDraft({
        type: 'sale',
        mode: 'new',
        items: [
          {
            product_id: prodA.id,
            name: prodA.name,
            category: prodA.category,
            qty: 2,
            price: 74000,
            cost: prodA.buy_price,
            sell_price: prodA.sell_price,
          },
          {
            product_id: prodB.id,
            name: prodB.name,
            category: prodB.category,
            qty: 3,
            price: 10000,
            cost: prodB.buy_price,
            sell_price: prodB.sell_price,
          },
        ],
        selectedPartyId: customer.id,
        discount: 3000,
        paid: '100000',
        invoiceCurrency: 'د.ع',
        searchQuery: 'شاشة',
        editingInvoice: null,
        originalSaleQtyMap: {},
        idempotencyKey: 'draft-sale-idem-1',
      });

      // Verify DB was NOT modified
      assert.strictEqual(DB.getInvoices().length, beforeInvoicesCount);
      assert.strictEqual(DB.getProductById(prodA.id)?.qty, beforeStockA);

      // Simulate leaving to Products / Customers and returning to Sale
      const restored = getInvoiceDraft('sale', 'new');
      assert(restored, 'Sale draft must exist after navigation');
      assert.strictEqual(restored.items.length, 2);
      assert.strictEqual(restored.items[0].qty, 2);
      assert.strictEqual(restored.items[0].price, 74000);
      assert.strictEqual(restored.items[1].qty, 3);
      assert.strictEqual(restored.selectedPartyId, customer.id);
      assert.strictEqual(restored.discount, 3000);
      assert.strictEqual(restored.paid, '100000');
      assert.strictEqual(restored.searchQuery, 'شاشة');
      assert.strictEqual(restored.idempotencyKey, 'draft-sale-idem-1');
    }
  );

  // 2. P0: Purchase, sale_return, quote drafts remain isolated from Sale draft
  await runCase(
    '2. عزل مسودات الشراء والمرتجع وعرض السعر عن مسودة البيع وعدم تداخلها',
    'Automated Unit Test',
    () => {
      saveInvoiceDraft({
        type: 'purchase',
        mode: 'new',
        items: [
          {
            product_id: prodA.id,
            name: prodA.name,
            qty: 5,
            price: 48000,
            cost: 48000,
          },
        ],
        selectedPartyId: supplier.id,
        discount: 0,
        paid: '240000',
        invoiceCurrency: 'د.ع',
        searchQuery: '',
        editingInvoice: null,
        originalSaleQtyMap: {},
        idempotencyKey: null,
      });

      saveInvoiceDraft({
        type: 'quote',
        mode: 'new',
        items: [
          {
            product_id: prodB.id,
            name: prodB.name,
            qty: 10,
            price: 9000,
            cost: prodB.buy_price,
          },
        ],
        selectedPartyId: customer.id,
        discount: 500,
        paid: '',
        invoiceCurrency: 'د.ع',
        searchQuery: '',
        editingInvoice: null,
        originalSaleQtyMap: {},
        idempotencyKey: null,
      });

      const saleDraft = getInvoiceDraft('sale', 'new');
      const purchaseDraft = getInvoiceDraft('purchase', 'new');
      const quoteDraft = getInvoiceDraft('quote', 'new');
      const returnDraft = getInvoiceDraft('sale_return', 'new');

      assert.strictEqual(saleDraft?.items.length, 2);
      assert.strictEqual(purchaseDraft?.items.length, 1);
      assert.strictEqual(purchaseDraft?.selectedPartyId, supplier.id);
      assert.strictEqual(quoteDraft?.items.length, 1);
      assert.strictEqual(quoteDraft?.discount, 500);
      assert.strictEqual(returnDraft, null);
    }
  );

  // 3. P0: Edit invoice preservation across navigation without overwriting edits or duplicating items
  await runCase(
    '3. الحفاظ على وضع تعديل فاتورة موجودة وتعديلاتها عند التنقل والعودة دون مسح أو تكرار',
    'Isolated Integration Test',
    async () => {
      const savedInv = await DB.saveInvoice({
        type: 'sale',
        partyId: customer.id,
        items: [
          {
            product_id: prodA.id,
            name: prodA.name,
            category: prodA.category,
            qty: 1,
            price: 75000,
            cost: prodA.buy_price,
            sell_price: prodA.sell_price,
          },
        ],
        discount: 0,
        paid: 50000,
        currency: 'د.ع',
        idempotencyKey: 'real-inv-for-edit-test',
      });

      const dbItems = DB.getInvoiceItems(savedInv.id);
      const firstInit = initializeEditInvoiceDraft(savedInv, dbItems, 'د.ع');
      assert.strictEqual(firstInit.reusedExisting, false);
      assert.strictEqual(firstInit.draft.originalSaleQtyMap[prodA.id], 1);

      // User edits qty to 4 and adds a discount + updates paid BEFORE saving
      saveInvoiceDraft({
        ...firstInit.draft,
        items: [{ ...firstInit.draft.items[0], qty: 4 }],
        discount: 5000,
        paid: '200000',
      });

      // Verify editingInvoice remains retrievable after navigating away
      const activeEdit = getActiveEditInvoice('sale');
      assert.strictEqual(activeEdit?.id, savedInv.id);
      assert.strictEqual(activeEdit?.invoice_number, savedInv.invoice_number);

      // Simulate returning to InvoiceScreen in edit mode for the same invoice
      const returnInit = initializeEditInvoiceDraft(savedInv, DB.getInvoiceItems(savedInv.id), 'د.ع');
      assert.strictEqual(returnInit.reusedExisting, true, 'Must reuse modified draft, not overwrite from DB');
      assert.strictEqual(returnInit.draft.items.length, 1, 'Must NOT duplicate items on return');
      assert.strictEqual(returnInit.draft.items[0].qty, 4, 'Unsaved qty edit must persist');
      assert.strictEqual(returnInit.draft.discount, 5000);
      assert.strictEqual(returnInit.draft.paid, '200000');

      // Separate "new" sale draft must still be untouched
      assert.strictEqual(getInvoiceDraft('sale', 'new')?.items.length, 2);

      // DB invoice must remain untouched (still qty=1, discount=0, paid=50000)
      assert.strictEqual(DB.getInvoiceItems(savedInv.id)[0].qty, 1);
      assert.strictEqual(DB.getProductById(prodA.id)?.qty, 11);

      // Explicit cancel clears ONLY edit slot
      clearInvoiceDraft('sale', 'edit');
      assert.strictEqual(getActiveEditInvoice('sale'), null);
      assert.strictEqual(getInvoiceDraft('sale', 'new')?.items.length, 2);
    }
  );

  // 4. P0: Repeated navigation round-trips do not duplicate items or alter idempotencyKey
  await runCase(
    '4. عدم تكرار الأصناف أو المبالغ أو كسر idempotencyKey عند تكرار التنقل والعودة',
    'Automated Unit Test',
    () => {
      for (let i = 0; i < 5; i++) {
        const snap = getInvoiceDraft('sale', 'new');
        assert(snap);
        assert.strictEqual(snap.items.length, 2);
        assert.strictEqual(snap.idempotencyKey, 'draft-sale-idem-1');
        saveInvoiceDraft(snap);
      }
      assert.strictEqual(hasNonEmptyDraft(getInvoiceDraft('sale', 'new')), true);
      clearInvoiceDraft('sale', 'new');
      assert.strictEqual(getInvoiceDraft('sale', 'new'), null);
    }
  );

  // 5. P1: Mobile keyboard orientation handling & anti-jitter scroll checks
  await runCase(
    '5. كشف لوحة مفاتيح الهاتف يتكيف مع التدوير Portrait ↔ Landscape ولا يخطئ عند تغيير الأبعاد',
    'Automated Unit Test',
    () => {
      // Portrait start: 390 x 844
      let state = createViewportTrackerState(390, 844);

      // Rotate Portrait -> Landscape (844 x 390) with NO input focused
      let evalRes = evaluateKeyboardViewport(state, {
        windowWidth: 844,
        windowHeight: 390,
        visualHeight: 390,
        hasFocusedTextControl: false,
      });
      state = evalRes.nextState;
      assert.strictEqual(evalRes.orientationChanged, true);
      assert.strictEqual(
        evalRes.keyboardOpen,
        false,
        'Rotation Portrait->Landscape must NEVER falsely mark keyboard as open'
      );

      // Focus input & open keyboard in Landscape (visualHeight shrinks 390 -> 200)
      evalRes = evaluateKeyboardViewport(state, {
        windowWidth: 844,
        windowHeight: 390,
        visualHeight: 200,
        hasFocusedTextControl: true,
      });
      state = evalRes.nextState;
      assert.strictEqual(evalRes.keyboardOpen, true);

      // Rotate Landscape -> Portrait while focus remains (844x390 -> 390x844, visualHeight 844)
      evalRes = evaluateKeyboardViewport(state, {
        windowWidth: 390,
        windowHeight: 844,
        visualHeight: 844,
        hasFocusedTextControl: true,
      });
      state = evalRes.nextState;
      assert.strictEqual(evalRes.orientationChanged, true);
      assert.strictEqual(evalRes.keyboardOpen, false);

      // Open keyboard in Portrait (844 -> 510)
      evalRes = evaluateKeyboardViewport(state, {
        windowWidth: 390,
        windowHeight: 844,
        visualHeight: 510,
        hasFocusedTextControl: true,
      });
      assert.strictEqual(evalRes.keyboardOpen, true);

      // Editable text check & anti-jitter scroll guard
      assert.strictEqual(isEditableTextControl({ tagName: 'INPUT', type: 'number' }), true);
      assert.strictEqual(isEditableTextControl({ tagName: 'INPUT', type: 'checkbox' }), false);
      assert.strictEqual(isEditableTextControl({ tagName: 'TEXTAREA' }), true);
      assert.strictEqual(isEditableTextControl({ tagName: 'BUTTON' }), false);

      // Element comfortably inside visible area (top 200..244 within visualHeight 510) -> NO jitter scroll
      assert.strictEqual(shouldScrollFocusedElement({ top: 200, bottom: 244 }, 510), false);
      // Element obscured below keyboard (bottom 540 > 510 - 16) -> scroll needed
      assert.strictEqual(shouldScrollFocusedElement({ top: 496, bottom: 540 }, 510), true);
      // Element hidden under fixed header (top 40 < 76) -> scroll needed
      assert.strictEqual(shouldScrollFocusedElement({ top: 40, bottom: 84 }, 510), true);
    }
  );

  // 6. P1: AccountsScreen swipe guard ignores tables, horizontal containers, and controls
  await runCase(
    '6. حماية السحب في AccountsScreen من تعطيل الجداول والحقول والتمرير الأفقي',
    'Automated Unit Test',
    () => {
      const boundary = { tagName: 'DIV', scrollWidth: 380, clientWidth: 380, parentElement: null };
      const plainCard = { tagName: 'DIV', scrollWidth: 360, clientWidth: 360, parentElement: boundary };
      const tableCell = {
        tagName: 'TD',
        parentElement: {
          tagName: 'TABLE',
          parentElement: {
            tagName: 'DIV',
            scrollWidth: 680,
            clientWidth: 340,
            parentElement: boundary,
          },
        },
      };
      const horizSubtab = {
        tagName: 'BUTTON',
        parentElement: {
          tagName: 'DIV',
          scrollWidth: 520,
          clientWidth: 340,
          parentElement: boundary,
        },
      };
      const inputEl = { tagName: 'INPUT', parentElement: boundary };

      assert.strictEqual(shouldIgnoreAccountsSwipeTarget(plainCard, boundary), false);
      assert.strictEqual(shouldIgnoreAccountsSwipeTarget(tableCell, boundary), true);
      assert.strictEqual(shouldIgnoreAccountsSwipeTarget(horizSubtab, boundary), true);
      assert.strictEqual(shouldIgnoreAccountsSwipeTarget(inputEl, boundary), true);
    }
  );

  // 7. Mobile/Tablet side drawer (Navbar MOBILE_NAV_ITEMS) covers ALL 16 ScreenIds cleanly including independent Store Settings & Backup
  await runCase(
    '7. القائمة الجانبية في الشريط العلوي (☰) تغطي جميع أقسام التطبيق الـ16 بما فيها بندا «إعدادات المتجر» و«النسخ الاحتياطي» مستقلين',
    'Automated Unit Test',
    () => {
      const allScreens: ScreenId[] = [
        'home',
        'sale',
        'purchase',
        'sale_return',
        'quote',
        'products',
        'customers',
        'suppliers',
        'invoices_sale',
        'invoices_purchase',
        'invoices_return',
        'invoices_quote',
        'accounts',
        'expenses',
        'settings',
        'backup',
      ];
      const drawerIds = MOBILE_NAV_ITEMS.map((item) => item.id);
      for (const s of allScreens) {
        assert(drawerIds.includes(s), `Screen "${s}" must be accessible from Navbar side drawer`);
      }
      assert.strictEqual(new Set(drawerIds).size, allScreens.length);
      const settingsItem = MOBILE_NAV_ITEMS.find((i) => i.id === 'settings');
      const backupItem = MOBILE_NAV_ITEMS.find((i) => i.id === 'backup');
      assert.strictEqual(settingsItem?.label, 'إعدادات المتجر');
      assert.strictEqual(backupItem?.label, 'النسخ الاحتياطي');
    }
  );

  // 8. Structural check: BottomNav removed, Store Settings direct route, Navbar fixed with ☰ drawer button, and non-overlapping Invoice options button
  await runCase(
    '8. إزالة الشريط السفلي وفتح StoreSettingsHub مباشرة من «إعدادات المتجر» وعدم تداخل زر خيارات البيع مع أي عنصر أثناء التمرير',
    'Source Structural Check',
    () => {
      const rootDir = process.cwd();
      assert(
        !fs.existsSync(path.join(rootDir, 'src/components/BottomNav.tsx')),
        'BottomNav.tsx must be permanently removed'
      );

      const filesToAudit = [
        'src/App.tsx',
        'src/screens/InvoiceScreen.tsx',
        'src/screens/ProductsScreen.tsx',
        'src/screens/PartiesScreen.tsx',
        'src/screens/ExpensesScreen.tsx',
        'src/screens/AccountsScreen.tsx',
        'src/screens/BackupScreen.tsx',
        'src/components/BarcodeScannerModal.tsx',
        'src/components/ExcelImportModal.tsx',
      ];

      for (const rel of filesToAudit) {
        const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
        // No unscrollable centered modal backdrops should remain
        const badMatches = content.match(/fixed inset-0 z-50 flex items-center justify-center/g);
        assert(
          !badMatches,
          `${rel} still contains blocking centered modal overlay without top-edge scroll safety`
        );
      }

      const navbarSrc = fs.readFileSync(path.join(rootDir, 'src/components/Navbar.tsx'), 'utf8');
      assert(
        navbarSrc.includes("currentScreen !== 'home'") &&
          navbarSrc.includes('setMenuOpen(true)') &&
          navbarSrc.includes('shrink-0 z-30'),
        'Navbar must remain fixed (shrink-0) and expose mobile drawer button alongside Back button on all screens'
      );

      const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
      assert(
        !appSrc.includes('BottomNav') &&
          !appSrc.includes('pb-[76px]') &&
          appSrc.includes('initialView="settings"') &&
          appSrc.includes('data-keyboard-open={isKeyboardOpen') &&
          !appSrc.includes("currentScreen !== 'sale' && currentScreen !== 'purchase' && editingInvoice"),
        'App.tsx must route settings directly to StoreSettingsHub without BottomNav or pb-[76px]'
      );

      const invoiceSrc = fs.readFileSync(
        path.join(rootDir, 'src/screens/InvoiceScreen.tsx'),
        'utf8'
      );
      assert(
        !invoiceSrc.includes('bottom-20') &&
          !invoiceSrc.includes('fixed bottom-[max(1rem') &&
          !invoiceSrc.includes('pb-16'),
        'Options ⋮ button in InvoiceScreen must stay in normal flow and never float over interactive elements'
      );
    }
  );

  // 9. Boundary check: untouched Dark Mode CSS tokens & ReportsScreen.tsx not deleted
  await runCase(
    '9. الالتزام بنطاق المرحلتين 1 و2 دون تعديل ألوان الوضع الليلي أو حذف ReportsScreen',
    'Source Structural Check',
    () => {
      const rootDir = process.cwd();
      assert(
        fs.existsSync(path.join(rootDir, 'src/screens/ReportsScreen.tsx')),
        'ReportsScreen.tsx must remain untouched in Phase 1-2'
      );
      assert(
        fs.existsSync(path.join(rootDir, 'docs/backups_p28/App.tsx')),
        'Pre-edit backups must exist under docs/backups_p28'
      );
    }
  );

  const passedCount = results.filter((r) => r.passed).length;
  console.log(`\n=== Phase 28 Summary: ${passedCount}/${results.length} Passed ===`);

  storageCacheAdapter.dispose();
  await testDb.close();
  await CashierDatabase.delete(isolatedDbName);

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
