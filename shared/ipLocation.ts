// How the admin pages describe where a request came from.
//
// Locations come from an offline IP database (geoip-lite in
// server/geolocation.ts), never from the device. That is only a guess: UK
// mobile networks hand out addresses that map to whichever city their
// gateway is in, and relay/VPN services (iCloud Private Relay, Cloudflare
// WARP) show the relay's address instead of the person's. So a city is
// always shown as approximate, and known relay ranges are labelled as such
// instead of naming a city.

function ipv4Parts(ip: string): number[] | null {
  const m = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Loopback or private-network address (RFC 1918 / unique-local), so it has no location. */
export function isPrivateIP(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || v6.startsWith("fe80:");
}

// Egress ranges of the relay/VPN services our players are most likely to be
// behind. Requests from these come from the relay, not the device, so the
// IP database's city is the relay's, not theirs.
//  - Cloudflare 104.28.0.0/16 and 2a09:bac0::/29: WARP / 1.1.1.1 and the
//    Cloudflare half of iCloud Private Relay.
//  - Akamai 172.224.0.0/12 and 2a02:26f7::/32: the Akamai half of iCloud
//    Private Relay.
const RELAY_V4: Array<[number, number, number]> = [
  // [first octet, second octet min, second octet max]
  [104, 28, 28],
  [172, 224, 239],
];
const RELAY_V6 = [/^2a09:ba[c-f][0-9a-f]:/i, /^2a02:26f7:/i];

export function isRelayIP(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) return RELAY_V4.some(([a, lo, hi]) => v4[0] === a && v4[1] >= lo && v4[1] <= hi);
  return RELAY_V6.some((re) => re.test(ip));
}

/** One-line location for an admin row, e.g. "Edinburgh, GB (approx.)". */
export function describeLocation(ip: string | null | undefined, city: string | null, country: string | null): string {
  const knownCountry = country && country !== "Unknown" && country !== "Local" ? country : null;
  if (ip && isRelayIP(ip)) return knownCountry ? `Private relay / VPN, ${knownCountry}` : "Private relay / VPN";
  if (ip && isPrivateIP(ip)) return "Local network";
  const knownCity = city && city !== "Unknown" && city !== "Local" ? city : null;
  if (knownCity) return `${knownCity}${knownCountry ? `, ${knownCountry}` : ""} (approx.)`;
  if (knownCountry) return knownCountry;
  if (city === "Local" || country === "Local") return "Local network";
  return "Unknown location";
}

export const LOCATION_HINT =
  "Locations are estimated from the IP address, not the device. The country is usually right; the city often isn't (mobile networks and relays like iCloud Private Relay show a different city).";
