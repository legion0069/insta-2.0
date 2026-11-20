"use client"

import { useState, useEffect, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"

export function useInstagramSession() {
    const [username, setUsername] = useState<string | null>(null)
    const [userId, setUserId] = useState<string | null>(null)
    const [profilePic, setProfilePic] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    const searchParams = useSearchParams()
    const router = useRouter()
    const isExchangingRef = useRef(false)

    useEffect(() => {
        const code = searchParams.get("code")

        const handleSession = async () => {
            // CASE A: New Login from Instagram
            if (code && !isExchangingRef.current) {
                isExchangingRef.current = true
                try {
                    const res = await fetch("/api/instagram/callback", {
                        method: "POST",
                        body: JSON.stringify({ code }),
                    })
                    const data = await res.json()

                    if (data.success) {
                        localStorage.setItem("ig_user_id", data.userId)
                        localStorage.setItem("ig_username", data.username)
                        if (data.profilePic) localStorage.setItem("ig_profile_pic", data.profilePic)

                        setUserId(data.userId)
                        setUsername(data.username)
                        setProfilePic(data.profilePic || null)
                        // Remove code from URL
                        router.replace("/dashboard")
                    } else {
                        console.error("Backend login error:", data.error)
                        // Fallback: Check if session is already saved in database
                        try {
                            const activeRes = await fetch("/api/instagram/active-user")
                            const activeData = await activeRes.json()
                            if (activeData.user) {
                                localStorage.setItem("ig_user_id", activeData.user.userId)
                                localStorage.setItem("ig_username", activeData.user.username)
                                setUserId(activeData.user.userId)
                                setUsername(activeData.user.username)
                                router.replace("/dashboard")
                                setIsLoading(false)
                                return
                            }
                        } catch (e) {
                            console.warn("Fallback active user check failed:", e)
                        }
                    }
                } catch (err) {
                    console.error("Login failed:", err)
                } finally {
                    isExchangingRef.current = false
                }
            }
            // CASE B: Restore Session from Database or LocalStorage
            else {
                try {
                    const activeRes = await fetch("/api/instagram/active-user")
                    const activeData = await activeRes.json()
                    if (activeData.user) {
                        localStorage.setItem("ig_user_id", activeData.user.userId)
                        localStorage.setItem("ig_username", activeData.user.username)
                        setUserId(activeData.user.userId)
                        setUsername(activeData.user.username)
                        setIsLoading(false)
                        return
                    }
                } catch (e) {
                    console.warn("Could not check active user:", e)
                }

                const savedId = localStorage.getItem("ig_user_id")
                const savedName = localStorage.getItem("ig_username")

                if (savedId && savedName) {
                    setUserId(savedId)
                    setUsername(savedName)
                    setProfilePic(localStorage.getItem("ig_profile_pic"))
                }
            }
            setIsLoading(false)
        }

        handleSession()
    }, [searchParams, router])

    const logout = () => {
        localStorage.removeItem("ig_user_id")
        localStorage.removeItem("ig_username")
        localStorage.removeItem("ig_profile_pic")
        document.cookie = "insta_session=; Max-Age=0; path=/;"
        setUsername(null)
        setUserId(null)
        setProfilePic(null)
        router.push("/")
    }

    return { userId, username, profilePic, isLoading, logout }
}
