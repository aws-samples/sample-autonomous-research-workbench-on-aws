"use client"

import { LoaderCircle, LogIn } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"

import { authClient } from "@repo/auth/client"

import PixelBlast from "#/components/animation/pixel-blast"
import { Button } from "#/components/ui/button"

export function SignInView({ redirect }: { redirect?: string }) {
  const t = useTranslations("SignIn")
  const [isLoading, setIsLoading] = useState(false)

  const handleSignIn = async () => {
    setIsLoading(true)
    try {
      await authClient.signIn.social({
        provider: "cognito",
        // Absolute URL on the web app origin so Better Auth (served from the
        // API origin) sends the user back here after the OAuth round-trip.
        callbackURL: new URL(redirect ?? "/", window.location.origin).toString(),
      })
    } catch (error) {
      console.error("Sign-in failed:", error)
      setIsLoading(false)
    }
  }

  return (
    <div className="dark grid min-h-svh bg-background text-foreground lg:grid-cols-2">
      <div className="relative hidden bg-black lg:block">
        <div className="animate-fade-in absolute inset-0">
          <PixelBlast
            variant="square"
            color="#22C55E"
            edgeFade={0.15}
            patternDensity={1.4}
            pixelSize={4}
          />
        </div>
      </div>
      <div className="flex flex-col border-l border-l-border bg-background text-foreground">
        <div className="flex flex-1 flex-col items-center justify-center px-10">
          <div className="flex w-full max-w-xs flex-col items-center justify-center gap-5 text-center">
            <img
              src="/aws-logo.png"
              alt={t("logoAlt")}
              width={64}
              height={64}
              className="size-16 rounded-lg"
            />
            <span className="text-xl font-medium">{t("platform")}</span>
          </div>
          <Button
            variant="outline"
            className="mt-6 flex h-11 w-full max-w-xs items-center gap-2"
            onClick={handleSignIn}
            disabled={isLoading}
          >
            {isLoading ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <LogIn className="size-4" />
            )}
            {isLoading ? t("signingIn") : t("signIn")}
          </Button>
        </div>
      </div>
    </div>
  )
}
