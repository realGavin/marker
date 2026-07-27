import React, { createContext, useContext, useEffect, useState } from "react";
import Purchases, { LOG_LEVEL, type CustomerInfo } from "react-native-purchases";
import { useAuth } from "./auth";

const KEY = process.env.EXPO_PUBLIC_REVENUECAT_KEY ?? "";
const ENTITLEMENT = "pro";

interface PurchasesState {
  isPro: boolean;
  ready: boolean;
  refresh: () => Promise<void>;
}

const PurchasesContext = createContext<PurchasesState>({
  isPro: false,
  ready: false,
  refresh: async () => {},
});

export function PurchasesProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [isPro, setIsPro] = useState(false);
  const [ready, setReady] = useState(false);

  const apply = (info: CustomerInfo) => {
    setIsPro(info.entitlements.active[ENTITLEMENT] !== undefined);
  };

  useEffect(() => {
    if (!KEY || !session) return;
    Purchases.setLogLevel(LOG_LEVEL.WARN);
    // appUserID = our auth user id, so the RevenueCat webhook can write the
    // server-side entitlements row for this user.
    Purchases.configure({ apiKey: KEY, appUserID: session.user.id });
    Purchases.getCustomerInfo().then(apply).catch(() => {});
    Purchases.addCustomerInfoUpdateListener(apply);
    setReady(true);
  }, [session?.user.id]);

  const refresh = async () => {
    try {
      apply(await Purchases.getCustomerInfo());
    } catch {
      /* offline — keep last known state */
    }
  };

  return (
    <PurchasesContext.Provider value={{ isPro, ready, refresh }}>
      {children}
    </PurchasesContext.Provider>
  );
}

export const usePurchases = () => useContext(PurchasesContext);
