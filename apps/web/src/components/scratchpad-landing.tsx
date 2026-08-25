"use client"

import { useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUp, FolderKanban } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { authClient } from '@repo/auth/client'
import { orpc } from "@/orpc/client"
import { CategorySuggestions } from "@/components/category-suggestions"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { SidebarTrigger } from "@/components/ui/sidebar"

type TimeOfDay = "morning" | "afternoon" | "evening" | "night"

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 17) return "afternoon"
  if (hour >= 17 && hour < 21) return "evening"
  return "night"
}

export function ScratchpadLanding() {
  const t = useTranslations("AppShell")
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const [input, setInput] = React.useState("")
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const createProject = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: ({ id }) =>
        navigate({ to: "/projects/create", search: { projectId: id } }),
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Could not create project"
        ),
    })
  )

  const userName = session?.user.name ?? ""
  const greeting = mounted
    ? t(`greeting.${getTimeOfDay()}`, { name: userName })
    : ""

  const canSubmit = input.trim().length > 0 && !createProject.isPending

  const handleSubmit = () => {
    const question = input.trim()
    if (!question || createProject.isPending) return
    createProject.mutate({ question })
  }

  return (
    <div className="h-full flex-1 overflow-hidden p-2">
      <div className="relative flex h-full w-full flex-col items-center justify-center rounded-xl border bg-card">
        <SidebarTrigger className="absolute top-1 left-1 text-muted-foreground hover:text-foreground" />
        <div className="-mt-16 flex w-full max-w-2xl flex-col items-center px-6">
          <h1
            className="max-w-3xl text-center text-2xl font-medium tracking-tight text-foreground transition-opacity duration-500 md:text-3xl"
            style={{ opacity: mounted ? 1 : 0 }}
          >
            {greeting}
          </h1>

          <div className="mt-8 w-full">
            <InputGroup className="bg-card">
              <InputGroupTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                placeholder={t("placeholder")}
                className="min-h-16"
              />
              <InputGroupAddon align="block-end">
                <InputGroupButton variant="outline" className="pointer-events-none">
                  <FolderKanban className="size-3.5" />
                  {t("modes.project")}
                </InputGroupButton>
                <div className="ml-auto" />
                <InputGroupButton
                  variant="default"
                  className="size-7"
                  disabled={!canSubmit}
                  onClick={handleSubmit}
                  aria-label={t("send")}
                >
                  <ArrowUp />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>

            <CategorySuggestions onSelect={setInput} />
          </div>
        </div>
      </div>
    </div>
  )
}

