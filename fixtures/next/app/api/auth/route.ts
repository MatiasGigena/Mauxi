import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("mauxi-next-auth", "1", { httpOnly: true, sameSite: "lax", path: "/" });
  return response;
}
