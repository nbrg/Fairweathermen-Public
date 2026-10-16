import { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { visitors } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import axios from "axios";

// Function to get IP location information from ipinfo.io
async function getLocationInfo(ip: string) {
  try {
    // Note: For a production app, consider using an API key for better rate limits
    const response = await axios.get(`https://ipinfo.io/${ip}/json`);
    return response.data;
  } catch (error) {
    console.error("Error fetching location info:", error);
    return null;
  }
}

// Extract detailed device information from user agent
function getDeviceInfo(userAgent: string) {
  let deviceInfo = "Unknown";
  let deviceModel = "";
  let browserInfo = "";
  
  if (!userAgent) return deviceInfo;
  
  // iPhone/iPad model detection - simplified approach that works better for most user agents
  if (userAgent.includes("iPhone")) {
    deviceInfo = "iPhone";
    
    // Extract iOS version first as it's more reliable
    const iosVersionMatch = userAgent.match(/OS (\d+_\d+(_\d+)?)/i);
    let iosVersion = "";
    if (iosVersionMatch && iosVersionMatch[1]) {
      iosVersion = iosVersionMatch[1].replace(/_/g, '.');
      deviceModel = `iOS ${iosVersion}`;
    }
    
    // Looking at screen size and features can help determine model
    if (iosVersion) {
      const majorVersion = parseInt(iosVersion.split('.')[0], 10);
      
      // This is a simplified approach - iOS 17 usually means iPhone 15 or similar
      if (majorVersion >= 17) {
        deviceModel = `iPhone 15/14 Series, ${deviceModel}`;
      } 
      else if (majorVersion >= 16) {
        deviceModel = `iPhone 14/13 Series, ${deviceModel}`;
      }
      else if (majorVersion >= 15) {
        deviceModel = `iPhone 13/12 Series, ${deviceModel}`;
      }
      else if (majorVersion >= 14) {
        deviceModel = `iPhone 12/11 Series, ${deviceModel}`;
      }
      else if (majorVersion >= 13) {
        deviceModel = `iPhone 11/XS/XR Series, ${deviceModel}`;
      }
    }
  } 
  // iPad detection
  else if (userAgent.includes("iPad")) {
    deviceInfo = "iPad";
    
    // Try to get iPad model and iOS version
    const iosVersionMatch = userAgent.match(/OS (\d+_\d+(_\d+)?)/i);
    if (iosVersionMatch && iosVersionMatch[1]) {
      deviceModel = `iOS ${iosVersionMatch[1].replace(/_/g, '.')}`;
    }
    
    if (userAgent.includes("iPad Pro")) {
      deviceModel = deviceModel ? `iPad Pro, ${deviceModel}` : "iPad Pro";
    } else if (userAgent.includes("iPad Air")) {
      deviceModel = deviceModel ? `iPad Air, ${deviceModel}` : "iPad Air";
    } else if (userAgent.includes("iPad Mini")) {
      deviceModel = deviceModel ? `iPad Mini, ${deviceModel}` : "iPad Mini";
    }
  } 
  // Android device detection
  else if (userAgent.includes("Android")) {
    deviceInfo = "Android";
    
    // Try to get Android version
    const androidVersionMatch = userAgent.match(/Android (\d+(\.\d+)+)/i);
    if (androidVersionMatch && androidVersionMatch[1]) {
      deviceModel = `Android ${androidVersionMatch[1]}`;
    }
    
    // Samsung detection
    if (userAgent.includes("SM-G") || userAgent.includes("SM-N") || userAgent.includes("SM-A") || 
        userAgent.includes("Samsung") || userAgent.includes("SAMSUNG")) {
      
      // Detect Samsung specific models
      let samsungModel = "";
      if (userAgent.includes("SM-G99") || userAgent.includes("SM-S901") || 
          userAgent.includes("SM-S911") || userAgent.includes("SM-S921")) {
        samsungModel = "Galaxy S22/S23 Series";
      } else if (userAgent.includes("SM-G98") || userAgent.includes("SM-G99")) {
        samsungModel = "Galaxy S20/S21 Series";
      } else if (userAgent.includes("SM-N9") || userAgent.includes("SM-N980")) {
        samsungModel = "Galaxy Note Series";
      } else if (userAgent.includes("SM-F9")) {
        samsungModel = "Galaxy Fold/Flip Series";
      } else if (userAgent.includes("SM-A")) {
        samsungModel = "Galaxy A Series";
      } else {
        // Generic Samsung detection
        const samsungMatch = userAgent.match(/Samsung\s+([A-Za-z0-9\-\s]+)/i);
        if (samsungMatch && samsungMatch[1]) {
          samsungModel = `Galaxy ${samsungMatch[1].trim()}`;
        } else {
          samsungModel = "Galaxy device";
        }
      }
      
      deviceModel = deviceModel ? `Samsung ${samsungModel}, ${deviceModel}` : `Samsung ${samsungModel}`;
    } 
    // Google Pixel detection
    else if (userAgent.includes("Pixel")) {
      const pixelMatch = userAgent.match(/Pixel\s+(\d+(\s+[A-Za-z]+)?)/i);
      if (pixelMatch && pixelMatch[1]) {
        deviceModel = deviceModel ? `Google Pixel ${pixelMatch[1]}, ${deviceModel}` : `Google Pixel ${pixelMatch[1]}`;
      } else {
        deviceModel = deviceModel ? `Google Pixel, ${deviceModel}` : "Google Pixel";
      }
    }
    // OnePlus detection
    else if (userAgent.includes("OnePlus")) {
      const oneplusMatch = userAgent.match(/OnePlus\s+([A-Za-z0-9\s]+)/i);
      if (oneplusMatch && oneplusMatch[1]) {
        deviceModel = deviceModel ? `OnePlus ${oneplusMatch[1].trim()}, ${deviceModel}` : `OnePlus ${oneplusMatch[1].trim()}`;
      } else {
        deviceModel = deviceModel ? `OnePlus, ${deviceModel}` : "OnePlus";
      }
    }
    // Xiaomi, Huawei, Oppo, etc.
    else if (userAgent.includes("Xiaomi") || userAgent.includes("Mi ")) {
      deviceModel = deviceModel ? `Xiaomi, ${deviceModel}` : "Xiaomi device";
    }
    else if (userAgent.includes("Huawei")) {
      deviceModel = deviceModel ? `Huawei, ${deviceModel}` : "Huawei device";
    }
    else if (userAgent.includes("OPPO")) {
      deviceModel = deviceModel ? `OPPO, ${deviceModel}` : "OPPO device";
    }
    else if (userAgent.includes("Vivo")) {
      deviceModel = deviceModel ? `Vivo, ${deviceModel}` : "Vivo device";
    }
    else if (userAgent.includes("Motorola") || userAgent.includes("Moto")) {
      deviceModel = deviceModel ? `Motorola, ${deviceModel}` : "Motorola device";
    }
  } 
  // Desktop OS detection
  else if (userAgent.includes("Windows")) {
    deviceInfo = "Windows";
    if (userAgent.includes("Windows NT 10.0")) {
      deviceModel = "Windows 10/11";
    } else if (userAgent.includes("Windows NT 6.3")) {
      deviceModel = "Windows 8.1";
    } else if (userAgent.includes("Windows NT 6.2")) {
      deviceModel = "Windows 8";
    } else if (userAgent.includes("Windows NT 6.1")) {
      deviceModel = "Windows 7";
    }
  } else if (userAgent.includes("Mac") && !userAgent.includes("iPhone") && !userAgent.includes("iPad")) {
    deviceInfo = "macOS";
    
    // Try to detect M1/M2 chips or Intel
    if (userAgent.includes("Intel")) {
      deviceModel = "Intel Mac";
    } else if (userAgent.includes("Apple") || userAgent.includes("arm64")) {
      deviceModel = "Apple Silicon Mac";
    }
    
    // Try to get macOS version
    const macVersionMatch = userAgent.match(/Mac OS X (\d+[._]\d+([._]\d+)?)/i);
    if (macVersionMatch && macVersionMatch[1]) {
      const macVersion = macVersionMatch[1].replace(/_/g, '.');
      deviceModel = deviceModel ? `${deviceModel}, macOS ${macVersion}` : `macOS ${macVersion}`;
    }
  } else if (userAgent.includes("Linux")) {
    deviceInfo = "Linux";
    // Try to detect specific Linux distribution
    if (userAgent.includes("Ubuntu")) {
      deviceModel = "Ubuntu";
    } else if (userAgent.includes("Debian")) {
      deviceModel = "Debian";
    } else if (userAgent.includes("Fedora")) {
      deviceModel = "Fedora";
    }
  }
  
  // Browser detection
  if (userAgent.includes("CriOS")) {
    const versionMatch = userAgent.match(/CriOS\/(\d+)/);
    browserInfo = versionMatch ? `Chrome ${versionMatch[1]}` : "Chrome";
  } else if (userAgent.includes("Chrome") && !userAgent.includes("Edg")) {
    const versionMatch = userAgent.match(/Chrome\/(\d+)/);
    browserInfo = versionMatch ? `Chrome ${versionMatch[1]}` : "Chrome";
  } else if (userAgent.includes("FxiOS")) {
    const versionMatch = userAgent.match(/FxiOS\/(\d+)/);
    browserInfo = versionMatch ? `Firefox ${versionMatch[1]}` : "Firefox";
  } else if (userAgent.includes("Firefox")) {
    const versionMatch = userAgent.match(/Firefox\/(\d+)/);
    browserInfo = versionMatch ? `Firefox ${versionMatch[1]}` : "Firefox";
  } else if (userAgent.includes("EdgiOS")) {
    browserInfo = "Edge";
  } else if (userAgent.includes("Edg") || userAgent.includes("Edge")) {
    const versionMatch = userAgent.match(/Edg(?:e)?\/(\d+)/);
    browserInfo = versionMatch ? `Edge ${versionMatch[1]}` : "Edge";
  } else if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) {
    const versionMatch = userAgent.match(/Version\/(\d+)/);
    browserInfo = versionMatch ? `Safari ${versionMatch[1]}` : "Safari";
  }
  
  // Combine device and browser info
  if (deviceModel && browserInfo) {
    return `${deviceInfo} (${deviceModel}) / ${browserInfo}`;
  } else if (deviceModel) {
    return `${deviceInfo} (${deviceModel})`;
  } else if (browserInfo) {
    return `${deviceInfo} / ${browserInfo}`;
  }
  
  return deviceInfo;
}

/**
 * Extract specific device model information from user agent
 */
function getDeviceModel(userAgent: string): string {
  if (!userAgent) return "Unknown";
  
  // iPhone specific detection with improved model identification
  if (userAgent.includes("iPhone")) {
    // Check for specific iPhone models
    if (userAgent.includes("iPhone15,4") || userAgent.includes("iPhone15,5")) {
      return "iPhone 15 Pro";
    } else if (userAgent.includes("iPhone15,2") || userAgent.includes("iPhone15,3")) {
      return "iPhone 15";
    } else if (userAgent.includes("iPhone14,7") || userAgent.includes("iPhone14,8")) {
      return "iPhone 14 Pro";
    } else if (userAgent.includes("iPhone14,4") || userAgent.includes("iPhone14,5")) {
      return "iPhone 14";
    } else if (userAgent.includes("iPhone13,")) {
      return "iPhone 13";
    } else {
      // Generic iPhone
      return "iPhone";
    }
  }
  
  // iPad detection
  if (userAgent.includes("iPad")) {
    if (userAgent.includes("iPad Pro")) {
      return "iPad Pro";
    } else if (userAgent.includes("iPad Air")) {
      return "iPad Air";
    } else if (userAgent.includes("iPad Mini")) {
      return "iPad Mini";
    } else {
      return "iPad";
    }
  }
  
  // Android device detection
  if (userAgent.includes("Android")) {
    // Samsung detection
    if (userAgent.includes("Samsung") || userAgent.includes("SAMSUNG") || userAgent.includes("SM-")) {
      if (userAgent.includes("SM-G99") || userAgent.includes("SM-S9")) {
        return "Samsung Galaxy S22";
      } else if (userAgent.includes("SM-N9")) {
        return "Samsung Galaxy Note";
      } else if (userAgent.includes("SM-F9")) {
        return "Samsung Galaxy Fold";
      } else {
        return "Samsung Galaxy";
      }
    }
    
    // Google Pixel
    if (userAgent.includes("Pixel")) {
      const pixelMatch = userAgent.match(/Pixel\s+(\d+)/i);
      if (pixelMatch && pixelMatch[1]) {
        return `Google Pixel ${pixelMatch[1]}`;
      }
      return "Google Pixel";
    }
    
    // Other Android manufacturers
    if (userAgent.includes("OnePlus")) {
      return "OnePlus";
    } else if (userAgent.includes("Xiaomi")) {
      return "Xiaomi";
    } else if (userAgent.includes("Huawei")) {
      return "Huawei";
    } else {
      return "Android Device";
    }
  }
  
  // Desktop OS detection
  if (userAgent.includes("Windows")) {
    return "Windows PC";
  } else if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS")) {
    if (userAgent.includes("Intel")) {
      return "Intel Mac";
    } else {
      return "Apple Silicon Mac";
    }
  } else if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
    return "Linux PC";
  }
  
  return "Unknown Device";
}

/**
 * Extract OS version information from user agent
 */
function getOSVersion(userAgent: string): string {
  if (!userAgent) return "Unknown";
  
  // iOS version
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) {
    const iosMatch = userAgent.match(/OS\s+(\d+_\d+(_\d+)?)/i);
    if (iosMatch && iosMatch[1]) {
      return `iOS ${iosMatch[1].replace(/_/g, '.')}`;
    }
    return "iOS";
  }
  
  // Android version
  if (userAgent.includes("Android")) {
    const androidMatch = userAgent.match(/Android\s+(\d+(\.\d+)+)/i);
    if (androidMatch && androidMatch[1]) {
      return `Android ${androidMatch[1]}`;
    }
    return "Android";
  }
  
  // Windows version
  if (userAgent.includes("Windows")) {
    if (userAgent.includes("Windows NT 10.0")) {
      return "Windows 10/11";
    } else if (userAgent.includes("Windows NT 6.3")) {
      return "Windows 8.1";
    } else if (userAgent.includes("Windows NT 6.2")) {
      return "Windows 8";
    } else if (userAgent.includes("Windows NT 6.1")) {
      return "Windows 7";
    }
    return "Windows";
  }
  
  // macOS version
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS")) {
    const macMatch = userAgent.match(/Mac OS X\s+(\d+[._]\d+([._]\d+)?)/i);
    if (macMatch && macMatch[1]) {
      return `macOS ${macMatch[1].replace(/_/g, '.')}`;
    }
    return "macOS";
  }
  
  // Linux distribution
  if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
    if (userAgent.includes("Ubuntu")) {
      return "Ubuntu Linux";
    } else if (userAgent.includes("Fedora")) {
      return "Fedora Linux";
    } else if (userAgent.includes("Debian")) {
      return "Debian Linux";
    }
    return "Linux";
  }
  
  return "Unknown OS";
}

/**
 * Extract browser information from user agent
 */
function getBrowserInfo(userAgent: string): string {
  if (!userAgent) return "Unknown";
  
  // Chrome
  if (userAgent.includes("CriOS") || (userAgent.includes("Chrome") && !userAgent.includes("Edg"))) {
    const chromeMatch = userAgent.match(/(?:Chrome|CriOS)\/(\d+)/);
    if (chromeMatch && chromeMatch[1]) {
      return `Chrome ${chromeMatch[1]}`;
    }
    return "Chrome";
  }
  
  // Firefox
  if (userAgent.includes("FxiOS") || userAgent.includes("Firefox")) {
    const firefoxMatch = userAgent.match(/(?:Firefox|FxiOS)\/(\d+)/);
    if (firefoxMatch && firefoxMatch[1]) {
      return `Firefox ${firefoxMatch[1]}`;
    }
    return "Firefox";
  }
  
  // Safari
  if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) {
    const safariMatch = userAgent.match(/Version\/(\d+)/);
    if (safariMatch && safariMatch[1]) {
      return `Safari ${safariMatch[1]}`;
    }
    return "Safari";
  }
  
  // Edge
  if (userAgent.includes("Edg") || userAgent.includes("Edge")) {
    const edgeMatch = userAgent.match(/Edg(?:e)?\/(\d+)/);
    if (edgeMatch && edgeMatch[1]) {
      return `Edge ${edgeMatch[1]}`;
    }
    return "Edge";
  }
  
  return "Unknown Browser";
}

// Visitor tracking middleware
export const visitorTrackingMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Skip API calls and static assets to avoid excessive logging
    if (req.path.startsWith("/api/") || 
        req.path.includes(".") || 
        req.path.startsWith("/assets/")) {
      return next();
    }
    
    // Get IP address - try multiple methods as mobile clients may use different headers
    let ipAddress = "unknown";
    
    // Check for proxy headers first (common in production environments)
    if (req.headers['x-forwarded-for']) {
      // Extract the first IP from x-forwarded-for as it's the client's original IP
      const forwardedIps = Array.isArray(req.headers['x-forwarded-for']) 
        ? req.headers['x-forwarded-for'][0] 
        : req.headers['x-forwarded-for'].split(',')[0].trim();
      ipAddress = forwardedIps || ipAddress;
    } 
    // Fall back to standard request IP
    else {
      ipAddress = req.ip || req.socket.remoteAddress || ipAddress;
    }
    
    // For local development, map localhost to a real IP for testing
    if (ipAddress === "127.0.0.1" || ipAddress === "::1" || ipAddress === "::ffff:127.0.0.1") {
      // Using a placeholder IP for better testing
      ipAddress = "127.0.0.1";
    }
    
    // Get user agent
    const userAgent = req.headers["user-agent"] || "unknown";
    
    // Get referrer
    const referrer = req.headers.referer || "direct";
    
    // Always get device info from user agent - this will use our enhanced detection
    const deviceInfo = getDeviceInfo(userAgent);
    
    // Check if this IP exists in our database
    const [existingVisitor] = await db
      .select()
      .from(visitors)
      .where(eq(visitors.ipAddress, ipAddress));
    
    // Always parse device info components for consistent format
    const deviceModel = getDeviceModel(userAgent);
    const osVersion = getOSVersion(userAgent);
    const browserInfo = getBrowserInfo(userAgent);
    
    // Store in pipe-separated format for easier parsing in admin UI
    const enhancedDeviceInfo = `${deviceModel}|${osVersion}|${browserInfo}`;
    
    if (existingVisitor) {
      console.log(`Updating visitor: ${ipAddress} with device: ${deviceModel}`);
      
      // Update existing visitor with the enhanced device info
      await db.update(visitors)
        .set({
          visitCount: existingVisitor.visitCount + 1,
          lastVisit: new Date(),
          userAgent, // Update user agent in case it changed
          deviceInfo: enhancedDeviceInfo, // Store the enhanced formatted device info
          referrer // Update referrer
        })
        .where(eq(visitors.id, existingVisitor.id));
    } else {
      // This is a new visitor, get location info
      const locationInfo = await getLocationInfo(ipAddress);
      const location = locationInfo ? 
        `${locationInfo.city || ''}, ${locationInfo.region || ''}, ${locationInfo.country || ''}` : 
        "Unknown";
      
      console.log(`New visitor: ${ipAddress} with device: ${deviceModel}`);
      
      // Create new visitor record with enhanced device information
      await db.insert(visitors).values({
        ipAddress,
        userAgent,
        deviceInfo: enhancedDeviceInfo,
        location,
        referrer,
        screenResolution: "Unknown" // Collected from client side later if possible
      });
    }
  } catch (error) {
    console.error("Error tracking visitor:", error);
    // Don't block the request if tracking fails
  }
  
  // Continue to the next middleware
  next();
};

// Admin API route to get visitor data
export const getVisitorStats = async (req: Request, res: Response) => {
  try {
    // Check for admin authentication here
    // This is a simple example - in a real app, use proper authentication
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    // Get all visitors with counts - sort by lastVisit in descending order
    const allVisitors = await db
      .select()
      .from(visitors)
      .orderBy(sql`${visitors.lastVisit} DESC`);
    
    // Get total unique visitors
    const totalUniqueVisitors = allVisitors.length;
    
    // Get total visits
    const totalVisits = allVisitors.reduce((sum, visitor) => sum + visitor.visitCount, 0);
    
    // Get top devices
    const deviceCounts: Record<string, number> = {};
    allVisitors.forEach(visitor => {
      const device = visitor.deviceInfo || "Unknown";
      deviceCounts[device] = (deviceCounts[device] || 0) + visitor.visitCount;
    });
    
    // Get top locations
    const locationCounts: Record<string, number> = {};
    allVisitors.forEach(visitor => {
      const location = visitor.location || "Unknown";
      locationCounts[location] = (locationCounts[location] || 0) + visitor.visitCount;
    });
    
    // Get top referrers
    const referrerCounts: Record<string, number> = {};
    allVisitors.forEach(visitor => {
      const referrer = visitor.referrer || "direct";
      referrerCounts[referrer] = (referrerCounts[referrer] || 0) + visitor.visitCount;
    });
    
    // Return stats
    res.json({
      totalUniqueVisitors,
      totalVisits,
      topDevices: Object.entries(deviceCounts)
        .map(([device, count]) => ({ device, count }))
        .sort((a, b) => b.count - a.count),
      topLocations: Object.entries(locationCounts)
        .map(([location, count]) => ({ location, count }))
        .sort((a, b) => b.count - a.count),
      topReferrers: Object.entries(referrerCounts)
        .map(([referrer, count]) => ({ referrer, count }))
        .sort((a, b) => b.count - a.count),
      rawData: allVisitors
    });
  } catch (error) {
    console.error("Error getting visitor stats:", error);
    res.status(500).json({ error: "Failed to get visitor stats" });
  }
};

// Function to update screen resolution (can be called from client-side)
export const updateScreenResolution = async (req: Request, res: Response) => {
  try {
    const { width, height } = req.body;
    const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
    
    if (!width || !height) {
      return res.status(400).json({ error: "Width and height are required" });
    }
    
    const resolution = `${width}x${height}`;
    
    // Update the visitor record
    const [existingVisitor] = await db
      .select()
      .from(visitors)
      .where(eq(visitors.ipAddress, ipAddress));
    
    if (existingVisitor) {
      await db.update(visitors)
        .set({ screenResolution: resolution })
        .where(eq(visitors.id, existingVisitor.id));
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating screen resolution:", error);
    res.status(500).json({ error: "Failed to update screen resolution" });
  }
};