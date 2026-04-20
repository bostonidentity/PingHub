import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { tenantBaseUrl, apiKey, apiSecret } = body as {
    tenantBaseUrl: string;
    apiKey: string;
    apiSecret: string;
  };

  if (!tenantBaseUrl || !apiKey || !apiSecret) {
    return NextResponse.json(
      { ok: false, message: "tenantBaseUrl, apiKey, and apiSecret are required." },
      { status: 400 }
    );
  }

  const base = tenantBaseUrl.replace(/\/+$/, "");
  const url = `${base}/monitoring/logs/sources`;

  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "x-api-secret": apiSecret,
      },
    });

    const text = await res.text();

    if (res.ok) {
      return NextResponse.json({ ok: true, status: res.status, body: text });
    } else {
      return NextResponse.json({
        ok: false,
        status: res.status,
        message: `HTTP ${res.status} ${res.statusText}`,
        body: text,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: String(err) },
      { status: 502 }
    );
  }
}
