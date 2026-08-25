"use client"

import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations, useLocale } from "next-intl"
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Loader2,
  PlusCircle,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { authClient } from '@repo/auth/client'
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

type AccessLevel = "Member" | "Admin"

const accessLevelOptions: AccessLevel[] = ["Member", "Admin"]

const USERS_QUERY_KEY = ["admin", "users"] as const

interface AdminUser {
  id: string
  name: string
  email: string
  image: string | null
  isAdmin: boolean
  accessLevel: AccessLevel
  createdAt: string
}

// Raw shape returned by better-auth admin.listUsers (structural subset).
interface RawAdminUser {
  id: string
  name: string
  email: string
  image?: string | null
  role?: string | null
  createdAt: string | Date
}

// Error thrown from the list-users query, carrying the HTTP status/code so the
// UI can distinguish a permission failure from a generic load error.
type ListUsersError = Error & { status?: number; code?: string }

function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("admin")
}

function toAdminUser(user: RawAdminUser): AdminUser {
  const isAdmin = hasAdminRole(user.role)
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    isAdmin,
    accessLevel: isAdmin ? "Admin" : "Member",
    createdAt:
      typeof user.createdAt === "string"
        ? user.createdAt
        : new Date(user.createdAt).toISOString(),
  }
}

function SortHeader({
  label,
  isSorted,
  onToggle,
  className,
}: {
  label: string
  isSorted: false | "asc" | "desc"
  onToggle: (desc: boolean) => void
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2.5 h-7 text-muted-foreground", className)}
      onClick={() => onToggle(isSorted === "asc")}
    >
      <span>{label}</span>
      {isSorted === "desc" ? (
        <ArrowDown />
      ) : isSorted === "asc" ? (
        <ArrowUp />
      ) : (
        <ChevronsUpDown className="opacity-50" />
      )}
    </Button>
  )
}

function useUserColumns(
  onToggleAccess: (user: AdminUser) => void
): ColumnDef<AdminUser>[] {
  const t = useTranslations("Settings.users")
  const locale = useLocale()

  return useMemo<ColumnDef<AdminUser>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <SortHeader
            label={t("columns.user")}
            isSorted={column.getIsSorted()}
            onToggle={(desc) => column.toggleSorting(desc)}
          />
        ),
        cell: ({ row }) => {
          const user = row.original
          return (
            <div className="flex items-center gap-2.5">
              <UserAvatar
                name={user.name}
                email={user.email}
                image={user.image}
                className="size-7 shrink-0 rounded-md"
              />
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {user.name}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {user.email}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        accessorKey: "accessLevel",
        header: t("columns.accessLevel"),
        cell: ({ row }) => {
          const isAdmin = row.original.isAdmin
          return (
            <Badge
              className={cn(
                isAdmin
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-foreground/5 text-foreground/70"
              )}
            >
              {isAdmin ? <ShieldCheck className="size-3" /> : null}
              {t(`accessLevels.${row.original.accessLevel}`)}
            </Badge>
          )
        },
        filterFn: (row, id, value: string[]) =>
          value.length === 0 || value.includes(row.getValue(id)),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortHeader
            label={t("columns.joined")}
            isSorted={column.getIsSorted()}
            onToggle={(desc) => column.toggleSorting(desc)}
          />
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {new Date(row.original.createdAt).toLocaleString(
              locale === "ko" ? "ko-KR" : "en-US",
              {
                year: "numeric",
                month: "short",
                day: "numeric",
              }
            )}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        header: () => (
          <div className="text-right text-muted-foreground">
            {t("columns.admin")}
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="min-w-24"
              onClick={() => onToggleAccess(row.original)}
              aria-label={t("toggleAria", { name: row.original.name })}
            >
              {row.original.isAdmin
                ? t("confirm.demoteConfirm")
                : t("confirm.promoteConfirm")}
            </Button>
          </div>
        ),
      },
    ],
    [t, locale, onToggleAccess]
  )
}

const COLUMN_LABEL_KEY: Record<string, string> = {
  name: "user",
  createdAt: "joined",
}

export function UsersAdminTable() {
  const t = useTranslations("Settings.users")
  const queryClient = useQueryClient()

  const { data: session, isPending: isSessionPending } =
    authClient.useSession()
  const isAdmin = hasAdminRole(session?.user.role)

  const {
    data: users = [],
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: USERS_QUERY_KEY,
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
      })
      if (error) {
        const err = new Error(
          error.message ?? "Failed to load users"
        ) as ListUsersError
        err.status = error.status
        err.code = error.code
        throw err
      }
      return (data.users as RawAdminUser[]).map(toAdminUser)
    },
  })

  const setRole = useMutation({
    mutationFn: async ({
      userId,
      role,
    }: {
      userId: string
      role: "admin" | "user"
    }) => {
      const { error } = await authClient.admin.setRole({ userId, role })
      if (error) throw new Error(error.message ?? "Failed to update role")
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Something went wrong"),
  })

  const [pendingUser, setPendingUser] = useState<AdminUser | null>(null)

  const requestToggle = (user: AdminUser) => setPendingUser(user)

  const applyToggle = () => {
    if (!pendingUser) return
    const nextRole = pendingUser.isAdmin ? "user" : "admin"
    const name = pendingUser.name
    setRole.mutate(
      { userId: pendingUser.id, role: nextRole },
      {
        onSuccess: () =>
          toast.success(
            nextRole === "admin"
              ? t("toasts.promoted", { name })
              : t("toasts.demoted", { name })
          ),
      }
    )
    setPendingUser(null)
  }

  const columns = useUserColumns(requestToggle)

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [globalFilter, setGlobalFilter] = useState("")

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns non-memoizable functions by design
  const table = useReactTable({
    data: users,
    columns,
    state: { sorting, columnFilters, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, value: string) => {
      const q = value.trim().toLowerCase()
      if (!q) return true
      const user = row.original
      return [user.name, user.email].join(" ").toLowerCase().includes(q)
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  })

  const accessColumn = table.getColumn("accessLevel")
  const accessSelected = (accessColumn?.getFilterValue() as string[]) ?? []
  const hasFilters = accessSelected.length > 0 || globalFilter.length > 0

  const isPromoting = pendingUser ? !pendingUser.isAdmin : false

  const listError = error as ListUsersError | null
  const isForbidden =
    listError?.status === 403 ||
    listError?.code === "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS"
  const isRestricted = !isSessionPending && (!isAdmin || isForbidden)

  if (isRestricted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border bg-card p-8 text-center">
        <ShieldAlert className="size-6 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm font-medium text-foreground">
          {t("restricted")}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t("restrictedHint")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-8"
          />
        </div>

        <FacetFilter
          label={t("columns.accessLevel")}
          options={accessLevelOptions.map((v) => ({
            value: v,
            label: t(`accessLevels.${v}`),
          }))}
          selected={accessSelected}
          onChange={(next) =>
            accessColumn?.setFilterValue(next.length ? next : undefined)
          }
        />

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              table.resetColumnFilters()
              setGlobalFilter("")
            }}
          >
            {t("filters.reset")}
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto">
              <Settings2 />
              {t("filters.view")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{t("filters.toggleColumns")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {t(`columns.${COLUMN_LABEL_KEY[column.id] ?? column.id}`)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="h-9">
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {t("loading")}
                  </span>
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-2">
                    <TriangleAlert className="size-4" />
                    {t("error")}
                  </span>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-foreground/4">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-2">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t("rowCount", { count: table.getFilteredRowModel().rows.length })}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("page", {
              page: table.getState().pagination.pageIndex + 1,
              total: Math.max(table.getPageCount(), 1),
            })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <AlertDialog
        open={pendingUser !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUser(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPromoting ? t("confirm.promoteTitle") : t("confirm.demoteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingUser
                ? isPromoting
                  ? t("confirm.promoteDescription", { name: pendingUser.name })
                  : t("confirm.demoteDescription", { name: pendingUser.name })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">
              {t("confirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction size="sm" onClick={applyToggle}>
              {isPromoting ? t("confirm.promoteConfirm") : t("confirm.demoteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FacetFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (value: string) => {
    const next = new Set(selectedSet)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange([...next])
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="border-dashed">
          <PlusCircle />
          {label}
          {selected.length > 0 ? (
            <>
              <span className="mx-1 h-3.5 w-px bg-border" />
              <Badge className="bg-foreground/10 text-foreground">
                {selected.length}
              </Badge>
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selectedSet.has(option.value)}
            onCheckedChange={() => toggle(option.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
