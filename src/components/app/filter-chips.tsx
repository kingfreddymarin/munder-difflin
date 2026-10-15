// A single-choice filter built on the animate-ui ToggleGroup, reused by every list.
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';

export function FilterChips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <ToggleGroup type="single" size="sm" variant="outline" aria-label={label} value={value} onValueChange={(v) => v && onChange(v as T)} className="flex-wrap">
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
