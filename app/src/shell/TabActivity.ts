import { createContext, useContext } from "react";
export const TabActivity = createContext(true);
export const useTabActive = () => useContext(TabActivity);
