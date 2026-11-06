/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Indexer API origin for production builds; dev uses the /api proxy. */
  readonly VITE_API_URL?: string;
  /** Chain RPC used only inside wallet flows (default http://127.0.0.1:8547). */
  readonly VITE_RPC_URL?: string;
  /** Deployment to show: 31337 (local fork, default) or 8453 (Base). Must be registered in @mandate/chains. */
  readonly VITE_CHAIN_ID?: string;
  /** Local fork only: AnchorLauncher address deployed for development. Ignored on live chains. */
  readonly VITE_ANCHOR_LAUNCHER?: string;
}
