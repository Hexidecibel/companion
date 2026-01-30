import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { DiscoveredServer } from '../types';

// Note: react-native-zeroconf needs to be configured in native code
// This is a simplified implementation that can be expanded

export function useDiscovery() {
  const [discovering, setDiscovering] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startDiscovery = useCallback(async () => {
    if (Platform.OS === 'web') {
      setError('mDNS discovery not available on web');
      return;
    }

    setDiscovering(true);
    setError(null);
    setDiscoveredServers([]);

    try {
      // In a real implementation, you would use react-native-zeroconf here
      // For now, we'll simulate a timeout
      //
      // Example with react-native-zeroconf:
      // const zeroconf = new Zeroconf();
      // zeroconf.scan('companion', 'tcp', 'local.');
      // zeroconf.on('resolved', service => {
      //   setDiscoveredServers(prev => [...prev, {
      //     name: service.name,
      //     host: service.host,
      //     port: service.port,
      //     tls: service.txt?.tls === 'true',
      //   }]);
      // });

      // Simulate discovery timeout
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }, []);

  const stopDiscovery = useCallback(() => {
    setDiscovering(false);
    // In real implementation: zeroconf.stop();
  }, []);

  useEffect(() => {
    return () => {
      stopDiscovery();
    };
  }, [stopDiscovery]);

  return {
    discovering,
    discoveredServers,
    error,
    startDiscovery,
    stopDiscovery,
  };
}
