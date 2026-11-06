/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Indexer API origin for production builds; dev uses the /api proxy. */
  readonly VITE_API_URL?: string;
  /** Chain RPC used only inside wallet flows (default http://127.0.0.1:8547). */
  readonly VITE_RPC_URL?: string;
}
