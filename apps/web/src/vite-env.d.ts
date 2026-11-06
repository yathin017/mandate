/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Indexer API origin for production builds; dev uses the /api proxy. */
  readonly VITE_API_URL?: string;
}
