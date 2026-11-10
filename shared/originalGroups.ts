// The original, hand-seeded groups that the code refers to directly (the
// default login group, legacy LMS stakes...). Every such reference goes
// through this file, so there is one place to get it right.
//
// Groups are matched ONLY by slug: it's unique and nobody can edit it. Never
// match by display name (anyone can create a group with any name) or by id
// (ids differ between databases; the test fixture's group 1 is "Demo League").
export const CITY_SLUG = "city";
export const ROVERS_SLUG = "rovers";
export type OriginalGroupSlug = typeof CITY_SLUG | typeof ROVERS_SLUG;

// Old slugs still accepted for a group (none in this edition).
export const LEGACY_GROUP_SLUGS: Record<string, string> = {};

type GroupRef = string | { slug?: string | null } | null | undefined;

// The group's current slug, lower-cased, with old aliases mapped on.
export function groupKey(group: GroupRef): string {
  const raw = typeof group === "object" ? group?.slug : group;
  const slug = (raw ?? "").trim().toLowerCase();
  return LEGACY_GROUP_SLUGS[slug] ?? slug;
}

export function isCityGroup(group: GroupRef): boolean {
  return groupKey(group) === CITY_SLUG;
}

export function isRoversGroup(group: GroupRef): boolean {
  return groupKey(group) === ROVERS_SLUG;
}

// Group names are compared ignoring case and extra spaces, so "City" and
// " city " count as the same name.
export function normaliseGroupName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
