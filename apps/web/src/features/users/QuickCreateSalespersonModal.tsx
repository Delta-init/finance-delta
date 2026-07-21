"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus } from "lucide-react";
import { createUserSchema, type CreateUserInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useRoles } from "@/features/roles/api";
import { useAllDepartments } from "@/features/departments/api";
import { useCreateUser } from "./api";

export function QuickCreateSalespersonModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const { data: roles } = useRoles({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: departments } = useAllDepartments();
  const createUser = useCreateUser();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: "", email: "", password: "", roleId: "", departmentId: undefined, tagIds: [] },
  });

  async function submit(values: CreateUserInput) {
    setServerError(null);
    try {
      const user = await createUser.mutateAsync(values);
      reset();
      onCreated(user.id, user.name);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Failed to create salesperson");
    }
  }

  function handleClose() {
    reset();
    setServerError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New Salesperson
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name *</Label>
            <Input {...register("name")} placeholder="e.g. Priya Sharma" autoFocus />
            {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input {...register("email")} type="email" placeholder="priya@company.com" />
            {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Password *</Label>
            <Input {...register("password")} type="password" placeholder="Min. 8 characters" />
            {errors.password && <p className="text-xs text-danger">{errors.password.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Role *</Label>
            <Controller
              control={control}
              name="roleId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles?.data.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.roleId && <p className="text-xs text-danger">{errors.roleId.message}</p>}
          </div>
          {(departments?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Controller
                control={control}
                name="departmentId"
                render={({ field }) => (
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a department…" />
                    </SelectTrigger>
                    <SelectContent>
                      {departments?.map((d) => (
                        <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          )}
          {serverError && <p className="text-sm text-danger">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create Salesperson"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
