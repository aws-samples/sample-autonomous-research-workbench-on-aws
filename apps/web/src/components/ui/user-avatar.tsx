"use client"

import BoringAvatar from "boring-avatars"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// Green-to-orange palette for the boring-avatars "pixel" variant.
const AVATAR_COLORS = ["#0b6e4f", "#3fa34d", "#a1c349", "#f79824", "#e4572e"]

export function UserAvatar({
  name,
  email,
  image,
  className,
  square = false,
}: {
  name: string
  email?: string
  image?: string | null
  className?: string
  square?: boolean
}) {
  return (
    <Avatar className={className}>
      {image ? <AvatarImage src={image} alt={name} /> : null}
      <AvatarFallback className="overflow-hidden p-0">
        <BoringAvatar
          name={email || name || "?"}
          variant="pixel"
          colors={AVATAR_COLORS}
          size="100%"
          square={square}
        />
      </AvatarFallback>
    </Avatar>
  )
}
