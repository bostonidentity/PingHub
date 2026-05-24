// src/core/aic/auth.ts
import axios from "axios";
import { tokenUrl } from "./urls";

export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface AuthParams {
  tenantUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export async function fetchAccessToken(params: AuthParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: params.scope ?? "fr:am:*"
  });

  try {
    const res = await axios.post<{
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(tokenUrl(params.tenantUrl), body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    return {
      accessToken: res.data.access_token,
      expiresInSeconds: res.data.expires_in,
      scope: res.data.scope
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = typeof err.response.data === "object"
        ? JSON.stringify(err.response.data)
        : String(err.response.data);
      throw new Error(`AIC token endpoint returned ${err.response.status}: ${detail}`);
    }
    throw err;
  }
}
