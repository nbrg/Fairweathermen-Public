import crypto from "crypto";

// Alphabet for private per-user login codes. Deliberately excludes visually
// ambiguous characters (0/O, 1/l/I) so codes are easy to read out and type.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 7;

// Generate a random login code from the unambiguous alphabet. ~31^7 ≈ 2.8e10
// possibilities — plenty of entropy for a closed friends app while staying
// short enough to share verbally.
export function generateLoginCode(length = CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const idx = crypto.randomInt(CODE_ALPHABET.length);
    out += CODE_ALPHABET[idx];
  }
  return out;
}

// Generate a code guaranteed not to collide with any existing user's code
// (i.e. not already used by another person).
export async function generateUniqueLoginCode(): Promise<string> {
  const { db } = await import("./db");
  const { users } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  // Retry on the astronomically unlikely collision.
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateLoginCode();
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.loginCode, code));
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique login code after 20 attempts");
}

// The existing code for a person, identified by username — ONLY within the
// original, hand-seeded groups (the ones without an invite link). There, a name
// really does identify one person ("Alex" in city and in rovers are the same
// human), so all their rows share one code. Self-service groups are excluded on
// purpose: anyone on the internet can create or join one under any name, so a
// name there proves nothing, and reusing a code by name would hand a stranger
// someone else's login. Returns null if no original-group row with this name
// has a code yet.
export async function codeForUsername(username: string): Promise<string | null> {
  const { db } = await import("./db");
  const { users, groups } = await import("@shared/schema");
  const { eq, and, isNotNull, isNull, inArray } = await import("drizzle-orm");
  const originalGroups = db.select({ id: groups.id }).from(groups).where(isNull(groups.inviteToken));
  const [row] = await db
    .select({ loginCode: users.loginCode })
    .from(users)
    .where(
      and(
        eq(users.username, username),
        isNotNull(users.loginCode),
        inArray(users.groupId, originalGroups),
      ),
    );
  return row?.loginCode ?? null;
}

// Resolve the code a new row in an ORIGINAL group should have: reuse the
// person's existing code if any of their (same-username) original-group rows
// already has one, otherwise mint a fresh unique code. Never use this for a
// self-service group or for an unauthenticated caller — see codeForUsername.
export async function resolveLoginCodeForUsername(username: string): Promise<string> {
  return (await codeForUsername(username)) ?? (await generateUniqueLoginCode());
}

// The login code a self-service create/join should give its new row. If the
// caller is already signed in (a verified cookie whose row still exists), the
// new row joins their existing identity, so one code keeps covering all their
// groups. Otherwise they're a new person and get a fresh code — never one found
// by name.
export async function codeForNewSelfServiceRow(signedInUserId: number | undefined): Promise<string> {
  if (signedInUserId != null) {
    const { db } = await import("./db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [me] = await db
      .select({ loginCode: users.loginCode })
      .from(users)
      .where(eq(users.id, signedInUserId));
    if (me?.loginCode) return me.loginCode;
  }
  return generateUniqueLoginCode();
}

// Idempotent boot-time backfill: assigns a login code to every user that
// doesn't have one yet. A person (all rows sharing a username) gets ONE code
// across their groups: if any of their rows already has a code it's reused for
// the rest, otherwise a fresh unique code is minted for the whole set. Safe to
// run on every boot — a no-op once all users are covered. Non-destructive: it
// never overwrites a code that's already set. Run after the groups/users
// seeding so newly seeded rows are included.
export async function backfillLoginCodes(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { users } = await import("@shared/schema");
    const { isNull, eq } = await import("drizzle-orm");
    const missing = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(isNull(users.loginCode));
    if (missing.length === 0) return;

    // Group the code-less rows by person (username) so multi-group people get
    // a single shared code rather than one per row.
    const byUsername = new Map<string, number[]>();
    for (const { id, username } of missing) {
      const ids = byUsername.get(username) ?? [];
      ids.push(id);
      byUsername.set(username, ids);
    }

    for (const [username, ids] of Array.from(byUsername.entries())) {
      const code = await resolveLoginCodeForUsername(username);
      for (const id of ids) {
        await db.update(users).set({ loginCode: code }).where(eq(users.id, id));
      }
    }
    console.log(
      `[loginCodes] Backfilled login codes for ${missing.length} user row(s) across ${byUsername.size} person(s)`,
    );
  } catch (err) {
    console.error("[loginCodes] Backfill failed:", err);
  }
}

// A person is one human with a row per group (same username), and they're meant
// to share ONE login code so a single code signs them into all their groups and
// drives the group switcher. Occasionally rows drift apart — the same person
// ends up with different codes in different groups (e.g. Morgan had one code in
// Fairweathermen and another in Rovers), which breaks the switcher.
//
// This idempotent boot step reconciles that: for every person whose rows carry
// more than one distinct code, it picks a single canonical code and updates all
// their rows to it. Canonical = the person's code in the Fairweathermen (city)
// home group if they have one, else the code on their lowest-id (earliest) row.
// The canonical is always an existing code of that person, so nobody is ever
// locked out — only a person's *alternate* code stops working. Safe to run on
// every boot: once a person's rows all match, they're skipped. Run after the
// null backfill so every row has a code to compare.
export async function unifyLoginCodesAcrossGroups(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { users, groups } = await import("@shared/schema");
    const { eq, isNull, inArray } = await import("drizzle-orm");

    const kprGroup = (await db.select({ id: groups.id }).from(groups).where(eq(groups.slug, "city")))[0];
    const kprGroupId = kprGroup?.id ?? null;

    // Original groups only: in self-service groups two rows with the same name
    // are usually two different people, and merging their codes would let one
    // sign in as the other.
    const originalGroups = db.select({ id: groups.id }).from(groups).where(isNull(groups.inviteToken));
    const rows = await db
      .select({ id: users.id, username: users.username, groupId: users.groupId, loginCode: users.loginCode })
      .from(users)
      .where(inArray(users.groupId, originalGroups));

    // Group rows by person (username).
    const byUsername = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byUsername.get(r.username) ?? [];
      list.push(r);
      byUsername.set(r.username, list);
    }

    let peopleFixed = 0;
    let rowsUpdated = 0;
    for (const [username, personRows] of Array.from(byUsername.entries())) {
      const distinctCodes = new Set(
        personRows.map((r) => r.loginCode).filter((c): c is string => !!c),
      );
      if (distinctCodes.size <= 1) continue; // already unified (or all null)

      const sortedById = [...personRows].sort((a, b) => a.id - b.id);
      const canonical =
        (kprGroupId != null && sortedById.find((r) => r.groupId === kprGroupId && r.loginCode)?.loginCode) ||
        sortedById.find((r) => r.loginCode)?.loginCode;
      if (!canonical) continue;

      for (const r of personRows) {
        if (r.loginCode !== canonical) {
          await db.update(users).set({ loginCode: canonical }).where(eq(users.id, r.id));
          rowsUpdated += 1;
        }
      }
      peopleFixed += 1;
      console.log(
        `[loginCodes] Unified codes for "${username}" → ${canonical} ` +
          `(was: ${Array.from(distinctCodes).join(", ")})`,
      );
    }

    if (peopleFixed > 0) {
      console.log(
        `[loginCodes] Unified login codes for ${peopleFixed} person(s), ${rowsUpdated} row(s) updated`,
      );
    }
  } catch (err) {
    console.error("[loginCodes] Unify failed:", err);
  }
}
