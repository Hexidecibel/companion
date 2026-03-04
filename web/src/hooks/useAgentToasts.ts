import { useState, useRef, useEffect, useCallback } from 'react';
import type { SubAgent } from '../types';

export interface AgentToast {
  id: string;
  agentId: string;
  type: 'started' | 'completed' | 'error';
  description: string;
  duration?: number;
  timestamp: number;
}

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 4000;

export function useAgentToasts(agents: SubAgent[]): {
  toasts: AgentToast[];
  dismissToast: (id: string) => void;
} {
  const [toasts, setToasts] = useState<AgentToast[]>([]);
  const prevAgentsRef = useRef<Map<string, SubAgent>>(new Map());
  const initializedRef = useRef(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToasts = useCallback((newToasts: AgentToast[]) => {
    if (newToasts.length === 0) return;
    setToasts(prev => {
      const combined = [...prev, ...newToasts];
      while (combined.length > MAX_TOASTS) {
        const removed = combined.shift()!;
        const timer = timersRef.current.get(removed.id);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(removed.id);
        }
      }
      return combined;
    });
  }, []);

  useEffect(() => {
    if (agents.length === 0) {
      if (initializedRef.current) {
        initializedRef.current = false;
        prevAgentsRef.current = new Map();
        setToasts([]);
        for (const timer of timersRef.current.values()) {
          clearTimeout(timer);
        }
        timersRef.current.clear();
      }
      return;
    }

    if (!initializedRef.current) {
      prevAgentsRef.current = new Map(agents.map(a => [a.agentId, a]));
      initializedRef.current = true;
      return;
    }

    const prev = prevAgentsRef.current;
    const newToasts: AgentToast[] = [];
    const now = Date.now();

    for (const agent of agents) {
      const prevAgent = prev.get(agent.agentId);

      if (!prevAgent) {
        newToasts.push({
          id: `${agent.agentId}-started`,
          agentId: agent.agentId,
          type: 'started',
          description: agent.description || agent.slug || 'Agent',
          timestamp: now,
        });
      } else if (prevAgent.status === 'running' && (agent.status === 'completed' || agent.status === 'error')) {
        const endTime = agent.completedAt || now;
        newToasts.push({
          id: `${agent.agentId}-${agent.status}`,
          agentId: agent.agentId,
          type: agent.status,
          description: agent.description || agent.slug || 'Agent',
          duration: Math.round((endTime - agent.startedAt) / 1000),
          timestamp: now,
        });
      }
    }

    prevAgentsRef.current = new Map(agents.map(a => [a.agentId, a]));
    addToasts(newToasts);
  }, [agents, addToasts]);

  useEffect(() => {
    for (const toast of toasts) {
      if (!timersRef.current.has(toast.id)) {
        const timer = setTimeout(() => {
          timersRef.current.delete(toast.id);
          setToasts(prev => prev.filter(t => t.id !== toast.id));
        }, AUTO_DISMISS_MS);
        timersRef.current.set(toast.id, timer);
      }
    }
  }, [toasts]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, []);

  return { toasts, dismissToast };
}
