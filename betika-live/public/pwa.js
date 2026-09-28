/* ── PWA + Push Notifications + Install prompt ──────────────────────────── */
(async function () {
  // ── Install prompt ────────────────────────────────────────────────────────
  let deferredInstall = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    showInstallBtn();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    hideInstallBtn();
    console.log('[pwa] App installed');
  });

  function showInstallBtn() {
    const btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'flex';
  }
  function hideInstallBtn() {
    const btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'none';
  }

  // Wire install button click
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      console.log('[pwa] Install outcome:', outcome);
      deferredInstall = null;
      if (outcome === 'accepted') hideInstallBtn();
    });
  }

  // ── Service Worker + Push ─────────────────────────────────────────────────
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('[pwa] SW register failed:', e);
    return;
  }

  // Fetch VAPID public key
  let vapidKey;
  try {
    const r = await fetch('/api/vapid-public');
    const j = await r.json();
    vapidKey = j.key;
  } catch (e) {
    console.warn('[pwa] Could not fetch VAPID key:', e);
    return;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function subscribe() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { updateNotifBtn(false, 'Blocked'); return; }
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      localStorage.setItem('push_subscribed', '1');
      updateNotifBtn(true);
    } catch (e) {
      console.warn('[pwa] Subscribe failed:', e);
      updateNotifBtn(false, 'Failed');
    }
  }

  async function unsubscribe() {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      localStorage.removeItem('push_subscribed');
      updateNotifBtn(false);
    } catch (e) {
      console.warn('[pwa] Unsubscribe failed:', e);
    }
  }

  function updateNotifBtn(on, label) {
    const btn = document.getElementById('notif-btn');
    if (!btn) return;
    btn.textContent = on ? '🔔 Alerts ON' : (label || '🔕 Enable Alerts');
    btn.classList.toggle('on', on);
  }

  const notifBtn = document.getElementById('notif-btn');
  if (notifBtn) {
    const existing = await reg.pushManager.getSubscription();
    updateNotifBtn(!!existing);
    notifBtn.addEventListener('click', async () => {
      const sub = await reg.pushManager.getSubscription();
      sub ? await unsubscribe() : await subscribe();
    });
  }

  // Auto-resubscribe if previously opted in
  if (localStorage.getItem('push_subscribed')) {
    const existing = await reg.pushManager.getSubscription();
    if (!existing) await subscribe();
  }
})();
