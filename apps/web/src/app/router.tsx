import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { Landing } from "@/pages/Landing";
import { MandateList } from "@/pages/MandateList";
import { NotFound } from "@/pages/NotFound";

import { Layout } from "./Layout";

// Chart-heavy pages load on demand so the landing page ships without recharts.
const MandatePage = lazy(() => import("@/pages/MandatePage").then((m) => ({ default: m.MandatePage })));
const IssuerConsole = lazy(() => import("@/pages/IssuerConsole").then((m) => ({ default: m.IssuerConsole })));
const Onboarding = lazy(() => import("@/pages/Onboarding").then((m) => ({ default: m.Onboarding })));
const MMDesk = lazy(() => import("@/pages/MMDesk").then((m) => ({ default: m.MMDesk })));
const ReplayTheater = lazy(() => import("@/pages/ReplayTheater").then((m) => ({ default: m.ReplayTheater })));

const page = (element: React.ReactNode) => <Suspense fallback={<Skeleton className="h-96 w-full" />}>{element}</Suspense>;

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Landing /> },
      { path: "replay", element: page(<ReplayTheater />) },
      { path: "mandates", element: <MandateList /> },
      { path: "mandates/:mandateId", element: page(<MandatePage />) },
      { path: "issuer", element: page(<IssuerConsole />) },
      { path: "desk", element: page(<MMDesk />) },
      { path: "onboard", element: page(<Onboarding />) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
