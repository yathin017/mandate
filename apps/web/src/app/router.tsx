import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";

import { Layout } from "./Layout";

// Everything but the landing page loads on demand, so the first paint ships without charts or wallet flows.
const Explore = lazy(() => import("@/pages/Explore").then((m) => ({ default: m.Explore })));
const MarketMakers = lazy(() => import("@/pages/MarketMakers").then((m) => ({ default: m.MarketMakers })));
const MarketMakerPage = lazy(() => import("@/pages/MarketMakerPage").then((m) => ({ default: m.MarketMakerPage })));
const MandatePage = lazy(() => import("@/pages/MandatePage").then((m) => ({ default: m.MandatePage })));
const IssuerConsole = lazy(() => import("@/pages/IssuerConsole").then((m) => ({ default: m.IssuerConsole })));
const Onboarding = lazy(() => import("@/pages/Onboarding").then((m) => ({ default: m.Onboarding })));
const MMDesk = lazy(() => import("@/pages/MMDesk").then((m) => ({ default: m.MMDesk })));

const page = (element: React.ReactNode) => <Suspense fallback={<Skeleton className="h-96 w-full" />}>{element}</Suspense>;

/** Old paths keep working (shared links), including their query strings. */
function Redirect({ to }: { to: string }) {
  return <Navigate to={{ pathname: to, search: window.location.search }} replace />;
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Landing /> },
      { path: "explore", element: page(<Explore />) },
      { path: "market-makers", element: page(<MarketMakers />) },
      { path: "market-makers/:address", element: page(<MarketMakerPage />) },
      { path: "launch", element: page(<Onboarding />) },
      { path: "issuer", element: page(<IssuerConsole />) },
      { path: "desk", element: page(<MMDesk />) },
      { path: "mandates/:mandateId", element: page(<MandatePage />) },
      { path: "mandates", element: <Redirect to="/explore" /> },
      { path: "onboard", element: <Redirect to="/launch" /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
