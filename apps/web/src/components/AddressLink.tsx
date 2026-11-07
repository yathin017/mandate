import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { addressUrl, txUrl } from "@/wallet/config";

/**
 * A full address or id with a copy button and, on live chains, a button that opens it on the block explorer.
 * `kind` picks the explorer page: an account or contract, a token, a transaction, or `id` for values the explorer has
 * no page for (policy and strategy ids, pool ids) — those take an explicit `href` if they have a page elsewhere.
 */
export function AddressLink({
  value,
  label,
  kind = "address",
  href,
  hrefLabel,
}: {
  value: string;
  label?: string;
  kind?: "address" | "token" | "tx" | "id";
  href?: string;
  /** Accessible name of the open button; defaults to the explorer. */
  hrefLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const explorer =
    href ??
    (kind === "tx" ? txUrl(value) : kind === "id" ? undefined : kind === "token" ? addressUrl(value)?.replace("/address/", "/token/") : addressUrl(value));

  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
      {label && <span className="text-muted-foreground">{label}</span>}
      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={copied ? "Copied" : `Copy ${label ?? "address"}`}
        title={copied ? "Copied" : "Copy"}
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check className="size-3.5 text-filled" /> : <Copy className="size-3.5" />}
      </Button>
      {explorer && (
        <Button asChild variant="ghost" size="icon" className="size-7">
          <a href={explorer} target="_blank" rel="noreferrer noopener" aria-label={hrefLabel ?? "Open on Basescan"} title={hrefLabel ?? "Open on Basescan"}>
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      )}
    </span>
  );
}
