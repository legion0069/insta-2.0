import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const error = searchParams.get("error")

  if (error) {
    const redirectUrl = new URL("/", request.url)
    redirectUrl.searchParams.set("error", error)
    return NextResponse.redirect(redirectUrl)
  }

  if (code) {
    const redirectUrl = new URL("/", request.url)
    redirectUrl.searchParams.set("code", code)
    return NextResponse.redirect(redirectUrl)
  }

  return NextResponse.json({ error: "Invalid callback" }, { status: 400 })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    let { code } = body
    if (!code) return NextResponse.json({ error: "No code" }, { status: 400 })

    // Facebook OAuth often appends '#_' to codes
    const cleanCode = code.replace(/#_$/, "").trim()

    // 1. Env Vars
    let clientId = process.env.INSTAGRAM_APP_ID || "4169116393392766"
    const clientSecret = process.env.INSTAGRAM_APP_SECRET
    const redirectUri = process.env.NEXT_PUBLIC_INSTAGRAM_REDIRECT_URI || "https://insta-2-0-psi.vercel.app/api/instagram/callback"

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Missing Env Vars: Check INSTAGRAM_APP_ID")
    }

    // 2. Exchange Code for Access Token
    let accessToken: string = ""
    let loginUserId: string = ""
    let expiresIn = 5184000 // 60 days default

    const tokenParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: cleanCode,
    })

    const igRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    })
    const igData = await igRes.json()

    if (igRes.ok && igData.access_token) {
      const shortToken = igData.access_token
      loginUserId = igData.user_id ? igData.user_id.toString() : ""
      const longLivedUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${clientSecret}&access_token=${shortToken}`
      const longRes = await fetch(longLivedUrl)
      const longData = await longRes.json()
      accessToken = longData.access_token || shortToken
      if (longData.expires_in) expiresIn = longData.expires_in
    } else {
      // Fallback: Exchange via Meta Graph API (Unified Login / Facebook Login for Business)
      console.log("[v0] Exchanging code via Meta Graph API...")
      const fbParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code: cleanCode,
      })
      const fbTokenUrl = `https://graph.facebook.com/v24.0/oauth/access_token?${fbParams.toString()}`
      const fbRes = await fetch(fbTokenUrl)
      const fbData = await fbRes.json()

      if (!fbRes.ok || !fbData.access_token) {
        if (fbData.error?.message?.includes("authorization code has been used") || igData.error_message?.includes("authorization code has been used")) {
          return NextResponse.json({ error: "Code already used" }, { status: 400 })
        }
        console.error("[v0] 🔴 Token Error (IG):", JSON.stringify(igData, null, 2))
        console.error("[v0] 🔴 Token Error (FB):", JSON.stringify(fbData, null, 2))
        return NextResponse.json({ error: fbData.error?.message || igData.error_message || "Token exchange failed" }, { status: 400 })
      }

      accessToken = fbData.access_token
      if (fbData.expires_in) expiresIn = fbData.expires_in
    }

    // 3. Get Username + IG Professional Account ID
    let username = `user_${Date.now()}`
    let businessAccountId = loginUserId
    let profilePic: string | null = null

    // Attempt 1: graph.instagram.com/v24.0/me
    try {
      const meRes = await fetch(
        `https://graph.instagram.com/v24.0/me?fields=user_id,username,profile_picture_url&access_token=${accessToken}`
      )
      const meData = await meRes.json()
      console.log("[v0] 📋 /me (Instagram) response:", JSON.stringify(meData))

      if (meData.username) username = meData.username
      if (meData.profile_picture_url) profilePic = meData.profile_picture_url
      if (meData.user_id) businessAccountId = meData.user_id.toString()
      else if (meData.id) businessAccountId = meData.id.toString()
    } catch (e) {
      console.warn("[v0] IG /me failed:", e)
    }

    // Attempt 2: If no businessAccountId, check accounts via graph.facebook.com
    if (!businessAccountId) {
      try {
        const pagesRes = await fetch(
          `https://graph.facebook.com/v24.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${accessToken}`
        )
        const pagesData = await pagesRes.json()
        console.log("[v0] 📋 /me/accounts (Facebook) response:", JSON.stringify(pagesData))
        const pageWithIg = pagesData.data?.find((p: any) => p.instagram_business_account)
        if (pageWithIg?.instagram_business_account) {
          const ig = pageWithIg.instagram_business_account
          businessAccountId = ig.id.toString()
          if (ig.username) username = ig.username
          if (ig.profile_picture_url) profilePic = ig.profile_picture_url
          if (pageWithIg.access_token) accessToken = pageWithIg.access_token
        }
      } catch (e) {
        console.warn("[v0] FB /me/accounts failed:", e)
      }
    }

    // Attempt 3: Direct FB /me fallback
    if (!businessAccountId) {
      try {
        const fbMeRes = await fetch(`https://graph.facebook.com/v24.0/me?fields=id,name&access_token=${accessToken}`)
        const fbMeData = await fbMeRes.json()
        if (fbMeData.id) businessAccountId = fbMeData.id.toString()
        if (fbMeData.name && username.startsWith("user_")) username = fbMeData.name
      } catch (e) {}
    }

    // Attempt 4: Direct Instagram Professional Account Verification
    // Ensure tokens for @vamshi__verse are always saved to the Instagram account ID, not a system user ID
    try {
      const igVerify = await fetch(
        `https://graph.facebook.com/v24.0/17841479501766910?fields=id,username,profile_picture_url&access_token=${accessToken}`
      )
      const igData = await igVerify.json()
      if (igData.id && igData.username) {
        businessAccountId = igData.id.toString()
        username = igData.username
        if (igData.profile_picture_url) profilePic = igData.profile_picture_url
      }
    } catch (e) {
      console.warn("[v0] IG direct verify check failed:", e)
    }

    const finalUserId = businessAccountId || loginUserId || "17841479501766910"

    // 6. Save/Update User
    const supabase = await getSupabaseServerClient()

    // Clean up any accidental system user rows so active-user never desyncs
    await supabase.from("users").delete().eq("username", "Automation System User")

    const updates: any = {
      username,
      access_token: accessToken,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      business_account_id: businessAccountId,
      page_id: businessAccountId, // Always keep in sync
    }

    console.log(`[v0] 💾 Saving user: ${username} | id=${finalUserId} | biz_id=${businessAccountId}`)

    const { error: upsertError } = await supabase
      .from("users")
      .upsert({ id: finalUserId, ...updates }, { onConflict: "id" })

    if (upsertError) throw upsertError

    const response = NextResponse.json({ success: true, username, userId: finalUserId, profilePic })
    response.cookies.set("insta_session", JSON.stringify({ username, userId: finalUserId }), {
      path: "/",
      maxAge: expiresIn,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    })
    return response

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
