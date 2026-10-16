import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions, users } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

// Web-push (VAPID) config comes from the environment. Without keys the feature
// is simply disabled — the app still boots and every push call is a no-op — so
// a deploy that hasn't set the keys yet degrades gracefully.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.error("[push] invalid VAPID config, push disabled:", err);
  }
} else {
  console.warn("[push] VAPID keys not set — push notifications are disabled.");
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

// Store (or refresh) a subscription for a user's device, keyed by its unique
// endpoint so re-subscribing the same device updates rather than duplicates.
export async function saveSubscription(
  userId: number,
  groupId: number,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent: string | null,
  leads: number[],
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      userId,
      groupId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent,
      reminderLeadsMinutes: leads,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        groupId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        reminderLeadsMinutes: leads,
      },
    });
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

// Set the reminder lead times for every device belonging to this person, so the
// choice follows them across devices. Returns how many subscriptions changed.
export async function setLeadsForUser(userId: number, leads: number[]): Promise<number> {
  const ids = await siblingUserIds(userId);
  const updated = await db
    .update(pushSubscriptions)
    .set({ reminderLeadsMinutes: leads })
    .where(inArray(pushSubscriptions.userId, ids))
    .returning({ id: pushSubscriptions.id });
  return updated.length;
}

// This person's current reminder settings: whether any device is subscribed and
// the set of lead times in effect (union across their devices).
export async function getPreferencesForUser(
  userId: number,
): Promise<{ subscribed: boolean; leads: number[] }> {
  const ids = await siblingUserIds(userId);
  const subs = await db
    .select({ leads: pushSubscriptions.reminderLeadsMinutes })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, ids));
  if (subs.length === 0) return { subscribed: false, leads: [60] };
  const union = new Set<number>();
  for (const s of subs) for (const m of s.leads ?? []) union.add(m);
  return { subscribed: true, leads: Array.from(union).sort((a, b) => a - b) };
}

// All user-row ids that belong to the same *person* as the given user row —
// i.e. every group's row sharing this person's login_code. Falls back to just
// the given id if the row has no login code.
async function siblingUserIds(userId: number): Promise<number[]> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row?.loginCode) return [userId];
  const rows = await db.select().from(users).where(eq(users.loginCode, row.loginCode));
  const ids = rows.map((r) => r.id);
  return ids.length ? ids : [userId];
}

// Send a notification to every device belonging to the person who owns this
// user row. Dead subscriptions (404/410) are pruned. Returns how many devices
// were successfully notified.
export async function sendToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!configured) return 0;
  const ids = await siblingUserIds(userId);
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, ids));
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  // urgency "high" tells the push service (FCM on Android especially) to deliver
  // immediately rather than batching it until the device next wakes — otherwise
  // a locked/idle Android phone in Doze can hold the notification indefinitely.
  // TTL keeps it deliverable for a day if the device is briefly offline.
  const options = { urgency: "high" as const, TTL: 24 * 60 * 60 };
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          options,
        );
        sent++;
      } catch (err: any) {
        const status = err?.statusCode;
        // Name the push service so iOS vs Android failures are distinguishable
        // in the logs.
        const host = (() => {
          try {
            return new URL(s.endpoint).host;
          } catch {
            return "?";
          }
        })();
        if (status === 404 || status === 410) {
          // Subscription is gone — prune it.
          await deleteSubscription(s.endpoint).catch(() => {});
        } else {
          console.error(`[push] send failed (${host}):`, status, err?.body || err?.message);
        }
      }
    }),
  );
  return sent;
}
