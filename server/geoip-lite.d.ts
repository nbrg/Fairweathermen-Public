// geoip-lite ships no type declarations. We only use geoip.lookup(ip), which
// returns a record (or null) with city/country/region/ll fields.
declare module "geoip-lite" {
  export interface GeoIpLookup {
    range: [number, number];
    country: string;
    region: string;
    eu: "0" | "1";
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }
  export function lookup(ip: string): GeoIpLookup | null;
  const geoip: { lookup: typeof lookup };
  export default geoip;
}
