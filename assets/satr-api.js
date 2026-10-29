/* سَطِر | SATR — عميل API خفيف (بدون مكتبات). يعمل مع Supabase REST + Auth. */
(function (w) {
  'use strict';
  var cfg = w.SATR_CONFIG || {};
  var base = String(cfg.supabaseUrl || '').replace(/\/+$/, '');

  function configured() {
    return !!(base && cfg.anonKey && !/YOUR_/.test(base + cfg.anonKey) && /^https?:\/\//.test(base));
  }

  /* ---------- حالات الطلب ---------- */
  var STATUS = ['new', 'confirmed', 'in_progress', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
  var LABEL = {
    new: 'تم استلام الطلب', confirmed: 'تم تأكيد الطلب', in_progress: 'قيد التنفيذ',
    ready: 'جاهز', out_for_delivery: 'في الطريق إليك', delivered: 'تم التسليم', cancelled: 'ملغي'
  };
  function statusLabel(s, method) {
    if (s === 'ready') return method === 'pickup' ? 'جاهز للاستلام' : 'جاهز للتوصيل';
    return LABEL[s] || s;
  }
  function flow(method) {
    return method === 'pickup'
      ? ['new', 'confirmed', 'in_progress', 'ready', 'delivered']
      : ['new', 'confirmed', 'in_progress', 'ready', 'out_for_delivery', 'delivered'];
  }

  /* ---------- رسائل الأخطاء بالعربي ---------- */
  var ERR = {
    invalid_name: 'الرجاء إدخال الاسم الكامل.',
    invalid_phone: 'الرجاء إدخال رقم هاتف صحيح.',
    invalid_delivery: 'اختر طريقة الاستلام.',
    invalid_city: 'الرجاء إدخال المدينة أو المنطقة.',
    invalid_address: 'الرجاء إدخال عنوان التوصيل التفصيلي.',
    invalid_qty: 'الكمية غير صحيحة.',
    invalid_details: 'التفاصيل طويلة جداً.',
    invalid_link: 'اكتب الرابط كاملاً، مثل https://example.com',
    invalid_product: 'المنتج المختار غير متاح.',
    rate_limited: 'تم إرسال طلبات كثيرة. حاول لاحقاً أو تواصل معنا عبر واتساب.',
    not_admin: 'هذا الحساب لا يملك صلاحية الإدارة.',
    not_found: 'العنصر غير موجود.',
    network: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مجدداً.',
    unknown: 'حدث خطأ غير متوقع. حاول مجدداً.'
  };
  function SatrError(code, status) {
    var e = new Error(ERR[code] || ERR.unknown);
    e.code = code; e.status = status || 0; return e;
  }

  /* ---------- جلسة الإدارة (sessionStorage مع بديل في الذاكرة) ---------- */
  var SK = 'satr.admin.session', memSession = null;
  function getSession() {
    if (memSession) return memSession;
    try { var v = w.sessionStorage.getItem(SK); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function setSession(s) {
    memSession = s;
    try { if (s) w.sessionStorage.setItem(SK, JSON.stringify(s)); else w.sessionStorage.removeItem(SK); } catch (e) {}
  }

  /* ---------- طلب HTTP ---------- */
  function raw(path, opt, token) {
    opt = opt || {};
    var h = { apikey: cfg.anonKey };
    /* مفاتيح sb_publishable_ ليست JWT: تُرسل في apikey فقط. رمز المدير يُرسل في Authorization */
    if (token) h.Authorization = 'Bearer ' + token; else if (!/^sb_/.test(cfg.anonKey)) h.Authorization = 'Bearer ' + cfg.anonKey;
    if (opt.body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(base + path, { method: opt.method || 'GET', headers: h,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined })
      .catch(function () { throw SatrError('network'); })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) {
            var m = (j && (j.message || j.msg || j.error_description || j.error)) || '';
            var code = ERR[m] ? m : (r.status === 401 || r.status === 403 ? 'not_admin' : 'unknown');
            var er = SatrError(code, r.status); er.detail = m; throw er;
          }
          return j;
        });
      });
  }

  function refresh() {
    var s = getSession();
    if (!s || !s.refresh_token) return Promise.reject(SatrError('not_admin', 401));
    return raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })
      .then(function (j) { saveToken(j, s.email); return getSession(); });
  }
  function saveToken(j, email) {
    setSession({ access_token: j.access_token, refresh_token: j.refresh_token, email: email || (j.user && j.user.email) || '',
      expires_at: Date.now() + ((j.expires_in || 3600) - 30) * 1000 });
  }
  /* طلب بصلاحية المدير مع تجديد تلقائي للرمز */
  function authed(path, opt) {
    var s = getSession();
    if (!s) return Promise.reject(SatrError('not_admin', 401));
    var ready = s.expires_at && Date.now() > s.expires_at ? refresh() : Promise.resolve(s);
    return ready.then(function (ss) {
      return raw(path, opt, ss.access_token).catch(function (e) {
        if (e.status !== 401) throw e;
        return refresh().then(function (s2) { return raw(path, opt, s2.access_token); });
      });
    });
  }

  /* ---------- واجهة الزبون ---------- */
  function createOrder(d) {
    return raw('/rest/v1/rpc/create_order', { method: 'POST', body: {
      p_name: d.name, p_phone: d.phone, p_delivery: d.delivery, p_city: d.city, p_address: d.address || null,
      p_product: d.product, p_qty: d.qty, p_details: d.details || null, p_link: d.link || null } });
  }
  function trackOrder(code, phone) {
    return raw('/rest/v1/rpc/track_order', { method: 'POST', body: { p_code: code, p_phone: phone } });
  }

  /* ---------- واجهة الإدارة ---------- */
  var admin = {
    session: getSession,
    signIn: function (email, password) {
      return raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email, password: password } })
        .then(function (j) {
          saveToken(j, email);
          return authed('/rest/v1/admins?select=user_id').then(function (rows) {
            if (!rows || !rows.length) { setSession(null); throw SatrError('not_admin', 403); }
            return getSession();
          }, function (e) {
            setSession(null);
            if (e.code === 'network') throw e;
            var x = SatrError('setup', e.status);
            x.message = 'تم تسجيل الدخول لكن تعذّر قراءة قاعدة البيانات (رمز ' + (e.status || '؟') + '). غالباً لم يُنفَّذ ملف setup.sql بنجاح بعد.';
            throw x;
          });
        }, function (e) {
          if (e.code === 'network') throw e;
          var d = String(e.detail || ''), x = SatrError('bad_login', e.status);
          if (/not confirmed/i.test(d)) x.message = 'الحساب غير مؤكَّد. من Supabase ← Authentication ← Users فعّل تأكيد الحساب (Confirm user).';
          else if (/invalid login/i.test(d)) x.message = 'البريد أو كلمة المرور غير صحيحة.';
          else x.message = 'تعذّر تسجيل الدخول (' + (e.status || '؟') + (d ? ': ' + d : '') + ').';
          throw x;
        });
    },
    check: function () {
      return authed('/rest/v1/admins?select=user_id').then(function (r) { return !!(r && r.length); }, function () { return false; });
    },
    signOut: function () { setSession(null); },
    listOrders: function () { return authed('/rest/v1/orders?select=*&order=created_at.desc&limit=1000'); },
    listEvents: function (id) {
      return authed('/rest/v1/order_events?select=*&order_id=eq.' + encodeURIComponent(id) + '&order=created_at.asc,id.asc');
    },
    setStatus: function (id, status, note) {
      return authed('/rest/v1/rpc/admin_set_status', { method: 'POST', body: { p_id: id, p_status: status, p_note: note || null } });
    },
    setInternalNote: function (id, note) {
      return authed('/rest/v1/rpc/admin_set_internal_note', { method: 'POST', body: { p_id: id, p_note: note || null } });
    }
  };

  w.SATR = { configured: configured, STATUS: STATUS, statusLabel: statusLabel, flow: flow,
    createOrder: createOrder, trackOrder: trackOrder, admin: admin, errorMessage: function (e) { return (e && e.message) || ERR.unknown; } };
})(window);
