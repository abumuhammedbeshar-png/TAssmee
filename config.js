/*
 * إعدادات الحسابات (Firebase)
 * ------------------------------------------------------------
 * اتركها فارغة ليعمل التطبيق دون حسابات كما كان.
 * لتفعيل تسجيل الدخول وإدارة المستخدمين: اتبع قسم «الحسابات وإدارة المستخدمين» في README.md
 * ثم الصق هنا قيم مشروعك من Firebase (Project settings ← Your apps ← SDK setup and configuration).
 */
window.TASMEE_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyAmtVDYi8ulIhCJDPxoEaMaFqfFhntBFzQ',
    authDomain: 'bashar-4b559.firebaseapp.com',
    projectId: 'bashar-4b559',
    storageBucket: 'bashar-4b559.firebasestorage.app',
    messagingSenderId: '976411703498',
    appId: '1:976411703498:web:99f34ae7f82e676ef11c33',
  },

  // بريد المدير (أو المدراء): له صلاحية لوحة إدارة المستخدمين. ضع البريد نفسه في firestore.rules
  adminEmails: ['sluk2hm@gmail.com'],

  // true: لا يُستخدم التطبيق إلا بعد تسجيل الدخول
  requireLogin: true,

  // true: يجب تفعيل البريد الإلكتروني (رابط يصل إلى البريد) قبل الدخول
  requireVerifiedEmail: true,
};
