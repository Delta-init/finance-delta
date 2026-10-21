"use client";

import { useState } from "react";
import type { ExpenseCategoryRecord } from "@delta/shared";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/*
 * A category and one of its subcategories (2026-10-21). An expense needs the
 * subcategory whenever its category has any, which since the taxonomy is all of
 * them; an organization not moved over yet still has the old flat ones.
 */

export interface CategoryChoice { category: string; subcategory: string }

export function subcategoriesOf(list: ExpenseCategoryRecord[] | undefined, slug: string) {
  return list?.find((c) => c.slug === slug)?.subcategories ?? [];
}

/** Whether the choice is whole: a category, and a subcategory when it has any. */
export function choiceComplete(list: ExpenseCategoryRecord[] | undefined, v: CategoryChoice): boolean {
  return !!v.category && (subcategoriesOf(list, v.category).length === 0 || subcategoriesOf(list, v.category).some((s) => s.slug === v.subcategory));
}

/** A payout page's default (a salary advance → Employee Advances › Salary Advances …) while this organization has it. */
function defaultChoice(list: ExpenseCategoryRecord[], fallback: CategoryChoice): CategoryChoice {
  const cat = list.find((c) => c.slug === fallback.category);
  if (!cat) return { category: "", subcategory: "" };
  return { category: cat.slug, subcategory: cat.subcategories.some((s) => s.slug === fallback.subcategory) ? fallback.subcategory : "" };
}

/** The choice on a payout: the page's default until someone picks. */
export function useCategoryChoice(list: ExpenseCategoryRecord[], fallback: CategoryChoice) {
  const [picked, setPicked] = useState<CategoryChoice | null>(null);
  const value = picked ?? defaultChoice(list, fallback);
  return { value, set: setPicked, reset: () => setPicked(null), complete: choiceComplete(list, value) };
}

/** The subcategory select alone — the expense form places it beside its own category select. */
export function SubcategorySelect({ categories, category, value, onChange, id, disabled }: {
  categories: ExpenseCategoryRecord[] | undefined;
  category: string;
  value: string;
  onChange: (slug: string) => void;
  id?: string;
  disabled?: boolean;
}) {
  const subs = subcategoriesOf(categories, category);
  return (
    <Select key={`${category}:${value}`} value={value || undefined} onValueChange={onChange} disabled={disabled || !subs.length}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={!category ? "Pick a category first" : subs.length ? "Choose a subcategory" : "None for this category"} />
      </SelectTrigger>
      <SelectContent>
        {subs.map((s) => <SelectItem key={s.slug} value={s.slug}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Category and subcategory, as two fields side by side in the page's grid. */
export function CategoryPicker({ categories, value, onChange, idPrefix, loading }: {
  categories: ExpenseCategoryRecord[];
  value: CategoryChoice;
  onChange: (v: CategoryChoice) => void;
  idPrefix: string;
  loading?: boolean;
}) {
  const pickCategory = (slug: string) => {
    const subs = subcategoriesOf(categories, slug);
    onChange({ category: slug, subcategory: subs.length === 1 ? subs[0]!.slug : "" });
  };
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-category`}>Category</Label>
        <Select value={value.category || undefined} onValueChange={pickCategory} disabled={loading}>
          <SelectTrigger id={`${idPrefix}-category`}><SelectValue placeholder={loading ? "Loading…" : "Choose a category"} /></SelectTrigger>
          <SelectContent>
            {categories.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-subcategory`}>Subcategory</Label>
        <SubcategorySelect
          categories={categories}
          category={value.category}
          value={value.subcategory}
          onChange={(s) => onChange({ ...value, subcategory: s })}
          id={`${idPrefix}-subcategory`}
          disabled={loading}
        />
      </div>
    </>
  );
}
