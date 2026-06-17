"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Search, Pencil, Trash2, Tags as TagsIcon } from "lucide-react";
import {
  createTagSchema,
  TAG_COLORS,
  type CreateTagInput,
  type Tag,
} from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTableQuery } from "@/lib/use-table-query";
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from "./api";
import { TagBadge } from "./TagBadge";
import { TAG_HEX } from "./tag-colors";

export function TagManager() {
  const t = useTableQuery({ initialSort: { key: "name", dir: "asc" } });
  const { data, isLoading } = useTags(t.baseParams);
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);

  const { register, handleSubmit, control, reset, formState: { errors, isSubmitting } } =
    useForm<CreateTagInput>({
      resolver: zodResolver(createTagSchema),
      defaultValues: { name: "", color: "blue" },
    });

  function openCreate() {
    setEditing(null);
    reset({ name: "", color: "blue" });
    setOpen(true);
  }
  function openEdit(tag: Tag) {
    setEditing(tag);
    reset({ name: tag.name, color: tag.color });
    setOpen(true);
  }

  async function onSubmit(values: CreateTagInput) {
    try {
      if (editing) {
        await updateTag.mutateAsync({ id: editing.id, input: values });
        toast.success("Tag updated");
      } else {
        await createTag.mutateAsync(values);
        toast.success("Tag created");
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save tag");
    }
  }

  const columns: Column<Tag>[] = [
    {
      key: "name",
      header: "Tag",
      sortable: true,
      cell: (tag) => <TagBadge tag={tag} />,
    },
    { key: "color", header: "Color", cell: (tag) => <span className="capitalize text-foreground-muted">{tag.color}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (tag) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(tag)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => deleteTag.mutate(tag.id, { onSuccess: () => toast.success("Tag deleted"), onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to delete tag") })}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        icon={TagsIcon}
        title="Tags"
        description="Reusable labels you can attach to customers, quotations, orders and more."
        action={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New tag
          </Button>
        }
      />

      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <Input value={t.q} onChange={(e) => t.setQ(e.target.value)} placeholder="Search tags…" className="pl-8" />
      </div>

      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{editing ? "Edit tag" : "Create tag"}</ResponsiveModalTitle>
            <ResponsiveModalDescription>Name the tag and pick a color.</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" {...register("name")} />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Color</Label>
              <Controller
                control={control}
                name="color"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAG_COLORS.map((c) => (
                        <SelectItem key={c} value={c}>
                          <span className="flex items-center gap-2">
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: TAG_HEX[c] }} />
                            <span className="capitalize">{c}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <ResponsiveModalFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={isSubmitting}>
                {editing ? "Save changes" : "Create tag"}
              </Button>
            </ResponsiveModalFooter>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <DataTable
        columns={columns}
        data={data?.data}
        getRowId={(tag) => tag.id}
        total={data?.meta.total ?? 0}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        onPageChange={t.setPage}
        onPageSizeChange={t.setPageSize}
        onSortChange={t.handleSort}
        isLoading={isLoading}
        emptyMessage="No tags yet. Create your first tag."
      />
    </div>
  );
}
