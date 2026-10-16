import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { MapPin } from "lucide-react";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";

interface LmsSelectionLog {
  id: number;
  gameweek: number;
  player_name: string;
  original_team: string | null;
  new_team: string;
  ip_address: string;
  city: string | null;
  country: string | null;
  created_at: string;
}



export default function AdminPage() {
  
  const { data: lmsLogs = [], isLoading: lmsLoading, error: lmsError } = useQuery<LmsSelectionLog[]>({
    queryKey: ["/api/admin/lms-selection-logs"],
    refetchInterval: 30000,
  });

  if (lmsLoading) {
    return (
      <div className="container mx-auto p-4">
        <div className="flex items-center justify-center min-h-[200px]">
          <div className="text-lg">Loading logs...</div>
        </div>
      </div>
    );
  }

  if (lmsError) {
    return (
      <div className="container mx-auto p-4">
        <Card className="border-red-200">
          <CardContent className="pt-6">
            <div className="text-red-600">
              Error loading logs: {lmsError instanceof Error ? lmsError.message : 'Unknown error'}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }



  return (
    <div className="container mx-auto pl-2 pr-4 py-4">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold">Audit Log</h1>
      </div>
      
      <Card>
        <CardHeader className="pb-3">
        </CardHeader>
        <CardContent className="pt-0">

          {/* LMS Selection Logs */}
          <div>
            {lmsLogs.length === 0 ? (
              <div className="text-center py-4 text-gray-500 text-sm">
                No LMS selections recorded
              </div>
            ) : (
                <div className="space-y-1">
                  {lmsLogs
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .map((log) => {
                      // Ensure the timestamp is treated as UTC by appending 'Z' if it doesn't have timezone info
                      const utcTimestamp = log.created_at.includes('Z') || log.created_at.includes('+') ? 
                        log.created_at : log.created_at + 'Z';
                      const londonTime = toZonedTime(new Date(utcTimestamp), 'Europe/London');
                      return (
                        <div
                          key={log.id}
                          className="grid grid-cols-[55px_70px_60px_42px] gap-x-2 gap-y-0 px-2 py-1.5 border rounded bg-gray-50 dark:bg-gray-800 text-xs items-center min-h-[2rem]"
                        >
                          <div className="font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap">
                            {log.player_name}
                          </div>
                          <div className="text-gray-600 dark:text-gray-400">
                            {log.original_team && !log.new_team ? (
                              <div className="leading-tight">
                                <div className="text-red-600">{log.original_team} →</div>
                                <div className="text-gray-400 italic">Cleared</div>
                              </div>
                            ) : log.original_team ? (
                              <div className="leading-tight">
                                <div className="text-red-600">{log.original_team} →</div>
                                <div className="text-green-600">{log.new_team}</div>
                              </div>
                            ) : (
                              <span className="text-green-600">{log.new_team}</span>
                            )}
                          </div>
                          <div className="text-center overflow-hidden">
                            {log.city && log.city !== 'Local' ? (
                              <div className="text-blue-600 flex items-center justify-center whitespace-nowrap text-[10px]">
                                <MapPin className="w-3 h-3 flex-shrink-0 mr-0.5" />
                                <span className="truncate">{log.city}, {log.country}</span>
                              </div>
                            ) : (
                              <div className="font-mono text-gray-400 text-[10px]">{log.ip_address.split('.').slice(-2).join('.')}</div>
                            )}
                          </div>
                          <div className="text-gray-500 dark:text-gray-400 text-right text-[10px] leading-tight">
                            <div>{format(londonTime, 'dd/MM')}</div>
                            <div>{format(londonTime, 'HH:mm:ss')}</div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
        </CardContent>
      </Card>
    </div>
  );
}