/**
 * Cashier Pro — Phase 9: Multi-Device & User Management Simulation
 *
 * محاكاة إدارة الأجهزة المتعددة، والصلاحيات (RBAC)، وجلسات العمل،
 * وإلغاء ارتباط الأجهزة، والتحكم دون اتصال.
 */

interface DeviceRecord {
  deviceId: string;
  storeId: string;
  deviceName: string;
  deviceType: 'pos_terminal' | 'manager_phone' | 'inventory_handheld';
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  pairedAt: string;
  lastSeenAt: string;
  authTokenHash: string;
}

interface UserSession {
  userId: string;
  storeId: string;
  username: string;
  role: 'owner' | 'manager' | 'cashier';
  deviceId: string;
  token: string;
  expiresAt: number;
  isRevoked: boolean;
}

interface ActionPermissionCheck {
  action: string;
  requiredRole: ('owner' | 'manager' | 'cashier')[];
  requiresSupervisorPin?: boolean;
}

class MultiDeviceAuthEngine {
  private devices = new Map<string, DeviceRecord>();
  private sessions = new Map<string, UserSession>();
  private storeSecrets = new Map<string, string>(); // storeId -> masterPairingSecret
  private auditLog: Array<{
    id: string;
    timestamp: string;
    storeId: string;
    userId: string;
    deviceId: string;
    action: string;
    status: 'allowed' | 'denied';
    reason?: string;
  }> = [];

  constructor() {
    this.storeSecrets.set('store_main_01', 'DEMO_TEST_PAIRING_CODE_01');
  }

  // 1. تسجيل وربط الأجهزة (Device Pairing)
  pairDevice(params: {
    deviceId: string;
    storeId: string;
    deviceName: string;
    deviceType: 'pos_terminal' | 'manager_phone' | 'inventory_handheld';
    pairingSecret: string;
  }): { success: boolean; message: string; device?: DeviceRecord } {
    if (this.storeSecrets.get(params.storeId) !== params.pairingSecret) {
      return { success: false, message: 'كود ربط المتجر غير صحيح أو منتهي الصلاحية' };
    }

    const device: DeviceRecord = {
      deviceId: params.deviceId,
      storeId: params.storeId,
      deviceName: params.deviceName,
      deviceType: params.deviceType,
      status: 'active',
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      authTokenHash: `tok_hash_${Math.random().toString(36).substring(2, 10)}`
    };

    this.devices.set(params.deviceId, device);
    return { success: true, message: 'تم ربط الجهاز بنجاح وتفعيله', device };
  }

  // 2. إنشاء جلسة مستخدم (Login Session)
  loginUser(params: {
    userId: string;
    storeId: string;
    username: string;
    role: 'owner' | 'manager' | 'cashier';
    deviceId: string;
  }): { success: boolean; token?: string; error?: string } {
    const dev = this.devices.get(params.deviceId);
    if (!dev) {
      return { success: false, error: 'الجهاز غير معرف بالنظام' };
    }
    if (dev.status !== 'active') {
      return { success: false, error: `الجهاز في حالة (${dev.status}) وممنوع من تسجيل الدخول` };
    }
    if (dev.storeId !== params.storeId) {
      return { success: false, error: 'الجهاز لا ينتمي لنفس المتجر' };
    }

    const token = `session_${params.userId}_${Date.now()}`;
    const session: UserSession = {
      userId: params.userId,
      storeId: params.storeId,
      username: params.username,
      role: params.role,
      deviceId: params.deviceId,
      token,
      expiresAt: Date.now() + 24 * 3600 * 1000,
      isRevoked: false
    };

    this.sessions.set(token, session);
    dev.lastSeenAt = new Date().toISOString();
    return { success: true, token };
  }

  // 3. التحقق من الصلاحيات والـ RBAC
  authorizeAction(params: {
    token: string;
    action: string;
    costVisibilityRequired?: boolean;
    supervisorPin?: string;
  }): { allowed: boolean; reason?: string } {
    const session = this.sessions.get(params.token);
    if (!session || session.isRevoked || session.expiresAt < Date.now()) {
      return { allowed: false, reason: 'جلسة العمل غير صالحة أو منتهية الصلاحية' };
    }

    const device = this.devices.get(session.deviceId);
    if (!device || device.status !== 'active') {
      return { allowed: false, reason: 'تم تعليق أو إلغاء ارتباط هذا الجهاز' };
    }

    // قواعد الصلاحيات الدقيقة:
    // الكاشير لا يرى أسعار التكلفة
    if (params.costVisibilityRequired && session.role === 'cashier') {
      this.recordAudit(session, params.action, 'denied', 'حظر الكاشير من رؤية سعر التكلفة والأرباح الصافية');
      return { allowed: false, reason: 'غير مصرح للكاشير بالاطلاع على أسعار التكلفة وأرباح النظام' };
    }

    // إلغاء الفاتورة يتطلب صلاحية المدير أو تفويض برمز PIN
    if (params.action === 'VOID_INVOICE' && session.role === 'cashier') {
      if (params.supervisorPin === 'SUPER_PIN_9999') {
        this.recordAudit(session, params.action, 'allowed', 'تم تفويض إلغاء الفاتورة بواسطة رمز المشرف');
        return { allowed: true };
      }
      this.recordAudit(session, params.action, 'denied', 'محاولة إلغاء فاتورة دون تفويض مشرف');
      return { allowed: false, reason: 'يتطلب إلغاء الفاتورة حضور المشرف وإدخال رمز PIN' };
    }

    // استعادة النسخ الاحتياطي وتعديل إعدادات المتجر محصورة في المالك
    if (['RESTORE_BACKUP', 'MODIFY_STORE_SETTINGS', 'PURGE_SYSTEM_LOGS'].includes(params.action)) {
      if (session.role !== 'owner') {
        this.recordAudit(session, params.action, 'denied', 'محاولة تنفيذ إجراء خاص بالمالك فقط');
        return { allowed: false, reason: 'هذا الإجراء مقصور فقط على مالك المتجر (Owner)' };
      }
    }

    this.recordAudit(session, params.action, 'allowed');
    return { allowed: true };
  }

  // 4. تعليق أو إلغاء ارتباط جهاز (Device Revocation)
  revokeDevice(deviceId: string, revokedByOwnerToken: string): { success: boolean; message: string } {
    const session = this.sessions.get(revokedByOwnerToken);
    if (!session || session.role !== 'owner') {
      return { success: false, message: 'صلاحية غير كافية لإلغاء ربط الأجهزة' };
    }

    const dev = this.devices.get(deviceId);
    if (!dev) {
      return { success: false, message: 'الجهاز غير موجود' };
    }

    dev.status = 'revoked';

    // إنهاء كافة الجلسات المرتبطة بهذا الجهاز فوراً
    for (const [t, s] of this.sessions.entries()) {
      if (s.deviceId === deviceId) {
        s.isRevoked = true;
      }
    }

    return { success: true, message: `تم إلغاء ارتباط الجهاز ${dev.deviceName} فورياً وإبطال جميع جلساته` };
  }

  private recordAudit(session: UserSession, action: string, status: 'allowed' | 'denied', reason?: string) {
    this.auditLog.push({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      storeId: session.storeId,
      userId: session.userId,
      deviceId: session.deviceId,
      action,
      status,
      reason
    });
  }

  getAuditLogCount() {
    return this.auditLog.length;
  }
}

async function runPhase9Audit() {
  console.log('================================================================');
  console.log('   Cashier Pro — Phase 9: Multi-Device & RBAC Simulation');
  console.log('   محاكاة إدارة الأجهزة المتعددة، وصلاحيات الأدوار، وسحب الصلاحيات');
  console.log('================================================================\n');

  const engine = new MultiDeviceAuthEngine();
  let passedTests = 0;
  const totalTests = 6;

  // Test 1: ربط أجهزة متعددة بحساب المتجر
  const dev1Res = engine.pairDevice({
    deviceId: 'pos_cashier_01',
    storeId: 'store_main_01',
    deviceName: 'نقطة بيع الصالة 1',
    deviceType: 'pos_terminal',
    pairingSecret: 'DEMO_TEST_PAIRING_CODE_01'
  });

  const dev2Res = engine.pairDevice({
    deviceId: 'manager_phone_02',
    storeId: 'store_main_01',
    deviceName: 'هاتف المدير التنفيذي',
    deviceType: 'manager_phone',
    pairingSecret: 'DEMO_TEST_PAIRING_CODE_01'
  });

  if (dev1Res.success && dev2Res.success) {
    passedTests++;
    console.log('✅ 1. نجاح ربط الأجهزة المتعددة (كاشير صالة + هاتف مدير) بكلمة سر المتجر.');
  } else {
    console.error('❌ فشل ربط الأجهزة المتعددة');
  }

  // Test 2: تسجيل الدخول وتوليد الجلسات
  const cashierLogin = engine.loginUser({
    userId: 'usr_cashier_ahmed',
    storeId: 'store_main_01',
    username: 'أحمد الكاشير',
    role: 'cashier',
    deviceId: 'pos_cashier_01'
  });

  const managerLogin = engine.loginUser({
    userId: 'usr_mgr_khaled',
    storeId: 'store_main_01',
    username: 'خالد المدير',
    role: 'manager',
    deviceId: 'manager_phone_02'
  });

  const ownerLogin = engine.loginUser({
    userId: 'usr_owner_samir',
    storeId: 'store_main_01',
    username: 'سمير المالك',
    role: 'owner',
    deviceId: 'manager_phone_02'
  });

  if (cashierLogin.success && managerLogin.success && ownerLogin.success) {
    passedTests++;
    console.log('✅ 2. نجاح تسجيل الدخول وتوليد الرموز الأمنية للأدوار الثلاثة (مالك، مدير، كاشير).');
  } else {
    console.error('❌ فشل تسجيل دخول المستخدمين');
  }

  // Test 3: حظر الكاشير من رؤية أسعار التكلفة والأرباح
  const cashierCostCheck = engine.authorizeAction({
    token: cashierLogin.token!,
    action: 'VIEW_COST_AND_PROFIT',
    costVisibilityRequired: true
  });

  const managerCostCheck = engine.authorizeAction({
    token: managerLogin.token!,
    action: 'VIEW_COST_AND_PROFIT',
    costVisibilityRequired: true
  });

  if (!cashierCostCheck.allowed && managerCostCheck.allowed) {
    passedTests++;
    console.log('✅ 3. نجاح فرض سرية التكلفة: حظر الكاشير من الاطلاع على أسعار التكلفة وسماح ذلك للمدير.');
  } else {
    console.error('❌ فشل التحقق من سرية التكلفة');
  }

  // Test 4: حظر الكاشير من إلغاء الفاتورة بدون PIN المشرف
  const cashierVoidNoPin = engine.authorizeAction({
    token: cashierLogin.token!,
    action: 'VOID_INVOICE'
  });

  const cashierVoidWithPin = engine.authorizeAction({
    token: cashierLogin.token!,
    action: 'VOID_INVOICE',
    supervisorPin: 'SUPER_PIN_9999'
  });

  if (!cashierVoidNoPin.allowed && cashierVoidWithPin.allowed) {
    passedTests++;
    console.log('✅ 4. نجاح قفل العمليات الحساسة (إلغاء فاتورة) باشتراط تفويض المشرف (Supervisor PIN).');
  } else {
    console.error('❌ فشل نظام تفويض المشرف');
  }

  // Test 5: حظر غير المالك من استعادة النسخ الاحتياطية وتغيير إعدادات المتجر
  const managerRestoreCheck = engine.authorizeAction({
    token: managerLogin.token!,
    action: 'RESTORE_BACKUP'
  });

  const ownerRestoreCheck = engine.authorizeAction({
    token: ownerLogin.token!,
    action: 'RESTORE_BACKUP'
  });

  if (!managerRestoreCheck.allowed && ownerRestoreCheck.allowed) {
    passedTests++;
    console.log('✅ 5. نجاح قفل استعادة النسخ الاحتياطية على رتبة المالك فقط وحظر المدراء والكوادر.');
  } else {
    console.error('❌ فشل قفل الصلاحيات الحساسة على المالك');
  }

  // Test 6: سحب فوري لصلاحية جهاز ملغى أو مفقود وإبطال كافة جلساته
  const revokeRes = engine.revokeDevice('pos_cashier_01', ownerLogin.token!);
  const postRevokeCashierCheck = engine.authorizeAction({
    token: cashierLogin.token!,
    action: 'CREATE_SALE'
  });

  if (revokeRes.success && !postRevokeCashierCheck.allowed) {
    passedTests++;
    console.log('✅ 6. نجاح الإلغاء الفوري لجهاز مفقود أو معزول وحظر أي نشاط بيع منه فوراً.');
  } else {
    console.error('❌ فشل إلغاء ارتباط الجهاز وتطهير الجلسة');
  }

  console.log(`\n----------------------------------------------------------------`);
  console.log(`🏆 نتيجة المرحلة 9 (Multi-Device & RBAC Simulation): ${passedTests}/${totalTests} نجاح كامل`);
  console.log(`================================================================`);
}

runPhase9Audit().catch(err => {
  console.error('خطأ في تنفيذ المرحلة 9:', err);
  process.exit(1);
});
