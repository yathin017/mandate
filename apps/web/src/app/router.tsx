import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { Landing } from "@/pages/Landing";
import { MandateList } from "@/pages/MandateList";
import { NotFound } from "@/pages/NotFound";

import { Layout } from "./Layout";

// Chart-heavy pages load on demand so the landing page ships without recharts.
const MandatePage = lazy(() => import("@/pages/MandatePage").then((m) => ({ default: m.MandatePage })));
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
      { path: "*", element: <NotFound /> },
    ],
  },
]);
