import { createContext, useContext } from "react";
import type { Antibiotic, Family, Standard, User } from "./api";

export interface Catalog {
  standards: Standard[];
  families: Family[];
  antibiotics: Antibiotic[];
  antibioticById: Map<number, Antibiotic>;
}

export interface Session {
  user: User;
  catalog: Catalog;
  logout: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside of a session");
  return s;
}
