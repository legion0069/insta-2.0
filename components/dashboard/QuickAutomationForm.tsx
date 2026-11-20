"use client"

import { useRef, useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"
import type { Automation } from "@/lib/types"
import { PostSelector, InstagramMediaItem } from "@/components/dashboard/PostSelector"

type Source = Automation["trigger_source"]

interface CardButton {
  title: string
  url: string
}

export function QuickAutomationForm({ userId, initialSource = "comment", onSuccess }: {
  userId: string
  initialSource?: Source
  onSuccess: (source: Source) => void
}) {
  const [source, setSource] = useState<Source>(initialSource || "comment")
  const [triggerMode, setTriggerMode] = useState<"keyword" | "any">("keyword")
  const [keyword, setKeyword] = useState("")
  const [answer, setAnswer] = useState("")
  const [useButtonCard, setUseButtonCard] = useState(false)
  const [cardTitle, setCardTitle] = useState("Job Links & Information")
  const [cardButtons, setCardButtons] = useState<CardButton[]>([
    { title: "🔗 View Job Links", url: "" },
  ])
  const [checkFollow, setCheckFollow] = useState(false)
  const [replyPublicly, setReplyPublicly] = useState(true)
  const [publicReplyText, setPublicReplyText] = useState("Check your DMs! 📥")
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null)
  const [selectedMedia, setSelectedMedia] = useState<InstagramMediaItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const submitting = useRef(false)

  const addButton = () => {
    if (cardButtons.length < 3) {
      setCardButtons(prev => [...prev, { title: "", url: "" }])
    }
  }

  const removeButton = (index: number) => {
    if (cardButtons.length > 1) {
      setCardButtons(prev => prev.filter((_, i) => i !== index))
    }
  }

  const updateButton = (index: number, field: keyof CardButton, value: string) => {
    setCardButtons(prev => prev.map((btn, i) => i === index ? { ...btn, [field]: value } : btn))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !answer.trim()) return
    if (triggerMode === "keyword" && !keyword.trim()) return

    submitting.current = true
    setSaving(true)
    setError("")

    const isAny = triggerMode === "any"
    const finalTriggerValue = isAny ? "*" : keyword.trim().toLowerCase()
    const autoName = isAny
      ? "Reply to any comment" + (selectedMedia ? ` on ${selectedMedia.id}` : "")
      : "Reply to " + keyword.trim()

    const contentPayload: any = {
      message: answer.trim(),
      reply_mode: source === "comment" && replyPublicly ? "both" : "dm_only",
      check_follow: checkFollow,
      public_replies: replyPublicly && publicReplyText.trim() ? [publicReplyText.trim()] : ["Check your DMs! 📥"],
    }

    const validButtons = cardButtons
      .map(b => ({
        type: "web_url",
        title: b.title.trim() || "🔗 Open Link",
        url: b.url.trim(),
      }))
      .filter(b => Boolean(b.url))

    if (useButtonCard && validButtons.length > 0) {
      contentPayload.card = {
        title: cardTitle.trim() || "Here is your link",
        subtitle: answer.trim() || "Tap below to view and apply:",
        buttons: validButtons,
      }
    }

    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          name: autoName,
          trigger_source: source,
          trigger_type: isAny ? "reply_all" : (source === "story" ? "reply" : "keyword"),
          trigger_value: finalTriggerValue,
          content: contentPayload,
          specific_media_id: source === "comment" ? selectedMediaId : null,
        }),
      })
      if (!response.ok) throw new Error("Could not save. Please try again.")
      setKeyword("")
      setAnswer("")
      setSelectedMediaId(null)
      setSelectedMedia(null)
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("automation-changed"))
      }
      onSuccess(source)
    } catch {
      setError("Could not save. Check your connection and try again.")
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return <form onSubmit={save} className="overflow-hidden rounded-xl border border-border bg-card">
    <fieldset disabled={saving} className="min-w-0">
      <label className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="shrink-0 text-xs text-muted-foreground font-medium">Trigger source</span>
        <select
          value={source}
          onChange={event => {
            const next = event.target.value as Source
            setSource(next)
            if (next !== "comment") {
              setSelectedMediaId(null)
              setSelectedMedia(null)
            }
          }}
          className="rounded-md bg-card py-1 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="comment">Post comments</option>
          <option value="dm">Direct messages</option>
          <option value="story">Story replies</option>
        </select>
      </label>

      {source === "comment" && (
        <div className="border-b border-border bg-muted/20 p-4 sm:p-5">
          <div className="mb-3">
            <p className="text-sm font-medium text-foreground">Choose where this runs</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Apply this reply to every post/reel, or pick one specific post or reel.
            </p>
          </div>
          <PostSelector
            userId={userId}
            selectedMediaId={selectedMediaId}
            onSelect={(id, item) => {
              setSelectedMediaId(id)
              setSelectedMedia(item)
            }}
          />
        </div>
      )}

      {/* Trigger Condition: Specific Word vs Comment Anything */}
      {source === "comment" && (
        <div className="border-b border-border px-4 py-3.5 bg-card flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <span className="text-xs font-semibold text-foreground">Trigger condition</span>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Choose whether to require specific words or reply to any comment.
            </p>
          </div>
          <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setTriggerMode("keyword")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                triggerMode === "keyword"
                  ? "bg-card text-foreground shadow-xs border border-border"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Specific word(s)
            </button>
            <button
              type="button"
              onClick={() => setTriggerMode("any")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                triggerMode === "any"
                  ? "bg-card text-foreground shadow-xs border border-border"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Comment anything
            </button>
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-[1fr_2fr]">
        {triggerMode === "keyword" ? (
          <label className="block border-b border-border p-4 sm:border-b-0 sm:border-r">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">When they say</span>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono-ui font-medium">Case-insensitive</span>
            </div>
            <input
              required
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder="e.g. barbell, price, link"
              className="mt-2 w-full rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-normal">
              Separate multiple words with commas. Capitalization does not matter (<span className="font-mono">BARBELL</span>, <span className="font-mono">Barbell</span>, <span className="font-mono">barbell</span>).
            </p>
          </label>
        ) : (
          <div className="border-b border-border p-4 sm:border-b-0 sm:border-r flex flex-col justify-center">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-accent-blue bg-accent-blue/10 px-2.5 py-1.5 rounded-lg w-fit">
              <span>✦ Any Comment Trigger</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              Any comment left by a viewer on this reel will trigger the reply.
            </p>
          </div>
        )}

        <div className="p-4 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Send this DM reply</span>
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={answer}
              onChange={event => setAnswer(event.target.value)}
              placeholder="Here are the job links and application details..."
              className="mt-2 w-full resize-y rounded-md border border-border bg-muted/30 p-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </label>

          {/* Interactive Button Card Option (Anti-Spam Link Delivery) */}
          <div className="pt-3 border-t border-border space-y-3">
            <div className="flex items-start gap-3">
              <input
                id="use-button-card-toggle"
                type="checkbox"
                checked={useButtonCard}
                onChange={e => setUseButtonCard(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
              />
              <label htmlFor="use-button-card-toggle" className="cursor-pointer select-none flex-1">
                <span className="text-xs font-semibold text-foreground flex flex-wrap items-center gap-2">
                  <span>🔘 Deliver as an Interactive Button Card</span>
                  <span className="rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] px-2 py-0.5 font-bold uppercase tracking-wide">
                    Anti-Spam · Safe
                  </span>
                </span>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Recommended for sending links. Instead of raw text URLs that Instagram can hide, sends a clean native tap button (<span className="font-semibold text-primary">🔗 View Link</span>).
                </p>
              </label>
            </div>

            {useButtonCard && (
              <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5 space-y-3.5 animate-in fade-in-50 duration-150">
                <label className="block">
                  <span className="text-[11px] font-medium text-muted-foreground">Card Title</span>
                  <input
                    type="text"
                    value={cardTitle}
                    onChange={e => setCardTitle(e.target.value)}
                    placeholder="e.g. Job Links & Information"
                    className="mt-1 w-full text-xs bg-card border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>

                {/* Multiple Card Buttons */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                      <span>Card Buttons / Links</span>
                      <span className="text-[10px] text-muted-foreground font-mono">({cardButtons.length}/3)</span>
                    </span>
                    {cardButtons.length < 3 && (
                      <button
                        type="button"
                        onClick={addButton}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:opacity-85 transition-opacity cursor-pointer"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add another link
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {cardButtons.map((btn, idx) => (
                      <div key={idx} className="rounded-lg border border-border/80 bg-card p-2.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            Button #{idx + 1}
                          </span>
                          {cardButtons.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeButton(idx)}
                              className="text-muted-foreground hover:text-destructive transition-colors p-0.5 rounded cursor-pointer"
                              title="Remove button"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block">
                            <span className="text-[10px] font-medium text-muted-foreground">Button Text</span>
                            <input
                              type="text"
                              value={btn.title}
                              onChange={e => updateButton(idx, "title", e.target.value)}
                              placeholder={idx === 0 ? "e.g. 🔗 View Job Links" : idx === 1 ? "e.g. 📄 Application Form" : "e.g. 💬 Join Community"}
                              className="mt-1 w-full text-xs bg-muted/30 border border-border rounded-md px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-medium text-muted-foreground">Destination URL</span>
                            <input
                              required={useButtonCard && idx === 0}
                              type="url"
                              value={btn.url}
                              onChange={e => updateButton(idx, "url", e.target.value)}
                              placeholder="https://..."
                              className="mt-1 w-full text-xs bg-muted/30 border border-border rounded-md px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live Preview */}
                <div className="mt-2 pt-2.5 border-t border-border">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                    Instagram In-App Preview
                  </span>
                  <div className="max-w-xs mx-auto rounded-xl border border-border bg-card p-3 shadow-xs text-center space-y-2">
                    <div>
                      <p className="text-xs font-semibold text-foreground truncate">{cardTitle || "Job Links & Information"}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{answer || "Tap below to view and apply:"}</p>
                    </div>
                    <div className="space-y-1.5 pt-1">
                      {cardButtons.map((btn, idx) => (
                        <div key={idx} className="w-full rounded-lg bg-primary/10 border border-primary/20 py-1.5 text-xs font-semibold text-primary flex items-center justify-center gap-1.5 shadow-2xs">
                          <span className="truncate">{btn.title || `🔗 Link #${idx + 1}`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Follower Gate Toggle */}
          <div className="pt-2 border-t border-border flex items-start gap-3">
            <input
              id="check-follow-toggle"
              type="checkbox"
              checked={checkFollow}
              onChange={e => setCheckFollow(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
            />
            <label htmlFor="check-follow-toggle" className="cursor-pointer select-none">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <span>🔒 Only send if they follow you (Follow-Gate)</span>
              </span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                If they don't follow your account, they are prompted to follow to unlock the link.
              </p>
            </label>
          </div>

          {/* Public Reply Option */}
          {source === "comment" && (
            <div className="pt-2 border-t border-border space-y-2">
              <div className="flex items-center gap-3">
                <input
                  id="reply-public-toggle"
                  type="checkbox"
                  checked={replyPublicly}
                  onChange={e => setReplyPublicly(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
                />
                <label htmlFor="reply-public-toggle" className="text-xs font-semibold text-foreground cursor-pointer select-none">
                  💬 Also reply publicly to their comment
                </label>
              </div>
              {replyPublicly && (
                <input
                  type="text"
                  value={publicReplyText}
                  onChange={e => setPublicReplyText(e.target.value)}
                  placeholder="e.g. Check your DMs! 📥"
                  className="w-full text-xs bg-muted/30 border border-border rounded-md px-3 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 bg-muted/10">
        <p className="text-xs text-muted-foreground truncate">
          {source === "comment"
            ? selectedMediaId
              ? "Runs on selected reel · " + (triggerMode === "any" ? "Any comment" : "Keyword match")
              : "Runs on all reels · " + (triggerMode === "any" ? "Any comment" : "Keyword match")
            : "Direct messages"}
        </p>
        <button
          disabled={saving || (triggerMode === "keyword" && !keyword.trim()) || !answer.trim()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-all shrink-0"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {saving ? "Saving…" : "Save Automation"}
        </button>
      </div>
      {error && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error}</p>}
    </fieldset>
  </form>
}
