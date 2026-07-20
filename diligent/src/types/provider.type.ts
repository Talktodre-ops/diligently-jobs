export interface TYPE_PROVIDER {
  id?: string;
  /** Human-readable label in provider dropdown (defaults to id). */
  name?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
}
