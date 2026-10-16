// Generate a VAPID key pair for web-push. Run once, then set the output as
// environment variables (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) in every
// environment that should send kickoff reminders. Keep the private key secret.
//
//   npx tsx scripts/generateVapidKeys.ts
//
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("# Also set VAPID_SUBJECT=mailto:you@example.com");
