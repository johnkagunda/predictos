/* ── PWA + Push Notifications shared helper ─────────────────────────────── */
(async function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  // ── Register SW ──────────────────────────────────────────────────────────
  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('[pwa] SW register failed:', e);
    return;
  }

  // ── Fetch VAPID public key ───────────────────────────────────────────────
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

  // ── Subscribe ─────────────────────────────────────────────────────────────
  async function subscribe() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      updateBtn(false, 'Notifications blocked');
      return;
    }
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      await fetch('/api/subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(sub),
      });
      localStorage.setItem('push_subscribed', '1');
      updateBtn(true);
      console.log('[pwa] Subscribed to push notifications');
    } catch (e) {
      console.warn('[pwa] Subscribe failed:', e);
      updateBtn(false, 'Failed');
    }
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────────
  async function unsubscribe() {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/subscribe', {
          method:  'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      localStorage.removeItem('push_subscribed');
      updateBtn(false);
      console.log('[pwa] Unsubscribed');
    } catch (e) {
      console.warn('[pwa] Unsubscribe failed:', e);
    }
  }

  // ── Button UI ─────────────────────────────────────────────────────────────
  function updateBtn(on, label) {
    const btn = document.getElementById('notif-btn');
    if (!btn) return;
    if (on) {
      btn.textContent = '🔔 Alerts ON';
      btn.classList.add('on');
      btn.title = 'Click to disable notifications';
    } else {
      btn.textContent = label || '🔕 Enable Alerts';
      btn.classList.remove('on');
      btn.title = 'Click to enable push notifications';
    }
  }

  // ── Wire up button ────────────────────────────────────────────────────────
  const btn = document.getElementById('notif-btn');
  if (btn) {
    // Check current state
    const existing = await reg.pushManager.getSubscription();
    updateBtn(!!existing);

    btn.addEventListener('click', async () => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribe();
      } else {
        await subscribe();
      }
    });
  }

  // ── Auto-resubscribe if they had it on before ─────────────────────────────
  const wasOn = localStorage.getItem('push_subscribed');
  if (wasOn) {
    const existing = await reg.pushManager.getSubscription();
    if (!existing) await subscribe();
  }
})();
