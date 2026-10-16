import { useEffect } from 'react';
import { apiRequest } from '@/lib/queryClient';

/**
 * Component that sends screen resolution data to the server for visitor tracking
 * This component doesn't render anything visible - it just tracks screen size
 */
export default function ScreenResolutionTracker() {
  useEffect(() => {
    const sendResolution = async () => {
      try {
        await fetch('/api/track/resolution', {
          method: 'POST',
          body: JSON.stringify({
            width: window.innerWidth,
            height: window.innerHeight
          }),
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
        // Silently fail - this is just analytics
        console.error('Failed to send resolution data:', error);
      }
    };

    // Send resolution when component mounts
    sendResolution();

    // Also track window resize
    const handleResize = () => {
      sendResolution();
    };

    // Throttle resize events to avoid too many API calls
    let resizeTimeout: number;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(handleResize, 1000);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // This component doesn't render anything
  return null;
}