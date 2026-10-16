// Client-side web-push helpers: register the service worker, subscribe/
// unsubscribe the device, and report the current state so the UI can show the
// right control. On iOS, push only works once the site is installed to the Home
// Screen (standalone) — we detect that so we can prompt the user to install.

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// Installed to the Home Screen / running as an installed PWA.
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error("[push] SW registration failed:", err);
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export type PushState =
  | "unsupported"
  | "needs-install" // iOS Safari, not yet added to Home Screen
  | "denied"
  | "enabled"
  | "disabled"; // supported + permitted-or-default but not subscribed

export async function getPushState(): Promise<PushState> {
  // iOS only supports push once installed to the Home Screen — check this first,
  // since Safari can otherwise report the APIs as present before install.
  if (isIos() && !isStandalone()) return "needs-install";
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "enabled" : "disabled";
}

// Fire-and-forget: record a push/PWA lifecycle event on the server so the owner
// can see who set things up or tried to. Ignores failures (e.g. not logged in).
export function logPushEvent(type: string, detail?: Record<string, unknown>): void {
  fetch("/api/push/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, detail }),
  }).catch(() => {});
}

// Report once per session that the app is running as an installed PWA.
let pwaLaunchReported = false;
export function reportPwaLaunchOnce(): void {
  if (pwaLaunchReported || !isStandalone()) return;
  pwaLaunchReported = true;
  logPushEvent("pwa_launch");
}

export type PushPreferences = { subscribed: boolean; leads: number[] };

export async function getPreferences(): Promise<PushPreferences> {
  try {
    const res = await fetch("/api/push/preferences");
    if (!res.ok) return { subscribed: false, leads: [60] };
    return await res.json();
  } catch {
    return { subscribed: false, leads: [60] };
  }
}

// Persist which lead times (minutes before kickoff) to remind at.
export async function setLeads(leads: number[]): Promise<void> {
  await fetch("/api/push/lead", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leads }),
  });
}

// Ask for permission, subscribe, and register the subscription with the server.
// Returns the resulting state. `leads` = minutes-before-kickoff to remind at.
export async function enablePush(leads: number[]): Promise<PushState> {
  if (isIos() && !isStandalone()) {
    logPushEvent("push_needs_install");
    return "needs-install";
  }
  if (!isPushSupported()) {
    logPushEvent("push_unsupported");
    return "unsupported";
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    logPushEvent(permission === "denied" ? "push_denied" : "push_error", { permission });
    return permission === "denied" ? "denied" : "disabled";
  }

  try {
    const keyRes = await fetch("/api/push/vapid-public-key");
    const { key } = await keyRes.json();
    if (!key) throw new Error("Push is not configured on the server yet.");

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), leads }),
    });
    if (!res.ok) throw new Error("Failed to register subscription");
    return "enabled";
  } catch (err: any) {
    logPushEvent("push_error", { message: String(err?.message || err) });
    throw err;
  }
}

// Unsubscribe this device and tell the server to forget it.
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
  return "disabled";
}
