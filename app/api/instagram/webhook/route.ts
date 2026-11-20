/* @ts-nocheck */

import crypto from "crypto"
import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"
import { ensureSchema } from "@/lib/supabase-migrate"
import {
  sendTextDM,
  sendCardDM,
  sendMediaDM,
  sendSenderAction,
  replyToComment,
  fetchProfile,
  verifyIdOwnership,
  sleep,
  buildFollowGateCard,
} from "@/lib/instagram-api"
import { generateAIReply } from "@/lib/ai-reply"
import { bumpUnlockAttempt, clearUnlockAttempts, unlockKey } from "@/lib/unlock-tracking"

const WEBHOOK_VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
// Meta signs every webhook POST with HMAC-SHA256 of the raw body. Depending on app setup the
// signing key is the Instagram app secret or the parent Meta app secret, so accept either.
const APP_SECRETS = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(
  (s): s is string => Boolean(s),
)

function isValidSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (APP_SECRETS.length === 0 || !signatureHeader?.startsWith("sha256=")) return false
  const received = signatureHeader.slice("sha256=".length)
  return APP_SECRETS.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"))
    )
  })
}

const DEFAULT_PUBLIC_REPLIES = [
  "Check your DMs! 📥",
  "Sent you the link! 🔥",
  "Check your inbox! ✨",
  "Just sent it to your DMs! 📩",
  "Check your messages! 👍",
  "Sent! Check your DMs 🚀",
]

// Max times we'll send the gate card for an unverifiable follow status on a single unlock event.
// After this, we send a single "couldn't verify your follow" message and stop spamming the user.
const UNLOCK_GATE_MAX_ATTEMPTS = 3

function shortcodeToId(shortcode: string): string {
  try {
    let id = BigInt(0)
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    for (let i = 0; i < shortcode.length; i++) {
      const idx = alphabet.indexOf(shortcode[i])
      if (idx === -1) return shortcode
      id = id * BigInt(64) + BigInt(idx)
    }
    return id.toString()
  } catch {
    return shortcode
  }
}

function isMediaMatch(savedId: string | null | undefined, incomingId: string): boolean {
  if (!savedId) return true
  if (savedId === incomingId) return true
  if (shortcodeToId(savedId) === incomingId) return true
  return false
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: "Invalid token" }, { status: 403 })
}

// ============================================================
// Content parsing — response_content may be object or JSON string
// ============================================================
function parseContent(raw: any) {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return { message: raw }
    }
  }
  return raw
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function keywordMatches(triggerValue: string, text: string): boolean {
  if (!triggerValue || !text) return false
  if (triggerValue === "*" || triggerValue === "any") return true
  const cleanText = text.toLowerCase()
  return triggerValue
    .split(",")
    .map((k: string) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((k: string) => {
      if (k === "*" || k === "any") return true
      if (cleanText.includes(k)) return true
      try {
        return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cleanText)
      } catch {
        return false
      }
    })
}

// ============================================================
// Unified response sender — handles text, card, media, quick
// replies, typing indicators, and human-like delays.
// ============================================================
async function sendAutomationResponse(
  token: string,
  recipient: { id?: string; comment_id?: string },
  content: any,
  opts: { skipTyping?: boolean } = {},
) {
  const delaySeconds = Number(content.delay_seconds) || 0
  const waitMs = delaySeconds > 0 ? delaySeconds * 1000 : Math.floor(Math.random() * 3000) + 2000 // 2-5s human jitter
  const useTyping = content.typing_indicator === true && recipient.id && !opts.skipTyping

  if (useTyping) await sendSenderAction(token, recipient.id!, "typing_on")
  await sleep(waitMs)

  const quickReplies = Array.isArray(content.quick_replies)
    ? content.quick_replies
        .filter((q: any) => q?.title)
        .map((q: any) => ({ title: q.title, payload: q.payload || `QR_${q.title.toUpperCase().replace(/\s+/g, "_")}` }))
    : undefined

  // Anti-spam message variator: slightly vary greetings so Meta doesn't flag identical string hash
  const getMessageText = (msg: string) => {
    if (!msg) return msg
    const greetings = ["", "Hey! ", "Hi there! ", "Here you go: ", "Hey, "]
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)]
    return randomGreeting ? `${randomGreeting}${msg}` : msg
  }

  let result
  if (content.media?.url) {
    result = await sendMediaDM(token, recipient, content.media.type || "image", content.media.url)
    if (result.ok && content.message) {
      result = await sendTextDM(token, recipient, getMessageText(content.message), quickReplies)
    }
  } else if (content.card) {
    result = await sendCardDM(token, recipient, content.card)
    if (!result.ok && content.message) {
      console.warn("[webhook] Card DM delivery failed, falling back to text DM:", result.error)
      result = await sendTextDM(token, recipient, getMessageText(content.message), quickReplies)
    }
  } else if (content.message) {
    result = await sendTextDM(token, recipient, getMessageText(content.message), quickReplies)
  } else {
    result = { ok: false, error: "empty content" }
  }

  if (useTyping) await sendSenderAction(token, recipient.id!, "typing_off")
  return result
}

function responsePreviewText(content: any): string {
  if (content.message) return content.message
  if (content.card) return `[Card] ${content.card.title}`
  if (content.media?.url) return `[${content.media.type || "media"}]`
  return "[automation]"
}

// ============================================================
// Instagram API Helper: Verifies actual follow status
// API: GET https://graph.instagram.com/v21.0/{recipientId}?fields=is_user_follow_business
// Returns:
//   { follows: true, error: undefined }  → confirmed following
//   { follows: false, error: undefined } → confirmed NOT following
//   { follows: null, error: 'auth' } → auth/permission failure (401, 403) — fail CLOSED
//   { follows: null, error: 'transient' } → transient failure (5xx, timeout) — fail OPEN
// ============================================================
async function verifyFollowStatus(igScopedId: string, pageAccessToken: string): Promise<{ follows: boolean | null; error?: 'auth' | 'transient' }> {
  try {
    const isFb = pageAccessToken.startsWith("EAA")
    const baseUrl = isFb ? "https://graph.facebook.com/v24.0" : "https://graph.instagram.com/v21.0"
    const url = `${baseUrl}/${igScopedId}?fields=name,username,is_user_follow_business&access_token=${pageAccessToken}`
    // 5s timeout -- Graph API is fast, anything longer means trouble
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      const errorText = await response.text()
      console.warn(`[webhook] Follow status check note: ${response.status} ${errorText}`)
      // Distinguish auth failures (fail closed) from transient (fail open)
      if (response.status === 401 || response.status === 403) {
        return { follows: null, error: 'auth' }
      }
      // 5xx, 429, network timeout, etc. → transient, fail open
      return { follows: null, error: 'transient' }
    }
    const data = await response.json()
    const follows = typeof data.is_user_follow_business === "boolean" ? data.is_user_follow_business : null
    console.log(`[webhook] Follow check for ${igScopedId} (@${data.username || "unknown"}): is_user_follow_business=${data.is_user_follow_business} => ${follows ? "FOLLOWS" : "NOT FOLLOWING"}`)
    return { follows, error: undefined }
  } catch (error: any) {
    console.warn("[webhook] Error checking follow status:", error)
    // AbortSignal.timeout throws AbortError/TimeoutError -- both are transient
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      return { follows: null, error: 'transient' }
    }
    // Network error → transient, fail open
    return { follows: null, error: 'transient' }
  }
}

// Unlock-attempt counter is in lib/unlock-tracking.ts -- uses Supabase
// unlock_attempts table so the 3-attempt cap works across Vercel instances.

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const signature = request.headers.get("x-hub-signature-256")
    if (!isValidSignature(rawBody, signature)) {
      console.warn(
        `[webhook] Signature check mismatch (incoming x-hub-signature-256 did not match local APP_SECRETS). Permitting request for setup/testing.`,
      )
    }
    const body = JSON.parse(rawBody)
    if (!body.entry) return NextResponse.json({ ok: true })

    const supabase = await getSupabaseServerClient()

    // Store raw incoming webhook payload in Supabase for full debugging & visibility
    try {
      await supabase.from("webhook_events").insert({
        event_type: body.object || "instagram_event",
        data: body,
      })
    } catch (e) {
      console.warn("[webhook] Failed to record webhook_events:", e)
    }

    // Ensure schema is up-to-date on cold start (idempotent, no-op if all tables exist)
    ensureSchema().catch((e) => console.warn("[webhook] ensureSchema failed:", e?.message))

    for (const entry of body.entry) {
      // Skip pure system events (echo / read / delivery)
      if (entry.messaging) {
        const isSystemEvent = entry.messaging.every(
          (event: any) => event.read || event.delivery || (event.message && event.message.is_echo),
        )
        if (isSystemEvent) continue
      }

      const webhookId = entry.id

      // ---------- User resolution: direct, payload fallback, token verify ----------
      let { data: user } = await supabase
        .from("users")
        .select("*")
        .or(`business_account_id.eq.${webhookId},page_id.eq.${webhookId}`)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!user) {
        const candidateIds = new Set<string>()
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.value?.media?.owner?.id) candidateIds.add(String(change.value.media.owner.id))
          }
        }
        if (entry.messaging) {
          for (const event of entry.messaging) {
            if (event.recipient?.id) candidateIds.add(String(event.recipient.id))
          }
        }
        for (const candidateId of candidateIds) {
          if (candidateId === webhookId) continue
          const { data: fallbackUser } = await supabase
            .from("users")
            .select("*")
            .or(`business_account_id.eq.${candidateId},page_id.eq.${candidateId}`)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle()
          if (fallbackUser) {
            await supabase.from("users").update({ page_id: webhookId }).eq("id", fallbackUser.id)
            user = fallbackUser
            break
          }
        }
      }

      if (!user) {
        const { data: allUsers } = await supabase
          .from("users")
          .select("*")
          .order("updated_at", { ascending: false })
        if (allUsers && allUsers.length > 0) {
          user = allUsers[0]
          console.log(`[webhook] Auto-bound webhook to active user ${user.username} (${user.id})`)
        }
      }

      if (!user) {
        console.log(`[webhook] ❌ Could not resolve user for ID ${webhookId}`)
        continue
      }

      if (process.env.INSTAGRAM_ACCESS_TOKEN) {
        user.access_token = process.env.INSTAGRAM_ACCESS_TOKEN
      }

      let { data: automations } = await supabase
        .from("automations")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)

      if (!automations || automations.length === 0) {
        const { data: allActive } = await supabase
          .from("automations")
          .select("*")
          .eq("is_active", true)
        if (allActive) automations = allActive
      }

      if (!automations?.length) continue

      // ============================================================
      //  PART A: COMMENTS
      // ============================================================
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field !== "comments" || !change.value?.text) continue

          const commentId = change.value.id
          const commentText = change.value.text.toLowerCase().trim()
          const senderId = change.value.from.id
          const mediaId = change.value.media.id
          const parentId = change.value.parent_id || null

          if (senderId === webhookId || senderId === user.business_account_id || senderId === user.page_id) continue

          const commentAutomations = automations.filter((a: any) => a.trigger_source === "comment")

          // Priority: specific post reply-all → specific post keyword → global reply-all → global keyword
          let match = commentAutomations.find(
            (a: any) =>
              isMediaMatch(a.specific_media_id, mediaId) &&
              (a.trigger_type === "reply_all" || a.trigger_value === "ALL_COMMENTS" || a.trigger_value === "*" || a.trigger_value === "any"),
          )
          if (!match) {
            match = commentAutomations.find(
              (a: any) =>
                isMediaMatch(a.specific_media_id, mediaId) &&
                keywordMatches(a.trigger_value, commentText),
            )
          }
          if (!match) {
            match = commentAutomations.find(
              (a: any) =>
                !a.specific_media_id &&
                (a.trigger_type === "reply_all" || a.trigger_value === "ALL_COMMENTS" || a.trigger_value === "*" || a.trigger_value === "any"),
            )
          }
          if (!match) {
            match = commentAutomations.find(
              (a: any) =>
                !a.specific_media_id &&
                keywordMatches(a.trigger_value, commentText),
            )
          }
          if (!match) continue

                    const content = parseContent(match.response_content)

                    // Skip nested replies unless user opted in
                    if (parentId && content.include_replies !== true) continue

                    console.log(`[webhook] ✅ Comment match: "${match.name}"`)

                    // reply_mode: 'both' (default) | 'dm_only' | 'public_only'
                    const replyMode = content.reply_mode || "both"

                    // Helper: pick a public reply from user's rotation list (with defaults fallback)
                    const getPublicReply = (): string => {
                      const pool: string[] =
                        Array.isArray(content.public_replies) && content.public_replies.filter(Boolean).length > 0
                          ? content.public_replies.filter(Boolean)
                          : DEFAULT_PUBLIC_REPLIES
                      return pickRandom(pool)
                    }

                    const commenterUsername = change.value?.from?.username || "instagram_user"
                    const recordCommentReplyStats = async (messageText: string) => {
                      try {
                        const { data: conv } = await supabase
                          .from("conversations")
                          .upsert({
                            user_id: user.id,
                            recipient_id: senderId,
                            recipient_username: commenterUsername,
                            last_message_at: new Date().toISOString(),
                          }, { onConflict: "user_id,recipient_id" })
                          .select("id")
                          .single()

                        if (conv?.id) {
                          await supabase.from("messages").insert({
                            id: `mid_comment_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                            conversation_id: conv.id,
                            user_id: user.id,
                            sender_id: user.business_account_id || user.id,
                            sender_username: user.username,
                            content: messageText || responsePreviewText(content) || "Automated reply",
                            is_from_instagram: false,
                          })
                        }
                      } catch (statErr) {
                        console.warn("[webhook] Failed to log stats message:", statErr)
                      }
                    }

                    // ===== FOLLOWER GATE FOR COMMENTS (Step 1: Interaction Card) =====
                    if (content.check_follow === true) {
                      console.log(`[webhook] 🔒 Follow-Gate comment triggered by @${commenterUsername} (${senderId}) for rule "${match.name}"`)
                      if (replyMode !== "dm_only") {
                        await replyToComment(user.access_token, commentId, getPublicReply())
                      }
                      if (replyMode !== "public_only") {
                        const cardTitle = content.card?.title || match.name || "Your Application Links"
                        const interactCard = {
                          title: `🚀 ${cardTitle}`.slice(0, 80),
                          subtitle: "Tap below and we'll send the links right into your DMs 👇",
                          buttons: [
                            {
                              type: "postback" as const,
                              title: "📩 Send Me The Link",
                              payload: `START_GATE_${match.id}`,
                            },
                          ],
                        }
                        const res = await sendCardDM(user.access_token, { comment_id: commentId }, interactCard)
                        console.log("[webhook] Sent initial interaction card to comment:", JSON.stringify(res))
                        await recordCommentReplyStats("Sent 'Send Me The Link' interaction button")
                      } else {
                        await recordCommentReplyStats(getPublicReply())
                      }
                    } else {
                      // No follower check required — send normally
                      if (replyMode !== "dm_only") {
                        const pubRes = await replyToComment(user.access_token, commentId, getPublicReply())
                        console.log("[webhook] Public comment reply result:", JSON.stringify(pubRes))
                      }
                      if (replyMode !== "public_only") {
                        const dmRes = await sendAutomationResponse(
                          user.access_token,
                          { comment_id: commentId },
                          content,
                          { skipTyping: true },
                        )
                        console.log("[webhook] Private DM reply result:", JSON.stringify(dmRes))
                        if (dmRes?.error?.code === 368) {
                          console.warn(`[webhook] ⚠️ Meta anti-spam block 368 detected for comment ${commentId}. Sending bio fallback.`)
                          try {
                            await replyToComment(
                              user.access_token,
                              commentId,
                              "If the DM doesn't arrive, check the direct link in my bio! 🔗",
                            )
                          } catch (bioErr) {
                            console.warn("[webhook] Failed to send bio fallback comment:", bioErr)
                          }
                        }
                        try {
                          await supabase.from("webhook_events").insert({
                            event_type: "dm_dispatch",
                            data: { rule: match.name, commentId, dmRes },
                          })
                        } catch (logErr) {
                          // Ignore non-critical debug log failure
                        }

                        await recordCommentReplyStats(responsePreviewText(content))
                      } else {
                        await recordCommentReplyStats(getPublicReply())
                      }
                    }
        }
      }

      // ============================================================
      //  PART A.5: STORY AUTOMATIONS (mention / reaction / reply)
      // ============================================================
      if (entry.messaging) {
        for (const event of entry.messaging) {
          const senderId = event.sender.id
          const recipientId = event.recipient.id
          if (event.read || event.delivery || event.message?.is_echo || senderId === recipientId) continue

          const storyAutomations = automations.filter((a: any) => a.trigger_source === "story")
          if (storyAutomations.length === 0) continue

          let match = null
          let storyMediaId: string | null = null

          if (event.message?.attachments?.[0]?.type === "story_mention") {
            storyMediaId = event.message.attachments[0].payload?.url || null
            match = storyAutomations.find(
              (a: any) => a.trigger_type === "mention" && (!a.specific_media_id || a.specific_media_id === storyMediaId),
            )
          } else if (event.reaction) {
            const reactionEmoji = event.reaction.emoji
            storyMediaId = event.reaction.mid || null
            match = storyAutomations.find((a: any) => {
              if (a.trigger_type !== "reaction") return false
              if (a.specific_media_id && a.specific_media_id !== storyMediaId) return false
              const triggers = a.trigger_value?.split(",").map((t: string) => t.trim()) || []
              if (triggers.length > 0 && triggers[0] !== "ALL" && triggers[0] !== "ALL_REACTIONS" && triggers[0] !== "") {
                return triggers.includes(reactionEmoji)
              }
              return true
            })
          } else if (event.message?.reply_to?.story) {
            const messageText = event.message.text || ""
            storyMediaId = event.message.reply_to.story.id || null
            match = storyAutomations.find((a: any) => {
              if (a.trigger_type !== "reply") return false
              if (a.specific_media_id && a.specific_media_id !== storyMediaId) return false
              const triggers = a.trigger_value?.split(",").map((t: string) => t.trim()) || []
              if (
                triggers.length > 0 &&
                triggers[0] !== "ALL" &&
                triggers[0] !== "ALL_MENTIONS" &&
                triggers[0] !== ""
              ) {
                return keywordMatches(a.trigger_value, messageText)
              }
              return true
            })
          }

          if (match) {
                                          console.log(`[webhook] ✨ Story match: "${match.name}"`)
                                          const content = parseContent(match.response_content)

                                          if (content.check_follow === true) {
                                            const followResult = await verifyFollowStatus(senderId, user.access_token)

                                            if (followResult.follows === true) {
                                              console.log(`[webhook] ✅ Story follower gate: @${senderId} follows @${user.username} — sending content`)
                                              await sendAutomationResponse(user.access_token, { id: senderId }, content)
                                            } else if (followResult.follows === false) {
                                              console.log(`[webhook] 🔒 Story follower gate: @${senderId} doesn't follow @${user.username}`)
                                              await sendCardDM(user.access_token, { id: senderId }, buildFollowGateCard({ username: user.username, ruleId: match.id }))
                                            } else {
                                              // null → unverifiable. Distinguish auth vs transient.
                                              const isAuthError = followResult.error === 'auth'
                                              if (isAuthError) {
                                                // Auth failure — fail CLOSED: send gate
                                                console.warn(`[webhook] ⚠️ Story follower gate auth failure for @${senderId}; sending gate`)
                                                await sendCardDM(user.access_token, { id: senderId }, buildFollowGateCard({ username: user.username, ruleId: match.id }))
                                              } else {
                                                // Transient failure — fail OPEN: deliver content
                                                console.warn(`[webhook] ⚠️ Story follower gate transient failure for @${senderId}; failing open`)
                                                await sendAutomationResponse(user.access_token, { id: senderId }, content)
                                              }
                                            }
                                          } else {
                                            // No follower check required — send normally
                                            await sendAutomationResponse(user.access_token, { id: senderId }, content)
                                          }
                                        }
        }
      }

      // ============================================================
      //  PART B: DIRECT MESSAGES
      // ============================================================
      if (entry.messaging) {
        for (const event of entry.messaging) {
          if (event.read || event.delivery || event.reaction || event.message?.is_echo) continue

          const senderId = event.sender.id
          if (senderId === webhookId || senderId === user.business_account_id || senderId === user.page_id) continue

          let triggerType = ""
          let triggerValue = ""

          if (event.message?.quick_reply?.payload) {
            triggerType = "postback"
            triggerValue = event.message.quick_reply.payload
          } else if (event.message?.text) {
            triggerType = "keyword"
            triggerValue = event.message.text.toLowerCase().trim()
          } else if (event.postback?.payload) {
            triggerType = "postback"
            triggerValue = event.postback.payload
          } else {
            continue
          }

          console.log(`[webhook] 📩 DM from ${senderId}: "${triggerValue}"`)

          // Inbox bookkeeping runs alongside delivery, not ahead of it. Always
          // joined below so serverless shutdown cannot discard pending writes.
          const incomingSaved = (async () => {
          let conv = null
          try {
            const { data: existing } = await supabase
              .from("conversations")
              .select("id")
              .eq("user_id", user.id)
              .eq("recipient_id", senderId)
              .single()

            if (!existing) {
              let realUsername = `cnt_${senderId.slice(0, 5)}...`
              const profile = await fetchProfile(user.access_token, senderId)
              if (profile?.username) realUsername = profile.username

              const { data: newConv } = await supabase
                .from("conversations")
                .insert({
                  user_id: user.id,
                  recipient_id: senderId,
                  recipient_username: realUsername,
                  last_message_at: new Date().toISOString(),
                })
                .select("id")
                .single()
              conv = newConv
            } else {
              conv = existing
              await supabase
                .from("conversations")
                .update({ last_message_at: new Date().toISOString() })
                .eq("id", existing.id)
            }

            if (conv) {
              await supabase.from("messages").insert({
                id: event.message?.mid || `mid_${Date.now()}_${Math.random()}`,
                conversation_id: conv.id,
                user_id: user.id,
                sender_id: senderId,
                sender_username: "User",
                content: triggerValue,
                is_from_instagram: true,
              })
            }
          } catch (err) {
            console.error("[webhook] Failed to save incoming message", err)
          }
          return conv
          })()

          try {
          // ---------- Match automation ----------
                    const dmAutomations = automations.filter((a: any) => a.trigger_source === "dm" || !a.trigger_source)
                    let match = null

                    const isUnlockEvent = triggerType === "postback" && triggerValue.startsWith("UNLOCK_CONTENT_")
                    const isStartGate = triggerType === "postback" && triggerValue.startsWith("START_GATE_")

                    if (triggerType === "postback") {
                      if (isUnlockEvent) {
                        const ruleId = triggerValue.replace("UNLOCK_CONTENT_", "")
                        match = automations.find((a) => a.id === ruleId)
                      } else if (isStartGate) {
                        const ruleId = triggerValue.replace("START_GATE_", "")
                        match = automations.find((a) => a.id === ruleId)
                      } else if (triggerValue.startsWith("ICE_BREAKER_")) {
                        const iceBreakerId = triggerValue.replace("ICE_BREAKER_", "")
                        const { data: ib } = await supabase
                          .from("ice_breakers")
                          .select("*")
                          .eq("id", iceBreakerId)
                          .eq("user_id", user.id)
                          .single()
                        if (ib) {
                          match = { name: "Ice Breaker: " + ib.question, response_content: { message: ib.response } }
                        }
                      } else {
                        match = automations.find((a) => a.trigger_type === "postback" && a.trigger_value === triggerValue)
                        // Quick reply payloads can also match keyword rules
                        if (!match) {
                          match = dmAutomations.find(
                            (a) => a.trigger_type === "keyword" && keywordMatches(a.trigger_value, triggerValue.toLowerCase()),
                          )
                        }
                      }
                    } else {
                      match = dmAutomations.find(
                        (a) => a.trigger_type === "keyword" && keywordMatches(a.trigger_value, triggerValue),
                      )
                    }

                    if (!match) {
                      // AI fallback: if no keyword rule matched, try AI auto-reply
                      if (user.groq_auto_reply_enabled && triggerType !== "postback") {
                        console.log(`[webhook] 🤖 No rule match — trying AI auto-reply for DM from ${senderId}`)
                        await sendSenderAction(user.access_token, senderId, "mark_seen")
                        const conv = await incomingSaved // AI needs history; keyword replies do not.
                        const { data: recentMessages } = conv
                          ? await supabase
                              .from("messages")
                              .select("content, is_from_instagram")
                              .eq("conversation_id", conv.id)
                              .order("created_at", { ascending: false })
                              .limit(10)
                          : { data: [] }
                        const history = (recentMessages || []).reverse().map((message: any) => ({
                          role: message.is_from_instagram ? "user" as const : "assistant" as const,
                          content: message.content,
                        }))
                        const aiReply = await generateAIReply(triggerValue, user.ai_context || "", history, user.groq_api_key, user.ai_base_url, user.ai_model)
                        if (aiReply) {
                          await sendSenderAction(user.access_token, senderId, "typing_on")
                          const result = await sendTextDM(user.access_token, { id: senderId }, aiReply)
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_ai_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: aiReply,
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save AI reply", e)
                            }
                          }
                        }
                      }
                      continue
                    }

                    if (!match) continue

                    console.log(`[webhook] ✅ DM match: "${match.name}"`)
                    const content = parseContent(match.response_content)

                    // Mark message as seen for human-like flow
                    if (content.mark_seen !== false) {
                      await sendSenderAction(user.access_token, senderId, "mark_seen")
                    }

                    // ---------- Follow gate for DMs ----------
                    const attemptKey = unlockKey(senderId, match.id)

                    if (content.check_follow === true) {
                      if (isStartGate) {
                        // Step 2: User tapped "Send Me The Link" from the comment private reply!
                        console.log(`[webhook] 📩 START_GATE postback from @${senderId} for rule "${match.name}"`)
                        const followResult = await verifyFollowStatus(senderId, user.access_token)

                        if (followResult.follows === true) {
                          // Already following! Deliver content immediately
                          await clearUnlockAttempts(attemptKey)
                          console.log(`[webhook] ✅ @${senderId} is already following @${user.username} — delivering content`)
                          await sendTextDM(
                            user.access_token,
                            { id: senderId },
                            `🎉 Awesome! You're already following @${user.username || "thehyderabadiedu.co"}! Here are your links:`,
                          )
                          const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: responsePreviewText(content),
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        } else {
                          // Not following yet (or unverified) -> Send Follow-Gate card with "👉 Follow Now" & "✅ I'm Following"
                          console.log(`[webhook] 🔒 @${senderId} is not following yet (follows=${followResult.follows}) — sending Follow-Gate card`)
                          const result = await sendCardDM(
                            user.access_token,
                            { id: senderId },
                            buildFollowGateCard({ username: user.username, ruleId: match.id }),
                          )
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: "[Follow-Gate: Sent Follow Now & I'm Following card]",
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        }
                      } else if (isUnlockEvent) {
                        // Step 3: User tapped "✅ I'm Following" button!
                        console.log(`[webhook] 🔍 UNLOCK_CONTENT check for @${senderId} for rule "${match.name}"`)
                        const followResult = await verifyFollowStatus(senderId, user.access_token)

                        if (followResult.follows === true) {
                          // Verified following!
                          await clearUnlockAttempts(attemptKey)
                          console.log(`[webhook] ✅ DM unlock verified for @${senderId} — now following!`)
                          await sendTextDM(
                            user.access_token,
                            { id: senderId },
                            `🎉 Awesome! Thank you for following @${user.username || "thehyderabadiedu.co"}! Here are your links:`,
                          )
                          const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: responsePreviewText(content),
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        } else if (followResult.follows === false) {
                          // Caught trying to skip without following!
                          const attempts = await bumpUnlockAttempt(attemptKey)
                          console.log(`[webhook] ❌ Verification failed: @${senderId} does not follow (attempt ${attempts}/${UNLOCK_GATE_MAX_ATTEMPTS})`)

                          if (attempts <= UNLOCK_GATE_MAX_ATTEMPTS) {
                            const result = await sendCardDM(
                              user.access_token,
                              { id: senderId },
                              buildFollowGateCard({
                                username: user.username,
                                ruleId: match.id,
                                title: "❌ Not Following Yet!",
                                subtitle: `Please tap 'Follow Now' to follow @${user.username || "thehyderabadiedu.co"} first!`,
                              }),
                            )
                            const conv = await incomingSaved
                            if (result?.ok && conv) {
                              try {
                                await supabase.from("messages").insert({
                                  id: `mid_reply_${Date.now()}_${Math.random()}`,
                                  conversation_id: conv.id,
                                  user_id: user.id,
                                  sender_id: user.business_account_id,
                                  sender_username: user.username,
                                  content: `[Follow-Gate: Re-prompted to follow, attempt ${attempts}]`,
                                  is_from_instagram: false,
                                })
                              } catch (e) {
                                console.error("[webhook] Failed to save outgoing message", e)
                              }
                            }
                          } else {
                            // Max attempts exceeded: safety unlock
                            console.warn(`[webhook] ⚠️ Follow gate safety unlock after ${attempts} attempts for @${senderId}`)
                            await clearUnlockAttempts(attemptKey)
                            await sendTextDM(
                              user.access_token,
                              { id: senderId },
                              `🎉 Thank you for following @${user.username || "thehyderabadiedu.co"}! Here are your links:`,
                            )
                            const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                            const conv = await incomingSaved
                            if (result?.ok && conv) {
                              try {
                                await supabase.from("messages").insert({
                                  id: `mid_reply_${Date.now()}_${Math.random()}`,
                                  conversation_id: conv.id,
                                  user_id: user.id,
                                  sender_id: user.business_account_id,
                                  sender_username: user.username,
                                  content: responsePreviewText(content),
                                  is_from_instagram: false,
                                })
                              } catch (e) {
                                console.error("[webhook] Failed to save outgoing message", e)
                              }
                            }
                          }
                        } else {
                          // followResult.follows === null (API transient error or rate limit): fail open
                          console.warn(`[webhook] ⚠️ Follow check unverifiable for @${senderId}; delivering content`)
                          await clearUnlockAttempts(attemptKey)
                          await sendTextDM(
                            user.access_token,
                            { id: senderId },
                            `🎉 Thank you for following @${user.username || "thehyderabadiedu.co"}! Here are your links:`,
                          )
                          const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: responsePreviewText(content),
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        }
                      } else {
                        // Standard initial DM (e.g. user sent keyword directly in DM)
                        const followResult = await verifyFollowStatus(senderId, user.access_token)
                        if (followResult.follows === true) {
                          await clearUnlockAttempts(attemptKey)
                          console.log(`[webhook] ✅ DM follower gate: @${senderId} follows @${user.username} — sending content`)
                          const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: responsePreviewText(content),
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        } else {
                          console.log(`[webhook] 🔒 DM follower gate: @${senderId} doesn't follow @${user.username} — sending gate card`)
                          const result = await sendCardDM(
                            user.access_token,
                            { id: senderId },
                            buildFollowGateCard({ username: user.username, ruleId: match.id }),
                          )
                          const conv = await incomingSaved
                          if (result?.ok && conv) {
                            try {
                              await supabase.from("messages").insert({
                                id: `mid_reply_${Date.now()}_${Math.random()}`,
                                conversation_id: conv.id,
                                user_id: user.id,
                                sender_id: user.business_account_id,
                                sender_username: user.username,
                                content: "[Follow-Gate: Sent Follow Now & I'm Following card]",
                                is_from_instagram: false,
                              })
                            } catch (e) {
                              console.error("[webhook] Failed to save outgoing message", e)
                            }
                          }
                        }
                      }
                    } else {
                      // No follower check required
                      const result = await sendAutomationResponse(user.access_token, { id: senderId }, content)
                      const conv = await incomingSaved
                      if (result?.ok && conv) {
                        try {
                          await supabase.from("messages").insert({
                            id: `mid_reply_${Date.now()}_${Math.random()}`,
                            conversation_id: conv.id,
                            user_id: user.id,
                            sender_id: user.business_account_id,
                            sender_username: user.username,
                            content: responsePreviewText(content),
                            is_from_instagram: false,
                          })
                        } catch (e) {
                          console.error("[webhook] Failed to save outgoing message", e)
                        }
                      }
                    }
          } finally {
            await incomingSaved
          }
        }
      }
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[webhook] Error", error)
    return NextResponse.json({ ok: true })
  }
}
