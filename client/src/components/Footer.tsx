// `minimal` is accepted for backwards compatibility with existing callers; the
// footer now renders no text either way (the "Live scores update every 10s" line
// was removed at the owner's request).
export default function Footer({ minimal = false }: { minimal?: boolean }) {
  void minimal;
  return (
    <footer
      className="bg-primary text-white pt-6"
      // Keep the bottom padding past the fixed purple safe-area strip the app
      // paints over the home-indicator region on phones with an inset.
      style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
    >
      <div className="container mx-auto px-4" />
    </footer>
  );
}
