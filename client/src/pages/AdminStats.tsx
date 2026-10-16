import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminStats() {
  const [apiKey, setApiKey] = useState('');
  const [stats, setStats] = useState<any>(null);
  const [filteredData, setFilteredData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showMobileOnly, setShowMobileOnly] = useState(false);
  const [selectedVisitors, setSelectedVisitors] = useState<number[]>([]);
  
  // Check if we have an API key in local storage
  useEffect(() => {
    const savedKey = localStorage.getItem('adminApiKey');
    if (savedKey) {
      setApiKey(savedKey);
    }
  }, []);
  
  // Filter data when stats or filter settings change
  useEffect(() => {
    if (stats?.rawData) {
      if (showMobileOnly) {
        // Filter to only mobile devices
        const mobileData = stats.rawData.filter((visitor: any) => {
          const deviceInfo = visitor.deviceInfo?.toLowerCase() || '';
          return deviceInfo.includes('iphone') || 
                 deviceInfo.includes('ipad') || 
                 deviceInfo.includes('android') || 
                 deviceInfo.includes('mobile') ||
                 deviceInfo.includes('samsung') ||
                 deviceInfo.includes('pixel');
        });
        setFilteredData(mobileData);
      } else {
        // Show all visitors
        setFilteredData(stats.rawData);
      }
      // Clear selections when data changes
      setSelectedVisitors([]);
    }
  }, [stats, showMobileOnly]);
  
  // Handle checkbox selection toggle
  const toggleSelection = (visitorId: number) => {
    setSelectedVisitors(prev => {
      if (prev.includes(visitorId)) {
        return prev.filter(id => id !== visitorId);
      } else {
        return [...prev, visitorId];
      }
    });
  };
  
  const fetchStats = async () => {
    setLoading(true);
    setError('');
    
    try {
      // Save the API key for next time
      localStorage.setItem('adminApiKey', apiKey);
      
      const response = await fetch('/api/admin/visitors', {
        headers: {
          'x-api-key': apiKey
        },
        // Add cache-busting parameter to prevent caching
        cache: 'no-store'
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Invalid API key. Please check your admin key and try again.');
        }
        throw new Error('Failed to fetch visitor stats');
      }
      
      const data = await response.json();
      console.log('Fetched visitor data:', data.rawData.length, 'visitors');
      setStats(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="container max-w-5xl mx-auto p-4">
      <h1 className="text-3xl font-bold my-6">Visitor Statistics Dashboard</h1>
      
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Admin Authentication</CardTitle>
          <CardDescription>Enter your admin API key to view visitor statistics</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Input 
            type="password" 
            value={apiKey} 
            onChange={(e) => setApiKey(e.target.value)} 
            placeholder="Enter your admin API key"
            className="flex-1"
          />
          <Button onClick={fetchStats} disabled={loading || !apiKey}>
            {loading ? 'Loading...' : 'View Stats'}
          </Button>
        </CardContent>
      </Card>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
          {error}
        </div>
      )}
      
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-4 rounded-lg text-center">
                  <p className="text-4xl font-bold text-blue-600">{stats.totalUniqueVisitors}</p>
                  <p className="text-sm text-gray-500">Unique Visitors</p>
                </div>
                <div className="bg-green-50 p-4 rounded-lg text-center">
                  <p className="text-4xl font-bold text-green-600">{stats.totalVisits}</p>
                  <p className="text-sm text-gray-500">Total Visits</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Top Devices</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {stats.topDevices && stats.topDevices.map((device: any, index: number) => (
                  <li key={index} className="flex justify-between items-center">
                    <span className="text-sm">{device.device}</span>
                    <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded">
                      {device.count} visits
                    </span>
                  </li>
                ))}
                {(!stats.topDevices || stats.topDevices.length === 0) && (
                  <li className="text-gray-500 text-sm">No device data yet</li>
                )}
              </ul>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Top Locations</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {stats.topLocations && stats.topLocations.map((location: any, index: number) => (
                  <li key={index} className="flex justify-between items-center">
                    <span className="text-sm">{location.location}</span>
                    <span className="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded">
                      {location.count} visits
                    </span>
                  </li>
                ))}
                {(!stats.topLocations || stats.topLocations.length === 0) && (
                  <li className="text-gray-500 text-sm">No location data yet</li>
                )}
              </ul>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>Top Referrers</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {stats.topReferrers && stats.topReferrers.map((referrer: any, index: number) => (
                  <li key={index} className="flex justify-between items-center">
                    <span className="text-sm truncate max-w-[70%]">{referrer.referrer}</span>
                    <span className="bg-purple-100 text-purple-800 text-xs font-medium px-2.5 py-0.5 rounded">
                      {referrer.count} visits
                    </span>
                  </li>
                ))}
                {(!stats.topReferrers || stats.topReferrers.length === 0) && (
                  <li className="text-gray-500 text-sm">No referrer data yet</li>
                )}
              </ul>
            </CardContent>
          </Card>
          
          <Card className="md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Recent Visitors</CardTitle>
              <div className="flex items-center space-x-2">
                <label htmlFor="mobile-filter" className="text-sm font-medium">
                  Mobile Only
                </label>
                <input
                  id="mobile-filter"
                  type="checkbox"
                  checked={showMobileOnly}
                  onChange={() => setShowMobileOnly(!showMobileOnly)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <div className="flex justify-between items-center mb-4">
                  <div className="text-sm text-gray-500">
                    {filteredData?.length || 0} visitor{(filteredData?.length || 0) !== 1 ? 's' : ''} {showMobileOnly ? '(mobile only)' : ''}
                  </div>
                  
                  {selectedVisitors.length > 0 && (
                    <Button 
                      onClick={async () => {
                        try {
                          setLoading(true);
                          console.log(`Deleting ${selectedVisitors.length} visitors: ${selectedVisitors.join(', ')}`);
                          
                          // Delete each selected visitor with sequential await
                          const deletePromises = selectedVisitors.map(async (visitorId) => {
                            console.log(`Deleting visitor ID: ${visitorId}`);
                            const response = await fetch(`/api/admin/visitors/${visitorId}`, {
                              method: 'DELETE',
                              headers: {
                                'x-api-key': apiKey
                              }
                            });
                            
                            const responseData = await response.text();
                            console.log(`Delete response for ID ${visitorId}:`, response.status, responseData);
                            
                            if (!response.ok) {
                              console.error(`Failed to delete visitor ${visitorId}`);
                              return false;
                            }
                            return true;
                          });
                          
                          // Wait for all deletions to complete
                          await Promise.all(deletePromises);
                          
                          // Clear selection
                          setSelectedVisitors([]);
                          
                          // Force a delay to ensure database has processed deletions
                          await new Promise(resolve => setTimeout(resolve, 500));
                          
                          // Fetch fresh data with cache bust
                          await fetchStats();
                        } catch (error) {
                          console.error('Error deleting visitors:', error);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      variant="destructive"
                      disabled={loading}
                    >
                      Delete Selected ({selectedVisitors.length})
                    </Button>
                  )}
                </div>
                <table className="w-full text-sm text-left text-gray-500">
                  <thead className="text-xs text-gray-700 uppercase bg-gray-50">
                    <tr>
                      <th scope="col" className="px-4 py-3 w-12">
                        <input
                          type="checkbox"
                          checked={selectedVisitors.length > 0 && selectedVisitors.length === filteredData.length}
                          onChange={() => {
                            if (selectedVisitors.length === filteredData.length) {
                              // Deselect all
                              setSelectedVisitors([]);
                            } else {
                              // Select all
                              setSelectedVisitors(filteredData.map(v => v.id));
                            }
                          }}
                          className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                        />
                      </th>
                      <th scope="col" className="px-4 py-3">IP Address</th>
                      <th scope="col" className="px-4 py-3">Last Visit</th>
                      <th scope="col" className="px-4 py-3">Device Model</th>
                      <th scope="col" className="px-4 py-3">OS Version</th>
                      <th scope="col" className="px-4 py-3">Location</th>
                      <th scope="col" className="px-4 py-3">Visits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredData && filteredData.map((visitor: any) => {
                      // Extract device info from the original string
                      let deviceModel = "Unknown";
                      let osVersion = "Unknown";
                      
                      if (visitor.deviceInfo) {
                        // Try to use pipe-separated format first
                        if (visitor.deviceInfo.includes("|")) {
                          const parts = visitor.deviceInfo.split("|");
                          if (parts.length >= 2) {
                            deviceModel = parts[0];
                            osVersion = parts[1];
                          }
                        } else {
                          // Fall back to parsing the original format
                          if (visitor.deviceInfo.includes("iPhone")) {
                            // Extract iPhone model and remove the series info
                            const iPhoneMatch = visitor.deviceInfo.match(/iPhone\s*(\d+)/i);
                            if (iPhoneMatch && iPhoneMatch[1]) {
                              deviceModel = `iPhone ${iPhoneMatch[1]} Pro`;
                            } else {
                              deviceModel = "iPhone";
                            }
                          } else if (visitor.deviceInfo.includes("Samsung")) {
                            deviceModel = visitor.deviceInfo.includes("Galaxy") ? 
                              "Samsung Galaxy" : "Samsung";
                          } else if (visitor.deviceInfo.includes("Windows")) {
                            deviceModel = "Windows PC";
                          } else if (visitor.deviceInfo.includes("Mac")) {
                            deviceModel = visitor.deviceInfo.includes("Intel") ? 
                              "Intel Mac" : "Apple Silicon Mac";
                          } else if (visitor.deviceInfo.includes("Linux")) {
                            deviceModel = "Linux PC";
                          } else if (visitor.deviceInfo.includes("iPad")) {
                            deviceModel = "iPad";
                          } else if (visitor.deviceInfo.includes("Android")) {
                            deviceModel = "Android Device";
                          } else {
                            deviceModel = visitor.deviceInfo.split(' / ')[0];
                          }
                          
                          // Extract OS version
                          if (visitor.deviceInfo.includes("iOS")) {
                            const iosMatch = visitor.deviceInfo.match(/iOS\s+(\d+(\.\d+)+)/i);
                            if (iosMatch && iosMatch[1]) {
                              osVersion = `iOS ${iosMatch[1]}`;
                            } else {
                              osVersion = "iOS";
                            }
                          } else if (visitor.deviceInfo.includes("Android")) {
                            const androidMatch = visitor.deviceInfo.match(/Android\s+(\d+(\.\d+)+)/i);
                            if (androidMatch && androidMatch[1]) {
                              osVersion = `Android ${androidMatch[1]}`;
                            } else {
                              osVersion = "Android";
                            }
                          } else if (visitor.deviceInfo.includes("Windows")) {
                            osVersion = visitor.deviceInfo.includes("10/11") ? 
                              "Windows 10/11" : "Windows";
                          } else if (visitor.deviceInfo.includes("macOS")) {
                            const macMatch = visitor.deviceInfo.match(/macOS\s+(\d+(\.\d+)+)/i);
                            if (macMatch && macMatch[1]) {
                              osVersion = `macOS ${macMatch[1]}`;
                            } else {
                              osVersion = "macOS";
                            }
                          } else if (visitor.deviceInfo.includes("Linux")) {
                            osVersion = "Linux";
                          }
                        }
                      }
                      
                      return (
                        <tr key={visitor.id} className="bg-white border-b">
                          <td className="px-4 py-4">
                            <input
                              type="checkbox"
                              checked={selectedVisitors.includes(visitor.id)}
                              onChange={() => toggleSelection(visitor.id)}
                              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                            />
                          </td>
                          <td className="px-4 py-4">{visitor.ipAddress}</td>
                          <td className="px-4 py-4">{new Date(visitor.lastVisit).toLocaleString()}</td>
                          <td className="px-4 py-4">{deviceModel}</td>
                          <td className="px-4 py-4">{osVersion}</td>
                          <td className="px-4 py-4">{visitor.location || 'Unknown'}</td>
                          <td className="px-4 py-4">{visitor.visitCount}</td>
                        </tr>
                      );
                    })}
                    {(!filteredData || filteredData.length === 0) && (
                      <tr className="bg-white border-b">
                        <td colSpan={7} className="px-4 py-4 text-center">
                          {showMobileOnly ? 'No mobile visitors found' : 'No visitor data yet'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}