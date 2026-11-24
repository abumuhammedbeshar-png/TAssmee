/*
 * إعدادات الحسابات (Firebase)
 * ------------------------------------------------------------
 * اتركها فارغة ليعمل التطبيق دون حسابات كما كان.
 * لتفعيل تسجيل الدخول وإدارة المستخدمين: اتبع قسم «الحسابات وإدارة المستخدمين» في README.md
 * ثم الصق هنا قيم مشروعك من Firebase (Project settings ← Your apps ← SDK setup and configuration).
 */
window.TASMEE_CONFIG = {
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  },

  // بريد المدير (أو المدراء): له صلاحية لوحة إدارة المستخدمين. ضع البريد نفسه في firestore.rules
  adminEmails: ['you@example.com'],

  // true: لا يُستخدم التطبيق إلا بعد تسجيل الدخول
  requireLogin: true,

  // true: يجب تفعيل البريد الإلكتروني (رابط يصل إلى البريد) قبل الدخول
  requireVerifiedEmail: true,
};
