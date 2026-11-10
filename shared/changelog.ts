// New entries ship in the product PR and use the date they were recorded.
// Historical entries retain their actual merge timestamp and PR number.
export type ChangelogEntry = {
  id?: string;
  number?: number;
  title: string;
  recordedAt?: string;
  mergedAt?: string;
  summary?: string;
  bullets: string[];
};

export function changelogDate(entry: ChangelogEntry): string {
  return entry.mergedAt ?? entry.recordedAt ?? "";
}
