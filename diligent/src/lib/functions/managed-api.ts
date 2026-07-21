// Managed mode was removed for the open-source BYOK build.
export async function shouldUseManagedApi(): Promise<boolean> {
  return false;
}
