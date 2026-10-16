import geoip from 'geoip-lite';

export interface LocationInfo {
  ip: string;
  city: string | null;
  country: string | null;
}

export function getLocationFromIP(ipAddress: string): LocationInfo {
  // Skip geolocation for localhost/private IPs
  if (ipAddress === '127.0.0.1' || ipAddress === '::1' || 
      ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.') ||
      ipAddress.startsWith('172.')) {
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