import { createBrowserRouter } from "react-router";

import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";

import { Layout } from "./Layout";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Landing /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
