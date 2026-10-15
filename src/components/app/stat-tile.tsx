import { Card } from '@/components/ui/card';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';

export function StatTile({ label, value, suffix, sub, decimals = 0 }: { label: string; value: number; suffix?: string; sub?: string; decimals?: number }) {
  return (
    <Card className="gap-1 px-5 py-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex items-baseline gap-1 text-2xl font-semibold tracking-tight">
        <SlidingNumber number={value} decimalPlaces={decimals} />
        {suffix && <span className="text-muted-foreground text-base">{suffix}</span>}
      </span>
      {sub && <span className="text-muted-foreground text-xs">{sub}</span>}
    </Card>
  );
}
