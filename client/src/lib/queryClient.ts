import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: 60000, // Refresh data every 60 seconds
      refetchOnWindowFocus: true, // Refresh when window gets focus
      staleTime: 30000, // Consider data stale after 30 seconds
      retry: 3, // Retry failed queries 3 times
      retryDelay: 1000, // Wait 1 second between retries
      networkMode: 'always', // Always attempt to fetch data regardless of network status
      refetchOnMount: 'always', // Always refetch when component mounts
    },
    mutations: {
      retry: 3, // Retry failed mutations 3 times
      retryDelay: 1000, // Wait 1 second between retries
    },
  },
});
