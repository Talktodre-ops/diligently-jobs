/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL, e.g. `http://localhost:8787`. */
  readonly VITE_BACKEND_URL: string;
  /** Shared bearer token; must match the backend's `BEARER_TOKEN`. */
  readonly VITE_BEARER_TOKEN: string;
  /** Stable identifier for this device, written to `events.device_id`. */
  readonly VITE_DEVICE_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
