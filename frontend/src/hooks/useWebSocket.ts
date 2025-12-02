import { useEffect, useRef, useState, useCallback } from 'react';
import type { RGBW, Wall, Light, WSMessage } from '../types';

interface UseWebSocketResult {
  connected: boolean;
  frameData: Record<number, RGBW>;
  walls: Wall[];
  lights: Light[];
}

export function useWebSocket(): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [frameData, setFrameData] = useState<Record<number, RGBW>>({});
  const [walls, setWalls] = useState<Wall[]>([]);
  const [lights, setLights] = useState<Light[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);

        if (message.type === 'frame') {
          setFrameData(message.data as Record<number, RGBW>);
        } else if (message.type === 'layout') {
          const layoutData = message.data as { walls: Wall[]; lights: Light[] };
          setWalls(layoutData.walls);
          setLights(layoutData.lights);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);

      // Attempt to reconnect after 2 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 2000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { connected, frameData, walls, lights };
}
