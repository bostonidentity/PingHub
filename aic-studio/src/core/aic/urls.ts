function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function tokenUrl(tenantUrl: string): string {
  return `${trimSlash(tenantUrl)}/am/oauth2/realms/root/access_token`;
}

export function realmsListUrl(tenantUrl: string): string {
  return `${trimSlash(tenantUrl)}/am/json/global-config/realms?_queryFilter=true`;
}

export function journeysListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees?_queryFilter=true`;
}

export function journeyDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees/${id}`;
}
