"use client";

import { createContext, useContext, useState, ReactNode } from "react";

type ScannerContextType = {
  isActivelyScanningOrProcessing: boolean;
  setIsActivelyScanningOrProcessing: (active: boolean) => void;
};

const ScannerContext = createContext<ScannerContextType | undefined>(undefined);

export function ScannerProvider({ children }: { children: ReactNode }) {
  const [isActivelyScanningOrProcessing, setIsActivelyScanningOrProcessing] = useState(false);

  return (
    <ScannerContext.Provider value={{ isActivelyScanningOrProcessing, setIsActivelyScanningOrProcessing }}>
      {children}
    </ScannerContext.Provider>
  );
}

export function useScannerState() {
  const context = useContext(ScannerContext);
  if (context === undefined) {
    throw new Error("useScannerState must be used within a ScannerProvider");
  }
  return context;
}
