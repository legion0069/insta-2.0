import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const userId = searchParams.get("userId")

    if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 })

    const supabase = await getSupabaseServerClient()

    // 1. Get Access Token
    let { data: user } = await supabase
      .from("users")
      .select("access_token, business_account_id")
      .eq("id", userId)
      .single()

    // Fallback if userId string/bigint mismatch or stale session ID
    if (!user?.access_token) {
      const { data: fallbackUser } = await supabase
        .from("users")
        .select("access_token, business_account_id")
        .not("access_token", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .single()

      if (fallbackUser?.access_token) {
        user = fallbackUser
      }
    }

    if (!user?.access_token) {
      return NextResponse.json({ error: "Instagram not connected" }, { status: 401 })
    }

    // 2. Fetch Media from Meta Graph API
    let metaItems: any[] = []
    const igId = user.business_account_id || process.env.INSTAGRAM_ACCOUNT_ID || "17841419844203978"
    const isFb = user.access_token.startsWith("EAA")
    const url = isFb
      ? `https://graph.facebook.com/v24.0/${igId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=24&access_token=${user.access_token}`
      : `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=24&access_token=${user.access_token}`

    try {
      const res = await fetch(url, { cache: "no-store" })
      const data = await res.json()
      if (Array.isArray(data?.data)) {
        metaItems = data.data.map((m: any) => ({
          id: m.id,
          caption: m.caption || "",
          media_type: m.media_type || "VIDEO",
          permalink: m.permalink || `https://www.instagram.com/reel/${m.id}/`,
          image_url: m.thumbnail_url || m.media_url || null,
          timestamp: m.timestamp || new Date().toISOString(),
        }))
      }
    } catch (e) {
      console.warn("[media] Graph API media fetch error:", e)
    }

    // 3. Fetch cached posts / reels from Supabase
    let cachedItems: any[] = []
    try {
      const { data: cache } = await supabase
        .from("media_cache")
        .select("*")
        .eq("user_id", userId)
        .order("timestamp", { ascending: false })

      if (cache && cache.length > 0) {
        cachedItems = cache.map((c: any) => ({
          id: c.media_id,
          caption: c.caption || "Instagram Reel",
          media_type: c.media_type || "VIDEO",
          permalink: c.permalink || `https://www.instagram.com/reel/${c.media_id}/`,
          image_url: c.image_url || null,
          timestamp: c.timestamp || new Date().toISOString(),
        }))
      }
    } catch (e) {
      console.warn("[media] Cache fetch error:", e)
    }

    // Merge without duplicates (Graph API takes precedence)
    const seenIds = new Set<string>()
    const merged: any[] = []

    for (const item of [...metaItems, ...cachedItems]) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id)
        merged.push(item)
      }
    }

    return NextResponse.json({ data: merged })
  } catch (error) {
    console.error("[v0] Server Error:", error)
    return NextResponse.json({ error: "Server Error" }, { status: 500 })
  }
}
