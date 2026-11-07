import { Link } from "react-router";

import { Button } from "@/components/ui/button";

export function NotFound({ message = "This page does not exist." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="font-serif text-2xl">Nothing here</p>
      <p className="text-muted-foreground">{message}</p>
      <Button asChild variant="outline">
        <Link to="/">Back home</Link>
      </Button>
    </div>
  );
}
