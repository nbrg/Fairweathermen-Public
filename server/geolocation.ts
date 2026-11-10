import geoip from 'geoip-lite';
import { isPrivateIP } from '@shared/ipLocation';

export interface LocationInfo {
  ip: string;
  city: string | null;
  country: string | null;
}

export function getLocationFromIP(ipAddress: string): LocationInfo {
  // Skip geolocation for loopback/private-network IPs. Only 172.16.0.0/12 is
  // private; other 172.x addresses (e.g. iCloud Private Relay's) are public.
  if (isPrivateIP(ipAddress)) {
    return {
      ip: ipAddress,
      city: 'Local',
      country: 'Local'
    };
  }

  const geo = geoip.lookup(ipAddress);
  
  return {
    ip: ipAddress,
    city: geo?.city || 'Unknown',
    country: geo?.country || 'Unknown'
  };
}

// Helper to get real IP from request
export function getRealIP(req: any): string {
  // Try different header combinations for real IP
  return req.ip || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '127.0.0.1';
}