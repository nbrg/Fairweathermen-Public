import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Match, Prediction, LeaderboardEntry } from '@/lib/types';

// Hook to get current gameweek from LMS competition
export function useCurrentGameweek() {
  const { data: competition } = useQuery<any>({
    queryKey: ['/api/lms/current-competition'],
  });
  
  return competition?.current_gameweek || 2;
}

export function useMatches() {
  const queryClient = useQueryClient();
  
  const { data: matches = [], isLoading, error } = useQuery<Match[]>({
    queryKey: ['/api/matches'],
  });
  
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['/api/matches'] });
    }, 60000);
    
    return () => clearInterval(interval);
  }, [queryClient]);
  
  return { matches, isLoading, error };
}

export function useLeaderboard() {
  const queryClient = useQueryClient();
  
  const { data: leaderboard = [], isLoading, error } = useQuery<LeaderboardEntry[]>({
    queryKey: ['/api/leaderboard'],
  });
  
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
    }, 60000);
    
    return () => clearInterval(interval);
  }, [queryClient]);
  
  return { leaderboard, isLoading, error };
}

export function useUserPredictions(userId: number) {
  const queryClient = useQueryClient();
  
  const { data: predictions = [], isLoading, error } = useQuery<Prediction[]>({
    queryKey: [`/api/users/${userId}/predictions`],
  });
  
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/predictions`] });
    }, 60000);
    
    return () => clearInterval(interval);
  }, [queryClient, userId]);
  
  return { predictions, isLoading, error };
}

export function useAllPredictions() {
  const queryClient = useQueryClient();
  
  const { data: predictions = [], isLoading, error } = useQuery<Prediction[]>({
    queryKey: ['/api/predictions'],
  });
  
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['/api/predictions'] });
    }, 60000);
    
    return () => clearInterval(interval);
  }, [queryClient]);
  
  return { predictions, isLoading, error };
}

export function useLastUpdatedTime() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(new Date());
  
  const updateTime = useCallback(() => {
    setDate(new Date());
  }, []);
  
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      updateTime();
    });

    return () => {
      unsubscribe();
    };
  }, [queryClient, updateTime]);
  
  return {
    lastUpdated: date,
    updateTime
  };
}
