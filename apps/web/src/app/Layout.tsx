import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { Button } from "@/components/ui/button";
import { SyntheticTag } from "@/components/status";
import { useHealth } from "@/lib/hooks";
import { cn } from "@/lib/utils";

import { applyTheme, readTheme, type Theme } from "./theme";

const NAV = [
  { to: "/replay", label: "Replay" },
  { to: "/mandates", label: "Mandates" },
];

export function Layout() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const health = useHealth();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <NavLink to="/" className="font-serif text-lg font-semibold tracking-tight">
            Mandate
          </NavLink>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                    isActive && "bg-muted font-medium text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ChainStatus health={health.data} error={health.isError} />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        Tokens never leave the issuer Safe. Built on 1inch Aqua + SwapVM and Uniswap v4.
      </footer>
    </div>
  );
}

function ChainStatus({ health, error }: { health: ReturnType<typeof useHealth>["data"]; error: boolean }) {
  if (error || (health && !health.ok)) {
    return <span className="text-xs text-blocked">Indexer offline</span>;
  }
  if (!health?.head) return null;
  return (
    <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
      <SyntheticTag label="LOCAL FORK" />
      <span className="tabular font-mono">block {health.head.number}</span>
    </div>
  );
}
