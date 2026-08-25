"use client"

import {
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
import { useTranslations } from "next-intl"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  PlusCircle,
  Search,
  Settings2,
  Trash2,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { orpc } from "@/orpc/client"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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

import { dbProjectToUi } from "./db-adapter"
import { useProjectColumns } from "./projects-columns"
import type { Project, ProjectStatus } from "./types"

const STATUS_OPTIONS: ProjectStatus[] = [
  "draft",
  "active",
  "paused",
  "completed",
]

// Fixed widths for every column except "name", which absorbs the remaining
// space under table-fixed so long summaries truncate instead of widening the
// table past the page.
const COLUMN_WIDTHS: Record<string, string> = {
  status: "w-32",
  agents: "w-28",
  createdAt: "w-44",
  rowActions: "w-12",
}

export function ProjectsDataTable() {
  const t = useTranslations("Projects")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const baseColumns = useProjectColumns()

  const projectsQuery = useQuery(orpc.projects.list.queryOptions({ input: {} }))

  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)

  const deleteProject = useMutation(
    orpc.projects.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.projects.list.key({ input: {} }),
        })
        toast.success(t("toasts.deleted"))
        setPendingDelete(null)
      },
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Could not delete project",
        ),
    }),
  )

  const columns = useMemo<ColumnDef<Project>[]>(
    () => [
      ...baseColumns,
      {
        id: "rowActions",
        enableHiding: false,
        cell: ({ row }) => {
          return (
            <div
              className="flex justify-end"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("delete")}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setPendingDelete(row.original)}
                  >
                    <Trash2 className="size-4" />
                    {t("delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [baseColumns, t],
  )

  // DB projects only (newest first).
  const data = useMemo(
    () => (projectsQuery.data ?? []).map(dbProjectToUi),
    [projectsQuery.data],
  )

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [globalFilter, setGlobalFilter] = useState("")

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns non-memoizable functions by design
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, value: string) => {
      const q = value.trim().toLowerCase()
      if (!q) return true
      const project = row.original
      return [project.name, project.summary]
        .join(" ")
        .toLowerCase()
        .includes(q)
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  })

  const statusColumn = table.getColumn("status")
  const statusSelected = (statusColumn?.getFilterValue() as string[]) ?? []
  const hasFilters = statusSelected.length > 0 || globalFilter.length > 0

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
          label={t("columns.status")}
          options={STATUS_OPTIONS.map((v) => ({
            value: v,
            label: t(`statuses.${v}`),
          }))}
          selected={statusSelected}
          onChange={(next) =>
            statusColumn?.setFilterValue(next.length ? next : undefined)
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

        <Button
          size="sm"
          className="ml-auto"
          onClick={() => navigate({ to: "/" })}
        >
          <PlusCircle />
          {t("create")}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Settings2 />
              {t("filters.view")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
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
                  {t(`columns.${columnLabelKey(column.id)}`)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn("h-9", COLUMN_WIDTHS[header.column.id])}
                  >
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
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() =>
                    row.original.status === "draft"
                      ? navigate({
                          to: "/projects/create",
                          search: { projectId: row.original.id },
                        })
                      : navigate({ to: `/projects/${row.original.id}` })
                  }
                >
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
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t("deleteConfirm.description", { name: pendingDelete.name })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">
              {t("deleteConfirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              disabled={deleteProject.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (pendingDelete) {
                  deleteProject.mutate({ id: pendingDelete.id })
                }
              }}
            >
              {deleteProject.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t("deleteConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function columnLabelKey(columnId: string): string {
  switch (columnId) {
    case "name":
      return "name"
    case "createdAt":
      return "created"
    default:
      return columnId
  }
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
      <DropdownMenuContent align="start" className="w-52">
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
