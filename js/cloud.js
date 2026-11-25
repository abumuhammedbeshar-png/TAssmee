/*
 * cloud.js — الحسابات وإدارة المستخدمين عبر Firebase
 *  - Authentication: إنشاء حساب، دخول، تفعيل البريد، استعادة كلمة المرور
 *  - Firestore: users/{uid} (الملف الشخصي والإحصاءات) و users/{uid}/sessions (سجلّ الجلسات)
 * يُحمَّل SDK من خوادم Google عند الحاجة فقط، فإن لم تُملأ config.js يعمل التطبيق دون حسابات.
 */
(function (root) {
  'use strict';
  const CFG = root.TASMEE_CONFIG || {};
  const FB = CFG.firebase || {};
  const configured = !!(FB.apiKey && FB.projectId && FB.appId);
  const SDK = String(CFG.sdkBase || 'https://www.gstatic.com/firebasejs/12.19.0').replace(/\/+$/, '');
  const ADMINS = (CFG.adminEmails || []).map((e) => String(e).trim().toLowerCase()).filter((e) => e && e !== 'you@example.com');

  let A = null, F = null, auth = null, db = null, loading = null;
  const err = (code) => Object.assign(new Error(code), { code });

  function load() {
    if (!configured) return Promise.reject(err('not-configured'));
    if (!loading) {
      loading = (async () => {
        const [app, a, f] = await Promise.all([
          import(SDK + '/firebase-app.js'),
          import(SDK + '/firebase-auth.js'),
          import(SDK + '/firebase-firestore.js'),
        ]);
        A = a; F = f;
        const fbApp = app.initializeApp(FB);
        auth = a.getAuth(fbApp);
        try { auth.languageCode = 'ar'; } catch (e) { /* ignore */ }
        db = f.getFirestore(fbApp);
      })().catch((e) => { loading = null; throw e.code ? e : err('sdk-load'); });
    }
    return loading;
  }

  const userRef = (uid) => F.doc(db, 'users', uid);
  const ms = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : v.seconds ? v.seconds * 1000 : +new Date(v) || 0);
  // ما رُفع من كل جلسة، كي لا تُحسب الكلمات مرتين — يبقى بعد إغلاق التطبيق
  const SYNC_KEY = 'tasmee:synced';
  let synced = {};
  try { synced = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') || {}; } catch (e) { synced = {}; }
  function saveSynced() {
    try {
      const ks = Object.keys(synced);
      if (ks.length > 60) ks.slice(0, ks.length - 60).forEach((k) => delete synced[k]);
      localStorage.setItem(SYNC_KEY, JSON.stringify(synced));
    } catch (e) { /* ignore */ }
  }

  const Cloud = {
    configured,
    requireLogin: CFG.requireLogin !== false,
    requireVerified: CFG.requireVerifiedEmail !== false,
    user: null,
    profile: null,
    ms,

    async onChange(cb) {
      await load();
      A.onAuthStateChanged(auth, (u) => { this.user = u; if (!u) this.profile = null; cb(u); });
    },
    isAdminEmail(email) { return ADMINS.includes(String(email || '').toLowerCase()); },
    get isAdmin() {
      return !!this.user && ((this.isAdminEmail(this.user.email) && (this.user.emailVerified || !this.requireVerified)) || (!!this.profile && this.profile.role === 'admin'));
    },

    async signUp(name, email, pass) {
      await load();
      this.pendingName = name;
      const c = await A.createUserWithEmailAndPassword(auth, email, pass);
      if (name) { try { await A.updateProfile(c.user, { displayName: name }); } catch (e) { /* ignore */ } }
      if (this.requireVerified) { try { await A.sendEmailVerification(c.user); } catch (e) { /* ignore */ } }
      return c.user;
    },
    async signIn(email, pass) { await load(); return (await A.signInWithEmailAndPassword(auth, email, pass)).user; },
    async signOut() { await load(); this.profile = null; await A.signOut(auth); },
    async reset(email) { await load(); await A.sendPasswordResetEmail(auth, email); },
    async resendVerify() { await load(); await A.sendEmailVerification(auth.currentUser); },
    async reloadUser() { await load(); await auth.currentUser.reload(); this.user = auth.currentUser; return this.user; },

    /** يُنشئ ملف المستخدم أول مرة، ويحدّث «آخر دخول» */
    async ensureProfile(u) {
      const ref = userRef(u.uid);
      const snap = await F.getDoc(ref);
      if (!snap.exists()) {
        await F.setDoc(ref, {
          name: u.displayName || this.pendingName || '', email: u.email, role: 'user', status: 'active',
          createdAt: F.serverTimestamp(), lastLogin: F.serverTimestamp(), lastActive: F.serverTimestamp(),
          sessions: 0, words: 0, ok: 0,
        });
      } else if (snap.data().status !== 'blocked') {
        const patch = { lastLogin: F.serverTimestamp(), lastActive: F.serverTimestamp() };
        if (u.displayName && !snap.data().name) patch.name = u.displayName;
        try { await F.updateDoc(ref, patch); } catch (e) { /* ignore */ }
      }
      const s2 = await F.getDoc(ref);
      this.profile = Object.assign({ uid: u.uid }, s2.data());
      return this.profile;
    },

    /** رفع ملخّص جلسة تسميع (لا يُرفع نص الكتب ولا الصوت) */
    async logSession(rec) {
      if (!this.user || !db || (this.profile && this.profile.status === 'blocked')) return;
      const uid = this.user.uid;
      const prev = synced[rec.id] || { judged: 0, ok: 0 };
      const dj = rec.judged - prev.judged, dok = rec.ok - prev.ok;
      await F.setDoc(F.doc(db, 'users', uid, 'sessions', rec.id), {
        title: rec.title, kind: rec.kind, date: rec.date, judged: rec.judged, ok: rec.ok, err: rec.err,
        hint: rec.hint, accuracy: rec.accuracy, hidden: !!rec.hidden, dur: rec.dur || 0,
      });
      const patch = { lastActive: F.serverTimestamp() };
      if (dj) patch.words = F.increment(dj);
      if (dok) patch.ok = F.increment(dok);
      if (!synced[rec.id]) patch.sessions = F.increment(1);
      await F.updateDoc(userRef(uid), patch);
      synced[rec.id] = { judged: rec.judged, ok: rec.ok };
      saveSynced();
    },

    /* ---------- للمدير ---------- */
    async listUsers() {
      await load();
      const snap = await F.getDocs(F.query(F.collection(db, 'users'), F.orderBy('lastActive', 'desc'), F.limit(1000)));
      return snap.docs.map((d) => Object.assign({ uid: d.id }, d.data()));
    },
    async userSessions(uid) {
      await load();
      const snap = await F.getDocs(F.query(F.collection(db, 'users', uid, 'sessions'), F.orderBy('date', 'desc'), F.limit(20)));
      return snap.docs.map((d) => d.data());
    },
    async setStatus(uid, status) { await load(); await F.updateDoc(userRef(uid), { status }); },
    async setRole(uid, role) { await load(); await F.updateDoc(userRef(uid), { role }); },
  };

  root.Cloud = Cloud;
})(window);
