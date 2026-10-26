// True for requests of a file rather than a page: anything whose last path
// segment has a file extension (/icons/logo.webp, /sw.js, /manifest.webmanifest).
// App routes never contain a dot, so these are never real page visits. Used by
// the server's visit logger to skip them and by /activity to hide old rows.
export function isStaticAssetPath(path: string): boolean {
  const last = path.split("?")[0].split("/").pop() ?? "";
  return /\.[a-z0-9]+$/i.test(last);
}
