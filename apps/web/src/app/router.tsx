import { createBrowserRouter } from "react-router";

import { Landing } from "@/pages/Landing";
import { MandateList } from "@/pages/MandateList";
import { MandatePage } from "@/pages/MandatePage";
import { NotFound } from "@/pages/NotFound";
import { ReplayTheater } from "@/pages/ReplayTheater";

import { Layout } from "./Layout";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Landing /> },
      { path: "replay", element: <ReplayTheater /> },
      { path: "mandates", element: <MandateList /> },
      { path: "mandates/:mandateId", element: <MandatePage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
