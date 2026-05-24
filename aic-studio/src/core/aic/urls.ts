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

export function samlProvidersListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/federation/entityproviders/saml2?_queryFilter=true`;
}

export function samlProviderDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/federation/entityproviders/saml2/${id}`;
}

export function oidcClientsListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/agents/OAuth2Client?_queryFilter=true`;
}

export function oidcClientDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/agents/OAuth2Client/${id}`;
}

export function logsQueryUrl(tenantUrl: string, params: {
  source: string;
  filterExpr?: string;
  pageSize?: number;
  beginTime?: string;
  endTime?: string;
}): string {
  const q = new URLSearchParams({ source: params.source });
  q.set("_pageSize", String(params.pageSize ?? 100));
  if (params.filterExpr) q.set("_queryFilter", params.filterExpr);
  if (params.beginTime) q.set("beginTime", params.beginTime);
  if (params.endTime) q.set("endTime", params.endTime);
  return `${trimSlash(tenantUrl)}/monitoring/logs?${q.toString()}`;
}
