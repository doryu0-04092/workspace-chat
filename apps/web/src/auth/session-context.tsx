import { createContext, type ReactNode, useContext } from 'react';
import { useStore } from 'zustand';
import type { SessionState, SessionStore } from './session-store';

const SessionContext = createContext<SessionStore | null>(null);

export function SessionProvider({ store, children }: { store: SessionStore; children: ReactNode }) {
  return <SessionContext value={store}>{children}</SessionContext>;
}

export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (!store) throw new Error('SessionProvider の外で useSessionStore を呼んでいる');
  return store;
}

export function useSession(): SessionState {
  return useStore(useSessionStore().state);
}
